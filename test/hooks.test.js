import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HookStore } from '../backend/hooks/store.js';
import { routeTool } from '../backend/tools/registry.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
test('hooks validate config and can deny before tool execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-hooks-')); const hooks = new HookStore(root);
  await hooks.save({ hooks: [{ id: 'deny-read', event: 'before', tool: 'read_file', action: 'deny', message: 'blocked' }] });
  const result = await routeTool(call('read_file', { path: 'x.txt' }), { workspace: { read: async () => { throw new Error('must not run'); } }, policy: new PermissionPolicy(), hooks: { evaluate: (event, payload) => hooks.evaluate(event, payload) } });
  assert.equal(result.errorCode, 'HOOK_DENIED');
});

test('hooks reject unknown actions and keep configuration bounded', async () => {
  const hooks = new HookStore(await mkdtemp(path.join(os.tmpdir(), 'agent-hooks-deny-')));
  await assert.rejects(hooks.save({ hooks: [{ id: 'bad', event: 'before', tool: '*', action: 'exec' }] }), /Invalid hooks/);
});

test('after hooks can bound string results while preserving tool result structure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-hooks-after-')); const hooks = new HookStore(root);
  await hooks.save({ hooks: [{ id: 'short', event: 'after', tool: 'read_file', action: 'truncate_result', maxChars: 3 }] });
  const result = await routeTool(call('read_file', { path: 'x.txt' }), { workspace: { read: async () => '123456' }, policy: new PermissionPolicy(), hooks: { evaluate: (event, payload) => hooks.evaluate(event, payload) } });
  assert.equal(result.isError, false); assert.equal(result.content, '123');
});
