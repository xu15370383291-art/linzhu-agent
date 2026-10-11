import { createHash } from 'node:crypto';

const types = new Set(['tool', 'provider', 'skill', 'hook', 'channel', 'task']);
const risk = new Set(['read', 'network', 'write', 'execute', 'message', 'admin']);
const MAX_SCHEMA = 32 * 1024;
const MAX_RESULT = 128 * 1024;

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function bounded(value) {
  const text = JSON.stringify(value);
  if (text.length > MAX_RESULT) throw Object.assign(new Error('Plugin result exceeds output limit'), { code: 'PLUGIN_OUTPUT_LIMIT' });
  return structuredClone(value);
}

export class PluginRuntimeRegistry {
  constructor({ operationBroker, policy = null, audit = null } = {}) { this.operationBroker = operationBroker; this.policy = policy; this.audit = audit; this.items = new Map(); }
  validate(plugin, declaration) {
    if (!plugin?.id || !plugin.enabled || !plugin.hash) throw Object.assign(new Error('Plugin must be enabled and hash-verified'), { code: 'PLUGIN_REGISTRATION_DENIED' });
    if (!declaration || !types.has(declaration.type) || typeof declaration.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(declaration.id)) throw Object.assign(new Error('Invalid plugin registration declaration'), { code: 'PLUGIN_REGISTRATION_INVALID' });
    if (declaration.risk && !risk.has(declaration.risk)) throw Object.assign(new Error('Invalid plugin registration risk'), { code: 'PLUGIN_REGISTRATION_INVALID' });
    if (declaration.schema !== undefined && JSON.stringify(declaration.schema).length > MAX_SCHEMA) throw Object.assign(new Error('Plugin schema is too large'), { code: 'PLUGIN_REGISTRATION_LIMIT' });
    if (typeof declaration.invoke !== 'function') throw Object.assign(new Error('Plugin registration requires a host adapter'), { code: 'PLUGIN_REGISTRATION_DENIED' });
    return { pluginId: plugin.id, pluginHash: plugin.hash, type: declaration.type, id: declaration.id, risk: declaration.risk ?? 'read', schema: structuredClone(declaration.schema ?? { type: 'object' }), permissions: structuredClone(declaration.permissions ?? []) };
  }
  register(plugin, declaration, { approve = false } = {}) {
    const item = this.validate(plugin, declaration);
    if (!approve) throw Object.assign(new Error('Explicit plugin registration approval is required'), { code: 'PLUGIN_REGISTRATION_DENIED' });
    const key = `${item.type}:${item.id}`;
    if (this.items.has(key)) throw Object.assign(new Error('Plugin registration ID is already in use'), { code: 'PLUGIN_REGISTRATION_CONFLICT' });
    this.items.set(key, { ...item, invoke: declaration.invoke });
    return this.public(this.items.get(key));
  }
  unregister(pluginId, pluginHash = null) { for (const [key, item] of this.items) if (item.pluginId === pluginId && (pluginHash === null || item.pluginHash === pluginHash)) this.items.delete(key); }
  reconcile(plugins) {
    const current = new Map(plugins.map(item => [item.id, item.hash]));
    for (const [key, item] of this.items) if (current.get(item.pluginId) !== item.pluginHash || !plugins.some(plugin => plugin.id === item.pluginId && plugin.enabled)) this.items.delete(key);
  }
  list() { return [...this.items.values()].map(item => this.public(item)); }
  public(item) { const { invoke, ...safe } = item; return structuredClone(safe); }
  async dynamicToolDefinitions() {
    return this.list().filter(item => item.type === 'tool').map(item => ({
      pluginId: item.pluginId,
      pluginHash: item.pluginHash,
      registrationId: item.id,
      risk: item.risk,
      name: `plugin__${item.pluginId}__${item.id}`,
      definition: { type: 'function', function: { name: `plugin__${item.pluginId}__${item.id}`, description: `已批准的插件工具：${item.id}`, parameters: item.schema?.type === 'object' ? item.schema : { type: 'object', properties: {}, additionalProperties: false } } },
    }));
  }
  async invokeTool(name, request, { authorize = async () => true } = {}) {
    const match = /^plugin__([a-z0-9][a-z0-9._-]{0,63})__([a-z0-9][a-z0-9._-]{0,63})$/.exec(name);
    if (!match) throw Object.assign(new Error('Unknown plugin tool'), { code: 'PLUGIN_TOOL_UNAVAILABLE' });
    return this.invoke(match[1], 'tool', match[2], request, { authorize });
  }
  async invoke(plugin, type, id, request, { authorize = async () => true } = {}) {
    const item = this.items.get(`${type}:${id}`);
    if (!item || item.pluginId !== plugin.id || item.pluginHash !== plugin.hash) throw Object.assign(new Error('Plugin registration is stale or unavailable'), { code: 'PLUGIN_REGISTRATION_STALE' });
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw Object.assign(new Error('Plugin request must be structured data'), { code: 'PLUGIN_REQUEST_DENIED' });
    if (!await authorize(item, request)) throw Object.assign(new Error('Plugin registration request denied'), { code: 'USER_DENIED' });
    const resource = { pluginId: plugin.id, pluginHash: plugin.hash, type, id, request: structuredClone(request) };
    const capability = this.operationBroker.issue({ tool: `plugin:${plugin.id}:${type}:${id}`, operation: 'invoke', resource });
    this.operationBroker.consume({ token: capability.id, tool: `plugin:${plugin.id}:${type}:${id}`, operation: 'invoke', resource });
    const result = await item.invoke(structuredClone(request), { permissions: item.permissions, risk: item.risk });
    return bounded(result);
  }
}

export function pluginRegistrationHash(declaration) { return hash({ type: declaration.type, id: declaration.id, risk: declaration.risk ?? 'read', schema: declaration.schema ?? {}, permissions: declaration.permissions ?? [] }); }
