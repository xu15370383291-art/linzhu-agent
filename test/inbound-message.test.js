import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { InboundMessageStore } from '../backend/messages/inbound.js';
import { createInboundMessageRunner } from '../backend/messages/inbound-runner.js';
import { Sessions } from '../backend/sessions.js';

const NOW = 1_700_000_000_000;
const sign = (secret, timestamp, value) => createHmac('sha256', secret).update(`${timestamp}.${value}`).digest('hex');
function payload({ source = 'alice', conversation = 'chat', messageId = 'm1', text = 'hello' } = {}) { return JSON.stringify({ source, conversation, messageId, text }); }
async function until(predicate, timeoutMs = 2000) { const end = Date.now() + timeoutMs; while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for inbound delivery'); }
function memorySecrets() { const values = new Map(); const messageIds = []; return { values, messageIds, async set(id, value) { values.set(id, value); if (id.startsWith('inbound.message.')) messageIds.push(id); }, async resolve(ref) { return values.get(ref.slice('secret://'.length)); }, async delete(id) { values.delete(id); } }; }
async function configure(store, secrets, allowedSources = ['alice']) { await secrets.set('hook', 'secret'); await store.configure({ id: 'hook', secretRef: 'secret://hook', allowedSources }); }

test('inbound messages verify signatures, enforce source allowlists, map isolated conversations and deduplicate', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-inbound-')); t.after(() => rm(root, { recursive: true, force: true })); const received = []; const created = [];
  const secrets = memorySecrets(); const store = new InboundMessageStore(root, { secrets, now: () => NOW, autoProcess: false, createSession: async metadata => { const session = { id: `session-${created.length + 1}`, ...metadata }; created.push(session); return session; }, onMessage: async message => { received.push(message); return { status: 'processed', code: 'OK' }; } });
  await configure(store, secrets, ['alice', 'bob']);
  const timestamp = String(NOW / 1000); const body = payload(); const signature = sign('secret', timestamp, body);
  const first = await store.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'm1', text: 'hello', source: 'alice', timestamp, signature, body });
  const duplicate = await store.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'm1', text: 'hello', source: 'alice', timestamp, signature, body });
  await store.process(first.id);
  const otherSourceBody = payload({ source: 'bob' });
  const otherSource = await store.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'm1', text: 'hello', source: 'bob', timestamp, signature: sign('secret', timestamp, otherSourceBody), body: otherSourceBody }); await store.process(otherSource.id);
  assert.equal(first.status, 'accepted'); assert.equal(duplicate.duplicate, true); assert.equal(received.length, 2);
  const queueText = await readFile(path.join(root, '.agent-data', 'inbound-messages.json'), 'utf8'); assert.equal(queueText.includes('hello'), false);
  assert.deepEqual([...secrets.values.keys()], ['hook']); assert.equal(secrets.messageIds.length, 2); assert.ok(secrets.messageIds.every(id => !secrets.values.has(id)));
  assert.notEqual(first.sessionId, otherSource.sessionId); assert.equal(created.length, 2); assert.equal((await store.listMappings()).length, 2);
  assert.equal(JSON.stringify(await store.listDeliveries()).includes('hello'), false);
  const deniedBody = payload({ source: 'mallory', messageId: 'm2' });
  await assert.rejects(store.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'm2', text: 'hello', source: 'mallory', timestamp, signature: sign('secret', timestamp, deniedBody), body: deniedBody }), { code: 'INBOUND_SOURCE_DENIED' });
  await assert.rejects(store.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'm3', text: 'tampered', source: 'alice', timestamp, signature, body }), { code: 'INBOUND_MESSAGE_INVALID' });
  await assert.rejects(store.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'm4', text: 'bad', source: 'alice', timestamp, signature: 'bad', body: payload({ messageId: 'm4', text: 'bad' }) }), { code: 'INBOUND_SIGNATURE_INVALID' });
});

test('inbound delivery retries with backoff, dead-letters, and can be explicitly recovered', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-inbound-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  let now = NOW; let calls = 0;
  const secrets = memorySecrets(); const store = new InboundMessageStore(root, { secrets, now: () => now, retryBaseMs: 10, autoProcess: false, createSession: async () => ({ id: 'session' }), onMessage: async () => { calls++; return { status: 'failed', code: 'MODEL_DOWN' }; } });
  await configure(store, secrets);
  const timestamp = String(NOW / 1000); const body = payload({ messageId: 'retry-1' });
  const first = await store.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'retry-1', text: 'hello', source: 'alice', timestamp, signature: sign('secret', timestamp, body), body });
  assert.equal(first.status, 'accepted'); await store.process(first.id); const retry = await store.listDeliveries().then(items => items[0]); assert.equal(retry.status, 'retry'); assert.equal(retry.attempts, 1); assert.equal(retry.nextAttemptAt, NOW + 10);
  assert.equal((await store.recoverDue()).length, 0);
  for (let attempt = 0; attempt < 4; attempt++) { now += 60_000; await store.recoverDue(); }
  assert.equal((await store.listDeliveries())[0].status, 'dead_letter'); assert.equal(calls, 5);
  const recovered = await store.retry(first.id); assert.equal(recovered.status, 'retry'); assert.equal(recovered.attempts, 0); await store.process(recovered.id); assert.equal(calls, 6); assert.equal((await store.listDeliveries())[0].attempts, 1);
});

