import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { approveChange } from '../backend/approval-view.js';

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.rows = 7;
  output.columns = 65;
  let text = '';
  output.on('data', chunk => { text += chunk; });
  return { input, output, text: () => text };
}

const change = { path: 'note.txt', before: 'old', after: 'new', diff: {
  text: Array.from({ length: 15 }, (_, i) => `+ line ${i}`).join('\n'), removed: 1, added: 15, truncated: true,
} };

test('approval preview scrolls without authorizing until explicit y', async () => {
  const io = terminal();
  const pending = approveChange(change, io);
  assert.match(io.text(), /新建|替换/);
  assert.match(io.text(), /预览已截断/);
  io.input.write('\x1b[6~');
  assert.match(io.text(), /line 4/);
  io.input.write('y');
  assert.equal(await pending, true);
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount('keypress'), 0);
});

test('approval denies on escape, Ctrl+C and n', async () => {
  for (const key of ['\x1b', '\x03', 'n']) {
    const io = terminal();
    const pending = approveChange(change, io);
    io.input.write(key);
    assert.equal(await pending, false);
    assert.equal(io.input.isRaw, false);
  }
});

test('narrow preview clips Chinese text and footer without wrapping terminal rows', async () => {
  const io = terminal();
  io.output.columns = 18;
  const pending = approveChange({ ...change, path: '中文文件.txt' }, io);
  const rows = io.text().split('\n');
  assert.equal(rows.length, io.output.rows);
  assert.match(rows[0], /中文文件/);
  io.input.write('n');
  assert.equal(await pending, false);
});
