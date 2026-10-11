import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkerBoundary } from '../backend/security/worker-boundary.js';
import { collectReadiness } from '../backend/security/readiness.js';

test('worker boundary fails closed without a verified isolated runner', async () => {
  const worker = new WorkerBoundary();
  assert.equal(worker.readiness().available, false);
  await assert.rejects(worker.run({ action: 'write' }), { code: 'WORKER_UNAVAILABLE' });
});

test('worker boundary accepts only explicitly isolated runners', async () => {
  const worker = new WorkerBoundary({ runner: { isolated: true, mode: 'test-isolated', run: async request => ({ ok: true, request }) } });
  assert.equal(worker.readiness().available, true);
  assert.deepEqual(await worker.run({ action: 'probe' }), { ok: true, request: { action: 'probe' } });
});

test('readiness exposes fail-closed worker and secret state', async () => {
  const result = await collectReadiness({ root: 'test-root', secrets: { available: async () => ({ available: true, backend: 'test' }) }, worker: new WorkerBoundary() });
  assert.equal(result.secrets.available, true); assert.equal(result.worker.available, false); assert.equal(result.failClosed, true);
});
