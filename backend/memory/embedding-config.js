import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateEmbeddingSettings } from './embedding-provider.js';

export class EmbeddingConfigStore {
  constructor(root) { this.file = path.join(path.resolve(root), '.agent-data', 'memory-embedding.json'); }
  async get() {
    try { const data = JSON.parse(await readFile(this.file, 'utf8')); return { configured: true, ...validateEmbeddingSettings(data) }; }
    catch (error) { if (error.code === 'ENOENT') return { configured: false, provider: null, model: null }; throw error; }
  }
  async set(input) {
    const config = validateEmbeddingSettings(input);
    const saved = { provider: config.provider, model: config.model, baseUrl: config.baseUrl, dimensions: config.dimensions };
    await mkdir(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(saved, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file); }
    finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { configured: true, ...config };
  }
  async clear() { await unlink(this.file).catch(error => { if (error.code !== 'ENOENT') throw error; }); return { configured: false, provider: null, model: null }; }
}
