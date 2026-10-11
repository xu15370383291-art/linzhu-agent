import { transcript } from './resume-menu.js';
import { acquireTerminalInput } from './terminal-input.js';

function printable(text) {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\x1b]/g, '');
}

function charWidth(char) {
  return /\p{Mark}/u.test(char) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
}

function widthOf(text) {
  return Array.from(text).reduce((width, char) => width + charWidth(char), 0);
}

function clip(text, width) {
  let result = '';
  for (const char of text) {
    if (widthOf(result + char) > width) break;
    result += char;
  }
  return result;
}

export function historyLines(session, columns) {
  const width = Math.max(1, columns - 1);
  const lines = [];
  for (const line of (printable(transcript(session, Infinity)) || '(empty conversation)').split('\n')) {
    if (!line) { lines.push(''); continue; }
    let part = '';
    let used = 0;
    for (const char of line) {
      const size = charWidth(char);
      if (part && used + size > width) { lines.push(part); part = ''; used = 0; }
      part += char;
      used += size;
    }
    lines.push(part);
  }
  return lines;
}

export async function browseHistory(session, input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    output.write(`${transcript(session, Infinity) || '(empty conversation)'}\n`);
    return;
  }
  let top = Infinity;
  const release = acquireTerminalInput(input, 'history');
  const render = () => {
    const rows = Math.max(3, output.rows || 24);
    const lines = historyLines(session, output.columns || 80);
    const page = rows - 2;
    top = Math.max(0, Math.min(top, Math.max(0, lines.length - page)));
    output.write('\x1b[2J\x1b[H');
    output.write(`${clip(`History: ${printable(session.title || session.id)} | ${Math.min(top + 1, lines.length)}-${Math.min(top + page, lines.length)}/${lines.length}`, Math.max(1, (output.columns || 80) - 1))}\r\n`);
    for (const line of lines.slice(top, top + page)) output.write(`${line}\r\n`);
    output.write('\x1b[' + rows + ';1H' + clip('↑↓ 滚动  PgUp/PgDn 翻页  Home/End 首尾  Esc/Enter 返回', Math.max(1, (output.columns || 80) - 1)));
  };
  try {
    render();
    await new Promise((resolve, reject) => {
      const finish = error => {
        input.off('keypress', onKey);
        input.off('end', onEnd);
        input.off('error', onError);
        output.off('resize', render);
        if (error) reject(error); else resolve();
      };
      const onEnd = () => finish();
      const onError = error => finish(error);
      const onKey = (_character, key = {}) => {
        const page = Math.max(1, (output.rows || 24) - 2);
        if (['escape', 'return', 'enter'].includes(key.name) || (key.ctrl && key.name === 'c')) return finish();
        if (key.name === 'up') top--;
        else if (key.name === 'down') top++;
        else if (key.name === 'pageup') top -= page;
        else if (key.name === 'pagedown') top += page;
        else if (key.name === 'home') top = 0;
        else if (key.name === 'end') top = Infinity;
        else return;
        render();
      };
      input.on('keypress', onKey);
      input.on('end', onEnd);
      input.on('error', onError);
      output.on('resize', render);
    });
  } finally {
    release();
  }
}
