import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { previewDiff } from './tools/diff.js';
import { atomicWrite } from './sandbox/atomic-write.js';

const hidden = name => name === '.agent-data' || name === '.git' || name === '.env' || name.startsWith('.env.');
const skipped = name => hidden(name) || name === 'node_modules';
const hash = content => createHash('sha256').update(content).digest('hex');
const PAGE_LIFETIME = 10 * 60_000;
const PAGE_LIMIT = 100;
function denied(message) { return Object.assign(new Error(message), { code: 'WORKSPACE_ACCESS_DENIED' }); }

export class Workspace {
  #changes = new Map();
  constructor(root, { commitBroker, changePlans = null } = {}) {
    this.root = path.resolve(root);
    this.pages = new Map();
    this.commitBroker = commitBroker;
    this.changePlans = changePlans;
  }

  async resolve(relativePath, { forWrite = false } = {}) {
    if (typeof relativePath !== 'string' || !relativePath.trim()) {
      throw new Error('Path must be a non-empty string');
    }
    if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
      throw denied('Absolute paths are not allowed');
    }
    const segments = relativePath.split(/[\\/]/);
    if (segments.some((segment) => segment === '..' || hidden(segment))) {
      throw denied('Path escapes or accesses private agent data');
    }
    const target = path.resolve(this.root, relativePath);
    if (!this.contains(target) || target === this.root) {
      throw denied('Path must stay inside the workspace');
    }

