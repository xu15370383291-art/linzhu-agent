import { randomUUID } from 'node:crypto';

const MAX_OUTPUT = 64 * 1024;

export class ProcessManager {
  constructor({ runner = null, onEvent = async () => {} } = {}) { this.runner = runner; this.onEvent = onEvent; this.items = new Map(); }
  async start({ command, cwd, timeoutMs = 30_000, metadata = {} }, { signal } = {}) {
    if (!this.runner || typeof this.runner.start !== 'function') throw Object.assign(new Error('Controlled process runner unavailable'), { code: 'PROCESS_UNAVAILABLE' });
    if (typeof command !== 'string' || !command.trim() || command.length > 2000) throw new Error('Invalid process command');
    const id = randomUUID(); const item = { id, command, cwd, status: 'running', startedAt: Date.now(), output: '', metadata: structuredClone(metadata) };
    this.items.set(id, item); await this.onEvent({ type: 'process.started', id });
    item.handle = await this.runner.start({ command, cwd, timeoutMs, signal, onOutput: chunk => { item.output = `${item.output}${String(chunk)}`.slice(-MAX_OUTPUT); } });
    return this.public(item);
  }
  async poll(id) {
    const item = this.items.get(id); if (!item) throw new Error('Process not found');
    if (item.handle?.poll) { const result = await item.handle.poll(); if (result?.done) { item.status = result.code === 0 ? 'completed' : 'failed'; item.exitCode = result.code; item.finishedAt = Date.now(); } }
    return this.public(item);
  }
  async kill(id) {
    const item = this.items.get(id); if (!item) throw new Error('Process not found');
    if (item.handle?.kill) await item.handle.kill(); item.status = 'cancelled'; item.finishedAt = Date.now(); await this.onEvent({ type: 'process.cancelled', id }); return this.public(item);
  }
  list() { return [...this.items.values()].map(item => this.public(item)); }
  public(item) { const { handle, ...safe } = item; const output = typeof handle?.output === 'function' ? handle.output() : safe.output; return { ...safe, output: String(output ?? '').slice(-MAX_OUTPUT) }; }
}
