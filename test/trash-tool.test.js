import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../backend/workspace.js';
import { TrashStore } from '../backend/security/trash.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { routeTool } from '../backend/tools/registry.js';
import { classifyIntent } from '../backend/agent/intent.js';

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test('delete_file moves a workspace file to recoverable Trash only after approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-trash-tool-')); const target = path.join(root, 'remove-me.txt'); await writeFile(target, 'keep me');
  const trash = new TrashStore(root); const workspace = new Workspace(root); const policy = new PermissionPolicy({ trashReady: true, approveWrite: async () => true });
  assert.equal(classifyIntent('删除文件 remove-me.txt').preferredTool, 'delete_file');
  const result = await routeTool(call('delete_file', { path: 'remove-me.txt' }), { workspace, trash, policy });
  assert.equal(result.isError, false); await assert.rejects(readFile(target), { code: 'ENOENT' });
  const item = JSON.parse(result.content); assert.equal(item.status, 'trashed');
  const restored = await routeTool(call('restore_file', { id: item.id }), { workspace, trash, policy });
  assert.equal(JSON.parse(restored.content).status, 'restored'); assert.equal(await readFile(target, 'utf8'), 'keep me');
});

test('delete_file denial and protected paths have no side effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-trash-tool-deny-')); await writeFile(path.join(root, 'keep.txt'), 'keep');
  const trash = new TrashStore(root); const workspace = new Workspace(root);
  const denied = await routeTool(call('delete_file', { path: 'keep.txt' }), { workspace, trash, policy: new PermissionPolicy({ trashReady: true, approveWrite: async () => false }) });
  assert.equal(denied.errorCode, 'USER_DENIED'); assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'keep');
  const blocked = await routeTool(call('delete_file', { path: '.env' }), { workspace, trash, policy: new PermissionPolicy({ trashReady: true, approveWrite: async () => true }) });
  assert.equal(blocked.isError, true);
});
