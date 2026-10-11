import { copyFile, mkdir, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertSafePath } from './path-policy.js';
import { CapabilityBroker } from './capability.js';
import { OperationBroker } from './broker.js';

const digest = content => createHash('sha256').update(content).digest('hex');

export class TrashStore {
  constructor(root, { trashRoot = path.join(root, '.agent-data', 'trash'), capabilities = new CapabilityBroker(), operationBroker = null } = {}) {
    this.root = path.resolve(root);
    this.trashRoot = path.resolve(trashRoot);
    this.indexFile = path.join(this.trashRoot, 'index.json');
    this.index = null;
    this.capabilities = operationBroker?.capabilities ?? capabilities;
    this.operationBroker = operationBroker ?? new OperationBroker({ capabilities, root: this.root });
  }

  async load() {
    if (this.index) return this.index;
    try { this.index = JSON.parse(await readFile(this.indexFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.index = { version: 1, items: {} }; }
    return this.index;
  }

  async save() {
    await mkdir(this.trashRoot, { recursive: true });
    const temp = `${this.indexFile}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(this.index, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.indexFile);
  }

  async prepareRemove(target, { issue = true } = {}) {
    const value = String(target);
    const absolute = path.isAbsolute(value) || path.win32.isAbsolute(value) ? path.resolve(value) : path.resolve(this.root, value);
    const relative = path.relative(this.root, absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Object.assign(new Error('Trash target must stay inside the workspace'), { code: 'TRASH_TARGET_DENIED' });
    assertSafePath(this.root, absolute, { operation: 'trash-remove' });
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Object.assign(new Error('Only regular unlinked files can be moved to trash'), { code: 'TRASH_TARGET_DENIED' });
    const content = await readFile(absolute);
    if (content.length > 2 * 1024 * 1024) throw Object.assign(new Error('Trash target exceeds 2 MB'), { code: 'TRASH_LIMIT' });
    const capability = issue ? this.capabilities.issue({ tool: 'delete_file', operation: 'trash-remove', resource: { path: absolute, hash: digest(content), size: stat.size } }) : null;
    return { relative, absolute, content, stat, capability };
  }

  async removePrepared(prepared) {
    const current = await this.prepareRemove(prepared.relative, { issue: false });
    this.operationBroker.consume({ token: prepared.capability.id, path: current.absolute, tool: 'delete_file', operation: 'trash-remove', resource: { path: current.absolute, hash: digest(current.content), size: current.stat.size } });
    if (current.stat.ino !== prepared.stat.ino || current.stat.dev !== prepared.stat.dev || digest(current.content) !== digest(prepared.content)) throw Object.assign(new Error('Trash target changed since approval'), { code: 'TRASH_CHANGED' });
    const absolute = current.absolute;
    const id = randomUUID();
    const stored = path.join(this.trashRoot, id, path.basename(absolute));
    await mkdir(path.dirname(stored), { recursive: true });
    await rename(absolute, stored);
    const index = await this.load();
    index.items[id] = { id, originalPath: absolute, storedPath: stored, hash: digest(current.content), size: current.stat.size, removedAt: Date.now(), status: 'trashed' };
    await this.save();
    return this.public(index.items[id]);
  }

  async remove(target) {
    const prepared = await this.prepareRemove(target);
    return this.removePrepared(prepared);
  }

  async restore(id) {
    const index = await this.load(); const item = index.items[id];
    if (!item || item.status !== 'trashed') throw Object.assign(new Error('Trash item not found or already restored'), { code: 'TRASH_NOT_FOUND' });
    assertSafePath(this.root, item.originalPath, { operation: 'trash-restore' });
    try { await lstat(item.originalPath); throw Object.assign(new Error('Restore target already exists'), { code: 'TRASH_TARGET_EXISTS' }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const stored = await readFile(item.storedPath);
    if (digest(stored) !== item.hash) throw Object.assign(new Error('Trash content changed'), { code: 'TRASH_CHANGED' });
    await mkdir(path.dirname(item.originalPath), { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    try {
      // Hard-link publication is no-clobber on the supported local filesystems.
      await import('node:fs/promises').then(fs => fs.link(item.storedPath, item.originalPath));
      await unlink(item.storedPath);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EXDEV'].includes(error.code)) throw error;
      if (error.code === 'EEXIST') throw Object.assign(new Error('Restore target already exists'), { code: 'TRASH_TARGET_EXISTS' });
      await copyFile(item.storedPath, item.originalPath, 1);
      await unlink(item.storedPath);
    }
    item.status = 'restored'; item.restoredAt = Date.now();
    await this.save();
    return this.public(item);
  }

  async list() { return Object.values((await this.load()).items).map(item => this.public(item)); }
  public(item) { return { ...item }; }
}
