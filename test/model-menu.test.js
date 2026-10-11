import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { chooseModel, moveSelection } from '../backend/model-menu.js';

const items = [
  { id: 'a', name: 'Alpha', model: 'a', hasKey: true },
  { id: 'b', name: 'Beta', model: 'b', hasKey: true },
  { id: 'c', name: 'Gamma', model: 'c', hasKey: false },
];

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  return { input, output, text: () => text };
}

test('selection wraps in both directions', () => {
  assert.equal(moveSelection(0, -1, 3), 2);
  assert.equal(moveSelection(2, 1, 3), 0);
  assert.equal(moveSelection(1, 1, 3), 2);
});

test('arrow keys navigate and Enter selects, restoring terminal mode', async () => {
  const io = terminal();
  const choice = chooseModel(items, 'a', io.input, io.output);
  io.input.write('\x1b[A'); // first -> last
  io.input.write('\x1b[C'); // last -> first
  io.input.write('\x1b[B'); // first -> second
  io.input.write('\r');
  assert.equal((await choice).id, 'b');
  assert.equal(io.input.isRaw, false);
  assert.match(io.text(), /\x1b\[7m/);
});

test('Escape cancels without changing the selection', async () => {
  const io = terminal();
  const choice = chooseModel(items, 'b', io.input, io.output);
  io.input.write('\x1b[D');
  io.input.write('\x1b');
  assert.equal(await choice, null);
  assert.equal(io.input.isRaw, false);
});

test('menu restores an existing readline raw mode', async () => {
  const io = terminal();
  io.input.isRaw = true;
  const choice = chooseModel(items, 'a', io.input, io.output);
  io.input.write('\r');
  assert.equal((await choice).id, 'a');
  assert.equal(io.input.isRaw, true);
});
