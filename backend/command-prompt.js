import readline from 'node:readline';
import { slashCommands } from './commands.js';
import { acquireTerminalInput } from './terminal-input.js';

export function matchesFor(text, commands = slashCommands) {
  if (!text.startsWith('/') || /\s/.test(text)) return [];
  const query = text.slice(1).toLowerCase();
  return commands.filter(command => !query || !command.lowFrequency)
    .filter(command => command.name.slice(1).toLowerCase().includes(query));
}

function clean(text) {
  return String(text).replace(/[\x00-\x1f\x7f-\x9f\x1b]/g, ' ');
}

function charWidth(char) {
  if (/\p{Mark}/u.test(char)) return 0;
  return /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
}

function sliceText(text, length) {
  let result = '';
  let width = 0;
  for (const char of text) {
    const columns = charWidth(char);
    if (width + columns > length) break;
    result += char;
    width += columns;
  }
  return result;
}

function displayWidth(text) {
  return Array.from(text).reduce((width, char) => width + charWidth(char), 0);
}

export function inputViewport(chars, cursor, columns) {
  const limit = Math.max(1, columns - 7);
  let start = 0;
  while (start < cursor && displayWidth(chars.slice(start, cursor).join('')) > limit) start++;
  const prefix = chars.slice(start, cursor).join('');
  return {
    text: sliceText(chars.slice(start).join(''), limit),
    column: 5 + displayWidth(prefix),
  };
}

export function compactUsageLabel(status) {
  if (!status || !Number.isFinite(status.estimatedInput) || !Number.isFinite(status.inputLimit) || status.inputLimit <= 0) {
    return '用量暂不可用';
  }
  return `约已用 ${Math.max(0, Math.round(status.estimatedInput / status.inputLimit * 100))}%`;
}

