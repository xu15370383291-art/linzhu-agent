import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SECURITY_MODES } from './mode.js';

export class SecurityModeStore {
  constructor(root) { this.file = path.join(path.resolve(root), '.agent-data', 'security-mode.json'); }
  async getRequested() {
    try { const value = JSON.parse(await readFile(this.file, 'utf8')).mode; return SECURITY_MODES.has(value) ? value : 'safe'; }
    catch (error) { if (error.code === 'ENOENT') return 'safe'; return 'safe'; }
  }
  async setRequested(mode) {
    if (!SECURITY_MODES.has(mode)) throw Object.assign(new Error('Invalid security mode'), { code: 'SECURITY_MODE_INVALID' });
    await mkdir(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, mode, updatedAt: Date.now() }, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file);
    return mode;
  }
}
