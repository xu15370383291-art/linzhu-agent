import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Workspace } from '../backend/workspace.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { availableTools, runTurn } from '../backend/agent.js';
import { routeTool } from '../backend/tools/registry.js';
import { approveSandboxCommand } from '../backend/command-approval.js';
import { classifyIntent } from '../backend/agent/intent.js';

const call = command => ({ id: 'command-1', function: { name: 'sandbox_command', arguments: JSON.stringify({ command }) } });

test('sandbox command is invisible without verified backend and denied outside routed turn', async () => {
  const workspace = new Workspace(await mkdtemp(path.join(os.tmpdir(), 'agent-command-')));
  const policy = new PermissionPolicy({ sandboxReady: false, approveCommand: async () => true });
  const sandbox = { execute: async () => { throw new Error('must not run'); } };
  assert.ok(!availableTools(policy).some(tool => tool.function.name === 'sandbox_command'));
  assert.equal((await routeTool(call('pwd'), { workspace, policy, sandbox })).errorCode, 'TOOL_NOT_AVAILABLE');
  policy.sandboxReady = true;
  assert.equal((await routeTool(call('pwd'), { workspace, policy, sandbox, allowedTools: new Set(['read_file']) })).errorCode, 'TOOL_NOT_AVAILABLE');
  assert.equal((await routeTool(call('pwd\nwhoami'), { workspace, policy, sandbox })).errorCode, 'INVALID_ARGUMENTS');
});

test('each sandbox command requires approval and returns bounded executor result', async () => {
  const workspace = new Workspace(await mkdtemp(path.join(os.tmpdir(), 'agent-command-')));
  let approvals = 0;
  let executions = 0;
  let allow = false;
  const policy = new PermissionPolicy({ sandboxReady: true, approveCommand: async details => {
    approvals++;
    assert.equal(details.command, 'pwd');
    return allow;
  } });
  const sandbox = { execute: async () => { executions++; return { exitCode: 0, stdout: '/workspace\n', stderr: '' }; } };
  const invoke = () => routeTool(call('pwd'), { workspace, policy, sandbox });
  assert.equal((await invoke()).errorCode, 'USER_DENIED');
  assert.equal(executions, 0);
  allow = true;
  assert.equal(JSON.parse((await invoke()).content).stdout, '/workspace\n');
  allow = false;
  assert.equal((await invoke()).errorCode, 'USER_DENIED');
  assert.equal(approvals, 3);
  assert.equal(executions, 1);
});

test('model routes a command only to the verified sandbox group', async () => {
  const workspace = new Workspace(await mkdtemp(path.join(os.tmpdir(), 'agent-command-')));
  const policy = new PermissionPolicy({ sandboxReady: true, approveCommand: async () => true });
  const sandbox = { execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }) };
  let requests = 0;
  const answer = await runTurn({ session: { messages: [] }, input: '运行测试命令', workspace, sandbox, policy,
    request: async (messages, tools) => {
      requests++;
      assert.deepEqual(tools.map(tool => tool.function.name), ['sandbox_command']);
      if (requests === 1) return { choices: [{ message: { role: 'assistant', tool_calls: [call('pwd')] } }] };
      assert.equal(JSON.parse(JSON.parse(messages.at(-1).content).content).stdout, 'ok');
      return { choices: [{ message: { role: 'assistant', content: '已执行' } }] };
    },
  });
  assert.equal(answer, '已执行');
});

test('model routes project-modifying command requests to the writable sandbox group only', () => {
  const intent = classifyIntent('运行命令修改项目文件');
  assert.deepEqual(intent.groups, ['sandbox.command.write']);
  assert.equal(intent.preferredTool, 'sandbox_command_write');
});

test('command approval releases input on accept, denial and too-small terminal', async () => {
  for (const [key, allowed] of [['y', true], ['n', false], ['\x03', false]]) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = output.isTTY = true;
    input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    output.rows = 10;
    output.columns = 100;
    const pending = approveSandboxCommand({ command: 'pwd', workspace: 'D:\\agent' }, { input, output });
    input.write(key);
    assert.equal(await pending, allowed);
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount('keypress'), 0);
  }
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.columns = 10;
  await assert.rejects(approveSandboxCommand({ command: 'pwd', workspace: 'D:\\agent' }, { input, output }), /too small/);
  assert.equal(input.isRaw, false);
});

test('command approval wraps a longer command without hiding text', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.rows = 12;
  output.columns = 48;
  let display = '';
  output.on('data', chunk => { display += chunk; });
  const command = 'git status --short --untracked-files=normal';
  const pending = approveSandboxCommand({ command, workspace: 'D:\\personal agent' }, { input, output });
  assert.match(display.replace(/\x1b\[[\d;?]*[A-Za-z]/g, ''), /命令：git status --short --untracked-files=normal/);
  input.write('n');
  assert.equal(await pending, false);
});
