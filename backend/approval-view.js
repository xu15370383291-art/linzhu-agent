import { acquireTerminalInput } from './terminal-input.js';

function stripControl(text) {
  return String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function fit(text, columns) {
  let result = '';
  let width = 0;
  for (const char of stripControl(text)) {
    const size = /\p{Mark}/u.test(char) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
    if (width + size > columns) break;
    result += char;
    width += size;
  }
  return result;
}

export async function approveChange(change, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Interactive approval requires a terminal');
  }
  const lines = change.diff.text.split('\n').map(stripControl);
  let offset = 0;
  const release = acquireTerminalInput(input, 'approval');
  const render = () => {
    const rows = Math.max(4, output.rows || 24);
    const columns = Math.max(10, output.columns || 80);
    const page = rows - 3;
    offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - page)));
    let frame = '\x1b[?25l\x1b[H';
    const header = `${change.before === null ? '新建' : '替换'}：${stripControl(change.path)} | -${change.diff.removed} +${change.diff.added}`;
    frame += `${fit(header, columns - 1)}\x1b[K\n`;
    for (let i = 0; i < page; i++) frame += `${fit(lines[offset + i] ?? '', columns - 1)}\x1b[K\n`;
    frame += `${fit(`行 ${Math.min(offset + 1, lines.length)}-${Math.min(offset + page, lines.length)}/${lines.length}${change.diff.truncated ? ' | 预览已截断' : ''}`, columns - 1)}\x1b[K\n`;
    frame += `${fit('↑↓ PgUp/PgDn：滚动 | y：允许 | n/Esc/Ctrl+C：拒绝', columns - 1)}\x1b[K\x1b[?25h`;
    output.write(frame);
  };
  try {
    output.write('\x1b[2J');
    render();
    return await new Promise((resolve, reject) => {
      const finish = (result, error) => {
        input.off('keypress', onKey);
        input.off('end', onEnd);
        input.off('error', onError);
        output.off('resize', render);
        if (error) reject(error);
        else resolve(result);
      };
      const onEnd = () => finish(false);
      const onError = error => finish(false, error);
      const onKey = (character, key = {}) => {
        const page = Math.max(1, (output.rows || 24) - 3);
        if (key.name === 'up' || key.name === 'pageup') offset -= key.name === 'up' ? 1 : page;
        else if (key.name === 'down' || key.name === 'pagedown') offset += key.name === 'down' ? 1 : page;
        else if (key.name === 'home') offset = 0;
        else if (key.name === 'end') offset = lines.length;
        else if (character?.toLowerCase() === 'y' && !key.ctrl && !key.meta) return finish(true);
        else if (character?.toLowerCase() === 'n' || key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(false);
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
