import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../backend/workspace.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { routeTool } from '../backend/tools/registry.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-pages-'));
  return { root, workspace: new Workspace(root) };
}

const invoke = async (workspace, name, args) => {
  const result = await routeTool({ function: { name, arguments: JSON.stringify(args) } }, { workspace, policy: new PermissionPolicy() });
  if (result.isError) return result;
  return JSON.parse(result.content);
};

test('read_file ranges report line numbers and preserve the original full-text call', async () => {
  const { root, workspace } = await fixture();
  await writeFile(path.join(root, 'large.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n'));
  assert.equal((await invoke(workspace, 'read_file', { path: 'large.txt' })).isError, true);
  const first = await invoke(workspace, 'read_file', { path: 'large.txt', lineCount: 2 });
  assert.deepEqual(first.lines, [{ line: 1, text: 'line 1' }, { line: 2, text: 'line 2' }]);
  assert.equal(first.totalLines, 5000);
  assert.equal(first.hasMore, true);
  const last = await invoke(workspace, 'read_file', { path: 'large.txt', startLine: 4999, lineCount: 2 });
  assert.equal(last.lines.at(-1).text, 'line 5000');
  assert.equal(last.hasMore, false);
  assert.equal((await invoke(workspace, 'read_file', { path: 'large.txt', lineCount: 201 })).errorCode, 'INVALID_ARGUMENTS');
  assert.equal((await invoke(workspace, 'read_file', { path: 'large.txt', startLine: 0 })).errorCode, 'INVALID_ARGUMENTS');
  assert.equal((await invoke(workspace, 'read_file', { path: '../large.txt', startLine: 1 })).isError, true);
  assert.equal((await invoke(workspace, 'read_file', { path: '.agent-data/models.json', startLine: 1 })).isError, true);
  await workspace.write('small.txt', 'original');
  assert.equal((await routeTool({ function: { name: 'read_file', arguments: '{"path":"small.txt"}' } },
    { workspace, policy: new PermissionPolicy() })).content, 'original');
});

test('file_info reports text metadata without reading private or linked files', async () => {
  const { root, workspace } = await fixture();
  const rootInfo = await invoke(workspace, 'file_info', { path: '.' });
  assert.equal(rootInfo.type, 'directory');
  assert.equal(rootInfo.sizeBytes, 0);
  await workspace.write('docs/note.txt', 'one\ntwo');
  await writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  const text = await invoke(workspace, 'file_info', { path: 'docs/note.txt' });
  assert.equal(text.type, 'file');
  assert.equal(text.sizeBytes, 7);
  assert.equal(text.totalLines, 2);
  assert.ok(!Number.isNaN(Date.parse(text.modifiedAt)));
  assert.equal((await invoke(workspace, 'file_info', { path: 'docs' })).type, 'directory');
  assert.equal((await invoke(workspace, 'file_info', { path: 'binary.dat' })).totalLines, null);
  await symlink(os.tmpdir(), path.join(root, 'link'), 'junction');
  assert.equal((await invoke(workspace, 'file_info', { path: 'link' })).isError, true);
  assert.equal((await invoke(workspace, 'file_info', { path: '.agent-data/models.json' })).isError, true);
  assert.equal((await invoke(workspace, 'file_info', { path: '../outside' })).isError, true);
});

test('directory pages are sorted, reject changed snapshots and wrong cursors', async () => {
  const { workspace } = await fixture();
  for (const name of ['c.txt', 'a.txt', 'b.txt']) await workspace.write(name, name);
  const first = await invoke(workspace, 'list_files', { limit: 2 });
  assert.deepEqual(first.items.map(item => item.path), ['a.txt', 'b.txt']);
  const second = await invoke(workspace, 'list_files', { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(item => item.path), ['c.txt']);
  assert.equal(second.nextCursor, null);
  assert.equal((await invoke(workspace, 'list_files', { limit: 2, cursor: first.nextCursor })).isError, true);
  const changed = await invoke(workspace, 'list_files', { limit: 1 });
  await workspace.write('d.txt', 'd');
  assert.match((await invoke(workspace, 'list_files', { limit: 1, cursor: changed.nextCursor })).content, /Directory changed/);
  assert.equal((await invoke(workspace, 'list_files', { limit: 101 })).errorCode, 'INVALID_ARGUMENTS');
  const another = await invoke(workspace, 'list_files', { limit: 1 });
  assert.match((await invoke(workspace, 'list_files', { path: 'other', limit: 1, cursor: another.nextCursor })).content, /ENOENT|Invalid/);
  const expired = await invoke(workspace, 'list_files', { limit: 1 });
  workspace.pages.get(expired.nextCursor).expires = Date.now() - 1;
  assert.match((await invoke(workspace, 'list_files', { limit: 1, cursor: expired.nextCursor })).content, /Invalid or expired cursor/);
});

test('filename and text pages continue without duplicates and exclude private paths', async () => {
  const { root, workspace } = await fixture();
  await mkdir(path.join(root, '.agent-data'));
  await writeFile(path.join(root, '.agent-data', 'note.txt'), 'needle');
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules', 'note.txt'), 'needle');
  await workspace.write('notes/a-note.txt', 'needle\nneedle\n');
  await workspace.write('notes/b-note.txt', 'needle');
  await symlink(os.tmpdir(), path.join(root, 'link'), 'junction');
  const found = await invoke(workspace, 'find_files', { query: 'note', limit: 1 });
  assert.deepEqual(found.items.map(item => item.path), ['notes']);
  const foundNext = await invoke(workspace, 'find_files', { query: 'note', limit: 2, cursor: found.nextCursor });
  assert.deepEqual(foundNext.items.map(item => item.path), ['notes/a-note.txt', 'notes/b-note.txt']);
  const results = [];
  let cursor;
  do {
    const page = await invoke(workspace, 'search_text', { query: 'needle', limit: 1, ...(cursor ? { cursor } : {}) });
    results.push(...page.matches);
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(results.map(item => `${item.path}:${item.line}`), ['notes/a-note.txt:1', 'notes/a-note.txt:2', 'notes/b-note.txt:1']);
  assert.equal((await invoke(workspace, 'find_files', { query: 'a', path: '.agent-data' })).isError, true);
  assert.equal((await invoke(workspace, 'find_files', { query: 'a', path: 'link' })).isError, true);
  assert.equal((await invoke(workspace, 'search_text', { query: 'other', limit: 1, cursor: foundNext.nextCursor })).isError, true);
  const mismatched = await invoke(workspace, 'search_text', { query: 'needle', limit: 1 });
  assert.match((await invoke(workspace, 'search_text', { query: 'other', limit: 1, cursor: mismatched.nextCursor })).content, /Invalid or expired cursor/);
  assert.equal((await invoke(workspace, 'find_files', { query: 'note', path: '../' })).isError, true);
});
