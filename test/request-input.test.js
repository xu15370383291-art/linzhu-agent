import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { withRequestInput } from '../backend/request-input.js';
import { questionWithCommands } from '../backend/command-prompt.js';

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.rows = 10;
  output.columns = 80;
  output.on('data', () => {});
  return { input, output, rl: { pause() {}, resume() {} } };
}

test('prompt accepts another message after a completed model request', async () => {
  const io = terminal();
  const first = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('first\r');
  assert.equal(await first, 'first');
  assert.equal(await withRequestInput(io.input, async () => 'answer'), 'answer');
  assert.equal(io.input.isRaw, false);
  const second = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('second\r');
  assert.equal(await second, 'second');
});

test('empty Enter after a completed model request keeps the prompt active', async () => {
  const io = terminal();
  const first = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('first\r');
  assert.equal(await first, 'first');
  await withRequestInput(io.input, async () => 'answer');
  const second = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(io.input.listenerCount('keypress'), 1);
  io.input.write('second\r');
  assert.equal(await second, 'second');
  assert.equal(io.input.listenerCount('keypress'), 0);
});

test('prompt accepts another message after cancelling a model request', async () => {
  const io = terminal();
  const pending = withRequestInput(io.input, signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  io.input.write('\x03');
  await assert.rejects(pending, /cancelled/);
  assert.equal(io.input.listenerCount('keypress'), 0);
  assert.equal(io.input.isRaw, false);
  const next = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('/help\r');
  assert.equal(await next, '/help');
});
