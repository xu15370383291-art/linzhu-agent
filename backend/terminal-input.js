import readline from 'node:readline';

const owners = new WeakMap();

// Windows console reads can outlive stream.pause(); keep one mode for the CLI lifetime.
export function beginTerminalSession(input) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') return () => {};
  const wasRaw = input.isRaw === true;
  input.pause();
  input.setRawMode(true);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    input.pause();
    input.setRawMode(wasRaw);
  };
}

export function acquireTerminalInput(input, owner) {
  if (owners.has(input)) throw new Error(`Terminal input is already owned by ${owners.get(input)}`);
  const wasRaw = input.isRaw === true;
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  owners.set(input, owner);
  input.resume();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owners.delete(input);
    // Do not start a Windows cooked-mode read between interactive owners.
    input.pause();
    input.setRawMode(wasRaw);
  };
}
