import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { compactUsageLabel, inputViewport, matchesFor, questionWithCommands } from '../backend/command-prompt.js';
import { slashCommands } from '../backend/commands.js';
import { createConversationView } from '../backend/session-screen.js';

function terminal(rows = 7, columns = 80) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.rows = rows;
  output.columns = columns;
  let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  let resumed = false;
  const rl = { pause() {}, resume() { resumed = true; } };
  return { input, output, rl, text: () => text, resumed: () => resumed };
}

test('slash matching includes all commands, ignores case, and supports substring', () => {
  assert.deepEqual(matchesFor('/'), slashCommands);
  assert.deepEqual(matchesFor('/C').map(item => item.name), ['/context', '/compact']);
  assert.deepEqual(matchesFor('/act').map(item => item.name), ['/compact']);
  assert.deepEqual(matchesFor('/zzz'), []);
  assert.deepEqual(matchesFor('/models use '), []);
  assert.deepEqual(matchesFor('ordinary text'), []);
});

test('compact usage follows the context input-budget estimate', () => {
  assert.equal(compactUsageLabel({ estimatedInput: 500, inputLimit: 20000 }), '约已用 3%');
  assert.equal(compactUsageLabel({ estimatedInput: 2400, inputLimit: 2000 }), '约已用 120%');
  assert.equal(compactUsageLabel(null), '用量暂不可用');
  assert.equal(compactUsageLabel({ estimatedInput: 1, inputLimit: 0 }), '用量暂不可用');
});

test('cursor columns account for Chinese and scroll by displayed width', () => {
  const chinese = Array.from('现在使用的是什么模型');
  assert.deepEqual(inputViewport(chinese, chinese.length, 80), { text: chinese.join(''), column: 5 + chinese.length * 2 });
  assert.deepEqual(inputViewport(Array.from('abc中文'), 5, 80), { text: 'abc中文', column: 12 });
  const long = inputViewport(Array.from('中文中文中文中文abc'), 11, 16);
  assert.ok(long.column < 16);
  assert.ok(long.text.endsWith('abc'));
});

