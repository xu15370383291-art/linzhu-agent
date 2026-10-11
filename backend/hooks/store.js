import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const allowedEvents = new Set(['before', 'after', 'on-error']);
const allowedActions = new Set(['deny', 'truncate_result']);
const matches = (tool, pattern) => pattern === '*' || pattern === tool || pattern.endsWith('*') && tool.startsWith(pattern.slice(0, -1));

export class HookStore {
  constructor(root) { this.file = path.join(root, '.agent-data', 'hooks.json'); }
  async load() {
    try { const data = JSON.parse(await readFile(this.file, 'utf8')); if (!Array.isArray(data.hooks)) throw new Error('Invalid hooks configuration'); return data; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, hooks: [] }; throw error; }
  }
  async save(data) {
    const valid = data.hooks.filter(hook => hook && typeof hook.id === 'string' && allowedEvents.has(hook.event) && allowedActions.has(hook.action) && typeof hook.tool === 'string');
    if (valid.length !== data.hooks.length || valid.length > 32) throw new Error('Invalid hooks configuration');
    await mkdir(path.dirname(this.file), { recursive: true }); const temp = path.join(path.dirname(this.file), `${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify({ version: 1, hooks: valid }, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file);
  }
  async list() { return (await this.load()).hooks; }
  async validate() { const data = await this.load(); return { valid: Array.isArray(data.hooks) && data.hooks.length <= 32, count: data.hooks.length, version: data.version ?? 1 }; }
  async reload() { return this.load(); }
  async evaluate(event, payload) {
    const hooks = (await this.list()).filter(hook => hook.enabled !== false && hook.event === event && matches(payload.tool, hook.tool)).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    let result = { allow: true, payload };
    for (const hook of hooks) {
      if (hook.action === 'deny') return { allow: false, code: 'HOOK_DENIED', message: hook.message || `Hook ${hook.id} denied ${payload.tool}` };
      if (hook.action === 'truncate_result' && typeof result.payload.result === 'string') result.payload = { ...result.payload, result: result.payload.result.slice(0, Math.max(1, Math.min(12000, hook.maxChars ?? 2000))) };
    }
    return result;
  }
}
