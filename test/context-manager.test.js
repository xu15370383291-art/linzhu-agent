import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sessions } from '../backend/sessions.js';
import { ContextManager } from '../backend/context/manager.js';
import { runTurn } from '../backend/agent.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-context-'));
  const sessions = new Sessions(root);
  return { sessions, session: await sessions.create() };
}

test('compaction preserves original transcript and survives session reload', async () => {
  const { sessions, session } = await fixture();
  for (let i = 0; i < 5; i++) session.messages.push({ role: 'user', content: `ask ${i}` }, { role: 'assistant', content: `answer ${i}` });
  const original = structuredClone(session.messages);
  const manager = new ContextManager(session);
  const summaryRequest = async (messages, tools, options) => {
    assert.deepEqual(tools, []);
    assert.equal(options.toolChoice, 'none');
    return { choices: [{ message: { content: 'Goal: continue task; verified path: docs/test.md' } }] };
  };
  assert.equal(await manager.compact(summaryRequest), true);
  assert.deepEqual(session.messages, original);
  assert.equal(session.context.startIndex, 4);
  const view = manager.project();
  assert.match(view.messages[0].content, /verified path/);
  assert.equal(view.messages[1].content, 'ask 2');
  await sessions.save(session);
  const restored = await sessions.get(session.id);
  assert.equal(new ContextManager(restored).project().messages[1].content, 'ask 2');
});

test('compaction retains complete tool-call/result pairs in the model view', async () => {
  const { session } = await fixture();
  session.messages.push(
    { role: 'user', content: 'old turn' }, { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'read' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'call-a', content: 'large result' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'follow up' }, { role: 'assistant', content: 'ok' },
  );
  const manager = new ContextManager(session);
  await manager.compact(async () => ({ choices: [{ message: { content: 'Older turn summary' } }] }), [], { force: true });
  const view = manager.project().messages;
  assert.equal(view.some(message => message.tool_calls?.some(call => call.id === 'call-a')), false);
  assert.equal(view.some(message => message.tool_call_id === 'call-a'), false);
  assert.equal(session.messages.some(message => message.tool_call_id === 'call-a'), true);
});

test('failed summary leaves checkpoint intact', async () => {
  const { session } = await fixture();
  for (let i = 0; i < 5; i++) session.messages.push({ role: 'user', content: `${i}` }, { role: 'assistant', content: 'ok' });
  const manager = new ContextManager(session);
  await assert.rejects(manager.compact(async () => ({ choices: [{ message: { content: '' } }] })), /summary failed/);
  assert.equal(session.context.startIndex, 0);
  assert.equal(session.context.summary, null);
});

test('reset hides old turns without deleting durable messages', async () => {
  const { session } = await fixture();
  session.messages.push({ role: 'user', content: 'secret earlier request' }, { role: 'assistant', content: 'done' });
  const manager = new ContextManager(session);
  manager.reset();
  assert.deepEqual(manager.project().messages, []);
  assert.equal(session.messages.length, 2);
});

test('overlarge current turn fails without damaging session', async () => {
  const { session } = await fixture();
  const manager = new ContextManager(session, { contextWindow: 2048, outputReserve: 256 });
  await assert.rejects(manager.prepare([{ role: 'user', content: 'x'.repeat(5000) }], [], async () => { throw new Error('must not summarize'); }), /Context exceeds/);
  assert.deepEqual(session.messages, []);
});

test('automatic compaction can keep one turn when keeping three does not fit', async () => {
  const { session } = await fixture();
  for (let i = 0; i < 4; i++) session.messages.push(
    { role: 'user', content: `question ${i} ${'x'.repeat(1400)}` },
    { role: 'assistant', content: `answer ${i} ${'y'.repeat(1400)}` },
  );
  const manager = new ContextManager(session, { contextWindow: 4096, outputReserve: 512 });
  const request = async () => ({ choices: [{ message: { content: 'Earlier verified conversation summarized.' } }] });
  const view = await manager.prepare([{ role: 'user', content: 'continue' }], [], request, { systemPrompt: 'system' });
  assert.equal(view.status.fits, true);
  assert.equal(session.context.startIndex, 6);
  assert.equal(session.messages.length, 8);
});

test('provider overflow retries only after reducing the context', async () => {
  const { session } = await fixture();
  for (let i = 0; i < 4; i++) session.messages.push({ role: 'user', content: `request ${i}` }, { role: 'assistant', content: 'x'.repeat(300) });
  let normalCalls = 0;
  const request = async (messages, _tools, options) => {
    if (options.toolChoice === 'none') return { choices: [{ message: { content: 'Goal: previous requests; no pending changes' } }] };
    normalCalls++;
    if (normalCalls === 1) throw new Error('context length exceeded');
    assert.ok(messages.some(message => String(message.content).includes('Historical context summary')));
    return { choices: [{ message: { role: 'assistant', content: 'recovered' } }], usage: { prompt_tokens: 120 } };
  };
  assert.equal(await runTurn({ session, input: 'continue', request }), 'recovered');
  assert.equal(normalCalls, 2);
  assert.equal(session.context.lastUsage.prompt_tokens, 120);
  assert.equal(session.messages.at(-1).content, 'recovered');
});

test('unrecoverable overflow does not resend an identical request', async () => {
  const { session } = await fixture();
  let calls = 0;
  await assert.rejects(runTurn({ session, input: 'hello', request: async () => {
    calls++;
    throw new Error('context length exceeded');
  } }), /no further reduction/);
  assert.equal(calls, 1);
  assert.deepEqual(session.messages, []);
});

test('current tool output is shortened only in model-facing context', async () => {
  const { session } = await fixture();
  const manager = new ContextManager(session);
  const active = [
    { role: 'user', content: 'read file' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'read-1' }] },
    { role: 'tool', tool_call_id: 'read-1', content: 'a'.repeat(30000) },
  ];
  const view = await manager.prepare(active, [], async () => { throw new Error('unexpected summary request'); });
  assert.equal(view.truncated, 1);
  assert.match(view.messages.at(-1).content, /truncated/);
  assert.equal(view.messages.at(-1).tool_call_id, 'read-1');
  assert.equal(active.at(-1).content.length, 30000);
});

test('authentication errors mentioning tokens are not retried as overflow', async () => {
  const { session } = await fixture();
  let calls = 0;
  await assert.rejects(runTurn({ session, input: 'hello', request: async () => {
    calls++;
    throw new Error('Model API returned 401: invalid token');
  } }), /invalid token/);
  assert.equal(calls, 1);
});
