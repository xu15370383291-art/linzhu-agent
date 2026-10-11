import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../backend/workspace.js';
import { ExternalReads } from '../backend/tools/external-reads.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { availableTools, runTurn } from '../backend/agent.js';
import { routeTool } from '../backend/tools/registry.js';
import { classifyIntent } from '../backend/agent/intent.js';

const call = (name, args) => ({ id: 't1', function: { name, arguments: JSON.stringify(args) } });

test('read and write intents route to distinct groups', () => {
  const read = classifyIntent('读取 README 文件');
  const write = classifyIntent('创建一个文件');
  assert.deepEqual(read.groups, ['workspace.read']);
  assert.deepEqual(write.groups, ['workspace.read', 'workspace.write']);
  assert.equal(classifyIntent('请调用 write_file 在工作区创建 test.txt 文件').kind, 'workspace_write');
  assert.equal(classifyIntent('请调用 edit_file 修改 test.txt 文件').kind, 'workspace_edit');
});

test('MCP concepts stay on the direct-answer route while explicit operations expose MCP tools', () => {
  for (const input of ['mcp是什么', '什么是 MCP？', 'MCP 有什么用？', '解释一下 Model Context Protocol']) {
    assert.notEqual(classifyIntent(input).kind, 'mcp', input);
  }
  for (const input of ['列出当前 MCP 服务器的工具', '帮我调用 MCP 工具', 'call the configured MCP server']) {
    assert.equal(classifyIntent(input).kind, 'mcp', input);
  }
});

test('MCP concept questions do not expose MCP operation tools to the model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-mcp-concept-'));
  const policy = new PermissionPolicy({ mcpReady: true });
  const skills = { list: async () => [{ id: 'mianshi', name: '面试回答', description: '整理面试回答模板' }] };
  let calls = 0;
  const answer = await runTurn({ session: { messages: [] }, input: 'mcp是什么', workspace: new Workspace(root), skills, policy,
    request: async (messages, tools) => {
      calls++;
      if (calls === 1) {
        assert.match(messages[0].content, /你是 Skill 语义路由器/);
        assert.deepEqual(tools, []);
        return { choices: [{ message: { role: 'assistant', content: 'NONE' } }] };
      }
      const names = tools.map(tool => tool.function.name);
      assert.ok(!names.includes('mcp_call_tool'));
      assert.ok(!names.includes('mcp_list_tools'));
      assert.ok(!names.includes('get_skills'));
      assert.ok(!names.includes('load_skill'));
      return { choices: [{ message: { role: 'assistant', content: 'MCP 是用于连接 AI 应用与外部工具、数据源的协议。' } }] };
    } });
  assert.match(answer, /外部工具、数据源/);
  assert.equal(calls, 2);
});

test('side-effect service tools are exposed only for matching explicit intent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-service-route-'));
  const policy = new PermissionPolicy({ messageReady: true, taskReady: true, mcpReady: true });
  const request = async (_messages, tools) => {
    const names = tools.map(tool => tool.function.name);
    assert.ok(names.includes('send_message'));
    assert.ok(!names.includes('task_create'));
    assert.ok(!names.includes('mcp_call_tool'));
    return { choices: [{ message: { role: 'assistant', content: '已处理' } }] };
  };
  await runTurn({ session: { messages: [] }, input: '发送一条消息', workspace: new Workspace(root), policy, request });
});

test('execution rejects tools not exposed in this turn, including writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-route-'));
  const workspace = new Workspace(root);
  let approved = 0;
  const policy = new PermissionPolicy({ approveWrite: async () => { approved++; return true; } });
  const blocked = await routeTool(call('write_file', { path: 'x.txt', content: 'x' }),
    { workspace, policy, allowedTools: new Set(['read_file']) });
  assert.equal(blocked.errorCode, 'TOOL_NOT_AVAILABLE');
  assert.equal(approved, 0);
  await assert.rejects(readFile(path.join(root, 'x.txt')), { code: 'ENOENT' });
  const session = { messages: [] };
  const response = await runTurn({ session, input: '读取 README 文件', workspace, policy,
    request: async (messages, tools) => messages.at(-1).role === 'user'
      ? (assert.ok(tools.every(tool => !['write_file', 'edit_file'].includes(tool.function.name))),
        { choices: [{ message: { role: 'assistant', tool_calls: [call('write_file', { path: 'x.txt', content: 'x' })] } }] })
      : { choices: [{ message: { role: 'assistant', content: '拒绝写入' } }] },
  });
  assert.equal(response, '拒绝写入');
  assert.equal(approved, 0);
});

