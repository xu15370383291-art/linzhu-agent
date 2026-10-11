import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TransactionJournal } from '../backend/security/transaction-journal.js';

test('transaction journal rolls back committed files after a later commit failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-transaction-rollback-'));
  const a = path.join(root, 'a.txt'); const b = path.join(root, 'b.txt');
  await writeFile(a, 'before-a'); await writeFile(b, 'before-b');
  const journal = new TransactionJournal(root);
  await assert.rejects(journal.commit([
    { target: a, before: 'before-a', after: 'after-a' },
    { target: b, before: 'before-b', after: 'after-b' },
  ], { apply: async (change, index) => { if (index === 1) throw new Error('simulated commit failure'); await writeFile(change.target, change.after); } }), { code: 'TRANSACTION_ROLLED_BACK' });
  assert.equal(await readFile(a, 'utf8'), 'before-a'); assert.equal(await readFile(b, 'utf8'), 'before-b');
});

test('transaction journal enters manual review instead of overwriting an external change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-transaction-review-')); const file = path.join(root, 'note.txt'); await writeFile(file, 'before');
  const journal = new TransactionJournal(root); const pending = await journal.begin([{ target: file, before: 'before', after: 'after' }]);
  await journal.mark(pending, 0, 'committing'); await writeFile(file, 'external');
  await assert.rejects(journal.rollback(pending), { code: 'TRANSACTION_MANUAL_REVIEW' });
  assert.equal(await readFile(file, 'utf8'), 'external');
  const saved = await journal.load(pending.id); assert.equal(saved.state, 'manual-review');
});

test('transaction recovery scans unfinished journals and safely completes rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-transaction-recover-')); const file = path.join(root, 'note.txt'); await writeFile(file, 'before');
  const journal = new TransactionJournal(root); const pending = await journal.begin([{ target: file, before: 'before', after: 'after' }]);
  await journal.mark(pending, 0, 'committing'); await writeFile(file, 'after');
  const results = await journal.recover(); assert.deepEqual(results, [{ id: pending.id, state: 'rolled-back' }]); assert.equal(await readFile(file, 'utf8'), 'before');
});
