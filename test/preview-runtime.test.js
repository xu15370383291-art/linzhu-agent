import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireGatewayLock, readGatewayLock } from '../backend/gateway/runtime.js';

test('preview lock records the owner and releases only its own record', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = await acquireGatewayLock(root, { pid: process.pid, lockName: 'preview.lock', label: 'Preview server' });
  assert.equal(lock.record.root, root);
  assert.equal((await readGatewayLock(root.replace(/\\+$/, ''), 'preview.lock'))?.pid, process.pid);
  await lock.release();
  await assert.rejects(readFile(path.join(root, '.agent-data', 'preview.lock')), { code: 'ENOENT' });
});

test('active preview lock rejects a second owner without deleting the first lock', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'preview-runtime-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await acquireGatewayLock(root, { pid: process.pid, lockName: 'preview.lock', label: 'Preview server' });
  await assert.rejects(acquireGatewayLock(root, { pid: process.pid, lockName: 'preview.lock', label: 'Preview server' }), { code: 'PREVIEW_ALREADY_RUNNING' });
  assert.equal((await readGatewayLock(root, 'preview.lock'))?.token, first.record.token);
  await first.release();
});
