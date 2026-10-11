import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { LocalGateway } from '../backend/gateway/server.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InboundMessageStore } from '../backend/messages/inbound.js';

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers ?? {}) } });
  return { status: response.status, body: await response.json() };
}

test('Local Gateway exposes localhost APIs and rejects foreign origins', async t => {
  const events = [];
  const gateway = new LocalGateway({
    models: { list: async () => ({ items: [] }) },
    sessions: { summaries: async () => [], create: async () => ({ id: 'session' }) },
    memory: { list: async () => [], search: async () => [], create: async item => item, suggest: async item => item, remove: async () => {} },
    skills: { list: async () => [], inspect: async () => ({}), setEnabled: async () => ({}) },
    tasks: { list: async () => [], create: async item => item, run: async () => ({}), history: async () => [], setEnabled: async () => ({}) },
    messages: { listChannels: async () => [], send: async item => item },
    approvals: new ApprovalManager(),
    health: async () => ({ ok: true, version: 'test' }),
  });
  gateway.events.on(event => events.push(event));
  const server = gateway.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await request(base, '/api/health')).body, { ok: true, version: 'test' });
  const toolItems = (await request(base, '/api/tools')).body.items;
  assert.equal(toolItems.some(item => item.name === 'send_message'), true);
  assert.equal(toolItems.find(item => item.name === 'send_message').description, '通过明确启用的渠道发送消息；消息投递支持幂等处理并会记录审计信息。');
  assert.equal(toolItems.some(item => /^(List|Load|Read|Run|Fetch|Render|Search|Get|Replace|Create|Delete|Send|Call|Approved)\b/.test(item.description)), false);
  assert.equal((await request(base, '/api/models')).status, 200);
  assert.equal((await request(base, '/api/models', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const approval = await gateway.approvals.request({ type: 'write', operation: 'test', resource: 'a' });
  assert.equal((await request(base, `/api/approvals/${approval.id}`, { method: 'POST', body: JSON.stringify({ decision: 'denied', resource: 'a' }) })).body.status, 'denied');
  assert.equal(events.length, 2);
});

test('Gateway skills list honors enabledOnly and includeInvalid query flags', async t => {
  const calls = [];
  const gateway = new LocalGateway({
    models: {}, sessions: {}, memory: {}, tasks: {}, messages: {}, approvals: new ApprovalManager(),
    skills: { list: async options => { calls.push(options); return []; } },
  });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await request(base, '/api/skills?includeInvalid=true&enabledOnly=true')).status, 200);
  assert.deepEqual(calls[0], { includeInvalid: true, enabledOnly: true });
  assert.equal((await request(base, '/api/skills')).status, 200);
  assert.deepEqual(calls[1], { includeInvalid: false, enabledOnly: false });
});

test('Local Gateway SSE emits bounded JSON events', async t => {
  const gateway = new LocalGateway({
    models: { list: async () => ({ items: [] }) }, sessions: { summaries: async () => [] }, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager(),
  });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/events`); const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value); assert.match(first, /connected/);
  gateway.emit('diagnostics.updated', { ok: true });
  const second = new TextDecoder().decode((await reader.read()).value); assert.match(second, /diagnostics.updated/); await reader.cancel();
});

test('Gateway model selection updates the selected model', async t => {
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  let selectedId = null;
  const gateway = new LocalGateway({
    models: { select: async value => { selectedId = value; return { selectedId, items: [{ id }] }; } },
    sessions: {}, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager(),
  });
  const server = gateway.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await request(`http://127.0.0.1:${server.address().port}`, `/api/models/${id}/select`, { method: 'POST', body: '{}' });
  assert.equal(result.status, 200);
  assert.equal(result.body.selectedId, id);
});

