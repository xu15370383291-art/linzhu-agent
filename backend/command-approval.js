import { acquireTerminalInput } from './terminal-input.js';

function wrap(label, value, width) {
  const lines = [];
  let line = '';
  let columns = 0;
  for (const char of `${label}${value}`) {
    const size = /\p{Mark}/u.test(char) ? 0 : /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
    if (columns + size > width) { lines.push(line); line = ''; columns = 0; }
    line += char;
    columns += size;
  }
  if (line) lines.push(line);
  return lines;
}

export async function approveSandboxCommand({ command, workspace }, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function')
    throw new Error('Interactive approval requires a terminal');
  const release = acquireTerminalInput(input, 'sandbox-command-approval');
  try {
    const width = (output.columns || 80) - 1;
    const lines = ['确认执行只读、离线命令：', ...wrap('工作区：', workspace, width),
      ...wrap('命令：', command, width), 'y：仅本次允许 | n / Esc / Ctrl+C：拒绝'];
    if (width < 40 || (output.rows || 24) < lines.length + 1 || /[\x00-\x1f\x7f\x1b]/.test(`${workspace}${command}`))
      throw new Error('Terminal too small to show the full command; resize and retry');
    output.write('\x1b[?25l\x1b[2J' + lines.map((line, index) => `\x1b[${index + 1};1H${line}\x1b[K`).join(''));
    return await new Promise((resolve, reject) => {
      const finish = (result, error) => {
        input.off('keypress', onKey);
        input.off('end', onEnd);
        input.off('error', onError);
        if (error) reject(error);
        else resolve(result);
      };
      const onEnd = () => finish(false);
      const onError = error => finish(false, error);
      const onKey = (character, key = {}) => {
        if (character?.toLowerCase() === 'y' && !key.ctrl && !key.meta) return finish(true);
        if (character?.toLowerCase() === 'n' || key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(false);
      };
      input.on('keypress', onKey);
      input.on('end', onEnd);
      input.on('error', onError);
    });
  } finally { release(); output.write('\x1b[?25h'); }
}