test('isolated file reads fail closed when the verified executor is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-route-'));
  await writeFile(path.join(root, 'note.txt'), 'private');
  const result = await routeTool(call('read_file', { path: 'note.txt' }), {
    workspace: new Workspace(root), policy: new PermissionPolicy({ sandboxReady: true }),
  });
  assert.equal(result.errorCode, 'PERMISSION_DENIED');
  const external = await mkdtemp(path.join(os.tmpdir(), 'agent-outside-'));
  const target = path.join(external, 'note.txt');
  await writeFile(target, 'external');
  const externalResult = await routeTool(call('external_read_file', { path: target }), {
    workspace: new Workspace(root), policy: new PermissionPolicy({ sandboxReady: true }),
    externalReads: new ExternalReads({ approve: async () => true }),
  });
  assert.equal(externalResult.errorCode, 'PERMISSION_DENIED');
});

test('changing an external target during approval prevents the isolated read', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-route-'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'agent-outside-'));
  const target = path.join(external, 'note.txt');
  await writeFile(target, 'before');
  let executed = 0;
  const externalReads = new ExternalReads({ approve: async () => {
    await writeFile(target, 'after');
    return true;
  } });
  const sandbox = { readExternal: async () => { executed++; return 'unexpected'; } };
  const result = await routeTool(call('external_read_file', { path: target }), {
    workspace: new Workspace(root), externalReads, sandbox,
    policy: new PermissionPolicy({ sandboxReady: true }),
  });
  assert.equal(result.errorCode, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(executed, 0);
});

test('external reads require approval per call and never permit writes or escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-external-'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'agent-outside-'));
  await writeFile(path.join(external, 'note.txt'), 'external text');
  await symlink(root, path.join(external, 'shortcut'), 'junction');
  const workspace = new Workspace(root);
  let approvals = 0;
  let allow = false;
  const externalReads = new ExternalReads({ approve: async ({ path: target }) => {
    approvals++;
    assert.ok(path.isAbsolute(target));
    return allow;
  } });
  const policy = new PermissionPolicy();
  const invoke = (name, args) => routeTool(call(name, args), { workspace, externalReads, policy });
  assert.ok(availableTools(policy).some(tool => tool.function.name === 'external_read_file'));
  assert.equal((await invoke('external_read_file', { path: 'relative' })).errorCode, 'WORKSPACE_ACCESS_DENIED');
  await mkdir(path.join(external, '.agent-data'));
  assert.equal((await invoke('external_file_info', { path: path.join(external, '.agent-data') })).errorCode, 'WORKSPACE_ACCESS_DENIED');
  assert.equal((await invoke('external_file_info', { path: path.join(external, '.AGENT-DATA') })).errorCode, 'WORKSPACE_ACCESS_DENIED');
  assert.equal((await invoke('external_file_info', { path: path.join(external, 'shortcut') })).errorCode, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(approvals, 0);
  const target = path.join(external, 'note.txt');
  assert.equal((await invoke('external_read_file', { path: target })).errorCode, 'USER_DENIED');
  allow = true;
  assert.equal((await invoke('external_read_file', { path: target })).content, 'external text');
  assert.equal(JSON.parse((await invoke('external_list_files', { path: external })).content).items[0].path, target);
  assert.equal(approvals, 3);
  allow = false;
  assert.equal((await invoke('external_read_file', { path: target })).errorCode, 'USER_DENIED');
  assert.equal(approvals, 4);
  assert.equal((await invoke('write_file', { path: '../note.txt', content: 'changed' })).isError, true);
  assert.equal(await readFile(path.join(external, 'note.txt'), 'utf8'), 'external text');
});

test('model proposes an external path but sees content only after approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-route-'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'agent-outside-'));
  const target = path.join(external, 'note.txt');
  await writeFile(target, 'private note');
  const workspace = new Workspace(root);
  for (const allow of [false, true]) {
    let approvals = 0;
    let requests = 0;
    const externalReads = new ExternalReads({ approve: async () => { approvals++; return allow; } });
    const answer = await runTurn({ session: { messages: [] }, input: `读取文件 ${target}`, workspace,
      externalReads, policy: new PermissionPolicy(),
      request: async (messages, tools) => {
        requests++;
        assert.ok(tools.some(tool => tool.function.name === 'external_read_file'));
        if (requests === 1) return { choices: [{ message: { role: 'assistant', tool_calls: [call('external_read_file', { path: target })] } }] };
        const observation = JSON.parse(messages.at(-1).content);
        assert.equal(observation.isError, !allow);
        assert.equal(observation.content.includes('private note'), allow);
        return { choices: [{ message: { role: 'assistant', content: allow ? '已读取' : '用户拒绝' } }] };
      },
    });
    assert.equal(answer, allow ? '已读取' : '用户拒绝');
    assert.equal(approvals, 1);
  }
});
