import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from '../backend/tasks/store.js';
import { McpStdioClient } from '../backend/mcp/stdio.js';
import { PluginStore } from '../backend/plugins/store.js';
import { LocalGateway } from '../backend/gateway/server.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';
import { acquireGatewayLock, readGatewayLock } from '../backend/gateway/runtime.js';
import { GatewayAutostart } from '../backend/gateway/autostart.js';
import { runGatewaySupervisor } from '../backend/gateway/supervisor.js';
import { EventEmitter } from 'node:events';

test('heartbeat tasks are schedulable and scheduler can be stopped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-heartbeat-')); let count = 0;
  const store = new TaskStore(root, { run: async () => { count++; return { ok: true }; } });
  const item = await store.create({ name: 'heartbeat', schedule: { type: 'heartbeat', ms: 10_000 } });
  await store.tick(item.nextRun + 1); assert.equal(count, 1); store.stopScheduler();
});

test('task permissions are snapshotted, bounded and retained in task state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-task-permissions-'));
  let received;
  const store = new TaskStore(root, { run: async (_task, permissions) => { received = permissions; try { permissions.network = true; } catch {} return { ok: true }; } });
  const task = await store.create({ name: 'restricted', schedule: { type: 'once', at: Date.now() + 1000 }, permissions: { tools: ['read_file'], roots: ['C:\\reports'], network: false, messages: false, maxFiles: 3, maxBytes: 1000 } });
  assert.deepEqual(task.permissions, { tools: ['read_file'], roots: ['C:\\reports'], network: false, messages: false, maxFiles: 3, maxBytes: 1000 });
  await store.run(task.id);
  assert.equal(received.network, false);
  assert.throws(() => store.validatePermissions({ tools: ['x'.repeat(129)] }), { code: 'TASK_PERMISSION_INVALID' });
  assert.equal((await new TaskStore(root).list())[0].permissions.network, false);
});

test('cron tasks validate five fields and calculate the next local occurrence', async () => {
  const store = new TaskStore(await mkdtemp(path.join(os.tmpdir(), 'agent-cron-')));
  const item = await store.create({ name: 'cron', schedule: { type: 'cron', expression: '*/5 * * * *' } });
  assert.ok(item.nextRun > Date.now());
  await assert.rejects(store.create({ name: 'bad-cron', schedule: { type: 'cron', expression: '* * *' } }), /five fields/);
});

test('task scheduler prevents duplicate runs, enforces concurrency and supports cancellation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-task-runtime-'));
  let release; let started = 0; let announceStarted; const startedPromise = new Promise(resolve => { announceStarted = resolve; });
  const store = new TaskStore(root, { maxConcurrent: 1, run: async (_task, _permissions, { signal }) => {
    started++; announceStarted(); await new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'TASK_CANCELLED' })), { once: true }); }); return { ok: true };
  } });
  const first = await store.create({ name: 'first', schedule: { type: 'once', at: Date.now() + 1000 }, timeoutMs: 1000 });
  const second = await store.create({ name: 'second', schedule: { type: 'once', at: Date.now() + 1000 } });
  const running = store.run(first.id);
  await startedPromise; assert.equal(started, 1);
  await assert.rejects(store.run(first.id), { code: 'TASK_ALREADY_RUNNING' });
  await assert.rejects(store.run(second.id), { code: 'TASK_CONCURRENCY_LIMIT' });
  const cancelled = await store.cancel(first.id); assert.ok(['running', 'cancelled'].includes(cancelled.status));
  const result = await running; assert.equal(result.result.code, 'TASK_CANCELLED'); assert.equal(result.task.status, 'cancelled'); release?.();
});

test('task timeout, retry and dead-letter history are durable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-task-timeout-')); let attempts = 0;
  const store = new TaskStore(root, { run: async () => { attempts++; await new Promise(resolve => setTimeout(resolve, 30)); return { ok: false, code: 'NOPE' }; } });
  const task = await store.create({ name: 'retry', schedule: { type: 'once', at: Date.now() + 1000 }, timeoutMs: 1000, retry: { max: 1 } });
  const first = await store.run(task.id); assert.equal(first.task.status, 'scheduled'); assert.equal(first.task.nextRun > Date.now(), true);
  const second = await store.run(task.id); assert.equal(second.task.status, 'dead_letter'); assert.equal(attempts, 2);
  assert.equal((await store.history(task.id)).at(-1).status, 'dead_letter'); assert.equal((await new TaskStore(root).list())[0].deadLetter, true);
});

test('running tasks are recovered after restart and diagnostics expose lifecycle state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-task-recovery-'));
  const file = path.join(root, '.agent-data'); await mkdir(file, { recursive: true });
  await writeFile(path.join(file, 'tasks.json'), JSON.stringify({ version: 2, tasks: { stale: { id: 'stale', name: 'stale', schedule: { type: 'once', at: Date.now() + 1000 }, enabled: true, status: 'running', permissions: {} } }, history: [] }));
  const store = new TaskStore(root); assert.equal((await store.list())[0].status, 'interrupted'); assert.equal((await store.diagnostics()).interrupted, 1);
  const recovered = await store.recover('stale', { runNow: false }); assert.equal(recovered.status, 'scheduled'); assert.equal(recovered.recoveryRequired, false);
});

