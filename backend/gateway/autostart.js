import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const defaults = { enabled: false, host: '127.0.0.1', port: 0, maxRestarts: 3, restartDelayMs: 2_000 };

export class GatewayAutostart {
  constructor(root) { this.file = path.join(path.resolve(root), '.agent-data', 'gateway-autostart.json'); }
  async get() {
    try { return { ...defaults, ...JSON.parse(await readFile(this.file, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { ...defaults }; }
  }
  async set(input = {}) {
    const value = { ...defaults, ...(await this.get()), enabled: input.enabled === true, host: input.host ?? '127.0.0.1', port: input.port ?? 0, maxRestarts: input.maxRestarts ?? 3, restartDelayMs: input.restartDelayMs ?? 2_000 };
    if (value.host !== '127.0.0.1' && value.host !== '::1') throw Object.assign(new Error('Autostart host must be local'), { code: 'AUTOSTART_HOST_DENIED' });
    if (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535) throw new Error('Invalid autostart port');
    if (!Number.isInteger(value.maxRestarts) || value.maxRestarts < 0 || value.maxRestarts > 10) throw new Error('Invalid autostart restart limit');
    if (!Number.isInteger(value.restartDelayMs) || value.restartDelayMs < 100 || value.restartDelayMs > 60_000) throw new Error('Invalid autostart restart delay');
    await mkdir(path.dirname(this.file), { recursive: true }); await writeFile(this.file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 }); return value;
  }
}
