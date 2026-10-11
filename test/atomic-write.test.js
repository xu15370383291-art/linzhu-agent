import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite } from '../backend/sandbox/atomic-write.js';

test('atomic publication preserves originals on preparation or validation failures and cleans stages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-atomic-'));
  const target = path.join(root, 'file.txt');
  await writeFile(target, 'original');
  await assert.rejects(atomicWrite(target, 'new', { existing: true, validate: async () => {}, beforePublish: async () => { throw new Error('simulated failure'); } }), /simulated failure/);
  assert.equal(await readFile(target, 'utf8'), 'original');
  await assert.rejects(atomicWrite(target, 'new', { existing: true, validate: async () => { throw new Error('conflict'); } }), /conflict/);
  assert.equal(await readFile(target, 'utf8'), 'original');
  await atomicWrite(target, 'new', { existing: true, validate: async () => {} });
  assert.equal(await readFile(target, 'utf8'), 'new');
  assert.deepEqual(await readdir(root), ['file.txt']);
});

test('atomic creation refuses a concurrently created target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-atomic-create-'));
  const target = path.join(root, 'file.txt');
  await assert.rejects(atomicWrite(target, 'new', { validate: async () => {}, beforePublish: () => writeFile(target, 'concurrent') }), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), 'concurrent');
  assert.deepEqual(await readdir(root), ['file.txt']);
});
