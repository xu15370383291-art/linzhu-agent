import test from 'node:test';
import assert from 'node:assert/strict';
import { WslWorkerRunner } from '../backend/security/wsl-worker.js';

test('WSL worker accepts only verified readonly command requests', async () => {
  const calls = [];
  const runner = new WslWorkerRunner('C:\\workspace', { sandbox: {
    verify: async () => true,
    execute: async (command, options) => { calls.push({ command, options }); return { exitCode: 0, stdout: 'ok', stderr: '' }; },
  } });
  assert.equal(await runner.verify(), true);
  assert.deepEqual(await runner.run({ operation: 'readonly-command', command: 'pwd' }), { exitCode: 0, stdout: 'ok', stderr: '' });
  assert.equal(calls.length, 1);
  await assert.rejects(runner.run({ operation: 'write-file', path: 'x' }), { code: 'WORKER_REQUEST_DENIED' });
  await assert.rejects(runner.run({ operation: 'readonly-command', command: 'x\nrm -rf /' }), { code: 'WORKER_REQUEST_DENIED' });
});

test('WSL worker remains unavailable when verification fails', async () => {
  const runner = new WslWorkerRunner('C:\\workspace', { sandbox: { verify: async () => false, execute: async () => ({}) } });
  assert.equal(await runner.verify(), false);
  assert.equal(runner.isolated, false);
  await assert.rejects(runner.run({ operation: 'readonly-command', command: 'pwd' }), { code: 'WORKER_UNAVAILABLE' });
});

test('failed revalidation clears success and preserves the actual error; a later retry recovers', async () => {
  let fail = false;
  const runner = new WslWorkerRunner('C:\\workspace', { sandbox: { verify: async () => {
    if (fail) throw new Error('Cannot lock file path (Windows error 5)');
    return true;
  } } });
  assert.equal(await runner.verify(), true);
  fail = true;
  await assert.rejects(runner.verify(), /Windows error 5/);
  assert.equal(runner.isolated, false);
  assert.match(runner.lastError, /Windows error 5/);
  fail = false;
  assert.equal(await runner.verify(), true);
  assert.equal(runner.lastError, null);
});