export async function questionWithCommands(terminal, input = process.stdin, output = process.stdout, commands = slashCommands, { compactUsage, view } = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return terminal.question('\nYou> ');
  }

  let chars = [];
  let cursor = 0;
  let selected = 0;
  let offset = 0;
  let rendered = 0;
  let dismissed = false;
  terminal.pause();
  let release;
  try { release = acquireTerminalInput(input, 'prompt'); }
  catch (error) { terminal.resume(); throw error; }

  function render() {
    const width = Math.max(12, (output.columns || 80) - (view ? 2 : 0));
    const matches = dismissed ? [] : matchesFor(chars.join(''), commands);
    const visible = Math.min(matches.length, Math.max(1, (output.rows || 24) - (view ? 5 : 3)));
    if (selected >= matches.length) selected = 0;
    if (selected < offset) offset = selected;
    if (selected >= offset + visible) offset = selected - visible + 1;
    offset = Math.min(offset, Math.max(0, matches.length - visible));

    const viewport = inputViewport(chars, cursor, width);
    const lines = matches.slice(offset, offset + visible).map((item, index) => {
      const name = clean(item.name);
      const description = clean(item.description);
      const nameWidth = Math.min(Math.max(16, ...matches.map(match => Array.from(match.name).length + 2)), Math.floor(width / 2));
      const usage = item.name === '/compact' ? compactUsage : null;
      const suffix = usage && width >= 48 ? clean(usage) : '';
      const suffixWidth = displayWidth(suffix);
      const descriptionWidth = width - nameWidth - 3 - (suffix ? suffixWidth + 2 : 0);
      const shortened = sliceText(description, Math.max(0, descriptionWidth));
      const label = width >= 48
        ? `${name.padEnd(nameWidth)} ${shortened}${suffix ? ' '.repeat(Math.max(2, width - 2 - nameWidth - displayWidth(shortened) - suffixWidth)) + suffix : ''}`
        : sliceText(name, width - 3);
      const highlighted = offset + index === selected;
      return highlighted ? `\x1b[7m ${label}\x1b[0m` : ` ${label}`;
    });
    if (view) {
      view.render({ draft: viewport.text, cursorColumn: viewport.column, menu: lines });
      return;
    }
    if (rendered) {
      readline.cursorTo(output, 0);
      readline.clearScreenDown(output);
      readline.clearLine(output, 0);
    } else output.write('\r\n');
    output.write(`You> ${viewport.text}`);
    for (const item of lines) output.write(`\r\n${item}`);
    if (lines.length) readline.moveCursor(output, 0, -lines.length);
    readline.cursorTo(output, viewport.column);
    rendered = lines.length + 1;
  }

  try {
    view?.setInputActive?.(true);
    render();
    return await new Promise((resolve, reject) => {
      const finish = (value, error) => {
        input.off('keypress', onKey);
        input.off('end', onEnd);
        input.off('error', onError);
        output.off('resize', render);
        if (!view) {
          readline.cursorTo(output, 0);
          readline.clearScreenDown(output);
          readline.clearLine(output, 0);
          output.write(`You> ${clean(value ?? chars.join(''))}\r\n`);
        }
        if (error) reject(error);
        else resolve(value);
      };
      const onEnd = () => finish(null, Object.assign(new Error('Input ended'), { name: 'AbortError' }));
      const onError = error => finish(null, error);
      const onKey = (character, key = {}) => {
        const matches = dismissed ? [] : matchesFor(chars.join(''), commands);
        if (key.ctrl && key.name === 'c') return finish(null, Object.assign(new Error('Aborted with Ctrl+C'), { name: 'AbortError' }));
        if (key.name === 'return' || key.name === 'enter') {
          // Do not tear down and recreate the terminal input owner for an empty
          // prompt. That handoff can leave the cursor visually displaced.
          if (!chars.length && !matches.length) { render(); return; }
          return finish(matches.length ? matches[selected].name : chars.join(''));
        }
        if (key.name === 'up' || key.name === 'down' || key.name === 'pageup' || key.name === 'pagedown') {
          if (matches.length) {
            const step = key.name.startsWith('page') ? Math.max(1, (output.rows || 24) - 3) : 1;
            const direction = key.name === 'up' || key.name === 'pageup' ? -1 : 1;
            selected = (selected + direction * step % matches.length + matches.length) % matches.length;
            render();
          } else if (view && !chars.length) {
            const page = Math.max(1, (output.rows || 24) - 5);
            view.scroll(key.name === 'up' ? 1 : key.name === 'down' ? -1 : key.name === 'pageup' ? page : -page);
            render();
          } else if (key.name === 'pageup' && !chars.length) finish('/history');
          return;
        }
        if (view && key.name === 'end' && !chars.length) { view.bottom(); render(); return; }
        if (key.name === 'escape') { dismissed = true; render(); return; }
        if (key.name === 'tab') {
          if (matches.length) { chars = Array.from(matches[selected].name); cursor = chars.length; dismissed = true; render(); }
          return;
        }
        if (key.ctrl && key.name === 'u') {
          chars = []; cursor = selected = offset = 0; dismissed = false; render(); return;
        }
        if (key.name === 'left') cursor = Math.max(0, cursor - 1);
        else if (key.name === 'right') cursor = Math.min(chars.length, cursor + 1);
        else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cursor = 0;
        else if (key.name === 'end' || (key.ctrl && key.name === 'e')) cursor = chars.length;
        else if (key.name === 'backspace' || (key.ctrl && key.name === 'h')) {
          if (cursor) { chars.splice(--cursor, 1); selected = 0; offset = 0; dismissed = false; }
        } else if (key.name === 'delete') {
          if (cursor < chars.length) { chars.splice(cursor, 1); selected = 0; offset = 0; dismissed = false; }
        } else if (!key.ctrl && !key.meta && character && !/[\x00-\x1f\x7f\x1b]/.test(character)) {
          const insertion = Array.from(character);
          chars.splice(cursor, 0, ...insertion);
          cursor += insertion.length;
          selected = 0;
          offset = 0;
          dismissed = false;
        } else return;
        render();
      };
      input.on('keypress', onKey);
      input.on('end', onEnd);
      input.on('error', onError);
      output.on('resize', render);
    });
  } finally {
    view?.setInputActive?.(false);
    release();
    terminal.resume();
  }
}
