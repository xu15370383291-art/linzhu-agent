import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const INDEX_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 1024;

function isSafeStorageName(value) { return typeof value === 'string' && /^[0-9a-f-]{36}\.bin$/i.test(value); }
function storedAttachmentMetadata(attachment) {
  return {
    path: typeof attachment.path === 'string' ? attachment.path.slice(0, 255) : 'attachment',
    mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : 'application/octet-stream',
    sizeBytes: Number.isSafeInteger(attachment.sizeBytes) ? attachment.sizeBytes : null,
    pages: Number.isSafeInteger(attachment.pages) ? attachment.pages : null,
    partial: attachment.partial === true,
  };
}

export class AttachmentStore {
  constructor(root, { now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
    const dataRoot = path.join(path.resolve(root), '.agent-data', 'attachments');
    this.directory = dataRoot;
    this.indexFile = path.join(dataRoot, 'index.json');
    this.now = now;
    this.ttlMs = ttlMs;
    this.items = new Map();
    this.loaded = false;
    this.saveQueue = Promise.resolve();
  }

  async load() {
    if (this.loaded) return;
    let data = null;
    try { data = JSON.parse(await readFile(this.indexFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (data && data.version !== INDEX_VERSION) throw new Error('Unsupported attachment index version');
    for (const item of data?.items ?? []) {
      if (!item || typeof item.id !== 'string' || !isSafeStorageName(item.storageName) || typeof item.clientIdentity !== 'string') continue;
      this.items.set(item.id, item);
    }
    this.loaded = true;
    await this.prune();
  }

  async save() {
    await mkdir(this.directory, { recursive: true });
    const operation = this.saveQueue.then(async () => {
      const temp = `${this.indexFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ version: INDEX_VERSION, items: [...this.items.values()].slice(-MAX_ITEMS) }, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.indexFile);
      } finally {
        await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    });
    this.saveQueue = operation.catch(() => {});
    return operation;
  }

  async put({ id = randomUUID(), clientIdentity, bytes, attachment }) {
    await this.load();
    if (!Buffer.isBuffer(bytes) || typeof clientIdentity !== 'string' || !attachment) throw new Error('Invalid attachment record');
    await mkdir(this.directory, { recursive: true });
    const storageName = `${id}.bin`;
    const file = path.join(this.directory, storageName);
    const createdAt = this.now();
    const item = { id, clientIdentity, storageName, attachment: storedAttachmentMetadata(attachment), createdAt, expiresAt: createdAt + this.ttlMs };
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    this.items.set(id, item);
    const evicted = [];
    if (this.items.size > MAX_ITEMS) {
      const count = this.items.size - MAX_ITEMS;
      for (const [oldId, oldItem] of [...this.items.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt).slice(0, count)) {
        this.items.delete(oldId);
        evicted.push([oldId, oldItem]);
      }
    }
    try { await this.save(); }
    catch (error) {
      this.items.delete(id);
      for (const [oldId, oldItem] of evicted) this.items.set(oldId, oldItem);
      await rm(file, { force: true });
      throw error;
    }
    for (const [, oldItem] of evicted) await rm(path.join(this.directory, oldItem.storageName), { force: true });
    return item;
  }

  async get(id, clientIdentity) {
    await this.load();
    await this.prune();
    const item = this.items.get(id);
    if (!item || item.clientIdentity !== clientIdentity) throw Object.assign(new Error('Attachment not found or expired'), { code: 'ATTACHMENT_NOT_FOUND' });
    if (!isSafeStorageName(item.storageName)) throw Object.assign(new Error('Attachment not found or expired'), { code: 'ATTACHMENT_NOT_FOUND' });
    let bytes;
    try { bytes = await readFile(path.join(this.directory, item.storageName)); }
    catch (error) {
      if (error.code === 'ENOENT') {
        this.items.delete(id);
        await this.save();
        throw Object.assign(new Error('Attachment not found or expired'), { code: 'ATTACHMENT_NOT_FOUND' });
      }
      throw error;
    }
    return { ...item, bytes };
  }

  async prune() {
    const now = this.now();
    const expired = [];
    for (const [id, item] of this.items) {
      if (item.expiresAt > now) continue;
      this.items.delete(id);
      expired.push(item.storageName);
    }
    for (const storageName of expired) await rm(path.join(this.directory, storageName), { force: true });
    if (expired.length) await this.save();
    return expired.length;
  }
}

export const attachmentStoreLimits = Object.freeze({ ttlMs: DEFAULT_TTL_MS, maxItems: MAX_ITEMS });
