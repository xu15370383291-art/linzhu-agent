import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_MESSAGE = 256 * 1024;

export class McpStdioClient {
  constructor({ command, args = [], cwd, env = {}, timeoutMs = 30_000, spawnImpl = spawn } = {}) { this.command = command; this.args = args; this.cwd = cwd; this.env = env; this.timeoutMs = timeoutMs; this.spawnImpl = spawnImpl; this.child = null; this.buffer = ''; this.pending = new Map(); }
  async start() {
    if (!/^[\w./\\:-]+$/.test(this.command ?? '') || this.args.some(arg => typeof arg !== 'string' || arg.length > 256)) throw new Error('Invalid MCP stdio command');
    this.child = this.spawnImpl(this.command, this.args, { cwd: this.cwd, env: { ...process.env, ...this.env }, windowsHide: true });
    this.child.stdout.setEncoding?.('utf8'); this.child.stdout.on('data', chunk => this.onData(String(chunk))); this.child.once('exit', code => { for (const pending of this.pending.values()) pending.reject(Object.assign(new Error('MCP server exited'), { code: 'MCP_EXITED', exitCode: code })); this.pending.clear(); });
    return this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'personal-agent', version: '0.1.0' } });
  }
  onData(chunk) { this.buffer += chunk; if (this.buffer.length > MAX_MESSAGE) return this.close(); let index; while ((index = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0, index).trim(); this.buffer = this.buffer.slice(index + 1); if (!line) continue; let message; try { message = JSON.parse(line); } catch { this.close(); return; } const pending = this.pending.get(message.id); if (pending) { this.pending.delete(message.id); clearTimeout(pending.timer); if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'MCP error'), { code: 'MCP_ERROR', data: message.error })); else pending.resolve(message.result); } } }
  request(method, params = {}) { if (!this.child?.stdin) return Promise.reject(Object.assign(new Error('MCP server is not started'), { code: 'MCP_NOT_STARTED' })); const id = randomUUID(); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('MCP request timed out'), { code: 'MCP_TIMEOUT' })); }, this.timeoutMs); this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); }); }
  async listTools() { const result = await this.request('tools/list'); return Array.isArray(result?.tools) ? result.tools : []; }
  async callTool(name, arguments_ = {}) { return this.request('tools/call', { name, arguments: arguments_ }); }
  close() { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error('MCP client closed'), { code: 'MCP_CLOSED' })); } this.pending.clear(); this.child?.kill?.(); this.child = null; }
}
