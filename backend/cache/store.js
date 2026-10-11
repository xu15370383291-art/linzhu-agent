import { createHash } from 'node:crypto';
import path from 'node:path';
import { openSqlite } from '../../database/sqlite.js';

const VERSION = 1;
const MAX_BYTES = 100 * 1024 * 1024;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function cacheKey({ endpoint, model, messages, tools, toolChoice, maxTokens, schemaVersion = VERSION }) {
  const body = JSON.stringify(stable({ endpoint, model, messages, tools, toolChoice, maxTokens, schemaVersion }));
  return createHash('sha256').update(body).digest('hex');
}

export function cacheEligible({ messages, tools, toolChoice, stream, realtime = false, cache = true } = {}) {
  return cache && !stream && !realtime && (!tools || tools.length === 0) && (toolChoice === undefined || toolChoice === 'none');
}

export class QueryCache {
  constructor(root, { ttlMs = 5 * 60_000, maxBytes = MAX_BYTES } = {}) {
    this.file = path.join(root, '.agent-data', 'cache.sqlite');
    this.ttlMs = ttlMs; this.maxBytes = maxBytes; this.dbPromise = null; this.enabled = true; this.hits = 0; this.misses = 0;
  }
  async db() {
    if (!this.dbPromise) this.dbPromise = openSqlite(this.file).then(db => {
      db.exec('CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, response TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS cache_expiry ON cache(expires_at);');
      return db;
    }).catch(error => { this.dbPromise = null; throw error; });
    return this.dbPromise;
  }
  async get(key) {
    if (!this.enabled) { this.misses++; return null; }
    const db = await this.db(); const now = Date.now();
    db.prepare('DELETE FROM cache WHERE expires_at <= ?').run(now);
    const row = db.prepare('SELECT response FROM cache WHERE key = ? AND expires_at > ?').get(key, now);
    if (!row) { this.misses++; return null; }
    this.hits++;
    db.prepare('UPDATE cache SET last_used_at = ? WHERE key = ?').run(now, key);
    try { return { ...JSON.parse(row.response), cached: true }; } catch { db.prepare('DELETE FROM cache WHERE key = ?').run(key); return null; }
  }
  async set(key, response) {
    if (!this.enabled) return false;
    const db = await this.db(); const now = Date.now(); const text = JSON.stringify(response); const bytes = Buffer.byteLength(text);
    if (bytes > this.maxBytes) return false;
    db.prepare('INSERT OR REPLACE INTO cache(key,response,bytes,created_at,expires_at,last_used_at) VALUES(?,?,?,?,?,?)').run(key, text, bytes, now, now + this.ttlMs, now);
    const total = db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM cache').get().bytes;
    if (total > this.maxBytes) {
      const rows = db.prepare('SELECT key FROM cache ORDER BY last_used_at ASC').all();
      let remaining = total;
      for (const row of rows) { if (remaining <= this.maxBytes) break; const size = db.prepare('SELECT bytes FROM cache WHERE key = ?').get(row.key)?.bytes ?? 0; db.prepare('DELETE FROM cache WHERE key = ?').run(row.key); remaining -= size; }
    }
    return true;
  }
  async clear() { const db = await this.db(); db.exec('DELETE FROM cache'); }
  async status() { const db = await this.db(); return { ...db.prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(bytes),0) AS bytes FROM cache WHERE expires_at > ?').get(Date.now()), enabled: this.enabled, hits: this.hits, misses: this.misses }; }
  enable() { this.enabled = true; }
  disable() { this.enabled = false; }
}
