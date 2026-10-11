import readline from 'node:readline';
import { acquireTerminalInput } from './terminal-input.js';

export function moveSelection(index, direction, count) {
  return (index + direction + count) % count;
}

function terminalText(value) {
  return String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

export async function chooseModel(items, selectedId, input = process.stdin, output = process.stdout) {
  if (!items.length) return null;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('模型菜单需要交互式终端；也可以使用 /models use <连接名称>');
  }

  let index = Math.max(0, items.findIndex(item => item.id === selectedId));
  let renderedLines = 0;
  const release = acquireTerminalInput(input, 'model menu');

  const render = () => {
    if (renderedLines) {
      readline.cursorTo(output, 0);
      readline.moveCursor(output, 0, -renderedLines);
    }
    const lines = ['选择模型 (↑/← 上一个, ↓/→ 下一个, Enter 确认, Esc 取消)'];
    items.forEach((item, itemIndex) => {
      const label = `${terminalText(item.name)} (${terminalText(item.model)})${item.id === selectedId ? '  [当前使用]' : ''}${item.hasKey ? '' : '  [未配置密钥]'}`;
      lines.push(itemIndex === index ? `\x1b[7m > ${label} \x1b[0m` : `   ${label}`);
    });
    for (const line of lines) {
      readline.cursorTo(output, 0);
      readline.clearLine(output, 0);
      output.write(`${line}\r\n`);
    }
    renderedLines = lines.length;
  };

  try {
    render();
    return await new Promise((resolve, reject) => {
      const finish = (value, error) => {
        input.off('keypress', onKey);
        input.off('end', onEnd);
        input.off('error', onError);
        if (error) reject(error);
        else resolve(value);
      };
      const onEnd = () => finish(null);
      const onError = error => finish(null, error);
      const onKey = (_character, key = {}) => {
        if (key.name === 'up' || key.name === 'left' || key.name === 'down' || key.name === 'right') {
          index = moveSelection(index, ['up', 'left'].includes(key.name) ? -1 : 1, items.length);
          render();
        } else if (key.name === 'return' || key.name === 'enter') finish(items[index]);
        else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) finish(null);
      };
      input.on('keypress', onKey);
      input.on('end', onEnd);
      input.on('error', onError);
    });
  } finally {
    release();
    readline.cursorTo(output, 0);
    output.write('\r\n');
  }
}
