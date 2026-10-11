import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalGateway } from '../backend/gateway/server.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';
import { createLocalGateway } from '../backend/gateway/factory.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Gateway token protects HTTP and high-risk actions create approval requests', async t => {
  const approvals = new ApprovalManager();
  const gateway = new LocalGateway({ token: 'test-token', models: { list: async () => ({ items: [] }) }, sessions: {}, memory: {}, skills: {}, tasks: { create: async () => ({}) }, messages: {}, approvals });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/models`)).status, 401);
  assert.equal((await fetch(`${base}/api/models`, { headers: { Authorization: 'Bearer test-token' } })).status, 200);
  const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'demo', schedule: { type: 'once', at: Date.now() + 1000 } }) });
  assert.equal(response.status, 202); assert.equal((await response.json()).code, 'APPROVAL_REQUIRED'); assert.equal(approvals.list().length, 1);
});

test('Gateway approved task can be retried once with the same resource', async t => {
  const approvals = new ApprovalManager(); let runs = 0;
  const gateway = new LocalGateway({
    token: 'test-token', models: {}, sessions: {}, memory: {}, skills: {}, messages: {}, approvals,
    tasks: { create: async input => { runs++; return { created: input.name }; } },
  });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = { name: 'demo', schedule: { type: 'once', at: Date.now() + 1000 } };
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const pending = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify(resource) }).then(response => response.json());
  await fetch(`${base}/api/approvals/${pending.approvalId}`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approved', resource }) });
  const completed = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ ...resource, approvalId: pending.approvalId }) }).then(response => response.json());
  assert.deepEqual(completed, { created: 'demo' }); assert.equal(runs, 1);
});

test('Gateway factory creates shared local services and closes schedulers/MCP clients', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-factory-')); const services = createLocalGateway(root);
  assert.ok(services.gateway.models); assert.ok(services.gateway.memory); assert.ok(services.gateway.mcp); assert.ok(services.gateway.plugins); services.close();
});

test('Gateway factory shares one message and MCP service with the task runner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-shared-services-'));
  let received;
  const services = createLocalGateway(root, {
    runTask: async (_task, permissions) => {
      received = permissions;
      return { ok: true };
    },
  });
  assert.strictEqual(services.gateway.messages, services.messages);
  assert.strictEqual(services.gateway.mcp, services.mcp);
  await services.tasks.create({ name: 'shared', schedule: { type: 'once', at: Date.now() + 1000 }, permissions: { tools: ['send_message'], messages: true } });
  services.close();
  assert.equal(received, undefined);
});

test('Gateway factory provides a default fail-closed turn runner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-turn-'));
  const services = createLocalGateway(root);
  assert.equal(typeof services.gateway.runTurn, 'function');
  await assert.rejects(services.gateway.runTurn({ input: '你好' }), { code: 'MODEL_NOT_CONFIGURED' });
  services.close();
});
