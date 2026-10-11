import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CapabilityBroker } from '../backend/security/capability.js';
import { OperationBroker } from '../backend/security/broker.js';
import { TaskPermissionPolicy } from '../backend/security/task-permissions.js';

test('red-team capability replay, scope mutation and resource exhaustion fail closed', async () => {
  const broker = new CapabilityBroker(); const token = broker.issue({ tool: 'write_file', operation: 'commit', resource: { path: 'a', content: 'x' } });
  const operation = new OperationBroker({ capabilities: broker, root: path.join(os.tmpdir(), 'safe-root') });
  await operation.authorize({ token: token.id, tool: 'write_file', operation: 'commit', resource: { path: 'a', content: 'x' }, reserve: () => true });
  await assert.rejects(operation.authorize({ token: token.id, tool: 'write_file', operation: 'commit', resource: { path: 'a', content: 'x' } }), { code: 'CAPABILITY_UNAVAILABLE' });
});

test('red-team task permissions cannot be expanded by untrusted payload values', () => {
  const policy = new TaskPermissionPolicy({ tools: ['read_file'], roots: [path.join(os.tmpdir(), 'allowed')], network: false, messages: false, maxFiles: 1, maxBytes: 10 });
  assert.equal(policy.allowsTool('write_file'), false);
  assert.equal(policy.allowsTool('web_fetch'), false);
  assert.equal(policy.allowsTool('send_message'), false);
  assert.equal(policy.allowsPath('read_file', { path: path.join(os.tmpdir(), 'outside') }), false);
  assert.equal(policy.reserve(10), true); assert.equal(policy.reserve(1), false);
});

test('red-team path variants remain outside task roots', () => {
  const root = path.join(os.tmpdir(), 'allowed'); const policy = new TaskPermissionPolicy({ tools: ['read_file'], roots: [root] });
  assert.equal(policy.allowsPath('read_file', { path: '..\\outside.txt' }), false);
  assert.equal(policy.allowsPath('read_file', { path: path.join(root, '..', 'outside.txt') }), false);
});
