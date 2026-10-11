import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { approveExternalRead } from '../backend/read-approval.js';

function terminal(columns = 80) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.columns = columns;
  output.rows = 10;
  let text = '';
  output.on('data', chunk => { text += chunk; });
  return { input, output, text: () => text };
}

test('external read approval shows path and releases terminal after one decision', async () => {
  for (const [key, result] of [['y', true], ['n', false], ['\x03', false], ['\x1b', false]]) {
    const io = terminal();
    const pending = approveExternalRead({ path: 'D:\\notes\\readme.txt', tool: 'external_read_file' }, io);
    assert.match(io.text(), /D:\\notes\\readme.txt/);
    io.input.write(key);
    assert.equal(await pending, result);
    assert.equal(io.input.isRaw, false);
    assert.equal(io.input.listenerCount('keypress'), 0);
  }
});

test('narrow terminal cannot approve a path it cannot fully show', async () => {
  const io = terminal(15);
  await assert.rejects(approveExternalRead({ path: 'D:\\long-folder\\readme.txt', tool: 'external_read_file' }, io), /too narrow|too small/);
  assert.equal(io.input.isRaw, false);
});
