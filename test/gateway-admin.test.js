import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalGateway } from '../backend/gateway/server.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';

test('Gateway exposes MCP and plugin administration endpoints', async t => {
  const calls = [];
  const gateway = new LocalGateway({
    mcp: { list: async () => [{ id: 'mcp' }], addStdio: async input => ({ id: input.id }), inspect: async () => ({ id: 'mcp' }), setEnabled: async (id, enabled) => ({ id, enabled }), tools: async () => [{ name: 'tool' }], call: async (...args) => { calls.push(args); return { ok: true }; } },
    plugins: { list: async () => [{ id: 'plugin' }], validate: async () => ({ valid: true }), enable: async () => ({ enabled: true }), disable: async () => ({ enabled: false }) },
    models: {}, sessions: {}, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager(),
  });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`; const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/api/mcp`)).status, 200);
  const added = await post('/api/mcp', { id: 'mcp' }); assert.equal(added.status, 202);
  const addApproval = (await added.json()).approvalId;
  assert.equal((await post(`/api/approvals/${addApproval}`, { decision: 'approved', resource: { id: 'mcp', enabled: false } })).status, 200);
  assert.equal((await post('/api/mcp', { id: 'mcp', enabled: false, approvalId: addApproval })).status, 200);
  assert.equal((await post('/api/mcp/mcp/tools', {})).status, 200);
  const callPending = await post('/api/mcp/mcp/call', { tool: 'tool', arguments: {} }); assert.equal(callPending.status, 202);
  const callApproval = (await callPending.json()).approvalId;
  assert.equal((await post(`/api/approvals/${callApproval}`, { decision: 'approved', resource: { server: 'mcp', tool: 'tool', arguments: {} } })).status, 200);
  assert.equal((await post('/api/mcp/mcp/call', { tool: 'tool', arguments: {}, approvalId: callApproval, approve: true })).status, 200);
  assert.equal((await fetch(`${base}/api/plugins`)).status, 200);
  const pluginPending = await post('/api/plugins/plugin/enable', {}); assert.equal(pluginPending.status, 202);
  const pluginApproval = (await pluginPending.json()).approvalId;
  assert.equal((await post(`/api/approvals/${pluginApproval}`, { decision: 'approved', resource: { id: 'plugin' } })).status, 200);
  assert.equal((await post('/api/plugins/plugin/enable', { approvalId: pluginApproval })).status, 200); assert.equal(calls.length, 1);
});
