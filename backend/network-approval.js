import { acquireTerminalInput } from './terminal-input.js';

export async function approveNetwork(details, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') throw new Error('Network approval requires a terminal');
  const release = acquireTerminalInput(input, 'network-approval');
  try {
    const width = Math.max(1, (output.columns || 80) - 1);
    const text = `联网确认：${details.tool}\n站点：${details.origin}\n网址：${details.url}\n${details.query ? `搜索内容：${details.query}\n` : ''}网页内容将发送给当前选择的模型。\ny：仅本次 | s：本会话允许该站点\nn / Esc / Ctrl+C：拒绝（直接按键，无需回车）`;
    const lines = text.split('\n').flatMap(line => {
      const chunks = [];
      let chunk = '', columns = 0;
      for (const char of line) {
        const size = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
        if (columns + size > width) { chunks.push(chunk); chunk = ''; columns = 0; }
        chunk += char; columns += size;
      }
      return [...chunks, chunk];
    });
    if (width < 40 || lines.length + 1 > (output.rows || 24) || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text))
      throw new Error('Cannot display complete network approval; resize the terminal or shorten the URL');
    output.write('\x1b[?25l\x1b[2J' + lines.map((line, index) => `\x1b[${index + 1};1H${line}\x1b[K`).join(''));
    return await new Promise((resolve, reject) => {
      const finish = (value, error) => {
        details.signal?.removeEventListener('abort', onAbort);
        input.off('keypress', onKey); input.off('end', onEnd); input.off('error', onError);
        error ? reject(error) : resolve(value);
      };
      const onEnd = () => finish(false);
      const onAbort = () => finish(false, details.signal.reason);
      const onError = error => finish(false, error);
      const onKey = (character, key = {}) => {
        if (!key.ctrl && !key.meta && character?.toLowerCase() === 'y') finish(true);
        else if (!key.ctrl && !key.meta && character?.toLowerCase() === 's') finish('session');
        else if (character?.toLowerCase() === 'n' || key.name === 'escape' || key.ctrl && key.name === 'c') finish(false);
      };
      input.on('keypress', onKey); input.on('end', onEnd); input.on('error', onError);
      details.signal?.addEventListener('abort', onAbort, { once: true });
      if (details.signal?.aborted) onAbort();
    });
  } finally { release(); output.write('\x1b[?25h'); }
}
