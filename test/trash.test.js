import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TrashStore } from '../backend/security/trash.js';

test('trash moves a file instead of permanently deleting it and restores it once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-trash-')); const target = path.join(root, 'important.txt');
  await writeFile(target, 'important content');
  const trash = new TrashStore(root); const item = await trash.remove(target);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.equal((await trash.list())[0].status, 'trashed');
  assert.equal((await trash.restore(item.id)).status, 'restored');
  assert.equal(await readFile(target, 'utf8'), 'important content');
  await assert.rejects(trash.restore(item.id), { code: 'TRASH_NOT_FOUND' });
});

test('trash refuses protected paths, hard links and restoring over an existing target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-trash-deny-')); const target = path.join(root, 'a.txt');
  await writeFile(target, 'a');
  const trash = new TrashStore(root); const item = await trash.remove(target);
  await writeFile(target, 'new');
  await assert.rejects(trash.restore(item.id), { code: 'TRASH_TARGET_EXISTS' });
  await assert.rejects(trash.remove(path.join(root, '.agent-data', 'secret.txt')), { code: 'PROTECTED_PATH' });
});

test('trash restore never replaces a concurrently created target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-trash-race-')); const target = path.join(root, 'race.txt');
  await writeFile(target, 'old');
  const trash = new TrashStore(root); const item = await trash.remove(target);
  await writeFile(target, 'new');
  await assert.rejects(trash.restore(item.id), { code: 'TRASH_TARGET_EXISTS' });
  assert.equal(await readFile(target, 'utf8'), 'new');
});
