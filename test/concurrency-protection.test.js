import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GatewayTurnStore } from '../backend/gateway/turn-store.js';
import { Workspace } from '../backend/workspace.js';
import { LocalGateway } from '../backend/gateway/server.js';

async function listen(gateway, t) {
  const server = gateway.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('same-session turns are rejected while another turn is active, other sessions proceed', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-session-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayTurnStore(root);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const runner = async ({ signal }) => {
    await Promise.race([blocked, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    return { sessionId: 'session-a', answer: 'done' };
  };
  const first = store.start({ turnId: 'turn-a', sessionId: 'session-a', input: 'first' }, runner, 'client-a');
  for (let attempt = 0; attempt < 50 && !store.activeSessions.has('session-a'); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(store.activeSessions.get('session-a'), 'turn-a');
  await assert.rejects(store.start({ turnId: 'turn-b', sessionId: 'session-a', input: 'second' }, runner, 'client-a'), { code: 'SESSION_TURN_CONFLICT' });
  const other = store.start({ turnId: 'turn-c', sessionId: 'session-b', input: 'other' }, async () => ({ sessionId: 'session-b', answer: 'other' }), 'client-a');
  await other;
  release();
  await first;
  const again = await store.start({ turnId: 'turn-d', sessionId: 'session-a', input: 'after' }, async () => ({ sessionId: 'session-a', answer: 'after' }), 'client-a');
  assert.equal(again.sessionId, 'session-a');
});

test('HTTP turn endpoint rejects a concurrent request for the same session', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-http-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = new LocalGateway({ root, token: 'concurrency-client', models: {}, sessions: { async get(id) { return { id, messages: [] }; } }, memory: {}, skills: {}, tasks: {}, messages: {},
    runTurn: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      setTimeout(() => resolve({ sessionId: 'shared-session', answer: 'done' }), 120);
    }) });
  const base = await listen(gateway, t);
  const headers = { Authorization: 'Bearer concurrency-client', 'Content-Type': 'application/json' };
  const first = fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ turnId: 'http-a', sessionId: 'shared-session', input: 'first' }) });
  for (let attempt = 0; attempt < 50 && !gateway.turns.activeSessions.has('shared-session'); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  const second = await fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ turnId: 'http-b', sessionId: 'shared-session', input: 'second' }) });
  assert.equal(second.status, 422);
  assert.equal((await second.json()).code, 'SESSION_TURN_CONFLICT');
  assert.equal((await first).status, 200);
});

test('write commit rejects a file changed after preview with a stable conflict code', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-file-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = new Workspace(root);
  await writeFile(path.join(root, 'shared.txt'), 'original');
  const preview = await workspace.prepareChange('shared.txt', { content: 'agent update' });
  await writeFile(path.join(root, 'shared.txt'), 'other task update');
  await assert.rejects(workspace.commitChange(preview), { code: 'FILE_CHANGED_SINCE_PREVIEW' });
  assert.equal(await readFile(path.join(root, 'shared.txt'), 'utf8'), 'other task update');
});