    // Check every existing component so a symlink cannot redirect a read or write.
    let current = this.root;
    for (const segment of path.relative(this.root, target).split(path.sep)) {
      current = path.join(current, segment);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw denied('Symlinks are not allowed');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!forWrite) throw error;
      }
    }
    return target;
  }

  contains(target) {
    const relative = path.relative(this.root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  async read(relativePath) {
    const target = await this.resolve(relativePath);
    const contents = await readFile(target, 'utf8');
    if (contents.length > 40_000) throw new Error('File exceeds 40,000 characters');
    return contents;
  }

  async readTextAttachment(relativePath, { maxBytes = 512 * 1024, maxChars = 80_000 } = {}) {
    const target = await this.resolve(relativePath);
    const stat = await lstat(target);
    if (!stat.isFile()) throw Object.assign(new Error('Attachment must be a regular file'), { code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    if (stat.size > maxBytes) throw Object.assign(new Error(`Text attachment exceeds ${maxBytes} bytes`), { code: 'ATTACHMENT_TOO_LARGE' });
    const extension = path.extname(target).toLowerCase();
    if (!['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cs', '.go', '.rs', '.sql', '.toml', '.ini'].includes(extension))
      throw Object.assign(new Error('Only UTF-8 text, Markdown, JSON, CSV and source files can be attached'), { code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    const bytes = await readFile(target);
    if (bytes.length > maxBytes) throw Object.assign(new Error(`Text attachment exceeds ${maxBytes} bytes`), { code: 'ATTACHMENT_TOO_LARGE' });
    if (bytes.includes(0)) throw Object.assign(new Error('Binary data cannot be attached as text'), { code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw Object.assign(new Error('Text attachment must be valid UTF-8'), { code: 'ATTACHMENT_ENCODING_INVALID' }); }
    if (content.length > maxChars) throw Object.assign(new Error(`Text attachment exceeds ${maxChars} characters`), { code: 'ATTACHMENT_TOO_LARGE' });
    return { path: relativePath, sizeBytes: bytes.length, content };
  }

  async readLines(relativePath, startLine = 1, lineCount = 100) {
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 200) throw new Error('Invalid line range');
    const target = await this.resolve(relativePath);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('File is not a regular text file under 2 MB');
    const bytes = await readFile(target);
    if (bytes.length > 2_000_000) throw new Error('File exceeds 2 MB');
    if (bytes.includes(0)) throw new Error('Binary file cannot be read as lines');
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/);
    const totalLines = lines.length;
    const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
    const text = selected.join('\n');
    if (text.length > 40_000) throw new Error('Selected lines exceed 40,000 characters; request fewer lines');
    return { path: relativePath, startLine, totalLines, lines: selected.map((content, index) => ({ line: startLine + index, text: content })), hasMore: startLine - 1 + selected.length < totalLines };
  }

  async info(relativePath) {
    const target = relativePath === '.' ? this.root : await this.resolve(relativePath);
    const stat = await lstat(target);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error('Path is not a regular file or directory');
    let totalLines = null;
    if (stat.isFile() && stat.size <= 2_000_000) {
      const bytes = await readFile(target);
      if (bytes.length <= 2_000_000 && !bytes.includes(0)) {
        try { totalLines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/).length; }
        catch { /* Non-UTF-8 files have no text line count. */ }
      }
    }
    return { path: relativePath, type: stat.isDirectory() ? 'directory' : 'file', sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(), totalLines };
  }

  takePage(cursor, kind, signature) {
    const now = Date.now();
    for (const [key, value] of this.pages) if (value.expires < now) this.pages.delete(key);
    const page = this.pages.get(cursor);
    if (!page || page.kind !== kind || page.signature !== signature) throw new Error('Invalid or expired cursor; start again');
    this.pages.delete(cursor);
    return page;
  }

  savePage(page) {
    while (this.pages.size >= 32) this.pages.delete(this.pages.keys().next().value);
    const cursor = randomUUID();
    this.pages.set(cursor, { ...page, expires: Date.now() + PAGE_LIFETIME });
    return cursor;
  }

  async write(relativePath, content) {
    if (typeof content !== 'string' || content.length > 40_000) {
      throw new Error('Content must be a string of at most 40,000 characters');
    }
    const target = await this.resolve(relativePath, { forWrite: true });
    await mkdir(path.dirname(target), { recursive: true });
    // Recheck after mkdir; the workspace is assumed not to be concurrently modified by an adversary.
    await this.resolve(relativePath, { forWrite: true });
    await writeFile(target, content, { encoding: 'utf8', flag: 'w' });
    return `Wrote ${relativePath}`;
  }

  async prepareChange(relativePath, { content, oldText, displayPath } = {}) {
    const target = await this.resolve(relativePath, { forWrite: true });
    let before = null;
    let metadata = null;
    try {
      const stat = await lstat(target);
      if (!stat.isFile()) throw new Error('Target is not a regular file');
      if (stat.nlink !== 1) throw denied('Hard-linked files cannot be edited');
      if (stat.size > 100_000) throw new Error('Target exceeds 100,000 bytes');
      const bytes = await readFile(target);
      if (bytes.includes(0)) throw new Error('Binary files cannot be edited');
      before = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      metadata = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, hash: hash(bytes), mode: stat.mode };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (oldText !== undefined) throw new Error('File to edit does not exist');
    }
    let after = content;
    if (oldText !== undefined) {
      if (typeof oldText !== 'string' || !oldText.length || typeof content !== 'string') throw new Error('Edit requires non-empty oldText and string newText');
      const first = before.indexOf(oldText);
      if (first < 0 || before.indexOf(oldText, first + oldText.length) >= 0) throw new Error('oldText must match exactly once');
      after = before.slice(0, first) + content + before.slice(first + oldText.length);
    }
    if (typeof after !== 'string' || after.length > 40_000 || Buffer.byteLength(after) > 100_000) throw new Error('Content exceeds size limit');
    if (before === after) return { unchanged: true, path: relativePath };
    const change = { path: relativePath, target, before, after, metadata, diff: previewDiff(before ?? '', after),
      ...(displayPath ? { displayPath } : {}) };
    const ticket = randomUUID();
    const now = Date.now();
    for (const [id, pending] of this.#changes) if (pending.expires < now) this.#changes.delete(id);
    while (this.#changes.size >= 32) this.#changes.delete(this.#changes.keys().next().value);
    this.#changes.set(ticket, { change: structuredClone(change), expires: now + 5 * 60_000 });
    return { ...change, ticket };
  }

  async commitChange(change) {
    if (change.unchanged) return `No changes to ${change.path}`;
    const pending = this.#changes.get(change.ticket);
    this.#changes.delete(change.ticket);
    if (!pending || pending.expires < Date.now()) throw denied('Write preview expired or already consumed; preview again');
    const expected = { ...pending.change, ticket: change.ticket };
    if (JSON.stringify(expected) !== JSON.stringify(change)) throw denied('Write preview changed since approval');
    const { target, metadata, after, path: relativePath, displayPath } = pending.change;
    try {
      if (this.commitBroker) {
        await this.commitBroker(pending.change);
        return `Wrote ${displayPath ?? relativePath}`;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await this.resolve(relativePath, { forWrite: true });
      await atomicWrite(target, after, { existing: !!metadata, mode: metadata?.mode, validate: async () => {
        await this.resolve(relativePath, { forWrite: true });
        if (!metadata) return;
        const handle = await open(target, 'r');
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== metadata.dev || stat.ino !== metadata.ino ||
              stat.mtimeMs !== metadata.mtimeMs || stat.size !== metadata.size || hash(await handle.readFile()) !== metadata.hash)
            throw Object.assign(new Error('File changed since preview; write cancelled'), { code: 'FILE_CHANGED_SINCE_PREVIEW' });
        } finally { await handle.close(); }
      } });
    } catch (error) {
      if (error?.code === 'FILE_CHANGED_SINCE_PREVIEW' || /File changed since preview/.test(error?.message ?? ''))
        throw Object.assign(new Error('File changed since preview; write cancelled'), { code: 'FILE_CHANGED_SINCE_PREVIEW' });
      throw error;
    }
    return `Wrote ${displayPath ?? relativePath}`;
  }

  async directory(relativePath = '.') {
    if (relativePath === '.') return this.root;
    const target = await this.resolve(relativePath);
    if (!(await lstat(target)).isDirectory()) throw new Error('Path is not a directory');
    return target;
  }

  async list(relativePath = '.', { limit, cursor } = {}) {
    const dir = await this.directory(relativePath);
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    limit ??= PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new Error('Invalid page limit');
    const stamp = hash(entries.map(entry => `${entry.name}:${entry.isDirectory()}:${entry.isSymbolicLink()}`).join('\n'));
    const page = cursor ? this.takePage(cursor, 'list', relativePath) : { offset: 0, stamp };
    if (page.stamp !== stamp) throw new Error('Directory changed since previous page; start again');
    const result = [];
    let offset = page.offset;
    for (; offset < entries.length; offset++) {
      const entry = entries[offset];
      if (skipped(entry.name) || (await lstat(path.join(dir, entry.name))).isSymbolicLink()) continue;
      result.push({ path: path.relative(this.root, path.join(dir, entry.name)).split(path.sep).join('/'), type: entry.isDirectory() ? 'directory' : 'file' });
      if (result.length >= limit) { offset++; break; }
    }
    while (offset < entries.length && (skipped(entries[offset].name) || (await lstat(path.join(dir, entries[offset].name))).isSymbolicLink())) offset++;
    return { items: result, nextCursor: offset < entries.length ? this.savePage({ kind: 'list', signature: relativePath, offset, stamp }) : null };
  }

  async *walk(relativePath, kind, query) {
    const start = await this.directory(relativePath);
    const pending = [start];
    while (pending.length) {
      const dir = pending.shift();
      const entries = await readdir(dir, { withFileTypes: true });
      if (entries.length > 20_000) throw new Error('Directory has too many entries');
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (skipped(entry.name)) continue;
        const target = path.join(dir, entry.name);
        if ((await lstat(target)).isSymbolicLink()) continue;
        yield { scanned: true };
        if (entry.isDirectory()) pending.push(target);
        if (kind === 'find' && entry.name.toLowerCase().includes(query.toLowerCase()))
          yield { item: { path: path.relative(this.root, target).split(path.sep).join('/'), type: entry.isDirectory() ? 'directory' : 'file' } };
        if (kind === 'search' && entry.isFile()) {
          const stat = await lstat(target);
          if (stat.size > 100_000) continue;
          const bytes = await readFile(target);
          if (bytes.includes(0)) continue;
          let text;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { continue; }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(query.toLowerCase()))
            yield { item: { path: path.relative(this.root, target).split(path.sep).join('/'), line: i + 1, text: lines[i].slice(0, 300) } };
        }
      }
    }
  }

  async scanPage(kind, query, relativePath = '.', { limit = 50, cursor } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Query must be 1-200 characters');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid page limit');
    const signature = JSON.stringify([query, relativePath]);
    const page = cursor ? this.takePage(cursor, kind, signature) : { iterator: this.walk(relativePath, kind, query) };
    const items = [];
    let scanned = 0;
    let done = false;
    try {
      while (items.length < limit && scanned < 2000) {
        const next = page.pending ?? await page.iterator.next();
        page.pending = null;
        if (next.done) { done = true; break; }
        if (next.value.scanned) scanned++;
        if (next.value.item) items.push(next.value.item);
      }
    } catch (error) { await page.iterator.return(); throw error; }
    if (!done && items.length >= limit) {
      while (true) {
        const next = await page.iterator.next();
        if (next.done) { done = true; break; }
        if (next.value.item || scanned >= 2000) { page.pending = next; break; }
        if (next.value.scanned) scanned++;
      }
    }
    const nextCursor = done ? null : this.savePage({ kind, signature, iterator: page.iterator, pending: page.pending });
    return { [kind === 'find' ? 'items' : 'matches']: items, nextCursor, truncated: nextCursor !== null };
  }

  async find(query, relativePath = '.', options = {}) { return this.scanPage('find', query, relativePath, options); }

  async search(query, relativePath = '.') {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('Query must be 1-200 characters');
    const start = await this.directory(relativePath);
    const pending = [start];
    const matches = [];
    let visited = 0;
    let scanned = 0;
    while (pending.length && visited < 500 && scanned < 2000 && matches.length < 50) {
      const dir = pending.shift();
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (++scanned > 2000) break;
        if (skipped(entry.name)) continue;
        const target = path.join(dir, entry.name);
        if ((await lstat(target)).isSymbolicLink()) continue;
        if (entry.isDirectory()) { pending.push(target); continue; }
        if (!entry.isFile() || ++visited > 500) break;
        const stat = await lstat(target);
        if (stat.size > 100_000) continue;
        const text = await readFile(target, 'utf8');
        if (text.includes('\0')) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < 50; i++) {
          if (lines[i].toLowerCase().includes(query.toLowerCase())) matches.push({ path: path.relative(this.root, target).split(path.sep).join('/'), line: i + 1, text: lines[i].slice(0, 300) });
        }
        if (matches.length >= 50) break;
      }
    }
    return { matches, truncated: pending.length > 0 || visited >= 500 || scanned >= 2000 || matches.length >= 50 };
  }
}
