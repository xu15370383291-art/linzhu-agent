import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { WindowsWorkerRunner } from '../backend/security/windows-worker.js';

test('Windows worker rejects unsafe command protocol before spawning', async () => {
  let spawned = false;
  const runner = new WindowsWorkerRunner(process.cwd(), { spawnImpl: () => { spawned = true; throw new Error('must not spawn'); } });
  await assert.rejects(runner.invoke({ operation: 'readonly-command', command: 'echo unsafe\nnext' }), { code: 'WORKER_REQUEST_DENIED' });
  assert.equal(spawned, false);
  await runner.close();
});

test('Windows worker fails closed on non-Windows hosts', async () => {
  const runner = new WindowsWorkerRunner(path.join(os.tmpdir(), 'agent-worker-test'));
  if (process.platform !== 'win32') await assert.rejects(runner.verify(), { code: 'WORKER_UNAVAILABLE' });
  await runner.close();
});

test('Windows worker real probe verifies restricted token, low integrity and job boundary', async () => {
  if (process.platform !== 'win32') return;
  const runner = new WindowsWorkerRunner(process.cwd());
  try {
    assert.equal(await runner.verify(), true);
    const result = await runner.run({ operation: 'readonly-command', command: 'ver' });
    assert.equal(result.restrictedToken, true);
    assert.equal(result.lowIntegrity, true);
    assert.equal(result.jobObject, true);
    assert.equal(result.exitCode, 0);
  } finally { await runner.close(); }
});
