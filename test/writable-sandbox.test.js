import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WritableSandbox } from '../backend/sandbox/writable.js';
import { WslSandbox } from '../backend/sandbox/wsl.js';
import { commitWindowsChange } from '../backend/sandbox/snapshot.js';

test('writable sandbox edits disposable copy and commits only approved diff', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-writable-')); await writeFile(path.join(root, 'note.txt'), 'before');
  const sandbox = new WritableSandbox(root, { runCommand: async (command, { cwd }) => { await writeFile(path.join(cwd, 'note.txt'), 'after'); return { exitCode: 0, stdout: 'ok', stderr: '' }; } });
  const item = await sandbox.prepare(); await sandbox.execute(item.id, 'edit'); const diff = await sandbox.collect(item.id); assert.equal(diff.changes[0].path, 'note.txt');
  const denied = await sandbox.commit(item.id, async () => false); assert.equal(denied.denied, true); assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'before');
});

test('writable sandbox rejects stale host files before commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-writable-stale-')); await writeFile(path.join(root, 'note.txt'), 'before');
  const sandbox = new WritableSandbox(root, { runCommand: async (_command, { cwd }) => { await writeFile(path.join(cwd, 'note.txt'), 'after'); } });
  const item = await sandbox.prepare(); await sandbox.execute(item.id, 'edit'); await sandbox.collect(item.id); await writeFile(path.join(root, 'note.txt'), 'external');
  await assert.rejects(sandbox.commit(item.id, async () => true), /changed since sandbox snapshot/); assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'external');
});

test('real WSL writable sandbox isolates the host workspace and commits reviewed changes', { skip: process.platform !== 'win32' || process.env.AGENT_TEST_WSL !== '1' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-writable-wsl-'));
  await writeFile(path.join(root, 'note.txt'), 'before');
  const wsl = new WslSandbox(root);
  assert.equal(await wsl.verify(), true);
  const sandbox = new WritableSandbox(root, {
    runCommand: (command, { cwd, signal }) => wsl.executeWritable(cwd, command, { signal }),
    commitBroker: commitWindowsChange,
  });
  const item = await sandbox.prepare();
  const result = await sandbox.execute(item.id, 'echo after > note.txt');
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'before');
  const changes = await sandbox.collect(item.id);
  assert.equal(changes.changes[0].path, 'note.txt');
  const committed = await sandbox.commit(item.id, async () => true);
  assert.equal(committed.committed, true);
  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'after\n');
});
