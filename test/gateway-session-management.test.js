import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalGateway } from '../backend/gateway/server.js';
import { Sessions } from '../backend/sessions.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';

test('Gateway exposes session rename and branch management without changing turn execution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-session-management-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new Sessions(root);
  const session = await sessions.create();
  session.messages.push({ role: 'user', content: '保留这段对话' }, { role: 'assistant', content: '完整内容' });
  await sessions.save(session);
  const gateway = new LocalGateway({
    root, sessions, approvals: new ApprovalManager(), models: {}, memory: {}, skills: {}, tasks: {}, messages: {},
  });
  const server = gateway.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json' };
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });

  const renamed = await post(`/api/sessions/${session.id}/rename`, { title: '研究任务' });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).title, '研究任务');

  const forked = await post(`/api/sessions/${session.id}/fork`, { name: '实验分支' });
  assert.equal(forked.status, 200);
  const branch = (await forked.json()).branch;
  assert.equal(branch.name, '实验分支');

  const listed = await fetch(`${base}/api/sessions/${session.id}/branches`);
  assert.deepEqual((await listed.json()).activeBranchId, branch.id);

  const switched = await post(`/api/sessions/${session.id}/branch`, { branchId: 'main' });
  assert.equal(switched.status, 200);
  assert.equal((await switched.json()).activeBranchId, 'main');

  const invalid = await post(`/api/sessions/${session.id}/rename`, { title: '' });
  assert.equal(invalid.status, 422);

  const archived = await post(`/api/sessions/${session.id}/archive`, {});
  assert.equal(archived.status, 200);
  assert.ok((await archived.json()).archivedAt);
  assert.equal((await sessions.get(session.id)).messages.length, 2);
  const activeList = await (await fetch(`${base}/api/sessions`)).json();
  const archiveList = await (await fetch(`${base}/api/sessions?archived=true`)).json();
  assert.equal(activeList.some(item => item.id === session.id), false);
  assert.equal(archiveList.some(item => item.id === session.id), true);
  assert.ok((await (await fetch(`${base}/api/sessions/${session.id}`)).json()).archivedAt);

  const restored = await post(`/api/sessions/${session.id}/restore`, {});
  assert.equal(restored.status, 200);
  assert.equal((await sessions.get(session.id)).archivedAt, undefined);
  assert.equal((await (await fetch(`${base}/api/sessions`)).json()).some(item => item.id === session.id), true);
});

test('Gateway refuses to archive a session with an active turn', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-session-archive-active-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new Sessions(root);
  const session = await sessions.create();
  const gateway = new LocalGateway({ root, sessions, approvals: new ApprovalManager(), models: {}, memory: {}, skills: {}, tasks: {}, messages: {} });
  gateway.turns.items.set('active-turn', { id: 'active-turn', sessionId: session.id, status: 'running' });
  const server = gateway.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sessions/${session.id}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'SESSION_TURN_ACTIVE');
  assert.equal((await sessions.get(session.id)).archivedAt, undefined);
});

test('Gateway blocks new turns in archived sessions until restored', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-session-archive-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new Sessions(root);
  const session = await sessions.create();
  session.messages.push({ role: 'user', content: '旧请求' });
  await sessions.save(session);
  await sessions.archive(session.id);
  const gateway = new LocalGateway({ root, sessions, approvals: new ApprovalManager(), models: {}, memory: {}, skills: {}, tasks: {}, messages: {}, runTurn: async () => ({ answer: 'unexpected' }) });
  const server = gateway.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '继续', sessionId: session.id, turnId: 'archived-turn' }) });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'SESSION_ARCHIVED');
  assert.equal(gateway.turns.items.has('archived-turn'), false);
});
