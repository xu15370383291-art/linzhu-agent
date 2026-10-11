import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { LocalGateway } from '../backend/gateway/server.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';
import { GatewayTurnStore } from '../backend/gateway/turn-store.js';

async function listen(gateway, t) {
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const client of gateway.clients) client.close?.(); server.close(resolve); server.closeAllConnections?.(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readSseEvents(reader, count, timeoutMs = 2000) {
  const decoder = new TextDecoder(); let buffer = ''; const events = [];
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    let timer;
    const part = await Promise.race([reader.read(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`SSE event timeout after ${events.map(event => event.type).join(',')}`)), Math.max(1, deadline - Date.now())); })]).finally(() => clearTimeout(timer));
    if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const line = block.split('\n').find(value => value.startsWith('data:'));
      if (line) events.push(JSON.parse(line.slice(5).trimStart()));
    }
  }
  return events;
}

test('Gateway turn approval can be resumed once and rejects changed or replayed resources', async t => {
  const approvals = new ApprovalManager(); let calls = 0;
  const gateway = new LocalGateway({ token: 'turn-token', models: {}, sessions: { async get(id) { return { id, messages: [] }; } }, memory: {}, skills: {}, tasks: {}, messages: {}, approvals,
    runTurn: async input => {
      calls++;
      if (!input.approvalId) throw Object.assign(new Error('Approval required'), { code: 'APPROVAL_REQUIRED', approvalId: (await approvals.request({ type: 'turn.tool', operation: 'write_file', resource: { turnId: input.turnId, sessionId: input.sessionId, input: input.input, tool: 'write_file', details: { path: 'note.txt', content: 'safe' } }, metadata: { source: 'gateway', turnId: input.turnId, sessionId: input.sessionId, tool: 'write_file' } })).id, turnId: input.turnId, sessionId: input.sessionId });
      if (!approvals.consumeApproved(input.approvalId, { turnId: input.turnId, sessionId: input.sessionId, input: input.input, tool: 'write_file', details: { path: 'note.txt', content: input.content ?? 'safe' } })) throw Object.assign(new Error('Approval required'), { code: 'APPROVAL_REQUIRED', approvalId: input.approvalId, turnId: input.turnId, sessionId: input.sessionId });
      return { turnId: input.turnId, sessionId: input.sessionId, answer: '已完成' };
    },
  });
  const base = await listen(gateway, t); const headers = { Authorization: 'Bearer turn-token', 'Content-Type': 'application/json' };
  const firstBody = { turnId: 'turn-1', sessionId: 'session-1', input: '创建 note.txt' };
  const pending = await fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify(firstBody) }); assert.equal(pending.status, 202); const pendingBody = await pending.json(); assert.ok(pendingBody.approvalId);
  const resource = approvals.list().find(item => item.id === pendingBody.approvalId);
  await fetch(`${base}/api/approvals/${pendingBody.approvalId}`, { method: 'POST', headers, body: JSON.stringify({ decision: 'approved' }) });
  const completed = await fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ ...firstBody, approvalId: pendingBody.approvalId }) }); assert.equal(completed.status, 200); assert.equal((await completed.json()).answer, '已完成');
  const replay = await fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ ...firstBody, approvalId: pendingBody.approvalId }) }); assert.equal(replay.status, 422); assert.equal((await replay.json()).code, 'TURN_NOT_RESUMABLE'); assert.equal(calls, 2);
  assert.ok(resource.resourceHash);
});

