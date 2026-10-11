import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { Sessions } from '../backend/sessions.js';
import { createGatewayTurnRunner } from '../backend/gateway/turn-runner.js';

test('Gateway persists a user question and model configuration failure in the session', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-session-failure-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = new Sessions(root);
  const runner = createGatewayTurnRunner({ root, sessions, models: { get: async () => null }, audit: { auditReady: true } });
  let failure;
  await assert.rejects(runner({ input: '读取外部文件', turnId: 'failure-config-1' }), error => { failure = error; return error.code === 'MODEL_NOT_CONFIGURED'; });
  const session = await sessions.get(failure.sessionId);
  assert.deepEqual(session.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(session.messages[0].content, '读取外部文件');
  assert.match(session.messages[1].content, /MODEL_NOT_CONFIGURED/);
  assert.match((await sessions.summaries())[0].title, /读取外部文件/);
});

test('Gateway persists provider HTTP errors with the sanitized detail', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-session-failure-provider-'));
  const upstream = http.createServer(async (_req, res) => { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('provider rejected request'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const sessions = new Sessions(root);
  const models = { get: async () => ({ model: 'test', apiKey: 'test-key', url: `http://127.0.0.1:${upstream.address().port}/v1`, streaming: false }) };
  const runner = createGatewayTurnRunner({ root, sessions, models, audit: { auditReady: true }, sandbox: { verify: async () => true, readOperation: async () => ({}), readExternal: async () => ({}), execute: async () => ({}) } });
  let failure;
  await assert.rejects(runner({ input: '测试接口失败', turnId: 'failure-provider-1' }), error => { failure = error; return error.code === 'REQUEST'; });
  const session = await sessions.get(failure.sessionId);
  assert.equal(session.messages[0].content, '测试接口失败');
  assert.match(session.messages[1].content, /模型接口返回 HTTP 400/);
  assert.match(session.messages[1].content, /provider rejected request/);
  assert.equal(JSON.stringify(session).includes('test-key'), false);
  assert.equal((await readFile(path.join(root, '.agent-data', 'sessions', `${session.id}.json`), 'utf8')).includes('provider rejected request'), true);
});