test('inbound processing resumes after restart and does not run concurrent deliveries for one session', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-inbound-restart-')); t.after(() => rm(root, { recursive: true, force: true }));
  let now = NOW; let active = 0; let maxActive = 0; let allowFinish;
  const entered = new Promise(resolve => { allowFinish = resolve; });
  const secrets = memorySecrets(); const baseOptions = { secrets, now: () => now, autoProcess: false, createSession: async () => ({ id: 'shared-session' }), retryBaseMs: 5 };
  const firstStore = new InboundMessageStore(root, { ...baseOptions, onMessage: async () => { active++; maxActive = Math.max(maxActive, active); await entered; active--; return { status: 'processed' }; } });
  await configure(firstStore, secrets);
  const timestamp = String(NOW / 1000); const body1 = payload({ messageId: 'first' }); const body2 = payload({ messageId: 'second' });
  const firstAccepted = await firstStore.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'first', text: 'hello', source: 'alice', timestamp, signature: sign('secret', timestamp, body1), body: body1 });
  const firstPromise = firstStore.process(firstAccepted.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  const secondAccepted = await firstStore.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'second', text: 'hello', source: 'alice', timestamp, signature: sign('secret', timestamp, body2), body: body2 }); const secondPromise = firstStore.process(secondAccepted.id);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(maxActive, 1); allowFinish(); await Promise.all([firstPromise, secondPromise]);
  const pendingBody = payload({ messageId: 'pending' });
  const pendingAccepted = await firstStore.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'pending', text: 'hello', source: 'alice', timestamp, signature: sign('secret', timestamp, pendingBody), body: pendingBody });
  const file = path.join(root, '.agent-data', 'inbound-messages.json'); const data = JSON.parse(await readFile(file, 'utf8'));
  const pending = Object.values(data.deliveries).find(item => item.id === pendingAccepted.id); pending.status = 'processing'; pending.nextAttemptAt = null; await (await import('node:fs/promises')).writeFile(file, JSON.stringify(data));
  const recovered = new InboundMessageStore(root, { ...baseOptions, onMessage: async () => ({ status: 'processed' }) });
  assert.equal((await recovered.listDeliveries()).find(item => item.id === pending.id).status, 'retry');
  assert.equal((await recovered.recoverDue()).length, 1);
});

test('inbound scheduler recovers accepted work and stops cleanly', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-inbound-scheduler-')); t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = memorySecrets(); let processed = 0;
  const store = new InboundMessageStore(root, { secrets, autoProcess: false, createSession: async () => ({ id: 'session' }), onMessage: async () => { processed++; return { status: 'processed' }; } });
  await configure(store, secrets);
  const timestamp = String(Math.floor(Date.now() / 1000)); const body = payload({ messageId: 'scheduled' });
  const accepted = await store.accept({ channel: 'hook', externalConversation: 'chat', messageId: 'scheduled', text: 'hello', source: 'alice', timestamp, signature: sign('secret', timestamp, body), body });
  await store.startScheduler({ pollMs: 250 });
  const end = Date.now() + 1500; while (!processed && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  store.stopScheduler();
  assert.equal(processed, 1); assert.equal((await store.listDeliveries()).find(item => item.id === accepted.id).status, 'processed'); assert.equal(store.timer, null);
});

test('inbound Agent runner exposes only read-only workspace tools and reuses its isolated session', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-inbound-runner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new Sessions(root); const session = await sessions.create(); let observed;
  const runner = createInboundMessageRunner({ workspaceRoot: root, models: { async get() { return { model: 'test', url: 'https://example.invalid/v1', apiKey: 'unused' }; } }, sessions,
    sandbox: { async verify() { return true; } }, audit: { auditReady: true, async record() {} },
    run: async options => { observed = options; return 'safe answer'; } });
  const result = await runner({ sessionId: session.id, text: 'inspect README', channel: 'hook', source: 'alice' });
  assert.equal(result.status, 'processed'); assert.equal(result.answer, 'safe answer');
  assert.deepEqual(observed.toolAllowlist, ['file_info', 'read_file', 'list_files', 'find_files', 'search_text']);
  assert.equal(observed.memory, undefined); assert.equal(observed.web, undefined); assert.equal(observed.mcp, undefined); assert.equal(observed.plugins, undefined);
  assert.equal(observed.userMessageMetadata.sourceId, 'hook:alice');
  const persisted = await sessions.get(session.id); assert.equal(persisted.messages.length, 0);
});