test('Gateway streams turn/tool events, replays after Last-Event-ID, and exposes session history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-turn-events-')); t.after(() => rm(root, { recursive: true, force: true }));
  const session = { id: '00000000-0000-4000-8000-000000000001', title: 'Lifecycle', activeBranchId: 'main', branches: [{ id: 'main', headMessageId: 'm2' }], messages: [
    { role: 'user', content: 'hello', messageId: 'm1', branchId: 'main', parentMessageId: null },
    { role: 'tool', content: 'secret tool body', messageId: 'm1t', branchId: 'main', parentMessageId: 'm1' },
    { role: 'assistant', content: 'hello there', messageId: 'm2', branchId: 'main', parentMessageId: 'm1t' },
  ] };
  const approvals = new ApprovalManager({ root });
  const gateway = new LocalGateway({ root, models: {}, sessions: { async summaries() { return []; }, async get() { return session; } }, memory: {}, skills: {}, tasks: {}, messages: {}, approvals,
    runTurn: async ({ turnId, sessionId, onSession, onDelta, onStatus }) => {
      onSession?.(sessionId); onStatus({ phase: 'tool', name: 'read_file' }); onStatus({ phase: 'tool_finished', name: 'read_file', ok: true }); onDelta('partial answer');
      return { turnId, sessionId, answer: 'partial answer' };
    } });
  const base = await listen(gateway, t); const headers = { Authorization: 'Bearer client-a', 'Content-Type': 'application/json' };
  const eventResponse = await fetch(`${base}/api/events`, { headers: { Authorization: 'Bearer client-a' } }); const eventReader = eventResponse.body.getReader(); t.after(() => eventReader.cancel().catch(() => {}));
  const response = await fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ turnId: 'events-1', sessionId: session.id, input: 'hello' }) });
  assert.equal(response.status, 200);
  const turn = await (await fetch(`${base}/api/turns/events-1`, { headers })).json(); assert.equal(turn.status, 'completed'); assert.equal(Object.hasOwn(turn, 'output'), false);
  const events = gateway.turns.events.filter(event => event.payload.turnId === 'events-1');
  assert.equal(gateway.clients.size, 1);
  const eventTypes = events.map(event => event.type);
  assert.deepEqual(eventTypes.filter(type => ['turn.started', 'tool.started', 'tool.finished', 'turn.completed'].includes(type)), ['turn.started', 'tool.started', 'tool.finished', 'turn.completed']);
  assert.ok(eventTypes.includes('task.plan.updated'));
  assert.ok(eventTypes.includes('task.step.updated'));
  const storedTurn = await gateway.turns.get('events-1', gateway.clientIdentity({ headers }));
  assert.equal(storedTurn.plan.status, 'completed');
  assert.ok(storedTurn.plan.steps.some(step => step.tool === 'read_file' && step.status === 'completed'));
  assert.ok(events.some(event => event.type === 'tool.started'));
  assert.ok(events.some(event => event.type === 'tool.finished'));
  const liveEvents = await readSseEvents(eventReader, 5); assert.ok(liveEvents.some(event => event.type === 'turn.delta')); assert.ok(liveEvents.some(event => event.type === 'turn.completed')); await eventReader.cancel();
  const replay = await fetch(`${base}/api/events?turnId=events-1`, { headers: { Authorization: 'Bearer client-a', 'Last-Event-ID': events[0].id } });
  const reader = replay.body.getReader(); t.after(() => reader.cancel().catch(() => {})); const replayed = await readSseEvents(reader, 3); await reader.cancel();
  assert.ok(replayed.some(event => event.type === 'tool.started' || event.type === 'tool.finished'));
  const history = await (await fetch(`${base}/api/sessions/${session.id}`, { headers })).json();
  assert.deepEqual(history.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(JSON.stringify(history).includes('secret tool body'), false);
  const foreignIdentity = gateway.clientIdentity({ headers: {} });
  assert.equal(await gateway.turns.get('events-1', foreignIdentity), null);
  await assert.rejects(gateway.turns.replay(null, { turnId: 'events-1', clientIdentity: foreignIdentity }), { code: 'TURN_NOT_FOUND' });
  const replayedTurn = await fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ turnId: 'events-1', sessionId: session.id, input: 'hello' }) });
  assert.equal(replayedTurn.status, 422); assert.equal((await replayedTurn.json()).code, 'TURN_NOT_RESUMABLE');
  await new Promise(resolve => setTimeout(resolve, 120));
  const durable = await readFile(path.join(root, '.agent-data', 'gateway-turns.json'), 'utf8');
  assert.equal(durable.includes('partial answer'), false);
  assert.equal(durable.includes('turn.delta'), false);
});

