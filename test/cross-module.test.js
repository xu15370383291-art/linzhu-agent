import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../backend/memory/store.js';
import { ensureBranches, forkBranch } from '../backend/sessions/branches.js';
import { HookStore } from '../backend/hooks/store.js';
import { routeTool } from '../backend/tools/registry.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { SubagentRunner } from '../backend/subagents/runner.js';

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test('memory is independent from branch history and does not grant tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cross-memory-')); const memory = new MemoryStore(root);
  const session = ensureBranches({ id: 's', createdAt: new Date().toISOString(), messages: [] }); forkBranch(session, 'experiment');
  await memory.create({ scope: 'project', kind: 'project', content: '项目使用 Node.js' });
  assert.equal((await memory.list()).length, 1); assert.equal(session.branches.length, 2);
  const policy = new PermissionPolicy(); assert.equal(policy.visible('write_file'), true); assert.equal(policy.visible('sandbox_command_write'), false);
});

test('hook denial blocks external write before approval and subagent cannot write', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cross-hook-')); const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-cross-out-')); const target = path.join(outside, 'note.txt');
  const hooks = new HookStore(root); await hooks.save({ hooks: [{ id: 'deny', event: 'before', tool: 'external_write_file', action: 'deny' }] });
  let approved = 0;
  const denied = await routeTool(call('external_write_file', { path: target, content: 'x' }), { workspace: { root }, externalWrites: { prepare: async () => { throw new Error('must not prepare'); } }, policy: new PermissionPolicy({ approveWrite: async () => { approved++; return true; } }), hooks: { evaluate: (event, payload) => hooks.evaluate(event, payload) } });
  assert.equal(denied.errorCode, 'HOOK_DENIED'); assert.equal(approved, 0);
  const runner = new SubagentRunner({ policy: new PermissionPolicy(), request: async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [call('write_file', { path: 'x', content: 'x' })] } }] }), workspace: {} });
  assert.equal((await runner.run({ task: 'write' })).denied, true);
});
