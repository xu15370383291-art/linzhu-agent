import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from '../sandbox/atomic-write.js';
import { isWithin, assertSafePath } from './path-policy.js';

const MAX_FILES = 128;
const MAX_BYTES = 16 * 1024 * 1024;
const activeStates = new Set(['prepared', 'committing', 'rollback-pending', 'manual-review']);
const digest = value => createHash('sha256').update(value).digest('hex');

async function safeRead(target) {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw Object.assign(new Error('Transaction target is not a regular file'), { code: 'TRANSACTION_TARGET_UNSAFE' });
    return await readFile(target);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export class TransactionJournal {
  constructor(root, { now = () => Date.now(), maxFiles = MAX_FILES, maxBytes = MAX_BYTES } = {}) {
    this.root = path.resolve(root); this.directory = path.join(this.root, '.agent-data', 'transactions'); this.now = now; this.maxFiles = maxFiles; this.maxBytes = maxBytes;
  }
  async persist(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, file);
  }
  async begin(changes) {
    if (!Array.isArray(changes) || !changes.length || changes.length > this.maxFiles) throw Object.assign(new Error('Transaction file limit exceeded'), { code: 'TRANSACTION_LIMIT' });
    const normalized = []; let total = 0;
    for (const change of changes) {
      const target = path.resolve(change.target ?? change.path);
      if (!isWithin(target, this.root)) throw Object.assign(new Error('Transaction target is outside root'), { code: 'TRANSACTION_SCOPE' });
      assertSafePath(this.root, target, { operation: 'transaction' });
      const before = change.before === null ? null : Buffer.from(String(change.before ?? ''), 'utf8');
      const after = Buffer.from(String(change.after ?? ''), 'utf8');
      total += after.length + (before?.length ?? 0);
      if (total > this.maxBytes) throw Object.assign(new Error('Transaction byte limit exceeded'), { code: 'TRANSACTION_LIMIT' });
      normalized.push({ target, before, after, beforeHash: before === null ? null : digest(before), afterHash: digest(after), existed: before !== null });
    }
    const id = randomUUID(); const directory = path.join(this.directory, id); await mkdir(directory, { recursive: true });
    const entries = [];
    try {
      for (let index = 0; index < normalized.length; index++) {
        const item = normalized[index]; const backup = path.join(directory, `${index}.before`);
        if (item.before !== null) await writeFile(backup, item.before, { flag: 'wx', mode: 0o600 });
        entries.push({ index, target: item.target, backup: item.before === null ? null : path.basename(backup), beforeHash: item.beforeHash, afterHash: item.afterHash, existed: item.existed, status: 'pending' });
      }
      const journal = { version: 1, id, root: this.root, state: 'prepared', createdAt: this.now(), updatedAt: this.now(), entries };
      await this.persist(path.join(directory, 'journal.json'), journal); return journal;
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async load(id) { return JSON.parse(await readFile(path.join(this.directory, id, 'journal.json'), 'utf8')); }
  async save(journal) { journal.updatedAt = this.now(); await this.persist(path.join(this.directory, journal.id, 'journal.json'), journal); }
  async mark(journal, index, state) { journal.entries[index].status = state; journal.state = state === 'committed' ? journal.state : 'committing'; await this.save(journal); }
  async complete(journal) { journal.state = 'completed'; await this.save(journal); await rm(path.join(this.directory, journal.id), { recursive: true, force: true }); }
  async restore(journal, entry, { write = null } = {}) {
    const current = await safeRead(entry.target); const currentHash = current === null ? null : digest(current);
    if (!['committing', 'committed'].includes(entry.status)) return;
    if (currentHash === entry.beforeHash) { entry.status = 'rolled-back'; return; }
    if (currentHash !== entry.afterHash) throw Object.assign(new Error(`Transaction target changed during recovery: ${entry.target}`), { code: 'TRANSACTION_MANUAL_REVIEW' });
    if (!entry.existed) { if (current !== null) await unlink(entry.target); return; }
    const backup = await readFile(path.join(this.directory, journal.id, entry.backup));
    if (write) await write({ ...entry, content: backup.toString('utf8') });
    else await atomicWrite(entry.target, backup.toString('utf8'), { existing: true, validate: async () => {} });
    entry.status = 'rolled-back';
  }
  async rollback(journal, { write = null } = {}) {
    journal.state = 'rollback-pending'; await this.save(journal);
    try { for (const entry of [...journal.entries].reverse()) await this.restore(journal, entry, { write });
      journal.state = 'rolled-back'; await this.save(journal); await rm(path.join(this.directory, journal.id), { recursive: true, force: true }); return { state: 'rolled-back', id: journal.id };
    } catch (error) { journal.state = 'manual-review'; journal.errorCode = error.code ?? 'TRANSACTION_ROLLBACK_FAILED'; await this.save(journal); throw error; }
  }
  async commit(changes, { apply, write = null } = {}) {
    if (typeof apply !== 'function') throw new Error('Transaction apply callback is required');
    const journal = await this.begin(changes);
    try {
      for (let index = 0; index < changes.length; index++) { await this.mark(journal, index, 'committing'); await apply(changes[index], index); await this.mark(journal, index, 'committed'); }
      await this.complete(journal); return { state: 'committed', id: journal.id };
    } catch (error) {
      try { const rollback = await this.rollback(journal, { write }); throw Object.assign(new Error(`Transaction failed and was rolled back: ${error.message}`), { code: 'TRANSACTION_ROLLED_BACK', cause: error, transaction: rollback }); }
      catch (rollbackError) { if (rollbackError.code === 'TRANSACTION_ROLLED_BACK') throw rollbackError; throw Object.assign(new Error(`Transaction failed; manual recovery required: ${rollbackError.message}`), { code: 'TRANSACTION_MANUAL_REVIEW', cause: error }); }
    }
  }
  async recover() {
    let entries; try { entries = await readdir(this.directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const results = [];
    for (const entry of entries) if (entry.isDirectory()) { try { const journal = await this.load(entry.name); if (activeStates.has(journal.state)) results.push(await this.rollback(journal)); } catch (error) { results.push({ id: entry.name, state: 'manual-review', code: error.code ?? 'TRANSACTION_RECOVERY_FAILED' }); } }
    return results;
  }
}
