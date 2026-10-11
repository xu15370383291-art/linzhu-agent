import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PluginStore } from '../backend/plugins/store.js';
import { runTurn } from '../backend/agent.js';
import { Workspace } from '../backend/workspace.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';

test('enabled plugins expose a declaration-only registration without executing code', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-registration-')); const dir = path.join(root, 'plugins', 'demo'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.js'), 'throw new Error("must not execute");');
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', entry: 'index.js', capabilities: ['tool'] }));
  const store = new PluginStore(root);
  await store.enable('demo', { approve: async () => true });
  const registrations = await store.registrations();
  assert.equal(registrations[0].id, 'demo'); assert.equal(registrations[0].execution, 'disabled-until-explicit-runtime-registration');
});

test('plugin runtime adapter requires explicit approval and current plugin hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-adapter-')); const dir = path.join(root, 'plugins', 'demo'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.js'), 'export default {};'); await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', entry: 'index.js', capabilities: ['tool'] }));
  const store = new PluginStore(root); const enabled = await store.enable('demo', { approve: async () => true });
  assert.throws(() => store.registerRuntimeAdapter('demo', { invoke: async () => 'x' }, { hash: enabled.hash }), { code: 'PLUGIN_ADAPTER_DENIED' });
  store.registerRuntimeAdapter('demo', { invoke: async request => ({ ok: true, request }) }, { hash: enabled.hash, approve: true });
  assert.deepEqual(await store.invoke('demo', { action: 'probe' }), { ok: true, request: { action: 'probe' } });
  await writeFile(path.join(dir, 'index.js'), 'export default { changed: true };');
  await assert.rejects(store.invoke('demo', { action: 'probe' }), { code: 'PLUGIN_ADAPTER_UNAVAILABLE' });
});

test('plugin runtime invocation is bound to the shared OperationBroker capability', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-broker-')); const dir = path.join(root, 'plugins', 'demo'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.js'), 'export default {};'); await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', entry: 'index.js', capabilities: ['tool'] }));
  const store = new PluginStore(root); const item = await store.enable('demo', { approve: async () => true }); let calls = 0;
  store.registerRuntimeAdapter('demo', { invoke: async () => { calls++; return 'ok'; } }, { hash: item.hash, approve: true });
  assert.equal(await store.invoke('demo', { action: 'read' }), 'ok'); assert.equal(calls, 1);
  await assert.rejects(store.invoke('demo', 'not-structured'), { code: 'PLUGIN_REQUEST_DENIED' });
});

test('dynamic plugin registrations require explicit approval, stay hash-bound and redact adapters', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-dynamic-')); const dir = path.join(root, 'plugins', 'demo'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.js'), 'throw new Error("must not execute");'); await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', entry: 'index.js', capabilities: ['tool'] }));
  const store = new PluginStore(root); const item = await store.enable('demo', { approve: async () => true }); let calls = 0;
  const declaration = { type: 'tool', id: 'lookup', risk: 'read', schema: { type: 'object' }, permissions: ['workspace.read'], invoke: async request => { calls++; return { echoed: request }; } };
  await assert.rejects(store.register('demo', declaration), { code: 'PLUGIN_REGISTRATION_DENIED' });
  const registered = await store.register('demo', declaration, { approve: true }); assert.equal(registered.id, 'lookup'); assert.equal('invoke' in registered, false);
  assert.deepEqual(await store.invokeRegistration('demo', 'tool', 'lookup', { q: 'x' }), { echoed: { q: 'x' } }); assert.equal(calls, 1);
  await writeFile(path.join(dir, 'index.js'), 'export default { changed: true };');
  await assert.rejects(store.invokeRegistration('demo', 'tool', 'lookup', { q: 'x' }), { code: 'PLUGIN_REGISTRATION_STALE' });
  assert.equal((await store.dynamicRegistrations()).length, 0); assert.equal(item.enabled, true);
});

test('dynamic plugin registration bounds returned data and rejects registration conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-dynamic-limit-')); const dir = path.join(root, 'plugins', 'demo'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.js'), 'export default {};'); await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', entry: 'index.js', capabilities: ['tool'] }));
  const store = new PluginStore(root); await store.enable('demo', { approve: async () => true });
  const declaration = { type: 'tool', id: 'same', invoke: async () => 'ok' }; await store.register('demo', declaration, { approve: true });
  await assert.rejects(store.register('demo', declaration, { approve: true }), { code: 'PLUGIN_REGISTRATION_CONFLICT' });
  await store.unregister('demo'); assert.equal((await store.dynamicRegistrations()).length, 0);
});

test('registered plugin tools enter an Agent turn surface and execute through the PluginStore boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugin-turn-')); const dir = path.join(root, 'plugins', 'demo'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.js'), 'throw new Error("must not execute");'); await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', entry: 'index.js', capabilities: ['tool'] }));
  const store = new PluginStore(root); await store.enable('demo', { approve: async () => true });
  await store.register('demo', { type: 'tool', id: 'lookup', risk: 'read', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, invoke: async request => ({ found: request.query }) }, { approve: true });
  const session = { messages: [] }; let step = 0;
  const answer = await runTurn({ session, input: '查询插件', workspace: new Workspace(root), plugins: store, policy: new PermissionPolicy(), request: async (messages, tools) => {
    if (step++ === 0) { assert.ok(tools.some(tool => tool.function.name === 'plugin__demo__lookup')); return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'plugin-call', type: 'function', function: { name: 'plugin__demo__lookup', arguments: JSON.stringify({ query: 'alpha' }) } }] } }] }; }
    assert.match(messages.at(-1).content, /alpha/); return { choices: [{ message: { role: 'assistant', content: '插件查询完成' } }] };
  } });
  assert.equal(answer, '插件查询完成');
});
