import { transcript } from './resume-menu.js';
import { historyLines } from './history-view.js';

function safe(text) {
  return String(text).replace(/[\x00-\x1f\x7f-\x9f\x1b]/g, ' ');
}

function charWidth(char) {
  return /\p{Mark}/u.test(char) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
}

function fit(text, width) {
  let result = '';
  let used = 0;
  for (const char of safe(text)) {
    const size = charWidth(char);
    if (used + size > width) break;
    used += size;
    result += char;
  }
  return result;
}

function wrap(text, width) {
  const result = [];
  for (const line of String(text).split('\n')) {
    if (!line) { result.push(''); continue; }
    let part = '';
    let used = 0;
    for (const char of safe(line)) {
      const size = charWidth(char);
      if (part && used + size > width) { result.push(part); part = ''; used = 0; }
      part += char;
      used += size;
    }
    result.push(part);
  }
  return result;
}

function sessionTitle(session) {
  const first = session.messages.find(message => message.role === 'user' && typeof message.content === 'string');
  return session.title || (first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 80) : '新会话');
}

export function createConversationView({ output = process.stdout, workspace } = {}) {
  let session;
  let lines = [];
  let transient = [];
  let columns = 0;
  let messageCount = -1;
  let scroll = 0;
  let notices = [];
  let noticeText = '';
  let pending = '';
  let busy = false;
  let busyLabel = '模型处理中… Ctrl+C 取消';
  let previous = [];
  let previousSize = '';
  let prompt = { draft: '', cursorColumn: 5, menu: [] };
  let inputActive = true;

  function content() {
    const width = output.columns || 80;
    if (width !== columns || messageCount !== session.messages.length) {
      columns = width;
      messageCount = session.messages.length;
      lines = historyLines(session, width);
    }
    if (transient.length) return lines.concat(transient);
    return lines;
  }

  function updateTransient() {
    const width = Math.max(1, (output.columns || 80) - 1);
    transient = [...(noticeText ? wrap(noticeText, width) : []), ...(pending ? wrap(`Agent> ${pending}`, width) : [])];
  }

  const view = {
    invalidate() { previous = []; previousSize = ''; },
    setInputActive(value) {
      inputActive = Boolean(value);
      if (!inputActive) prompt = { draft: '', cursorColumn: 5, menu: [] };
    },
    setSession(value) {
      session = value;
      columns = 0;
      messageCount = -1;
      notices = [];
      transient = [];
      noticeText = '';
      pending = '';
      busy = false;
      busyLabel = '模型处理中… Ctrl+C 取消';
      scroll = 0;
      prompt = { draft: '', cursorColumn: 5, menu: [] };
      this.invalidate();
    },
    notice(text) { noticeText = String(text); updateTransient(); scroll = 0; },
    pending(text) { pending = text; updateTransient(); scroll = 0; this.render(); },
    clearPending() { pending = ''; updateTransient(); },
    setBusy(value, label, render = true) { busy = Boolean(value); if (label) busyLabel = label; if (render) this.render(); },
    clearNotice() { notices = []; noticeText = ''; updateTransient(); },
    scroll(direction, pageSize) {
      const page = Math.max(1, pageSize || (output.rows || 24) - 5);
      const max = Math.max(0, content().length - page);
      scroll = Math.max(0, Math.min(max, scroll + direction));
      return scroll;
    },
    home(pageSize) { scroll = Math.max(0, content().length - Math.max(1, pageSize || (output.rows || 24) - 5)); },
    bottom() { scroll = 0; },
    render(state) {
      if (state) prompt = { ...prompt, ...state };
      const { draft, cursorColumn } = prompt;
      const menu = busy || !inputActive ? [] : prompt.menu;
      if (!session) return;
      const rows = Math.max(1, output.rows || 24);
      const width = Math.max(1, output.columns || 80);
      if (width !== columns) updateTransient();
      const all = content();
      if (rows < 5 || width < 7) {
        this.invalidate();
        output.write(`\x1b[?25l\x1b[2J\x1b[H${fit(busy ? busyLabel : inputActive ? `You> ${draft}` : '准备输入…', Math.max(0, width - 1))}\x1b[K\x1b[1;${Math.min(width, Math.max(1, cursorColumn + 1))}H${inputActive && !busy ? '\x1b[?25h' : '\x1b[?25l'}`);
        return;
      }
      const menuCount = Math.min(menu.length, Math.max(0, rows - 5));
      const page = Math.max(1, rows - 4 - menuCount);
      scroll = Math.min(scroll, Math.max(0, all.length - page));
      const start = Math.max(0, all.length - page - scroll);
      const title = sessionTitle(session);
      const header = [
        fit(`Personal Agent | workspace: ${workspace}`, width - 1),
        fit(`Session: ${title} (${session.id}) | ${start + 1}-${Math.min(start + page, all.length)}/${all.length}`, width - 1),
      ];
      const frame = [];
      for (let row = 0; row < rows; row++) {
        let text = '';
        if (row < 2) text = header[row];
        else if (row < rows - 2 - menuCount) text = all[start + row - 2] || '';
        else if (row === rows - 2 - menuCount) text = fit(busy ? busyLabel : inputActive ? `You> ${draft}` : '准备输入…', width - 1);
        else if (row < rows - 1) text = menu[row - (rows - 2 - menuCount) - 1] || '';
        else text = fit(scroll ? '↑↓ PgUp/PgDn 翻阅  End 返回最新 | 输入继续对话' : 'PgUp 翻阅历史  /resume 切换会话', width - 1);
        frame.push(text);
      }
      const inputRow = rows - 1 - menuCount;
      // cursorColumn is zero-based; ANSI cursor positions are one-based.
      const resized = previousSize !== `${rows}:${width}`;
      let update = '\x1b[?25l';
      if (resized) update += '\x1b[2J';
      for (let row = 0; row < rows; row++) {
        if (resized || frame[row] !== previous[row]) update += `\x1b[${row + 1};1H${frame[row]}\x1b[K`;
      }
      update += `\x1b[${inputRow};${Math.min(width, Math.max(1, cursorColumn + 1))}H${inputActive && !busy ? '\x1b[?25h' : '\x1b[?25l'}`;
      output.write(update);
      previous = frame;
      previousSize = `${rows}:${width}`;
    },
  };
  return view;
}

export function createSessionScreen({ input = process.stdin, output = process.stdout } = {}) {
  const interactive = Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
  let active = false;
  return {
    interactive,
    enter() {
      if (!interactive || active) return;
      output.write('\x1b[?1049h\x1b[?25h');
      active = true;
    },
    leave() {
      if (!active) return;
      output.write('\x1b[?25h\x1b[?1049l');
      active = false;
    },
    clear() {
      if (active) output.write('\x1b[2J\x1b[H');
    },
    switch() {
      if (!active) return;
      this.clear();
    },
  };
}

export function showSession(session, { output = process.stdout, workspace, restored = false } = {}) {
  if (output.isTTY) output.write('\x1b[2J\x1b[H');
  const title = sessionTitle(session);
  output.write(`Personal Agent | workspace: ${workspace}\n`);
  output.write(`Session: ${title} (${session.id}) | write: approval required\n`);
  if (restored) {
    if (output.isTTY) {
      const lines = historyLines(session, output.columns || 80);
      const page = Math.max(1, (output.rows || 24) - 5);
      output.write(`${lines.slice(-page).join('\n')}\n`);
    } else output.write(`${transcript(session, Infinity) || '(empty conversation)'}\n`);
  }
}
