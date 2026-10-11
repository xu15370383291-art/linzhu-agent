import { acquireTerminalInput } from './terminal-input.js';

export async function withRequestInput(input, action, { controller = new AbortController() } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return action(controller.signal);
  const release = acquireTerminalInput(input, 'request');
  const onKey = (_, key) => {
    if (key?.ctrl && key.name === 'c') controller.abort();
  };
  input.on('keypress', onKey);
  try { return await action(controller.signal); }
  finally {
    input.off('keypress', onKey);
    release();
  }
}