test('Gateway exposes task diagnostics, cancellation and recovery endpoints', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-task-api-')); const approvals = new ApprovalManager();
  const gateway = new LocalGateway({ root, token: 'task-token', models: {}, sessions: {}, memory: {}, skills: {}, messages: {}, approvals, tasks: { diagnostics: async () => ({ active: [], maxConcurrent: 2 }), list: async () => [], cancel: async id => ({ id, status: 'cancelled' }), recover: async id => ({ id, status: 'scheduled' }), history: async () => [] } });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`; const headers = { Authorization: 'Bearer task-token', 'Content-Type': 'application/json' };
  assert.deepEqual(await fetch(`${base}/api/tasks/diagnostics`, { headers }).then(response => response.json()), { active: [], maxConcurrent: 2 });
  const cancel = await fetch(`${base}/api/tasks/x/cancel`, { method: 'POST', headers, body: '{}' }).then(response => response.json()); assert.equal(cancel.code, 'APPROVAL_REQUIRED');
});

test('Gateway runtime lock rejects live duplicates and releases its own token', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-lock-')); const first = await acquireGatewayLock(root); assert.equal((await readGatewayLock(root)).token, first.record.token);
  await assert.rejects(acquireGatewayLock(root), { code: 'GATEWAY_ALREADY_RUNNING' }); await first.release(); assert.equal(await readGatewayLock(root), null);
});

test('Gateway autostart configuration is local-only and bounded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-autostart-')); const config = new GatewayAutostart(root);
  assert.equal((await config.get()).enabled, false); const saved = await config.set({ enabled: true, port: 4312, maxRestarts: 2, restartDelayMs: 500 }); assert.equal(saved.enabled, true);
  assert.equal((await config.get()).port, 4312); await assert.rejects(config.set({ host: '0.0.0.0' }), { code: 'AUTOSTART_HOST_DENIED' });
});

test('Gateway supervisor performs bounded crash recovery and stops cleanly', async () => {
  const controller = new AbortController(); let starts = 0; const restartEvents = [];
  const result = await runGatewaySupervisor({ maxRestarts: 2, restartDelayMs: 100, onRestart: info => restartEvents.push(info), signal: controller.signal, start: async () => {
    starts++;
    if (starts === 1) throw new Error('simulated crash');
    const server = new EventEmitter();
    queueMicrotask(() => controller.abort());
    return { server, close: async () => server.emit('close') };
  } });
  assert.equal(starts, 2); assert.equal(result.restarts, 1); assert.equal(restartEvents.length, 1);
});

test('Gateway autostart API remains approval protected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-autostart-api-')); const approvals = new ApprovalManager(); const autostart = new GatewayAutostart(root);
  const gateway = new LocalGateway({ root, token: 'auto-token', models: {}, sessions: {}, memory: {}, skills: {}, tasks: {}, messages: {}, approvals, autostart });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`; const headers = { Authorization: 'Bearer auto-token', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/gateway/autostart`, { headers })).status, 200);
  const pending = await fetch(`${base}/api/gateway/autostart`, { method: 'POST', headers, body: JSON.stringify({ enabled: true }) }).then(response => response.json()); assert.equal(pending.code, 'APPROVAL_REQUIRED');
});

test('MCP stdio client initializes, discovers, calls and closes with bounded messages', async () => {
  const writes = []; let onData; let killed = false;
  const child = { stdin: { write(text) { writes.push(JSON.parse(text)); const request = writes.at(-1); const result = request.method === 'tools/list' ? { tools: [{ name: 'demo' }] } : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'ok' }] } : { protocolVersion: 'test' }; queueMicrotask(() => onData?.(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)); } }, stdout: { setEncoding() {}, on(event, callback) { if (event === 'data') onData = callback; } }, once() {}, kill() { killed = true; } };
  const client = new McpStdioClient({ command: 'node', spawnImpl: () => child });
  await client.start(); assert.deepEqual(await client.listTools(), [{ name: 'demo' }]); assert.deepEqual((await client.callTool('demo')).content[0].text, 'ok'); client.close(); assert.equal(killed, true);
});

test('plugin store validates local manifest, hashes code and requires explicit enable approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plugins-')); const dir = path.join(root, 'plugins', 'demo'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'index.js'), 'export default {};'); await writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', entry: 'index.js', capabilities: ['tool'], permissions: ['network.read'] }));
  const store = new PluginStore(root); const item = (await store.list())[0]; assert.equal(item.enabled, false); assert.ok(item.hash);
  await assert.rejects(store.enable('demo'), { code: 'USER_DENIED' }); const enabled = await store.enable('demo', { approve: async details => { assert.equal(details.trustedCode, true); return true; } }); assert.equal(enabled.enabled, true); assert.equal((await store.disable('demo')).enabled, false); assert.equal((await store.list())[0].enabled, false);
});
