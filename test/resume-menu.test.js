import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { chooseSession, transcript } from '../backend/resume-menu.js';

const items = [
  { id: 'a', title: '第一个问题', updatedAt: '2026-09-27T12:00:00Z', messageCount: 1 },
  { id: 'b', title: '第二个问题', updatedAt: '2026-09-28T12:00:00Z', messageCount: 2 },
];
function io() {
  const input = new PassThrough(); const output = new PassThrough();
  input.isTTY = output.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.rows = 7; output.columns = 80;
  return { input, output };
}
test('resume menu searches, navigates, cancels and restores raw mode', async () => {
  const a = io(); const chosen = chooseSession(items, a.input, a.output);
  a.input.write('第二\r');
  assert.equal((await chosen).id, 'b');
  assert.equal(a.input.isRaw, false);
  const b = io(); const wrapped = chooseSession(items, b.input, b.output);
  b.input.write('\x1b[A\r');
  assert.equal((await wrapped).id, 'b');
  const c = io(); const cancelled = chooseSession(items, c.input, c.output);
  c.input.write('\x03');
  assert.equal(await cancelled, null);
});
test('transcript excludes tool payload and shows recent conversation', () => {
  assert.equal(transcript({ messages: [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: null, tool_calls: [{ id: 'x' }] },
    { role: 'tool', content: 'private tool output' }, { role: 'assistant', content: 'hi' },
  ] }), 'You> hello\nAgent> hi');
});

test('resume preview limits long messages while full history remains intact', () => {
  const session = { messages: [{ role: 'user', content: 'question' }, { role: 'assistant', content: 'answer'.repeat(100) }] };
  assert.match(transcript(session, 6, 12), /answeranswer…/);
  assert.equal(transcript(session, Infinity).includes('answer'.repeat(100)), true);
});

test('resume filters with backspace and does not wrap long session titles', async () => {
  const { input, output } = io();
  output.columns = 40;
  let rendered = '';
  output.on('data', chunk => { rendered += chunk.toString(); });
  const selection = chooseSession([{ ...items[0], title: '很长的中文会话标题'.repeat(8) }, items[1]], input, output);
  input.write('无\x7f第二\r');
  assert.equal((await selection).id, 'b');
  assert.match(rendered, /没有匹配的会话/);
  assert.equal(input.isRaw, false);
});