test('Gateway cancellation aborts the active runner and reports a terminal state', async t => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const gateway = new LocalGateway({ token: 'cancel-client', models: {}, sessions: {}, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager(),
    runTurn: async ({ signal }) => new Promise((resolve, reject) => {
      started();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
  const base = await listen(gateway, t); const headers = { Authorization: 'Bearer cancel-client', 'Content-Type': 'application/json' };
  const turnPromise = fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ turnId: 'cancel-1', input: 'wait' }) });
  await entered;
  const cancelled = await fetch(`${base}/api/turns/cancel-1/cancel`, { method: 'POST', headers, body: '{}' }); assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).status, 'cancelling');
  const response = await turnPromise; assert.equal(response.status, 422); assert.equal((await response.json()).code, 'CANCELLED');
  const state = await (await fetch(`${base}/api/turns/cancel-1`, { headers })).json(); assert.equal(state.status, 'cancelled');
  assert.equal(state.plan.status, 'cancelled');
});

test('Gateway turn history survives restart and unfinished turns become interrupted', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-turn-restart-')); t.after(() => rm(root, { recursive: true, force: true }));
  const owner = 'client-fingerprint';
  const first = new GatewayTurnStore(root);
  first.items.set('crash-1', { id: 'crash-1', clientIdentity: owner, inputHash: 'hash', status: 'running', plan: { version: 1, status: 'running', goal: '恢复任务', steps: [{ id: 'step-1', label: '读取文件', status: 'running' }] }, createdAt: Date.now(), updatedAt: Date.now() });
  await first.persist();
  const restarted = new GatewayTurnStore(root); const state = await restarted.get('crash-1', owner);
  assert.equal(state.status, 'interrupted'); assert.equal(state.errorCode, 'GATEWAY_RESTARTED'); assert.equal(state.plan.status, 'interrupted'); assert.equal(state.plan.steps[0].status, 'interrupted');
});

test('approval resource binding rejects a different client identity and changed input', async () => {
  const approvals = new ApprovalManager();
  const resource = { turnId: 't', sessionId: 's', clientIdentity: 'client-a', input: 'write x', tool: 'write_file', details: { path: 'x.txt', content: 'x' } };
  const approval = await approvals.request({ type: 'turn.tool', operation: 'write_file', resource, metadata: { source: 'gateway', turnId: 't', sessionId: 's', clientIdentity: 'client-a', tool: 'write_file' } });
  await approvals.resolve(approval.id, 'approved');
  assert.throws(() => approvals.consumeApproved(approval.id, { ...resource, clientIdentity: 'client-b' }), { code: 'APPROVAL_RESOURCE_CHANGED' });
  assert.throws(() => approvals.consumeApproved(approval.id, { ...resource, input: 'write other' }), { code: 'APPROVAL_RESOURCE_CHANGED' });
  assert.equal(approvals.consumeApproved(approval.id, resource), true);
});

