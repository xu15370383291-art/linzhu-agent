import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink, link, mkdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExternalWrites } from '../backend/tools/external-writes.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { routeTool } from '../backend/tools/registry.js';
import { availableTools } from '../backend/tools/registry.js';
import { Workspace } from '../backend/workspace.js';
import { classifyIntent } from '../backend/agent/intent.js';
import { runTurn } from '../backend/agent.js';

const call = (name, args) => ({ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } });
const setup = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-external-write-workspace-'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'agent-external-write-target-'));
  return { root, external, workspace: new Workspace(root), externalWrites: new ExternalWrites({ root }) };
};

test('external write tools are separate from external reads and require absolute paths', async () => {
  const { root, external, workspace, externalWrites } = await setup();
  const policy = new PermissionPolicy({ approveWrite: async () => true });
  const names = availableTools(policy).map(tool => tool.function.name);
  assert.ok(names.includes('external_write_file'));
  assert.ok(names.includes('external_edit_file'));
  assert.deepEqual(classifyIntent(`写入 ${path.join(external, 'note.txt')}`).groups, ['external.write']);
  assert.deepEqual(classifyIntent(`读取 ${path.join(external, 'note.txt')} 后保存 ${path.join(external, 'copy.txt')}`).groups,
    ['external.read', 'external.write']);
  assert.equal((await routeTool(call('external_write_file', { path: 'relative.txt', content: 'x' }), { workspace, externalWrites, policy })).errorCode, 'WORKSPACE_ACCESS_DENIED');
  assert.equal((await routeTool(call('external_write_file', { path: path.join(root, 'inside.txt'), content: 'x' }), { workspace, externalWrites, policy })).errorCode, 'WORKSPACE_ACCESS_DENIED');
});

test('external write intent recognizes Windows paths containing spaces and Chinese characters', () => {
  const text = '写入 "C:\\Users\\测试用户\\My Project\\notes.txt"，内容为 hello';
  const intent = classifyIntent(text);
  assert.deepEqual(intent.groups, ['external.write']);
  assert.equal(intent.preferredTool, 'external_write_file');
  assert.equal(intent.mustUseTool, true);
});

test('external write and edit show absolute path, require approval, and commit one file', async () => {
  const { root, external, workspace, externalWrites } = await setup();
  const target = path.join(external, 'note.txt');
  let previews = [];
  const policy = new PermissionPolicy({ approveWrite: async change => { previews.push(change); return true; } });
  const write = await routeTool(call('external_write_file', { path: target, content: 'before\nkeep\n' }), { workspace, externalWrites, policy });
  assert.equal(write.content, `Wrote ${target}`);
  assert.equal(await readFile(target, 'utf8'), 'before\nkeep\n');
  assert.equal(previews.at(-1).path, path.basename(target));
  assert.equal(previews.at(-1).displayPath, target);
  const edit = await routeTool(call('external_edit_file', { path: target, oldText: 'before', newText: 'after' }), { workspace, externalWrites, policy });
  assert.equal(edit.content, `Wrote ${target}`);
  assert.equal(await readFile(target, 'utf8'), 'after\nkeep\n');
  assert.equal(previews.length, 2);
});

test('external write denial and invalid targets have no side effects', async () => {
  const { root, external, workspace, externalWrites } = await setup();
  const target = path.join(external, 'denied.txt');
  const denied = await routeTool(call('external_write_file', { path: target, content: 'secret' }), {
    workspace, externalWrites, policy: new PermissionPolicy({ approveWrite: async () => false }),
  });
  assert.equal(denied.errorCode, 'USER_DENIED');
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  await mkdir(path.join(external, '.agent-data'));
  for (const bad of [path.join(external, '.env'), path.join(external, '.agent-data', 'model'), path.join(external, 'node_modules', 'x')]) {
    assert.equal((await routeTool(call('external_write_file', { path: bad, content: 'x' }), {
      workspace, externalWrites, policy: new PermissionPolicy({ approveWrite: async () => true }),
    })).errorCode, 'WORKSPACE_ACCESS_DENIED');
  }
  await symlink(root, path.join(external, 'linked-parent'), 'junction').catch(error => { if (error.code !== 'EPERM') throw error; });
  if (await readFile(path.join(external, 'linked-parent'), 'utf8').catch(() => null) === null) {
    const linked = path.join(external, 'linked-parent', 'x.txt');
    assert.equal((await routeTool(call('external_write_file', { path: linked, content: 'x' }), {
      workspace, externalWrites, policy: new PermissionPolicy({ approveWrite: async () => true }),
    })).errorCode, 'WORKSPACE_ACCESS_DENIED');
  }
});

test('external write rejects hard links and detects changes during approval', async () => {
  const { root, external, workspace, externalWrites } = await setup();
  const target = path.join(external, 'target.txt');
  const alias = path.join(external, 'alias.txt');
  await writeFile(target, 'original');
  await link(target, alias);
  const policy = new PermissionPolicy({ approveWrite: async () => true });
  assert.equal((await routeTool(call('external_edit_file', { path: alias, oldText: 'original', newText: 'changed' }), { workspace, externalWrites, policy })).errorCode, 'WORKSPACE_ACCESS_DENIED');
  await unlink(alias);
  const changing = new ExternalWrites({ root, });
  const result = await routeTool(call('external_edit_file', { path: target, oldText: 'original', newText: 'changed' }), {
    workspace, externalWrites: changing, policy: new PermissionPolicy({ approveWrite: async () => { await writeFile(target, 'concurrent'); return true; } }),
  });
  assert.equal(result.errorCode, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(await readFile(target, 'utf8'), 'concurrent');
});

test('new external file cannot be preempted after approval', async () => {
  const { root, external, workspace, externalWrites } = await setup();
  const target = path.join(external, 'race.txt');
  const result = await routeTool(call('external_write_file', { path: target, content: 'agent' }), {
    workspace, externalWrites, policy: new PermissionPolicy({ approveWrite: async () => { await writeFile(target, 'other'); return true; } }),
  });
  assert.match(result.content, /File changed|EEXIST|changed since approval/i);
  assert.equal(await readFile(target, 'utf8'), 'other');
});

test('external write is available in model tool loop and remains separate from read approval', async () => {
  const { root, external, workspace, externalWrites } = await setup();
  const target = path.join(external, 'model.txt');
  let requests = 0;
  const answer = await runTurn({
    session: { messages: [] }, input: `写入 ${target}`, workspace, externalWrites,
    policy: new PermissionPolicy({ approveWrite: async () => true }),
    request: async (messages, tools) => {
      requests++;
      assert.ok(tools.some(tool => tool.function.name === 'external_write_file'));
      assert.ok(!tools.some(tool => tool.function.name === 'external_read_file'));
      if (requests === 1) return { choices: [{ message: { role: 'assistant', tool_calls: [call('external_write_file', { path: target, content: 'from model' })] } }] };
      assert.match(messages.at(-1).content, /Wrote/);
      return { choices: [{ message: { role: 'assistant', content: '已写入外部文件' } }] };
    },
  });
  assert.equal(answer, '已写入外部文件');
  assert.equal(await readFile(target, 'utf8'), 'from model');
});