test('interactive cursor lands after Chinese text and tracks left/right editing', async () => {
  const io = terminal(8, 80);
  const answer = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('现在使用的是什么模型');
  assert.match(io.text(), /\x1b\[26G/);
  io.input.write('\x1b[D');
  assert.match(io.text(), /\x1b\[24G/);
  io.input.write('\x1b[C\r');
  assert.equal(await answer, '现在使用的是什么模型');
});

test('compact candidate shows usage on wide terminals and remains usable when narrow', async () => {
  const wide = terminal(8, 80);
  const answer = questionWithCommands(wide.rl, wide.input, wide.output, undefined, { compactUsage: '约已用 23%' });
  wide.input.write('/c');
  assert.match(wide.text(), /\/compact[^\r\n]*约已用 23%/);
  wide.input.write('\x1b[B\r');
  assert.equal(await answer, '/compact');

  const narrow = terminal(8, 30);
  const narrowAnswer = questionWithCommands(narrow.rl, narrow.input, narrow.output, undefined, { compactUsage: '约已用 23%' });
  narrow.input.write('/c');
  assert.match(narrow.text(), /\/compact/);
  assert.doesNotMatch(narrow.text(), /约已用 23%/);
  narrow.input.write('\x1b[B\r');
  assert.equal(await narrowAnswer, '/compact');
});

test('command menu filters and selects highlighted command by Enter', async () => {
  const io = terminal();
  const answer = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('/c');
  assert.match(io.text(), /\/context/);
  assert.match(io.text(), /\/compact/);
  assert.doesNotMatch(io.text(), /\/sessions/);
  io.input.write('\x1b[B\r');
  assert.equal(await answer, '/compact');
  assert.equal(io.input.isRaw, false);
  assert.ok(io.resumed());
});

test('scrolls command window with wraparound and page navigation', async () => {
  const io = terminal(5);
  const answer = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('/');
  for (let i = 0; i < 6; i++) io.input.write('\x1b[B');
  assert.match(io.text(), /\/sessions/);
  io.input.write('\r');
  assert.equal(await answer, '/resume');

  const other = terminal(5);
  const wrapped = questionWithCommands(other.rl, other.input, other.output);
  other.input.write('/\x1b[A\r');
  assert.equal(await wrapped, '/exit');

  const page = terminal(5);
  const paged = questionWithCommands(page.rl, page.input, page.output);
  page.input.write('/\x1b[6~\r');
  assert.equal(await paged, '/compact');
});

test('editing, completion, dismissal and parameterized commands retain input', async () => {
  const io = terminal();
  const answer = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('/contxt\x1b[D\x1b[De\t\r');
  assert.equal(await answer, '/context');

  const command = terminal();
  const withArgs = questionWithCommands(command.rl, command.input, command.output);
  command.input.write('/models use Local\r');
  assert.equal(await withArgs, '/models use Local');

  const escaped = terminal();
  const dismissed = questionWithCommands(escaped.rl, escaped.input, escaped.output);
  escaped.input.write('/c\x1b');
  await new Promise(resolve => setTimeout(resolve, 550));
  escaped.input.write('\r');
  assert.equal(await dismissed, '/c');

  const plain = terminal();
  const ordinary = questionWithCommands(plain.rl, plain.input, plain.output);
  plain.input.write('hello world\r');
  assert.equal(await ordinary, 'hello world');
});

test('backspace, delete, no-match and Ctrl+C work without running a command', async () => {
  const io = terminal();
  const answer = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('/cx\x7f\x1b[B\r');
  assert.equal(await answer, '/compact');

  const noMatch = terminal();
  const unmatched = questionWithCommands(noMatch.rl, noMatch.input, noMatch.output);
  noMatch.input.write('/unknown\r');
  assert.equal(await unmatched, '/unknown');

  const cancelled = terminal();
  const pending = questionWithCommands(cancelled.rl, cancelled.input, cancelled.output);
  cancelled.input.write('/\x03');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled.input.isRaw, false);
});

test('Ctrl+C while /compact is highlighted cancels without executing it', async () => {
  const io = terminal();
  const pending = questionWithCommands(io.rl, io.input, io.output, undefined, { compactUsage: '约已用 2%' });
  io.input.write('/compact');
  assert.match(io.text(), /\/compact[^\r\n]*约已用 2%/);
  io.input.write('\x03');
  await assert.rejects(pending, { name: 'AbortError', message: 'Aborted with Ctrl+C' });
  assert.equal(io.input.isRaw, false);
  assert.equal(io.resumed(), true);
});

test('non-TTY input delegates to readline question', async () => {
  let prompt;
  const result = await questionWithCommands({ question: async value => { prompt = value; return 'plain'; } }, {}, {});
  assert.equal(result, 'plain');
  assert.equal(prompt, '\nYou> ');
});

test('PageUp on an empty prompt opens full history without changing command navigation', async () => {
  const io = terminal();
  const answer = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('\x1b[5~');
  assert.equal(await answer, '/history');
  assert.equal(io.input.isRaw, false);
});

test('unified view scrolls history while keeping command and Chinese input editable', async () => {
  const io = terminal();
  let scroll = 0;
  const drafts = [];
  const view = { render: state => drafts.push(state), scroll: delta => { scroll += delta; }, bottom: () => { scroll = 0; } };
  const answer = questionWithCommands(io.rl, io.input, io.output, undefined, { view });
  io.input.write('\x1b[5~\x1b[A');
  assert.ok(scroll > 0);
  io.input.write('中文/compact');
  assert.equal(drafts.at(-1).draft, '中文/compact');
  io.input.write('\r');
  assert.equal(await answer, '中文/compact');
  assert.equal(io.input.isRaw, false);
});

test('unified view restores terminal mode on Ctrl+C and keeps slash selection', async () => {
  const io = terminal(8, 40);
  const frames = [];
  const view = { render: state => frames.push(state), scroll() {}, bottom() {} };
  const pending = questionWithCommands(io.rl, io.input, io.output, undefined, { view, compactUsage: '约已用 23%' });
  io.input.write('/c');
  assert.equal(frames.at(-1).menu.length, 2);
  io.input.write('\x1b[B\x03');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(io.input.isRaw, false);
});

test('submitting a unified prompt keeps the frame cache for the next prompt', async () => {
  const io = terminal(8, 40);
  const view = createConversationView({ output: io.output, workspace: 'D:\\project' });
  view.setSession({ id: 'test', title: 'prompt', messages: [] });
  const first = questionWithCommands(io.rl, io.input, io.output, undefined, { view });
  io.input.write('hello\r');
  assert.equal(await first, 'hello');
  const before = io.text().length;
  const second = questionWithCommands(io.rl, io.input, io.output, undefined, { view });
  const nextFrame = io.text().slice(before);
  assert.doesNotMatch(nextFrame, /\x1b\[2J/);
  io.input.write('again\r');
  assert.equal(await second, 'again');
});

test('Ctrl+U clears partial command before a new one', async () => {
  const io = terminal();
  const result = questionWithCommands(io.rl, io.input, io.output);
  io.input.write('/c\x15/resume\r');
  assert.equal(await result, '/resume');
});

test('unified screen places the cursor after text, including edits, menu and resize', async () => {
  const io = terminal(8, 40);
  const view = createConversationView({ output: io.output, workspace: 'D:\\project' });
  view.setSession({ id: 'test', title: 'cursor', messages: [] });
  const coordinates = () => {
    const matches = [...io.text().matchAll(/\x1b\[(\d+);(\d+)H\x1b\[\?25h/g)];
    return matches.at(-1)?.slice(1).map(Number);
  };
  const pending = questionWithCommands(io.rl, io.input, io.output, undefined, { view });
  assert.deepEqual(coordinates(), [7, 6]);
  io.input.write('dddddddddddddddd');
  assert.deepEqual(coordinates(), [7, 22]);
  io.input.write('中文');
  assert.deepEqual(coordinates(), [7, 26]);
  io.input.write('\x1b[D');
  assert.deepEqual(coordinates(), [7, 24]);
  io.input.write('\x15/c');
  assert.deepEqual(coordinates(), [5, 8]);
  io.input.write('\x15' + 'x'.repeat(80));
  assert.deepEqual(coordinates(), [7, 37]);
  io.output.columns = 20;
  io.output.emit('resize');
  assert.deepEqual(coordinates(), [7, 17]);
  io.output.columns = 12;
  io.output.emit('resize');
  assert.deepEqual(coordinates(), [7, 11]);
  io.output.columns = 6;
  io.output.emit('resize');
  assert.deepEqual(coordinates(), [1, 6]);
  io.input.write('\x03');
  await assert.rejects(pending, { name: 'AbortError' });
});

test('cursor bounds survive size matrix, long bilingual edits, resize and repeated prompt handoff', async () => {
  for (const rows of [2, 5, 8, 24]) {
    for (const columns of [4, 6, 12, 20, 80]) {
      const io = terminal(rows, columns);
      const view = createConversationView({ output: io.output, workspace: 'D:\\project' });
      view.setSession({ id: 'matrix', messages: [] });
      for (let turn = 0; turn < 2; turn++) {
        const pending = questionWithCommands(io.rl, io.input, io.output, undefined, { view });
        io.input.write('中文abc'.repeat(10) + '\x1b[D\x1b[D\x7f');
        io.output.emit('resize');
        const coordinates = [...io.text().matchAll(/\x1b\[(\d+);(\d+)H\x1b\[\?25h/g)].at(-1);
        assert.ok(coordinates, `${rows}x${columns}`);
        assert.ok(Number(coordinates[1]) >= 1 && Number(coordinates[1]) <= rows);
        assert.ok(Number(coordinates[2]) >= 1 && Number(coordinates[2]) <= columns);
        io.input.write('\r'); await pending;
        const before = io.text().length;
        view.render();
        const idle = io.text().slice(before);
        assert.doesNotMatch(idle, /\?25h|You>/);
        assert.equal(io.input.listenerCount('keypress'), 0);
        assert.equal(io.output.listenerCount('resize'), 0);
      }
    }
  }
});
