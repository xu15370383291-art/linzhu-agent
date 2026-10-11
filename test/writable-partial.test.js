import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WritableSandbox } from '../backend/sandbox/writable.js';

test('writable sandbox prepares all changes before committing and rolls back on failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-writable-partial-'));
  await writeFile(path.join(root, 'a.txt'), ''); await writeFile(path.join(root, 'b.txt'), '');
  const commits = [];
  const sandbox = new WritableSandbox(root, { commitBroker: async change => { commits.push(change.path); if (change.path.endsWith('b.txt')) throw new Error('second commit failed'); } });
  sandbox.changes.set('x', { id: 'x', original: root, directory: path.join(root, 'temp'), collected: [
    { path: 'a.txt', before: '', after: 'a', target: path.join(root, 'a.txt') },
    { path: 'b.txt', before: '', after: 'b', target: path.join(root, 'b.txt') },
  ] });
  await assert.rejects(sandbox.commit('x', async () => true), { code: 'TRANSACTION_ROLLED_BACK' });
  assert.deepEqual(commits, ['a.txt', 'b.txt']);
});