test('Local Gateway WebSocket completes a localhost handshake and ignores client data', async t => {
  const gateway = new LocalGateway({ models: {}, sessions: {}, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager() });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const socket = net.createConnection(server.address().port, '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  let raw = Buffer.alloc(0);
  const handshake = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket handshake timed out')), 2000);
    socket.on('data', chunk => { raw = Buffer.concat([raw, chunk]); if (raw.includes(Buffer.from('\r\n\r\n'))) { clearTimeout(timer); resolve(); } });
  });
  socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${server.address().port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await handshake;
  assert.match(raw.toString(), /101 Switching Protocols/);
  socket.write(Buffer.from([0x81, 0x00]));
  gateway.emit('diagnostics.updated', { ok: true });
  socket.destroy();
});

test('Gateway inbound webhook configuration is approved, signed messages are isolated, and delivery data stays private', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-inbound-')); t.after(() => rm(root, { recursive: true, force: true }));
  const approvals = new ApprovalManager(); const storedSecrets = new Map(); const messageSecretIds = []; let sessionNumber = 0;
  const inbound = new InboundMessageStore(root, { secrets: { async set(id, value) { storedSecrets.set(id, value); if (id.startsWith('inbound.message.')) messageSecretIds.push(id); }, async resolve(reference) { return storedSecrets.get(reference.slice('secret://'.length)); }, async delete(id) { storedSecrets.delete(id); } },
    createSession: async () => ({ id: `session-${++sessionNumber}` }), onMessage: async () => ({ status: 'processed', code: 'OK' }) });
  const gateway = new LocalGateway({ token: 'admin', approvals, inbound, models: {}, sessions: {}, memory: {}, skills: {}, tasks: {}, messages: {} });
  const base = await (async () => { const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); })); return `http://127.0.0.1:${server.address().port}`; })();
  const headers = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
  const config = { id: 'hook', secret: '0123456789abcdef', enabled: true, allowedSources: ['alice'] };
  const pending = await fetch(`${base}/api/inbound/channels`, { method: 'POST', headers, body: JSON.stringify(config) }); assert.equal(pending.status, 202); const approval = await pending.json();
  const approvalItem = approvals.list().find(item => item.id === approval.approvalId); assert.equal(JSON.stringify(approvalItem).includes(config.secret), false);
  await fetch(`${base}/api/approvals/${approval.approvalId}`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) });
  const configured = await fetch(`${base}/api/inbound/channels`, { method: 'POST', headers, body: JSON.stringify({ ...config, approvalId: approval.approvalId }) }); const configuredBody = await configured.json(); assert.equal(configured.status, 200, JSON.stringify(configuredBody));
  const payload = JSON.stringify({ source: 'alice', conversation: 'chat', messageId: 'm1', text: 'please inspect README' }); const timestamp = String(Math.floor(Date.now() / 1000)); const signature = createHmac('sha256', config.secret).update(`${timestamp}.${payload}`).digest('hex');
  const inboundHeaders = { 'Content-Type': 'application/json', 'X-Agent-Timestamp': timestamp, 'X-Agent-Signature': signature };
  const accepted = await fetch(`${base}/api/messages/inbound/hook`, { method: 'POST', headers: inboundHeaders, body: payload }); assert.equal(accepted.status, 202);
  const acceptedBody = await accepted.json(); assert.equal(acceptedBody.sessionId, 'session-1'); assert.equal(acceptedBody.status, 'accepted');
  const deliveryDeadline = Date.now() + 2000;
  while (Date.now() < deliveryDeadline && (await gateway.inbound.listDeliveries()).find(item => item.id === acceptedBody.id)?.status !== 'processed') await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await gateway.inbound.listDeliveries()).find(item => item.id === acceptedBody.id).status, 'processed');
  while (Date.now() < deliveryDeadline && messageSecretIds.some(id => storedSecrets.has(id))) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(messageSecretIds.length, 1); assert.equal(storedSecrets.has(messageSecretIds[0]), false);
  assert.equal(storedSecrets.has('inbound.hook'), true);
  const deniedPayload = JSON.stringify({ source: 'mallory', conversation: 'chat', messageId: 'm2', text: 'hello' });
  const denied = await fetch(`${base}/api/messages/inbound/hook`, { method: 'POST', headers: { ...inboundHeaders, 'X-Agent-Signature': createHmac('sha256', config.secret).update(`${timestamp}.${deniedPayload}`).digest('hex') }, body: deniedPayload }); assert.equal(denied.status, 403);
  const invalidSignature = await fetch(`${base}/api/messages/inbound/hook`, { method: 'POST', headers: { ...inboundHeaders, 'X-Agent-Signature': 'invalid' }, body: payload }); assert.equal(invalidSignature.status, 403);
  assert.equal((await fetch(`${base}/api/inbound/channels`)).status, 401);
  const listed = await (await fetch(`${base}/api/inbound/deliveries`, { headers })).json(); assert.equal(JSON.stringify(listed).includes('please inspect README'), false);
  const diagnostics = await (await fetch(`${base}/api/inbound/diagnostics`, { headers })).json(); assert.equal(diagnostics.completed, 1);
});