test('failed turns can be retried from the persisted user request, but active turns cannot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-turn-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = '00000000-0000-4000-8000-000000000009';
  const session = { id: sessionId, title: 'Retry', activeBranchId: 'main', branches: [{ id: 'main', headMessageId: null }], messages: [{ role: 'user', content: '读取 notes.txt' }] };
  let calls = 0;
  const approvals = new ApprovalManager({ root });
  const gateway = new LocalGateway({ root, token: 'retry-client', models: {}, sessions: { async get(id) { assert.equal(id, sessionId); return session; } }, memory: {}, skills: {}, tasks: {}, messages: {}, approvals,
    runTurn: async input => { calls++; if (calls === 1) throw Object.assign(new Error('temporary failure'), { code: 'TEMPORARY_FAILURE', sessionId }); return { sessionId, answer: '重试成功' }; },
  });
  const base = await listen(gateway, t); const headers = { Authorization: 'Bearer retry-client', 'Content-Type': 'application/json' };
  const first = await fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ turnId: 'retry-original', sessionId, input: '读取 notes.txt' }) });
  assert.equal(first.status, 422); assert.equal((await first.json()).code, 'TEMPORARY_FAILURE');
  const retry = await fetch(`${base}/api/turns/retry-original/retry`, { method: 'POST', headers, body: '{}' });
  const retryBody = await retry.json(); assert.equal(retry.status, 200, JSON.stringify(retryBody)); const retried = retryBody; assert.equal(retried.answer, '重试成功'); assert.notEqual(retried.turnId, 'retry-original');
  const state = await gateway.turns.get(retried.turnId, gateway.clientIdentity({ headers })); assert.equal(state.retryOf, 'retry-original');
  assert.equal(calls, 2);
  const activeGateway = new LocalGateway({ token: 'active-client', models: {}, sessions: { async get() { return session; } }, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager(), runTurn: async ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' })), { once: true })) });
  const activeBase = await listen(activeGateway, t); const activeHeaders = { Authorization: 'Bearer active-client', 'Content-Type': 'application/json' };
  const pending = fetch(`${activeBase}/api/turns`, { method: 'POST', headers: activeHeaders, body: JSON.stringify({ turnId: 'active-retry', sessionId, input: '等待' }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  const rejected = await fetch(`${activeBase}/api/turns/active-retry/retry`, { method: 'POST', headers: activeHeaders, body: '{}' });
  assert.equal(rejected.status, 422); assert.equal((await rejected.json()).code, 'TURN_NOT_RETRYABLE');
  await activeGateway.turns.cancel('active-retry', activeGateway.clientIdentity({ headers: activeHeaders })).catch(() => {}); await pending.catch(() => {});
});

test('explicit skill selection is bound to a turn and retained when retrying a failed turn', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-skill-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = '00000000-0000-4000-8000-000000000049';
  const session = { id: sessionId, title: 'Skill retry', activeBranchId: 'main', branches: [{ id: 'main', headMessageId: null }], messages: [{ role: 'user', content: '整理这些内容' }] };
  let calls = 0; const received = [];
  const gateway = new LocalGateway({ root, token: 'skill-retry-client', models: {}, sessions: { async get() { return session; } }, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager({ root }),
    runTurn: async input => { received.push({ skillId: input.skillId, skillReference: input.skillReference }); if (calls++ === 0) throw Object.assign(new Error('temporary failure'), { code: 'TEMPORARY_FAILURE', sessionId }); return { sessionId, answer: '完成' }; },
  });
  const base = await listen(gateway, t); const headers = { Authorization: 'Bearer skill-retry-client', 'Content-Type': 'application/json' };
  const skillReference = { skillId: 'meeting-notes', displayName: '会议纪要', offset: 2 };
  const first = await fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ turnId: 'skill-retry-original', sessionId, input: '整理这些内容', skillId: 'meeting-notes', skillReference }) });
  assert.equal(first.status, 422);
  const retry = await fetch(`${base}/api/turns/skill-retry-original/retry`, { method: 'POST', headers, body: '{}' });
  assert.equal(retry.status, 200, JSON.stringify(await retry.clone().json()));
  assert.deepEqual(received, [{ skillId: 'meeting-notes', skillReference }, { skillId: 'meeting-notes', skillReference }]);
});

test('interrupted structured turns recover from the last checkpoint without losing completed steps', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-plan-recover-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = '00000000-0000-4000-8000-000000000019';
  const input = '创建一个小型项目';
  const session = { id: sessionId, title: 'Recovery', activeBranchId: 'main', branches: [{ id: 'main', headMessageId: null }], messages: [{ role: 'user', content: input }] };
  const owner = createHash('sha256').update('Bearer recover-client').digest('hex').slice(0, 24); let resumed;
  const store = new GatewayTurnStore(root);
  store.items.set('recover-plan', { id: 'recover-plan', sessionId, clientIdentity: owner, input, inputHash: (await import('node:crypto')).createHash('sha256').update(`${input}\u0000`).digest('hex'), status: 'running', plan: { version: 1, status: 'running', goal: input, steps: [] }, structuredPlan: { version: 1, id: 'plan-id', revision: 1, status: 'running', goal: input, phases: [{ id: 'build', title: '实现', dependsOn: [], acceptance: { type: 'all_steps' }, status: 'running' }], steps: [
    { id: 'inspect', phaseId: 'build', title: '检查', status: 'completed', dependsOn: [], tools: ['list_files'], acceptance: { type: 'tool_success' }, retryPolicy: { maxAttempts: 2, mode: 'safe' }, attempts: 1 },
    { id: 'write', phaseId: 'build', title: '写入', status: 'running', dependsOn: ['inspect'], tools: ['write_file'], sideEffect: true, acceptance: { type: 'file_exists', path: 'index.js' }, retryPolicy: { maxAttempts: 2, mode: 'safe' }, attempts: 0 },
  ], checkpoints: [] }, createdAt: Date.now(), updatedAt: Date.now() });
  await store.persist();
  const gateway = new LocalGateway({ root, token: 'recover-client', models: {}, sessions: { async get() { return session; } }, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager(), runTurn: async options => { resumed = options; options.onPlan(options.structuredPlan); return { answer: '已恢复', sessionId }; } });
  gateway.turns = store;
  const base = await listen(gateway, t); const headers = { Authorization: 'Bearer recover-client', 'Content-Type': 'application/json' };
  await store.load(); assert.equal((await store.get('recover-plan', owner)).status, 'interrupted');
  const response = await fetch(`${base}/api/turns/recover-plan/recover`, { method: 'POST', headers, body: '{}' });
  const responseBody = await response.json(); assert.equal(response.status, 200, JSON.stringify(responseBody)); assert.equal(responseBody.answer, '已恢复'); assert.equal(Object.hasOwn(responseBody, 'input'), false);
  assert.equal(resumed.structuredPlan.steps[0].status, 'completed'); assert.equal(resumed.structuredPlan.steps[1].status, 'uncertain');
  assert.equal((await store.get('recover-plan', owner)).status, 'completed');
});

