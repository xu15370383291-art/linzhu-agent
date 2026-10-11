import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { acquireTerminalInput, beginTerminalSession } from '../backend/terminal-input.js';
import { questionWithCommands } from '../backend/command-prompt.js';
import { withRequestInput } from '../backend/request-input.js';
import { chooseModel } from '../backend/model-menu.js';
import { chooseSession } from '../backend/resume-menu.js';
import { approveChange } from '../backend/approval-view.js';

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.rows = 12;
  output.columns = 80;
  output.on('data', () => {});
  return { input, output, prompt: { pause() {}, resume() {} } };
}

test('input ownership rejects overlap and restores the previous raw mode', () => {
  const { input } = terminal();
  const release = acquireTerminalInput(input, 'prompt');
  assert.equal(input.isRaw, true);
  assert.throws(() => acquireTerminalInput(input, 'request'), /already owned by prompt/);
  release(); release();
  assert.equal(input.isRaw, false);
  input.isRaw = true;
  const next = acquireTerminalInput(input, 'approval');
  next();
  assert.equal(input.isRaw, true);
});

test('idle handoff never resumes cooked input before the next prompt', async () => {
  const io = terminal();
  let cookedReads = 0;
  const resume = io.input.resume.bind(io.input);
  io.input.resume = () => {
    if (!io.input.isRaw) cookedReads++;
    return resume();
  };
  for (let index = 0; index < 5; index++) {
    const prompt = questionWithCommands(io.prompt, io.input, io.output);
    io.input.write(`question${index}\r`);
    assert.equal(await prompt, `question${index}`);
    assert.equal(io.input.isPaused(), true);
    assert.equal(await withRequestInput(io.input, async () => 'answer'), 'answer');
    assert.equal(io.input.isPaused(), true);
    // Session saving and budget calculations happen before reacquiring input.
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(cookedReads, 0);
  assert.equal(io.input.listenerCount('keypress'), 0);
});

test('CLI lifetime keeps raw mode through requests, menus, approvals and idle reads, restoring on exit', async () => {
  const io = terminal();
  const transitions = [];
  io.input.setRawMode = value => { transitions.push(value); io.input.isRaw = value; };
  const restore = beginTerminalSession(io.input);
  try {
    for (let turn = 0; turn < 10; turn++) {
      const prompt = questionWithCommands(io.prompt, io.input, io.output);
      io.input.write(`中文${turn}\r`);
      assert.equal(await prompt, `中文${turn}`);
      assert.equal(io.input.isRaw, true);
      await withRequestInput(io.input, async () => 'answer');
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(io.input.isRaw, true);
      const model = chooseModel([{ id: 'm', name: 'Mock', model: 'mock', hasKey: true }], 'm', io.input, io.output);
      io.input.write('\r'); await model;
      const approval = approveChange({ path: 'a.txt', before: null, after: 'a', diff: { text: '+a', removed: 0, added: 1 } }, io);
      io.input.write('n'); assert.equal(await approval, false);
      assert.equal(io.input.listenerCount('keypress'), 0);
    }
    assert.ok(transitions.every(value => value === true));
  } finally { restore(); restore(); }
  assert.equal(io.input.isRaw, false);
  assert.equal(transitions.filter(value => value === false).length, 1);
});

test('one terminal passes through prompt, request cancellation, menus and approval', async () => {
  const io = terminal();
  const ask = async (text, expected = text) => {
    const pending = questionWithCommands(io.prompt, io.input, io.output);
    io.input.write(`${text}\r`);
    assert.equal(await pending, expected);
    assert.equal(io.input.isRaw, false);
    assert.equal(io.input.listenerCount('keypress'), 0);
  };

  await ask('hello');
  const request = withRequestInput(io.input, signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  io.input.write('\x03');
  await assert.rejects(request, /cancelled/);
  await ask('/models');

  const model = chooseModel([{ id: 'm', name: 'Mock', model: 'mock', hasKey: true }], 'm', io.input, io.output);
  io.input.write('\r');
  assert.equal((await model).id, 'm');
  await ask('/resume');

  const session = chooseSession([{ id: 's', title: 'Saved', updatedAt: '2026-01-01T00:00:00Z', messageCount: 1 }], io.input, io.output);
  io.input.write('\x1b');
  assert.equal(await session, null);
  await ask('write a file');

  const approval = approveChange({ path: 'note.txt', before: null, after: 'new', diff: { text: '+ new', removed: 0, added: 1, truncated: false } }, io);
  io.input.write('n');
  assert.equal(await approval, false);
  await ask('next question');
});
