import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentRunner } from '../backend/subagents/runner.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { routeTool } from '../backend/tools/registry.js';

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
test('sub-agent runner is read-only and returns a bounded answer', async () => {
  const runner = new SubagentRunner({ policy: new PermissionPolicy(), workspace: { read: async () => 'fact' }, request: async (_messages, tools) => {
    assert.ok(tools.some(tool => tool.function.name === 'read_file')); assert.ok(!tools.some(tool => tool.function.name === 'write_file'));
    return { choices: [{ message: { role: 'assistant', content: 'fact' } }] };
  } });
  assert.equal((await runner.run({ task: 'find a fact' })).content, 'fact');
});

test('delegate_task fails closed without a configured runner and cannot use hidden tools', async () => {
  const denied = await routeTool(call('delegate_task', { task: 'do it' }), { policy: new PermissionPolicy() });
  assert.equal(denied.errorCode, 'TOOL_NOT_AVAILABLE');
  const runner = new SubagentRunner({ policy: new PermissionPolicy(), request: async (_messages, tools) => ({ choices: [{ message: { role: 'assistant', tool_calls: [call('write_file', { path: 'x', content: 'x' })] } }] }), workspace: {} });
  const result = await routeTool(call('delegate_task', { task: 'write' }), { policy: new PermissionPolicy(), subagent: runner });
  assert.match(result.content, /未开放的工具|denied/);
});
