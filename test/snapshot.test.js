import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, link, symlink, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withSnapshot, commitWindowsChange } from '../backend/sandbox/snapshot.js';
import { Workspace } from '../backend/workspace.js';
const native = process.platform === 'win32' && (process.env.AGENT_TEST_NATIVE === '1' || process.env.AGENT_TEST_WSL === '1');

test('Windows locked snapshot copies only visible files and cleans up after errors', { skip: !native }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-snapshot-test-'));
  await writeFile(path.join(root, 'visible.txt'), 'public');
  await mkdir(path.join(root, '.agent-data'));
  await writeFile(path.join(root, '.agent-data', 'key'), 'secret');
  let copied;
  await withSnapshot(root, async (snapshot, metadata) => {
    copied = snapshot;
    assert.equal(await readFile(path.join(snapshot, 'visible.txt'), 'utf8'), 'public');
    await assert.rejects(readFile(path.join(snapshot, '.agent-data', 'key')), { code: 'ENOENT' });
    assert.equal(metadata['visible.txt'].sizeBytes, 6);
    await writeFile(path.join(root, 'visible.txt'), 'changed after snapshot');
    assert.equal(await readFile(path.join(snapshot, 'visible.txt'), 'utf8'), 'public');
  });
  await assert.rejects(stat(copied), { code: 'ENOENT' });
  await assert.rejects(withSnapshot(root, async snapshot => { copied = snapshot; throw new Error('callback failure'); }), /callback failure/);
  await assert.rejects(stat(copied), { code: 'ENOENT' });
});

test('Windows commit broker atomically creates/replaces files and rejects stale content', { skip: !native }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-native-commit-'));
  const workspace = new Workspace(root, { commitBroker: commitWindowsChange });
  await workspace.commitChange(await workspace.prepareChange('nested/child/file.txt', { content: 'nested' }));
  assert.equal(await readFile(path.join(root, 'nested', 'child', 'file.txt'), 'utf8'), 'nested');
  await workspace.commitChange(await workspace.prepareChange('file.txt', { content: 'original' }));
  await workspace.commitChange(await workspace.prepareChange('file.txt', { content: 'replacement' }));
  assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'replacement');
  const pending = await workspace.prepareChange('file.txt', { content: 'must not commit' });
  await writeFile(path.join(root, 'file.txt'), 'concurrent');
  await assert.rejects(workspace.commitChange(pending), /File changed since preview/);
  assert.equal(await readFile(path.join(root, 'file.txt'), 'utf8'), 'concurrent');
});

test('Windows snapshot rejects hard links, junctions, alternate streams and byte quotas', { skip: !native }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-snapshot-deny-'));
  const file = path.join(root, 'visible.txt');
  await writeFile(file, 'original');
  await link(file, path.join(root, 'alias.txt'));
  await assert.rejects(withSnapshot(file, () => assert.fail('must not expose hard link')), /hard links/);
  await assert.rejects(withSnapshot(`${file}:stream`, () => {}), /Alternate streams/);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-snapshot-outside-'));
  await symlink(outside, path.join(root, 'junction'), 'junction');
  await assert.rejects(withSnapshot(path.join(root, 'junction'), () => {}), /Reparse/);
  const large = path.join(outside, 'large.txt');
  await writeFile(large, Buffer.alloc(2_000_001));
  await assert.rejects(withSnapshot(large, () => {}), /byte quota/);
});

test('operation snapshots list and find large files without copying their bodies', { skip: !native }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-snapshot-mode-'));
  await writeFile(path.join(root, 'large.bin'), Buffer.alloc(2_000_001));
  await writeFile(path.join(root, 'small.txt'), 'needle');
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'child.txt'), 'child');
  await withSnapshot(root, async snapshot => {
    assert.equal((await stat(path.join(snapshot, 'large.bin'))).size, 0);
    await assert.rejects(stat(path.join(snapshot, 'nested', 'child.txt')), { code: 'ENOENT' });
  }, { mode: 'list_files' });
  await withSnapshot(root, async snapshot => {
    assert.equal((await stat(path.join(snapshot, 'nested', 'child.txt'))).size, 0);
  }, { mode: 'find_files' });
  await withSnapshot(root, async snapshot => {
    assert.equal((await stat(path.join(snapshot, 'large.bin'))).size, 100001);
    assert.equal(await readFile(path.join(snapshot, 'small.txt'), 'utf8'), 'needle');
  }, { mode: 'search_text' });
  await withSnapshot(path.join(root, 'large.bin'), async (snapshot, metadata) => {
    assert.equal(metadata['.'].sizeBytes, 2_000_001);
    assert.equal((await stat(snapshot)).size, 0);
  }, { mode: 'file_info' });
});
