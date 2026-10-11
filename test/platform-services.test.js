import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProcessManager } from '../backend/tools/processes.js';
import { MessageStore } from '../backend/messages/webhook.js';
import { TaskStore } from '../backend/tasks/store.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { registeredTools, routeTool } from '../backend/tools/registry.js';
import { TaskPermissionPolicy } from '../backend/security/task-permissions.js';
import { WslProcessRunner } from '../backend/tools/wsl-process-runner.js';

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test('registered tools expose complete safety contracts', () => {
  const tools = registeredTools();
  const names = new Set(tools.map(tool => tool.name));
  for (const name of ['read_file', 'write_file', 'process_start', 'send_message', 'task_create']) assert.ok(names.has(name));
  for (const tool of tools) {
    assert.equal(tool.contract.name, tool.name);
    assert.ok(tool.contract.timeoutMs > 0);
    assert.ok(['read', 'network', 'write', 'execute', 'message', 'admin'].includes(tool.contract.risk));
  }
});

test('process manager fails closed without a controlled runner and supports bounded lifecycle', async () => {
  const unavailable = new ProcessManager();
  await assert.rejects(unavailable.start({ command: 'echo no' }), { code: 'PROCESS_UNAVAILABLE' });
  let killed = false;
  const manager = new ProcessManager({ runner: { async start({ onOutput }) { onOutput('hello'); return { poll: async () => ({ done: false }), kill: async () => { killed = true; } }; } } });
  const item = await manager.start({ command: 'safe' });
  assert.equal(item.status, 'running');
  assert.equal((await manager.poll(item.id)).output, 'hello');
  assert.equal((await manager.kill(item.id)).status, 'cancelled');
  assert.equal(killed, true);
});

test('WSL process runner requires verification and uses a read-only isolated command boundary', async () => {
  const calls = [];
  const child = { stdout: { on() {} }, stderr: { on() {} }, once(event, callback) { if (event === 'close') this.close = callback; if (event === 'error') this.error = callback; }, kill() { this.close?.(0); } };
  const runner = new WslProcessRunner('C:\\workspace', { sandbox: { verify: async () => true }, spawnImpl: (file, args, options) => { calls.push({ file, args, options }); return child; } });
  const handle = await runner.start({ command: 'cat README.md', cwd: '.' });
  assert.equal(calls[0].file, 'wsl.exe');
  assert.ok(calls[0].args.includes('--unshare-all'));
  assert.ok(calls[0].args.includes('--ro-bind'));
  assert.match(calls[0].args.at(-1), /cat README\.md/);
  await handle.kill();
  await assert.rejects(runner.start({ command: 'echo\nunsafe' }), { code: 'PROCESS_REQUEST_DENIED' });
});

test('webhook message store enforces HTTPS, Secret resolution and idempotent delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-message-'));
  const sent = [];
  const secrets = { resolve: async reference => { assert.equal(reference, 'secret://webhook'); return 'message-secret'; } };
  const messages = new MessageStore(root, { secrets, transport: async (target, payload, { headers }) => { sent.push({ target, payload, headers }); return { ok: true }; } });
  await assert.rejects(messages.addWebhook({ id: 'bad', url: 'http://example.com/hook' }), /HTTPS/);
  await messages.addWebhook({ id: 'hook', url: 'https://example.com/hook', secretRef: 'secret://webhook', enabled: true });
  const first = await messages.send({ channel: 'hook', conversation: 'default', text: 'hello', idempotencyKey: 'same' });
  const second = await messages.send({ channel: 'hook', conversation: 'default', text: 'hello', idempotencyKey: 'same' });
  assert.equal(first.id, second.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.Authorization, 'Bearer message-secret');
  assert.equal(JSON.stringify(await messages.listChannels()).includes('message-secret'), false);
});

test('task store validates schedules, runs, records failures and pauses', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-task-'));
  let runs = 0;
  const tasks = new TaskStore(root, { run: async () => { runs++; return { ok: runs > 1, code: runs > 1 ? 'OK' : 'FAIL' }; } });
  await assert.rejects(tasks.create({ name: 'bad', schedule: { type: 'interval', ms: 1 } }), /interval/);
  const item = await tasks.create({ name: 'demo', schedule: { type: 'once', at: Date.now() + 1000 }, payload: { action: 'chat' } });
  assert.equal(item.hasPayload, true);
  const first = await tasks.run(item.id); assert.equal(first.task.status, 'scheduled');
  const second = await tasks.run(item.id); assert.equal(second.task.status, 'completed');
  assert.equal((await tasks.history(item.id)).length, 2);
  assert.equal((await tasks.setEnabled(item.id, false)).status, 'paused');
});

test('new side-effect tools require readiness, service and explicit approval', async () => {
  const deniedPolicy = new PermissionPolicy({ messageReady: true, approveMessage: async () => false });
  const denied = await routeTool(call('send_message', { channel: 'x', conversation: 'y', text: 'z' }), { policy: deniedPolicy, messages: { send: async () => { throw new Error('must not send'); } } });
  assert.equal(denied.errorCode, 'USER_DENIED');
  const hidden = await routeTool(call('process_start', { command: 'x' }), { policy: new PermissionPolicy(), processes: { start: async () => ({}) } });
  assert.equal(hidden.errorCode, 'TOOL_NOT_AVAILABLE');
});

test('all message actions share message readiness and approval', async () => {
  const policy = new PermissionPolicy({ messageReady: true, approveMessage: async () => true });
  for (const name of ['edit_message', 'delete_message', 'react_message', 'send_file']) {
    assert.equal(policy.visible(name), true);
    assert.equal(await policy.authorize(name, {}), true);
  }
});

test('task permission snapshot blocks tools, paths, network and messages before execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-task-policy-'));
  const taskPermissions = new TaskPermissionPolicy({ tools: ['read_file'], roots: [root], network: false, messages: false, maxFiles: 1, maxBytes: 10 }, { workspaceRoot: root });
  const policy = new PermissionPolicy({ taskPermissions });
  assert.equal(policy.visible('read_file'), true);
  assert.equal(policy.visible('write_file'), false);
  assert.equal(policy.visible('web_fetch'), false);
  assert.equal(policy.visible('send_message'), false);
  assert.equal(await policy.authorize('read_file', { path: path.join(root, 'a.txt') }), true);
  assert.equal(await policy.authorize('read_file', { path: path.join(os.tmpdir(), 'outside.txt') }), false);
  const result = await routeTool(call('write_file', { path: 'a.txt', content: 'x' }), { workspace: { root, prepareChange: async () => { throw new Error('must not execute'); } }, policy });
  assert.equal(result.errorCode, 'TOOL_NOT_AVAILABLE');
});

test('task file quotas are consumed before write approval or side effects', async () => {
  const taskPermissions = new TaskPermissionPolicy({ tools: ['write_file'], roots: ['C:\\allowed'], maxFiles: 1, maxBytes: 2 }, { workspaceRoot: 'C:\\allowed' });
  let approvals = 0;
  const policy = new PermissionPolicy({ taskPermissions, approveWrite: async () => { approvals++; return true; } });
  assert.equal(await policy.authorize('write_file', { path: 'a.txt', content: 'ab' }), true);
  await assert.rejects(policy.authorize('write_file', { path: 'b.txt', content: 'c' }), { code: 'RESOURCE_LIMIT' });
  assert.equal(approvals, 1);
});
