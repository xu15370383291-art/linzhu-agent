import test from 'node:test';
import assert from 'node:assert/strict';
import { isExitCommand, isUserInterrupt } from '../backend/commands.js';

test('exit aliases are handled locally', () => {
  for (const input of ['exit', '/exit', 'exit/', ' EXIT ', ' /EXIT ']) {
    assert.equal(isExitCommand(input), true, input);
  }
  for (const input of ['exiting', '/exit now', 'hello']) {
    assert.equal(isExitCommand(input), false, input);
  }
});

test('readline interrupts are recognized without hiding real errors', () => {
  assert.equal(isUserInterrupt(Object.assign(new Error('cancelled'), { name: 'AbortError' })), true);
  assert.equal(isUserInterrupt({ code: 'ABORT_ERR' }), true);
  assert.equal(isUserInterrupt(new Error('network failure')), false);
});

test('branch commands are visible in the slash command registry', async () => {
  const { slashCommands } = await import('../backend/commands.js');
  assert.deepEqual(slashCommands.filter(command => ['/branches', '/branch'].includes(command.name)).map(command => command.name), ['/branches', '/branch']);
  assert.ok(slashCommands.some(command => command.name === '/memory-embedding'));
});