test('Gateway memory embedding configuration is approved, local-only, bounded and disableable', async t => {
  const approvals = new ApprovalManager(); let embedding = null; let mode = 'keyword'; const config = { configured: false };
  const memory = { configureEmbedding(value, nextMode) { embedding = value; mode = nextMode; }, async status() { return { mode, embeddingConfigured: Boolean(embedding) }; }, async reembed({ limit }) { return { processed: 1, remaining: 2, limit }; } };
  const gateway = new LocalGateway({ token: 'memory-admin', approvals, memory, memoryEmbedding: {
    async get() { return config.configured ? { ...config } : { configured: false, provider: null, model: null }; },
    async set(input) { Object.assign(config, input, { configured: true }); return { ...config }; },
    async clear() { config.configured = false; return { configured: false, provider: null, model: null }; },
  }, models: {}, sessions: {}, skills: {}, tasks: {}, messages: {} });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`; const headers = { Authorization: 'Bearer memory-admin', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/memory/embedding`)).status, 401);
  const settings = { provider: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://127.0.0.1:11434' };
  const pending = await fetch(`${base}/api/memory/embedding`, { method: 'POST', headers, body: JSON.stringify(settings) }); assert.equal(pending.status, 202); const approval = await pending.json();
  await fetch(`${base}/api/approvals/${approval.approvalId}`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) });
  const configured = await fetch(`${base}/api/memory/embedding`, { method: 'POST', headers, body: JSON.stringify({ ...settings, approvalId: approval.approvalId }) }); const configuredBody = await configured.json(); assert.equal(configured.status, 200, JSON.stringify(configuredBody)); assert.equal(mode, 'hybrid');
  const remote = await fetch(`${base}/api/memory/embedding`, { method: 'POST', headers, body: JSON.stringify({ provider: 'ollama', model: 'x', baseUrl: 'http://192.168.1.5:11434' }) }); assert.equal(remote.status, 422);
  const oversized = await fetch(`${base}/api/memory/embedding/rebuild`, { method: 'POST', headers, body: JSON.stringify({ limit: 500 }) }); assert.equal(oversized.status, 422);
  const rebuild = await fetch(`${base}/api/memory/embedding/rebuild`, { method: 'POST', headers, body: JSON.stringify({ limit: 100 }) }); assert.equal(rebuild.status, 202);
  const rebuildApproval = await rebuild.json();
  await fetch(`${base}/api/approvals/${rebuildApproval.approvalId}`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) });
  const rebuilt = await fetch(`${base}/api/memory/embedding/rebuild`, { method: 'POST', headers, body: JSON.stringify({ limit: 100, approvalId: rebuildApproval.approvalId }) }); assert.equal(rebuilt.status, 200); assert.equal((await rebuilt.json()).limit, 100);
});
