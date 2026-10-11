import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { browseHistory, historyLines } from '../backend/history-view.js';

const session = { id: 'test', title: '历史测试', messages: [
  { role: 'user', content: '第一条内容'.repeat(6) },
  { role: 'assistant', content: '回答一' },
  { role: 'user', content: '最后的问题' },
  { role: 'assistant', content: '最后的回答' },
] };

test('history wraps Chinese text and excludes tool results', () => {
  const lines = historyLines({ ...session, messages: [...session.messages, { role: 'tool', content: 'private' }] }, 16);
  assert.ok(lines.length > 5);
  assert.ok(lines.every(line => !line.includes('private')));
  assert.ok(lines.some(line => line.includes('最后的问题')));
});

test('history scrolls and returns with raw mode restored', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.columns = 20;
  output.rows = 5;
  let rendered = '';
  output.on('data', chunk => { rendered += chunk.toString(); });
  const viewing = browseHistory(session, input, output);
  input.write('\x1b[H\x1b[B\x1b[5~\x1b[6~\x1b[F\x1b');
  await viewing;
  assert.equal(input.isRaw, false);
  assert.match(rendered, /History:/);
  assert.match(rendered, /最后的回答/);
  assert.match(rendered, /第一条内容/);
});

test('history in piped mode prints the complete conversation without escape codes', async () => {
  const input = { isTTY: false };
  let text = '';
  await browseHistory(session, input, { isTTY: false, write: chunk => { text += chunk; } });
  assert.match(text, /最后的回答/);
  assert.doesNotMatch(text, /\x1b/);
});
