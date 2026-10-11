import { acquireTerminalInput } from './terminal-input.js';

function clean(value) { return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
function columns(text) {
  return [...text].reduce((size, char) => size + (/\p{Mark}/u.test(char) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1), 0);
}

export async function approveExternalRead({ path, tool }, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
    throw new Error('Interactive approval requires a terminal');
  const release = acquireTerminalInput(input, 'external-read-approval');
  const render = () => {
    const width = Math.max(10, (output.columns || 80) - 1);
    const lines = [`外部读取确认：${tool}`, `路径：${clean(path)}`, '文件内容可能发送给当前模型。', 'y：仅本次允许 | n/Esc/Ctrl+C：拒绝'];
    if (lines.some(line => columns(line) > width) || (output.rows || 24) < 5) throw new Error('Terminal too small to show the full read path; resize and retry');
    output.write('\x1b[2J' + lines.map((line, index) => `\x1b[${index + 1};1H${line}\x1b[K`).join(''));
  };
  try {
    render();
    return await new Promise((resolve, reject) => {
      const finish = (value, error) => {
        input.off('keypress', onKey);
        input.off('end', onEnd);
        input.off('error', onError);
        output.off('resize', render);
        if (error) reject(error);
        else resolve(value);
      };
      const onEnd = () => finish(false);
      const onError = error => finish(false, error);
      const onKey = (character, key = {}) => {
        if (!key.ctrl && !key.meta && character?.toLowerCase() === 'y') return finish(true);
        if (character?.toLowerCase() === 'n' || key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(false);
      };
      input.on('keypress', onKey);
      input.on('end', onEnd);
      input.on('error', onError);
      output.on('resize', render);
    });
  } finally { release(); }
}
