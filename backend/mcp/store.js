import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpStdioClient } from './stdio.js';
import { CapabilityBroker } from '../security/capability.js';
import { OperationBroker } from '../security/broker.js';

export class McpStore {
  constructor(root, { secrets = null, clientFactory = options => new McpStdioClient(options), operationBroker = null } = {}) {
    this.file = path.join(path.resolve(root), '.agent-data', 'mcp.json'); this.secrets = secrets; this.clientFactory = clientFactory; this.data = null; this.clients = new Map(); this.capabilities = operationBroker?.capabilities ?? new CapabilityBroker(); this.operationBroker = operationBroker ?? new OperationBroker({ capabilities: this.capabilities });
  }
  async load() { if (this.data) return this.data; try { this.data = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { version: 1, servers: {} }; } return this.data; }
  async save() { const data = await this.load(); await mkdir(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file); }
  async addStdio({ id, command, args = [], cwd, env = {}, secretRefs = [], enabled = false, allowedTools = [], approveEachCall = true }) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error('Invalid MCP server ID');
    if (typeof command !== 'string' || !command.trim() || command.length > 256) throw new Error('Invalid MCP command');
    if (!Array.isArray(secretRefs) || secretRefs.some(ref => typeof ref !== 'string' || !ref.startsWith('secret://'))) throw new Error('Invalid MCP Secret reference');
    const data = await this.load(); data.servers[id] = { id, transport: 'stdio', command, args, cwd, env, secretRefs, enabled: enabled === true, allowedTools, approveEachCall: approveEachCall !== false, updatedAt: Date.now() }; await this.save(); return this.public(data.servers[id]);
  }
  async list() { return Object.values((await this.load()).servers).map(item => this.public(item)); }
  public(item) { return { ...item, env: undefined, ...(item.env && Object.keys(item.env).length ? { hasEnvironment: true } : {}), secretRefs: item.secretRefs?.map(() => 'secret://[configured]') ?? [] }; }
  async inspect(id) { const item = (await this.load()).servers[id]; if (!item) throw new Error('MCP server not found'); return { ...this.public(item), tools: this.clients.get(id)?.tools ?? [] }; }
  async setEnabled(id, enabled) { const data = await this.load(); const item = data.servers[id]; if (!item) throw new Error('MCP server not found'); item.enabled = enabled === true; if (!item.enabled) this.clients.get(id)?.client.close(); await this.save(); return this.public(item); }
  async connect(id) { const item = (await this.load()).servers[id]; if (!item || !item.enabled) throw new Error('MCP server is disabled'); const client = this.clientFactory({ command: item.command, args: item.args, cwd: item.cwd, env: item.env }); await client.start(); const tools = await client.listTools(); this.clients.set(id, { client, tools }); return { id, tools }; }
  async tools(id) { return (await this.inspect(id)).tools; }
  async call(id, name, args, { approve = async () => false } = {}) { const item = (await this.load()).servers[id]; if (!item?.enabled) throw new Error('MCP server is disabled'); const state = this.clients.get(id) ?? await this.connect(id); if (!state.tools.some(tool => tool.name === name)) throw Object.assign(new Error('MCP tool is not allowed'), { code: 'MCP_TOOL_NOT_ALLOWED' }); if (item.approveEachCall && !await approve({ server: id, tool: name })) throw Object.assign(new Error('MCP tool call denied'), { code: 'USER_DENIED' }); const capability = this.capabilities.issue({ tool: 'mcp_call_tool', operation: 'call', resource: { server: id, name, args } }); this.operationBroker.consume({ token: capability.id, tool: 'mcp_call_tool', operation: 'call', resource: { server: id, name, args } }); return state.client.callTool(name, args); }
  close() { for (const { client } of this.clients.values()) client.close(); this.clients.clear(); }
}
