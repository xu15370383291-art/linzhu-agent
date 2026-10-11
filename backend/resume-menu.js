import readline from 'node:readline';
import { acquireTerminalInput } from './terminal-input.js';

function clip(text, columns) {
  let result = '';
  let used = 0;
  for (const char of String(text).replace(/[\x00-\x1f\x7f-\x9f\x1b]/g, ' ')) {
    const width = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
    if (used + width > columns) break;
    result += char;
    used += width;
  }
  return result;
}

export function transcript(session, limit = 6, maxChars = Infinity) {
  const turns = [];
  for (const message of session.messages) {
    if (message.role === 'user' && typeof message.content === 'string') turns.push({ user: message.content, answer: '' });
    if (message.role === 'assistant' && typeof message.content === 'string' && turns.length) turns.at(-1).answer = message.content;
  }
  const safe = text => text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '');
  const preview = text => {
    const value = safe(text);
    return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
  };
  return turns.slice(-limit).map(turn => `You> ${preview(turn.user)}\nAgent> ${preview(turn.answer) || '(未完成)'}`).join('\n\n');
}

export async function chooseSession(items, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('会话选择需要交互式终端；也可使用 /use <id>');
  }
  let query = '';
  let selected = 0;
  let offset = 0;
  let lines = 0;
  const release = acquireTerminalInput(input, 'session menu');
  const visible = () => items.filter(item => `${item.title} ${item.id}`.toLowerCase().includes(query.toLowerCase()));
  function render() {
    const found = visible();
    const width = Math.max(12, output.columns || 80);
    const height = Math.max(1, (output.rows || 24) - 5);
    selected = Math.min(selected, Math.max(0, found.length - 1));
    if (selected < offset) offset = selected;
    if (selected >= offset + height) offset = selected - height + 1;
    if (lines) { readline.cursorTo(output, 0); readline.moveCursor(output, 0, -lines); }
    const display = [clip(`恢复会话 | 搜索: ${query} | ↑↓ 选择 Enter 恢复 Esc 取消`, width - 1),
      ...found.slice(offset, offset + height).map((item, index) => {
        const date = item.updatedAt.slice(0, 16).replace('T', ' ');
        const suffix = `  ${date}  (${item.messageCount} 轮)`;
        const label = `${clip(item.title, Math.max(3, width - suffix.length - 5))}${suffix}`;
        const safeLabel = clip(label, width - 4);
        return offset + index === selected ? `\x1b[7m > ${safeLabel}\x1b[0m` : `   ${safeLabel}`;
      }), ...(found.length ? [] : ['  没有匹配的会话'])];
    const count = Math.max(lines, display.length);
    for (let i = 0; i < count; i++) {
      readline.cursorTo(output, 0);
      readline.clearLine(output, 0);
      output.write(`${display[i] || ''}\r\n`);
    }
    lines = count;
  }
  try {
    render();
    return await new Promise((resolve, reject) => {
      const finish = (value, error) => {
        input.off('keypress', keypress);
        input.off('end', end);
        input.off('error', fail);
        if (error) reject(error); else resolve(value);
      };
      const end = () => finish(null);
      const fail = error => finish(null, error);
      const keypress = (character, key = {}) => {
        const found = visible();
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(null);
        if (key.name === 'return' || key.name === 'enter') return finish(found[selected] || null);
        if (key.name === 'up' || key.name === 'down') {
          if (found.length) selected = (selected + (key.name === 'up' ? -1 : 1) + found.length) % found.length;
        } else if (key.name === 'backspace') {
          query = Array.from(query).slice(0, -1).join(''); selected = offset = 0;
        } else if (!key.ctrl && !key.meta && character && !/[\x00-\x1f\x7f\x1b]/.test(character)) {
          query += character; selected = offset = 0;
        } else return;
        render();
      };
      input.on('keypress', keypress);
      input.on('end', end);
      input.on('error', fail);
    });
  } finally {
    release();
    readline.cursorTo(output, 0);
    output.write('\r\n');
  }
}