test('single-step retry requires confirmation for uncertain effects and leaves completed steps intact', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-plan-step-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = '创建并测试项目'; const owner = 'retry-owner'; const sessionId = 'retry-session';
  const store = new GatewayTurnStore(root);
  const plan = { version: 1, id: 'plan-retry', revision: 1, status: 'failed', goal: input, phases: [
    { id: 'build', title: '构建', dependsOn: [], acceptance: { type: 'all_steps' }, acceptanceStatus: 'pending', status: 'failed' },
  ], steps: [
    { id: 'inspect', phaseId: 'build', title: '读取', status: 'completed', dependsOn: [], tools: ['list_files'], acceptance: { type: 'tool_success' }, retryPolicy: { maxAttempts: 2, mode: 'safe' }, attempts: 1 },
    { id: 'write', phaseId: 'build', title: '写入', status: 'uncertain', sideEffect: true, dependsOn: ['inspect'], tools: ['write_file'], acceptance: { type: 'file_exists', path: 'app.js' }, retryPolicy: { maxAttempts: 2, mode: 'safe' }, attempts: 0 },
  ], checkpoints: [] };
  const { createHash } = await import('node:crypto');
  store.items.set('retry-plan', { id: 'retry-plan', sessionId, clientIdentity: owner, input, inputHash: createHash('sha256').update(`${input}\u0000`).digest('hex'), status: 'failed', structuredPlan: plan, createdAt: Date.now(), updatedAt: Date.now() });
  await store.persist();
  await assert.rejects(store.retryStep('retry-plan', 'write', owner, async () => { throw new Error('must not run'); }, { input }), { code: 'PLAN_STEP_OUTCOME_UNCERTAIN' });
  let received;
  const result = await store.retryStep('retry-plan', 'write', owner, async options => {
    received = options;
    const step = options.structuredPlan.steps.find(value => value.id === 'write');
    step.status = 'completed'; step.attempts = 1; step.acceptanceStatus = 'passed';
    options.onPlan(options.structuredPlan);
    return { answer: 'step done', sessionId };
  }, { input, confirmUncertain: true });
  assert.equal(result.status, 'completed'); assert.equal(received.retryStepId, 'write');
  const saved = (await store.get('retry-plan', owner)).structuredPlan;
  assert.equal(saved.steps.find(value => value.id === 'inspect').status, 'completed');
  assert.equal(saved.steps.find(value => value.id === 'write').status, 'completed');
});

