import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../backend/workspace.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { routeTool } from '../backend/tools/registry.js';

test('write tickets are single-use and bound to workspace and immutable preview', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ticket-'));
  const workspace = new Workspace(root);
  const change = await workspace.prepareChange('file.txt', { content: 'approved' });
  await assert.rejects(new Workspace(root).commitChange(change), /expired or already consumed/);
  await workspace.commitChange(change);
  await assert.rejects(workspace.commitChange(change), /expired or already consumed/);
  const mutated = await workspace.prepareChange('file.txt', { content: 'next' });
  mutated.after = 'unapproved';
  await assert.rejects(workspace.commitChange(mutated), /preview changed/);
  assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'approved');
  const pending = await workspace.prepareChange('file.txt', { content: 'again' });
  await writeFile(path.join(root, 'file.txt'), 'concurrent edit');
  await assert.rejects(workspace.commitChange(pending), /File changed/);
});

test('approval callback cannot change committed content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-approval-integrity-'));
  const result = await routeTool({ function: { name: 'write_file', arguments: JSON.stringify({ path: 'file.txt', content: 'approved' }) } }, {
    workspace: new Workspace(root), policy: new PermissionPolicy({ approveWrite: async change => {
      change.after = 'different';
      change.target = path.join(root, 'other.txt');
      return true;
    } }),
  });
  assert.equal(result.isError, false, result.content);
  assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'approved');
  await assert.rejects(readFile(path.join(root, 'other.txt')), { code: 'ENOENT' });
});

test('write tickets expire and hard-linked targets cannot be edited', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ticket-expiry-'));
  const workspace = new Workspace(root);
  const pending = await workspace.prepareChange('file.txt', { content: 'approved' });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 6 * 60_000);
  await assert.rejects(workspace.commitChange(pending), /expired/);
  t.mock.restoreAll();
  await writeFile(path.join(root, 'file.txt'), 'linked content');
  await link(path.join(root, 'file.txt'), path.join(root, 'alias.txt'));
  await assert.rejects(workspace.prepareChange('alias.txt', { content: 'new' }), /Hard-linked/);
});
