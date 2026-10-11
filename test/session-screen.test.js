import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationView, createSessionScreen, showSession } from '../backend/session-screen.js';

const session = { id: '12345678-1234-1234-1234-123456789abc', title: '目标会话', messages: [
  { role: 'user', content: '目标问题' }, { role: 'assistant', content: '目标回答' },
] };

function output(isTTY) {
  let text = '';
  return { isTTY, write: value => { text += value; }, text: () => text };
}

test('interactive session switch clears the screen and shows only the target conversation', () => {
  const terminal = output(true);
  showSession(session, { output: terminal, workspace: 'D:\\project', restored: true });
  assert.ok(terminal.text().startsWith('\x1b[2J\x1b[H'));
  assert.match(terminal.text(), /Session: 目标会话 \(12345678/);
  assert.match(terminal.text(), /You> 目标问题\nAgent> 目标回答/);
  assert.doesNotMatch(terminal.text(), /旧会话/);
});

test('new session starts an empty screen and piped output has no escape codes', () => {
  const terminal = output(true);
  showSession({ ...session, messages: [] }, { output: terminal, workspace: 'D:\\project' });
  assert.ok(terminal.text().startsWith('\x1b[2J\x1b[H'));
  assert.doesNotMatch(terminal.text(), /目标问题|Agent>/);
  const pipe = output(false);
  showSession(session, { output: pipe, workspace: 'D:\\project', restored: true });
  assert.doesNotMatch(pipe.text(), /\x1b\[[23]J|\x1b\[H/);
});

test('alternate screen enters once and restores the original terminal on exit', () => {
  const terminal = output(true);
  const screen = createSessionScreen({ input: { isTTY: true, setRawMode() {} }, output: terminal });
  screen.enter(); screen.enter(); screen.leave(); screen.leave();
  assert.equal(terminal.text(), '\x1b[?1049h\x1b[?25h\x1b[?25h\x1b[?1049l');
  const pipe = output(false);
  const noninteractive = createSessionScreen({ input: { isTTY: false }, output: pipe });
  noninteractive.enter(); noninteractive.leave();
  assert.equal(pipe.text(), '');
});

test('switch clears the active alternate screen without flashing the shell', () => {
  const terminal = output(true);
  const screen = createSessionScreen({ input: { isTTY: true, setRawMode() {} }, output: terminal });
  screen.enter(); screen.switch(); screen.leave();
  assert.equal(terminal.text().match(/\x1b\[\?1049h/g)?.length, 1);
  assert.equal(terminal.text().match(/\x1b\[\?1049l/g)?.length, 1);
  assert.match(terminal.text(), /\x1b\[2J\x1b\[H/);
});

test('older sessions without a stored title show their first question in the header', () => {
  const terminal = output(true);
  showSession({ ...session, title: undefined }, { output: terminal, workspace: 'D:\\project', restored: true });
  assert.match(terminal.text(), /Session: 目标问题 \(12345678/);
});

test('restored pipe prints every turn without a character limit', () => {
  const many = { ...session, messages: Array.from({ length: 8 }, (_, index) => [
    { role: 'user', content: `question ${index}` },
    { role: 'assistant', content: `answer ${index} ${'x'.repeat(600)}` },
  ]).flat() };
  const pipe = output(false);
  showSession(many, { output: pipe, workspace: 'D:\\project', restored: true });
  assert.match(pipe.text(), /question 0/);
  assert.match(pipe.text(), /answer 7 x{600}/);
  assert.doesNotMatch(pipe.text(), /…/);
});

test('restored terminal shows a viewport of the complete, untruncated last answer', () => {
  const terminal = { ...output(true), rows: 10, columns: 40 };
  const long = { ...session, messages: [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'z'.repeat(600) },
  ] };
  showSession(long, { output: terminal, workspace: 'D:\\project', restored: true });
  assert.match(terminal.text(), /z{39}/);
  assert.doesNotMatch(terminal.text(), /…/);
});

test('conversation view scrolls through long history and keeps input fixed', () => {
  const terminal = { ...output(true), rows: 8, columns: 40 };
  const view = createConversationView({ output: terminal, workspace: 'D:\\project' });
  const many = { ...session, messages: Array.from({ length: 30 }, (_, index) => [
    { role: 'user', content: `question ${index}` }, { role: 'assistant', content: `answer ${index}` },
  ]).flat() };
  view.setSession(many);
  view.render({ draft: '中文', cursorColumn: 9 });
  assert.match(terminal.text(), /answer 29/);
  assert.match(terminal.text(), /You> 中文/);
  view.home();
  view.render({ draft: '中文', cursorColumn: 9 });
  assert.match(terminal.text(), /question 0/);
  assert.match(terminal.text(), /You> 中文/);
  view.bottom();
  terminal.columns = 20;
  view.render();
  assert.match(terminal.text(), /answer 29/);
});

test('conversation view keeps history, prompt, menu and footer in separate rows', () => {
  const terminal = { ...output(true), rows: 8, columns: 32 };
  const view = createConversationView({ output: terminal, workspace: 'D:\\project' });
  view.setSession({ ...session, title: undefined });
  view.render({ draft: '/c', cursorColumn: 7, menu: [' /context', ' /compact'] });
  const frame = terminal.text();
  assert.match(frame, /\x1b\[2;1HSession: 目标问题/);
  assert.match(frame, /\x1b\[5;1HYou> \/c/);
  assert.match(frame, /\x1b\[6;1H \/context/);
  assert.match(frame, /\x1b\[7;1H \/compact/);
  assert.match(frame, /\x1b\[8;1HPgUp/);
  view.notice('状态消息'.repeat(20));
  terminal.columns = 18;
  view.render();
  assert.match(terminal.text(), /状态消息/);
});

test('scrolling updates changed rows without clearing the screen', () => {
  let text = '';
  const terminal = { isTTY: true, rows: 8, columns: 40, write: value => { text += value; } };
  const view = createConversationView({ output: terminal, workspace: 'D:\\project' });
  view.setSession({ ...session, messages: Array.from({ length: 30 }, (_, i) => [
    { role: 'user', content: `question ${i}` }, { role: 'assistant', content: `answer ${i}` },
  ]).flat() });
  view.render();
  assert.match(text, /\x1b\[2J/);
  text = '';
  view.scroll(1);
  view.render();
  assert.doesNotMatch(text, /\x1b\[2J/);
  assert.doesNotMatch(text, /\x1b\[7;1HYou>/);
  assert.match(text, /\x1b\[4;1H/);
  text = '';
  view.render();
  assert.doesNotMatch(text, /\x1b\[\d+;1H/);
  view.invalidate();
  text = '';
  view.render();
  assert.match(text, /\x1b\[2J/);
});

test('long history is indexed once per width and message count', () => {
  const terminal = { ...output(true), rows: 12, columns: 50 };
  const view = createConversationView({ output: terminal, workspace: 'D:\\project' });
  const many = { ...session, messages: Array.from({ length: 1000 }, (_, index) => [
    { role: 'user', content: `question ${index} 中文` },
    { role: 'assistant', content: `answer ${index} ${'a'.repeat(120)}` },
  ]).flat() };
  view.setSession(many);
  view.render();
  assert.match(terminal.text(), /answer 999/);
  view.home();
  view.render();
  assert.match(terminal.text(), /question 0/);
  terminal.columns = 28;
  view.bottom();
  view.render();
  assert.match(terminal.text(), /answer 999/);
});

test('pending streamed answer is temporary and clears without wiping the screen', () => {
  let text = '';
  const terminal = { isTTY: true, rows: 8, columns: 40, write: value => { text += value; } };
  const view = createConversationView({ output: terminal, workspace: 'D:\\project' });
  view.setSession({ ...session, messages: [...session.messages] });
  view.render();
  text = '';
  view.pending('你好');
  assert.match(text, /Agent> 你好/);
  assert.doesNotMatch(text, /\x1b\[2J/);
  text = '';
  view.clearPending();
  view.render();
  assert.doesNotMatch(text, /Agent> 你好/);
  assert.match(text, /\x1b\[5;1H\x1b\[K/);
  assert.doesNotMatch(text, /\x1b\[2J/);
});

test('busy state distinguishes model processing from an editable prompt', () => {
  let text = '';
  const terminal = { isTTY: true, rows: 8, columns: 40, write: value => { text += value; } };
  const view = createConversationView({ output: terminal, workspace: 'D:\\project' });
  view.setSession(session);
  view.render();
  text = '';
  view.setBusy(true, '等待模型响应');
  assert.match(text, /等待模型响应/);
  assert.doesNotMatch(text, /\x1b\[2J/);
  text = '';
  view.setBusy(true, '正在调用工具 read_file');
  assert.match(text, /正在调用工具 read_file/);
  text = '';
  view.setBusy(false);
  assert.match(text, /You>/);
});

test('stream status and pending text can render as one frame', () => {
  let writes = 0;
  const terminal = { isTTY: true, rows: 8, columns: 40, write: () => { writes++; } };
  const view = createConversationView({ output: terminal, workspace: 'D:\\project' });
  view.setSession(session);
  view.render();
  writes = 0;
  view.setBusy(true, '模型正在回答', false);
  view.pending('不能查看私有文件');
  assert.equal(writes, 1);
});

test('background redraw preserves edited draft, menu and cursor through resize', () => {
  let text = '';
  const terminal = { isTTY: true, rows: 10, columns: 50, write: value => { text += value; } };
  const view = createConversationView({ output: terminal, workspace: 'D:\\project' });
  view.setSession(session);
  view.render({ draft: '中文abc', cursorColumn: 10, menu: [' /compact'] });
  text = '';
  view.pending('background update');
  assert.doesNotMatch(text, /You> \x1b\[K/);
  assert.match(text, /\x1b\[8;11H\x1b\[\?25h/);
  terminal.columns = 35;
  view.render();
  assert.match(text, /You> 中文abc/);
  view.invalidate(); text = ''; view.render();
  assert.match(text, /You> 中文abc/);
  assert.match(text, /\/compact/);
});

test('inactive and busy views hide cursor and remove command menu even on tiny terminals', () => {
  let text = '';
  const terminal = { isTTY: true, rows: 10, columns: 50, write: value => { text += value; } };
  const view = createConversationView({ output: terminal, workspace: 'D:\\project' });
  view.setSession(session);
  view.render({ draft: '/c', cursorColumn: 7, menu: [' /compact'] });
  view.setInputActive(false); text = ''; view.render();
  assert.doesNotMatch(text, /\?25h/);
  view.setBusy(true); terminal.columns = 4; terminal.rows = 2; text = ''; view.render();
  assert.doesNotMatch(text, /\?25h/);
  view.setBusy(false, undefined, false); view.setInputActive(true);
  terminal.columns = 50; terminal.rows = 10; text = '';
  view.render({ draft: '', cursorColumn: 5, menu: [] });
  assert.match(text, /\x1b\[9;6H\x1b\[\?25h/);
});