test('Gateway retry-step endpoint is scoped to one validated step', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-retry-step-api-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = '验证一个失败步骤'; const sessionId = '00000000-0000-4000-8000-000000000021'; let received;
  const owner = createHash('sha256').update('Bearer retry-step-api').digest('hex').slice(0, 24);
  const store = new GatewayTurnStore(root);
  store.items.set('retry-step-api-turn', { id: 'retry-step-api-turn', sessionId, clientIdentity: owner, input, inputHash: createHash('sha256').update(`${input}\u0000`).digest('hex'), status: 'failed', structuredPlan: {
    version: 1, id: 'api-plan', revision: 1, status: 'failed', goal: input, phases: [{ id: 'phase', title: '验证', dependsOn: [], acceptance: { type: 'all_steps' }, acceptanceStatus: 'pending', status: 'failed' }],
    steps: [{ id: 'step', phaseId: 'phase', title: '重新读取', status: 'failed', dependsOn: [], tools: ['read_file'], sideEffect: false, acceptance: { type: 'tool_success' }, retryPolicy: { maxAttempts: 2, mode: 'safe' }, attempts: 1 }], checkpoints: [],
  }, createdAt: Date.now(), updatedAt: Date.now() });
  await store.persist();
  const gateway = new LocalGateway({ root, token: 'retry-step-api', models: {}, sessions: { async get(id) { return { id, messages: [] }; } }, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager(),
    runTurn: async options => { received = options; const step = options.structuredPlan.steps.find(value => value.id === 'step'); step.status = 'completed'; step.attempts = 2; step.acceptanceStatus = 'passed'; await options.onPlan(options.structuredPlan); return { answer: '步骤完成', sessionId }; } });
  gateway.turns = store;
  const base = await listen(gateway, t); const headers = { Authorization: 'Bearer retry-step-api', 'Content-Type': 'application/json' };
  const response = await fetch(`${base}/api/turns/retry-step-api-turn/retry-step`, { method: 'POST', headers, body: JSON.stringify({ stepId: 'step' }) });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.status, 'completed');
  assert.equal(received.retryStepId, 'step'); assert.equal(received.input, input);
  const saved = await store.get('retry-step-api-turn', owner);
  assert.equal(saved.structuredPlan.steps[0].status, 'completed'); assert.equal(saved.status, 'completed');
});

test('Gateway pauses for a generic clarification and resumes only with one of its options', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-clarification-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = '00000000-0000-4000-8000-000000000010';
  const session = { id: sessionId, title: 'Clarify', activeBranchId: 'main', branches: [{ id: 'main', headMessageId: null }], messages: [{ role: 'user', content: '找到简历并整理成 Markdown 文件' }] };
  let calls = 0;
  const clarification = { question: '找到多个简历，选择要处理的文件', options: [{ id: 'resume-a', label: 'D:\\资料\\简历-A.pdf' }, { id: 'resume-b', label: 'D:\\资料\\简历-B.pdf' }] };
  const gateway = new LocalGateway({ root, token: 'clarify-client', models: {}, sessions: { async get(id) { assert.equal(id, sessionId); return session; } }, memory: {}, skills: {}, tasks: {}, messages: {}, approvals: new ApprovalManager({ root }),
    runTurn: async input => { calls++; if (!input.clarificationContext) throw Object.assign(new Error('Waiting for the user to choose an option'), { code: 'USER_CLARIFICATION_REQUIRED', clarification }); return { sessionId, answer: `已处理 ${input.clarificationContext.selectedLabel}` }; },
  });
  const base = await listen(gateway, t); const headers = { Authorization: 'Bearer clarify-client', 'Content-Type': 'application/json' };
  const first = await fetch(`${base}/api/turns`, { method: 'POST', headers, body: JSON.stringify({ turnId: 'clarify-1', sessionId, input: session.messages[0].content }) });
  assert.equal(first.status, 202); const firstBody = await first.json(); assert.equal(firstBody.code, 'USER_CLARIFICATION_REQUIRED');
  const pending = await (await fetch(`${base}/api/turns/clarify-1`, { headers })).json(); assert.equal(pending.status, 'awaiting_clarification'); assert.equal(pending.clarification.options.length, 2);
  const invalid = await fetch(`${base}/api/turns/clarify-1/clarify`, { method: 'POST', headers, body: JSON.stringify({ optionId: 'not-an-option' }) }); assert.equal(invalid.status, 422); assert.equal((await invalid.json()).code, 'CLARIFICATION_OPTION_INVALID');
  const selected = await fetch(`${base}/api/turns/clarify-1/clarify`, { method: 'POST', headers, body: JSON.stringify({ optionId: 'resume-b' }) }); assert.equal(selected.status, 200); assert.match((await selected.json()).answer, /简历-B/); assert.equal(calls, 2);
  const completed = await (await fetch(`${base}/api/turns/clarify-1`, { headers })).json(); assert.equal(completed.status, 'completed'); assert.equal(completed.clarification, null);
});
