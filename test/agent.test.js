import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../backend/workspace.js';
import { Sessions } from '../backend/sessions.js';
import { availableTools, runTurn } from '../backend/agent.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { routeTool } from '../backend/tools/registry.js';
import { resolveVisibleTools } from '../backend/tools/surface.js';
import { registeredTools } from '../backend/tools/registry.js';
import { classifyIntent } from '../backend/agent/intent.js';
import { ContextManager } from '../backend/context/manager.js';
import { DEFAULT_EXECUTION_LIMITS, HARD_EXECUTION_LIMITS, resolveExecutionLimits } from '../backend/agent/limits.js';

test('execution limits provide a larger development budget with bounded overrides', () => {
  assert.deepEqual(DEFAULT_EXECUTION_LIMITS, { maxRounds: 24, maxToolCalls: 64, maxConsecutiveFailures: 5 });
  assert.equal(HARD_EXECUTION_LIMITS.maxToolCalls, 256);
  assert.deepEqual(resolveExecutionLimits({ maxRounds: 999, maxToolCalls: 999, maxConsecutiveFailures: 999 }), { maxRounds: 64, maxToolCalls: 256, maxConsecutiveFailures: 8 });
  assert.deepEqual(resolveExecutionLimits({ maxRounds: 0, maxToolCalls: 'invalid' }), DEFAULT_EXECUTION_LIMITS);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-'));
  return { root, workspace: new Workspace(root), sessions: new Sessions(root) };
}

test('workspace reads/writes local files and rejects escapes or private data', async () => {
  const { root, workspace } = await fixture();
  await workspace.write('notes/today.txt', 'Hello');
  assert.equal(await workspace.read('notes/today.txt'), 'Hello');
  await assert.rejects(workspace.read('../outside.txt'), /escapes/);
  await assert.rejects(workspace.write('.agent-data/secrets', 'x'), /private/);
  await assert.rejects(workspace.read('.env'), /private/);
  await assert.rejects(workspace.read('.env.local'), /private/);
  await assert.rejects(workspace.read('C:\\Windows\\win.ini'), /Absolute/);
  await symlink(os.tmpdir(), path.join(root, 'link'), 'junction');
  await assert.rejects(workspace.write('link/escape.txt', 'x'), /Symlinks/);
});

test('session can be saved and resumed', async () => {
  const { sessions } = await fixture();
  const session = await sessions.create();
  session.messages.push({ role: 'user', content: 'hello' });
  await sessions.save(session);
  assert.deepEqual((await sessions.get(session.id)).messages, session.messages);
  assert.deepEqual(await sessions.list(), [session.id]);
  assert.throws(() => sessions.file('../escape'), /Invalid/);
});

test('session summaries are searchable, recent first and renameable', async () => {
  const { sessions } = await fixture();
  const first = await sessions.create();
  first.messages.push({ role: 'user', content: '查找 项目文件' }, { role: 'assistant', content: 'done' });
  await sessions.save(first);
  const second = await sessions.create();
  assert.equal((await sessions.summaries('查找'))[0].title, '查找 项目文件');
  assert.equal((await sessions.summaries())[0].id, second.id);
  await sessions.rename(first.id, '项目讨论');
  assert.equal((await sessions.summaries('项目讨论'))[0].id, first.id);
  assert.equal((await sessions.get(first.id)).messages.length, 2);
  await assert.rejects(sessions.rename(first.id, ' '), /Title/);
});

test('archived sessions stay persisted and are separated from normal summaries', async () => {
  const { sessions } = await fixture();
  const session = await sessions.create();
  session.messages.push({ role: 'user', content: '保留的请求' }, { role: 'assistant', content: '保留的回答' });
  await sessions.save(session);
  const archived = await sessions.archive(session.id);
  assert.ok(archived.archivedAt);
  assert.equal((await sessions.get(session.id)).messages.length, 2);
  assert.equal((await sessions.summaries()).some(item => item.id === session.id), false);
  assert.equal((await sessions.summaries('', { archived: true })).some(item => item.id === session.id), true);
  await sessions.restore(session.id);
  assert.equal((await sessions.summaries()).some(item => item.id === session.id), true);
  assert.equal((await sessions.summaries('', { archived: true })).some(item => item.id === session.id), false);
});

test('legacy sessions remain searchable without rewriting their messages', async () => {
  const { root, sessions } = await fixture();
  const id = '12345678-1234-1234-1234-123456789abc';
  await mkdir(path.join(root, '.agent-data', 'sessions'), { recursive: true });
  await writeFile(sessions.file(id), JSON.stringify({ id, createdAt: '2026-01-01T00:00:00Z', messages: [
    { role: 'user', content: '旧会话问题' }, { role: 'assistant', content: '旧答案' },
  ] }));
  const summary = (await sessions.summaries('旧会话'))[0];
  assert.equal(summary.id, id);
  assert.equal(summary.title, '旧会话问题');
  assert.ok(summary.updatedAt);
  assert.equal((await sessions.get(id)).messages[1].content, '旧答案');
});

test('tool round trip retains messages and write requires approval', async () => {
  const { workspace, sessions } = await fixture();
  const session = await sessions.create();
  const responses = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'draft.txt', content: 'draft' }) } }] } }] },
    { choices: [{ message: { role: 'assistant', content: 'Done' } }] },
  ];
  let approved = 0;
  const result = await runTurn({
    session, input: 'write a draft', workspace,
    policy: new PermissionPolicy({ approveWrite: async () => { approved++; return false; } }),
    request: async (messages, tools) => {
      assert.ok(tools.some(tool => tool.function.name === 'write_file'));
      assert.ok(!tools.some(tool => ['get_skills', 'load_skill', 'load_skill_resource', 'run_skill_script'].includes(tool.function.name)));
      if (responses.length === 1) assert.match(messages.at(-1).content, /USER_DENIED/);
      return responses.shift();
    },
  });
  assert.equal(result, 'Done');
  assert.equal(approved, 1);
  await assert.rejects(readFile(path.join(workspace.root, 'draft.txt')), { code: 'ENOENT' });
  assert.equal(session.messages.length, 4);
  assert.deepEqual(availableTools(new PermissionPolicy()).map((tool) => tool.function.name), ['get_skills', 'load_skill', 'load_skill_resource', 'delegate_task', 'file_info', 'read_file', 'list_files', 'find_files', 'search_text', 'write_file', 'edit_file', 'external_file_info', 'external_read_file', 'external_list_files', 'external_find_files', 'external_search_text', 'external_write_file', 'external_edit_file']);
});

test('structured phase acceptance validates real workspace output before releasing dependent steps', async () => {
  const { workspace, sessions } = await fixture();
  const session = await sessions.create();
  const structuredPlan = {
    version: 1, id: 'phase-acceptance', revision: 1, status: 'ready', goal: '写文件并读取验证',
    phases: [
      { id: 'build', title: '写入产物', dependsOn: [], acceptance: { type: 'file_contains', path: 'output.txt', text: 'READY' }, status: 'pending', acceptanceStatus: 'pending' },
      { id: 'verify', title: '后续读取', dependsOn: ['build'], acceptance: { type: 'all_steps' }, status: 'pending', acceptanceStatus: 'pending' },
    ],
    steps: [
      { id: 'write', phaseId: 'build', title: '写入文件', dependsOn: [], tools: ['write_file'], sideEffect: true, acceptance: { type: 'tool_success' }, retryPolicy: { maxAttempts: 2, mode: 'safe' }, status: 'pending', attempts: 0 },
      { id: 'read', phaseId: 'verify', title: '读取文件', dependsOn: ['write'], tools: ['read_file'], acceptance: { type: 'tool_success' }, retryPolicy: { maxAttempts: 2, mode: 'safe' }, status: 'pending', attempts: 0 },
    ], checkpoints: [],
  };
  const responses = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'write-call', function: { name: 'write_file', arguments: JSON.stringify({ path: 'output.txt', content: 'PENDING' }) } }] } }] },
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'blocked-read', function: { name: 'read_file', arguments: JSON.stringify({ path: 'output.txt' }) } }] } }] },
    { choices: [{ message: { role: 'assistant', content: '停止，验收未通过。' } }] },
  ];
  let requests = 0;
  await assert.rejects(runTurn({ session, input: '写入并验证文件', workspace, structuredPlan, policy: new PermissionPolicy({ approveWrite: async () => true }),
    request: async () => { requests++; return responses.shift(); },
  }), { code: 'PHASE_ACCEPTANCE_FAILED' });
  assert.equal(requests, 1);
  assert.equal(structuredPlan.steps[0].status, 'completed');
  assert.equal(structuredPlan.phases[0].status, 'failed');
  assert.equal(structuredPlan.phases[0].acceptanceStatus, 'failed');
  assert.equal(structuredPlan.steps[1].attempts, 0);
});

test('stage acceptance success releases the dependent phase only after file evidence matches', async () => {
  const { workspace, sessions } = await fixture();
  const session = await sessions.create();
  const structuredPlan = {
    version: 1, id: 'phase-acceptance-pass', revision: 1, status: 'ready', goal: '写文件并读取验证',
    phases: [
      { id: 'build', title: '写入产物', dependsOn: [], acceptance: { type: 'file_contains', path: 'output.txt', text: 'READY' }, status: 'pending', acceptanceStatus: 'pending' },
      { id: 'verify', title: '后续读取', dependsOn: ['build'], acceptance: { type: 'all_steps' }, status: 'pending', acceptanceStatus: 'pending' },
    ],
    steps: [
      { id: 'write', phaseId: 'build', title: '写入文件', dependsOn: [], tools: ['write_file'], sideEffect: true, acceptance: { type: 'tool_success' }, retryPolicy: { maxAttempts: 2, mode: 'safe' }, status: 'pending', attempts: 0 },
      { id: 'read', phaseId: 'verify', title: '读取文件', dependsOn: ['write'], tools: ['read_file'], acceptance: { type: 'tool_success' }, retryPolicy: { maxAttempts: 2, mode: 'safe' }, status: 'pending', attempts: 0 },
    ], checkpoints: [],
  };
  const responses = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'write-call', function: { name: 'write_file', arguments: JSON.stringify({ path: 'output.txt', content: 'READY' }) } }] } }] },
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'read-call', function: { name: 'read_file', arguments: JSON.stringify({ path: 'output.txt' }) } }] } }] },
    { choices: [{ message: { role: 'assistant', content: '完成。' } }] },
  ];
  const answer = await runTurn({ session, input: '写入并验证文件', workspace, structuredPlan, policy: new PermissionPolicy({ approveWrite: async () => true }), request: async () => responses.shift() });
  assert.equal(answer, '完成。');
  assert.equal(structuredPlan.phases[0].acceptanceStatus, 'passed');
  assert.equal(structuredPlan.phases[0].status, 'completed');
  assert.equal(structuredPlan.steps[1].status, 'completed');
});

test('model tool definitions are unique when clarification and plugin surfaces overlap', async () => {
  const { workspace, sessions } = await fixture();
  const session = await sessions.create();
  let names;
  await runTurn({ session, input: '你好', workspace, policy: new PermissionPolicy(),
    plugins: { async toolDefinitions() { return [{ definition: { type: 'function', function: { name: 'ask_user', description: 'duplicate plugin name', parameters: { type: 'object', properties: {}, required: [] } } } }]; } },
    request: async (_messages, tools) => { names = tools.map(tool => tool.function.name); return { choices: [{ message: { role: 'assistant', content: '好的' } }] }; },
  });
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.filter(name => name === 'ask_user').length, 1);
});

test('policy denies unknown tools and validates paths before approval', async () => {
  const { workspace } = await fixture();
  let approvals = 0;
  const policy = new PermissionPolicy({ approveWrite: async () => { approvals++; return true; } });
  const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
  assert.equal((await routeTool(call('exec', { command: 'echo hi' }), { workspace, policy })).errorCode, 'TOOL_NOT_AVAILABLE');
  assert.match((await routeTool(call('write_file', { path: '../escape', content: 'x' }), { workspace, policy })).content, /Path escapes/);
  assert.equal(approvals, 0);
  assert.equal((await routeTool(call('write_file', { path: 'ok.txt', content: 'x' }), { workspace, policy: new PermissionPolicy() })).errorCode, 'USER_DENIED');
  await assert.rejects(readFile(path.join(workspace.root, 'ok.txt')), { code: 'ENOENT' });
  assert.equal(approvals, 0);
  assert.equal((await routeTool(call('write_file', { path: 'ok.txt', content: 'x' }), { workspace, policy })).content, 'Wrote ok.txt');
  assert.equal(await workspace.read('ok.txt'), 'x');
  assert.equal(approvals, 1);
});

test('private file info denial is explained without forced model retries', async () => {
  const { workspace, sessions } = await fixture();
  const session = await sessions.create();
  let requests = 0;
  const displayed = [];
  const answer = await runTurn({ session, input: '查看 .agent-data/models.json 的文件信息', workspace,
    onDelta: text => displayed.push(text),
    request: async (messages, tools, options) => {
      requests++;
      assert.equal(tools.some(tool => tool.function.name === 'file_info'), true);
      if (requests === 1) {
        assert.equal(options.toolChoice, 'required');
        options.onDelta('提前猜测的内容');
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'denied-1', function: { name: 'file_info', arguments: JSON.stringify({ path: '.agent-data/models.json' }) } },
        ] } }] };
      }
      assert.equal(JSON.parse(messages.at(-1).content).errorCode, 'WORKSPACE_ACCESS_DENIED');
      options.onDelta('不能查看私有配置文件。');
      return { choices: [{ message: { role: 'assistant', content: '不能查看私有配置文件。' } }] };
    },
  });
  assert.equal(answer, '不能查看私有配置文件。');
  assert.equal(requests, 2);
  assert.deepEqual(displayed, ['不能查看私有配置文件。']);
  assert.equal(session.messages.length, 4);
});

test('listing and searching exclude private paths', async () => {
  const { root, workspace } = await fixture();
  await workspace.write('docs/note.txt', 'find this line\nmore text');
  const policy = new PermissionPolicy();
  const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
  const listing = await routeTool(call('list_files', { path: '.' }), { workspace, policy });
  assert.equal(listing.isError, false);
  const listingContent = JSON.parse(listing.content);
  assert.deepEqual(listingContent, { items: [{ path: 'docs', type: 'directory' }], nextCursor: null });
  const result = await routeTool(call('search_text', { query: 'find' }), { workspace, policy });
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.content).matches, [{ path: 'docs/note.txt', line: 1, text: 'find this line' }]);
  assert.equal((await routeTool(call('search_text', { query: 'find', path: '.agent-data' }), { workspace, policy })).isError, true);
  assert.equal((await routeTool(call('read_file', { path: 'docs/note.txt', extra: 1 }), { workspace, policy })).errorCode, 'INVALID_ARGUMENTS');
});

test('consecutive tool failures stop the loop at the configured limit', async () => {
  const { workspace, sessions } = await fixture();
  const session = await sessions.create();
  let calls = 0;
  await assert.rejects(runTurn({ session, input: 'do it', workspace,
    request: async () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `t${++calls}`, function: { name: 'exec', arguments: '{}' } }] } }] }),
  }), error => error.code === 'TOOL_FAILURE_LIMIT' && /连续 5 次/.test(error.message) && /exec/.test(error.message));
  assert.equal(calls, 5);
  assert.deepEqual(session.messages, []);
});

test('runTurn stops at a custom tool-call budget instead of the default', async () => {
  const { workspace, sessions } = await fixture();
  await workspace.write('answer.txt', 'ok');
  const session = await sessions.create();
  let calls = 0;
  await assert.rejects(runTurn({ session, input: 'repeat', workspace, executionLimits: { maxRounds: 10, maxToolCalls: 2 },
    request: async () => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `read-${++calls}`, function: { name: 'read_file', arguments: JSON.stringify({ path: 'answer.txt' }) } }] } }] }),
  }), /工具调用达到本回合上限（2 次）/);
  assert.equal(calls, 2);
});

test('model observes tool results before deciding to answer', async () => {
  const { workspace, sessions } = await fixture();
  await workspace.write('answer.txt', 'The answer is 42');
  const session = await sessions.create();
  let calls = 0;
  const answer = await runTurn({ session, input: 'find the answer', workspace,
    request: async (messages, tools) => {
      assert.ok(tools.some(tool => tool.function.name === 'search_text'));
      if (calls++ === 0) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'search-1', function: { name: 'search_text', arguments: JSON.stringify({ query: 'answer' }) } },
      ] } }] };
      assert.equal(messages.at(-1).role, 'tool');
      assert.equal(messages.at(-1).tool_call_id, 'search-1');
      assert.match(messages.at(-1).content, /The answer is 42/);
      return { choices: [{ message: { role: 'assistant', content: '42' } }] };
    },
  });
  assert.equal(answer, '42');
  assert.equal(calls, 2);
  assert.equal(session.messages.at(-1).content, '42');
});

test('filename intent exposes find_files and returns paged evidence to the model', async () => {
  const { workspace, sessions } = await fixture();
  await workspace.write('config.json', '{}');
  const session = await sessions.create();
  let requests = 0;
  const answer = await runTurn({ session, input: '查找文件名包含 config 的文件', workspace,
    request: async (messages, tools, options) => {
      assert.equal(options.toolChoice, requests === 0 ? 'required' : 'auto');
      assert.ok(tools.some(tool => tool.function.name === 'find_files'));
      if (requests++ === 0) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'find-1', function: { name: 'find_files', arguments: JSON.stringify({ query: 'config', limit: 1 }) } },
      ] } }] };
      const result = JSON.parse(messages.at(-1).content);
      assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(result.content).items.map(item => item.path), ['config.json']);
      return { choices: [{ message: { role: 'assistant', content: 'config.json' } }] };
    },
  });
  assert.equal(answer, 'config.json');
  assert.equal(requests, 2);
});

test('all-results intent continues pages and only labels unfinished results', async () => {
  const { workspace, sessions } = await fixture();
  await workspace.write('a.txt', 'a');
  await workspace.write('b.txt', 'b');
  const session = await sessions.create();
  let calls = 0;
  let cursor;
  const answer = await runTurn({ session, input: '列出当前文件夹所有文件', workspace,
    request: async (messages, tools, options) => {
      if (calls++ === 0) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'p1', function: { name: 'list_files', arguments: JSON.stringify({ limit: 1 }) } },
      ] } }] };
      if (calls === 2) {
        cursor = JSON.parse(JSON.parse(messages.at(-1).content).content).nextCursor;
        assert.ok(cursor);
        assert.equal(options.toolChoice, 'required');
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'p2', function: { name: 'list_files', arguments: JSON.stringify({ limit: 1, cursor }) } },
        ] } }] };
      }
      assert.equal(JSON.parse(JSON.parse(messages.at(-1).content).content).nextCursor, null);
      return { choices: [{ message: { role: 'assistant', content: 'a.txt, b.txt' } }] };
    },
  });
  assert.equal(answer, 'a.txt, b.txt');
  assert.equal(calls, 3);

  const partial = await runTurn({ session: await sessions.create(), input: '列出当前文件夹所有文件', workspace,
    request: async (messages) => messages.at(-1).role === 'user'
      ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'p3', function: { name: 'list_files', arguments: JSON.stringify({ limit: 1 }) } },
      ] } }] }
      : { choices: [{ message: { role: 'assistant', content: 'a.txt' } }] },
  });
  assert.match(partial, /仅检查了部分结果/);
});

test('tool observations survive a later model failure as a valid session turn', async () => {
  const { workspace, sessions } = await fixture();
  const session = await sessions.create();
  let count = 0;
  await assert.rejects(runTurn({ session, input: 'what is in this folder', workspace,
    request: async () => {
      if (count++ === 0) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'list-1', function: { name: 'list_files', arguments: '{"path":"."}' } },
      ] } }] };
      throw new Error('provider unavailable');
    },
  }), /provider unavailable/);
  assert.deepEqual(session.messages.map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.match(session.messages.at(-1).content, /本次请求在工具调用后停止/);
  await sessions.save(session);
  const resumed = await sessions.get(session.id);
  assert.deepEqual(resumed.messages, session.messages);
  assert.equal((await new ContextManager(resumed).project([], [])).messages.length, 4);
});

test('high-confidence workspace intent requires a tool and retries when model answers too early', async () => {
  const { workspace, sessions } = await fixture();
  const session = await sessions.create();
  let calls = 0;
  const toolChoices = [];
  const answer = await runTurn({ session, input: '当前文件夹下有哪些文件', workspace,
    request: async (messages, tools, options) => {
      toolChoices.push(options.toolChoice);
      if (calls++ === 0) return { choices: [{ message: { role: 'assistant', content: '我猜有 README.md' } }] };
      if (calls < 3) assert.equal(options.toolChoice, 'required');
      if (calls === 2) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'list-1', function: { name: 'list_files', arguments: JSON.stringify({ path: '.' }) } },
        ] } }] };
      return { choices: [{ message: { role: 'assistant', content: '当前目录内容已读取。' } }] };
    },
  });
  assert.equal(answer, '当前目录内容已读取。');
  assert.deepEqual(toolChoices, ['required', 'required', 'auto']);
});

test('intent and tool surface select only the relevant filesystem tools', () => {
  assert.equal(classifyIntent('当前文件夹有哪些文件').preferredTool, 'list_files');
  assert.equal(classifyIntent('这个空的项目文件夹里面有什么').preferredTool, 'list_files');
  assert.equal(classifyIntent('这个项目文件夹里面有什么').mustUseTool, true);
  assert.equal(classifyIntent('解释一下闭包').mustUseTool, false);
  const policy = new PermissionPolicy();
  const visible = resolveVisibleTools(registeredTools(), policy, { categories: ['filesystem'], allowlist: ['list_*'] });
  assert.deepEqual(visible.map(tool => tool.function.name), ['list_files']);
});

test('successful tool execution still requires a valid result shape', async () => {
  const { workspace } = await fixture();
  const policy = new PermissionPolicy();
  const call = { function: { name: 'list_files', arguments: JSON.stringify({ path: '.' }) } };
  const original = workspace.list;
  workspace.list = async () => ({ unexpected: true });
  const result = await routeTool(call, { workspace, policy });
  workspace.list = original;
  assert.equal(result.errorCode, 'INVALID_TOOL_RESULT');
  assert.equal(result.isError, true);
});

test('write preview shows the changed lines and denial leaves the file untouched', async () => {
  const { workspace } = await fixture();
  await workspace.write('note.txt', 'before\nkeep\n');
  const call = { function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'after\nkeep\n' }) } };
  let preview;
  const result = await routeTool(call, { workspace, policy: new PermissionPolicy({ approveWrite: async change => {
    preview = change;
    return false;
  } }) });
  assert.equal(result.errorCode, 'USER_DENIED');
  assert.match(preview.diff.text, /- before\n\+ after/);
  assert.equal(await workspace.read('note.txt'), 'before\nkeep\n');
});

test('edit_file replaces exactly one occurrence after approval', async () => {
  const { workspace } = await fixture();
  await workspace.write('note.txt', 'one\ntwo\n');
  const call = args => ({ function: { name: 'edit_file', arguments: JSON.stringify(args) } });
  let approvals = 0;
  const policy = new PermissionPolicy({ approveWrite: async () => { approvals++; return true; } });
  assert.match((await routeTool(call({ path: 'note.txt', oldText: 'missing', newText: 'x' }), { workspace, policy })).content, /exactly once/);
  assert.equal(approvals, 0);
  assert.equal((await routeTool(call({ path: 'note.txt', oldText: 'two', newText: 'three' }), { workspace, policy })).content, 'Wrote note.txt');
  assert.equal(await workspace.read('note.txt'), 'one\nthree\n');
  assert.equal(approvals, 1);
  await workspace.write('note.txt', 'same same');
  assert.match((await routeTool(call({ path: 'note.txt', oldText: 'same', newText: 'x' }), { workspace, policy })).content, /exactly once/);
  assert.equal(approvals, 1);
});

test('changes after preview cancel overwrite and creation', async () => {
  const { workspace } = await fixture();
  await workspace.write('note.txt', 'initial');
  const call = (path, content) => ({ function: { name: 'write_file', arguments: JSON.stringify({ path, content }) } });
  const policy = new PermissionPolicy({ approveWrite: async change => {
    await workspace.write(change.path, 'external');
    return true;
  } });
  assert.match((await routeTool(call('note.txt', 'proposal'), { workspace, policy })).content, /File changed since preview/);
  assert.equal(await workspace.read('note.txt'), 'external');
  assert.match((await routeTool(call('new.txt', 'proposal'), { workspace, policy })).content, /EEXIST/);
  assert.equal(await workspace.read('new.txt'), 'external');
});

test('new file preview, unchanged write, and ambiguous edit', async () => {
  const { workspace } = await fixture();
  const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
  let approvals = 0;
  const policy = new PermissionPolicy({ approveWrite: async change => {
    approvals++;
    assert.equal(change.before, null);
    assert.match(change.diff.text, /\+ first/);
    return true;
  } });
  assert.equal((await routeTool(call('write_file', { path: 'sub/new.txt', content: 'first\n' }), { workspace, policy })).content, 'Wrote sub/new.txt');
  assert.equal(await workspace.read('sub/new.txt'), 'first\n');
  assert.equal((await routeTool(call('write_file', { path: 'sub/new.txt', content: 'first\n' }), { workspace, policy })).content, 'No changes to sub/new.txt');
  assert.match((await routeTool(call('edit_file', { path: 'sub/new.txt', oldText: '', newText: 'x' }), { workspace, policy })).content, /non-empty oldText/);
  assert.equal(approvals, 1);
});

test('local attachment context reaches the model as untrusted data but is not persisted in the transcript', async () => {
  const { workspace, sessions } = await fixture(); const session = await sessions.create(); let sentMessages;
  const answer = await runTurn({ session, input: 'Summarize the attached document', workspace, policy: new PermissionPolicy(), attachmentContext: 'Untrusted attachment data: private attachment body',
    request: async messages => { sentMessages = messages; return { choices: [{ message: { role: 'assistant', content: 'Document summary.' } }] }; } });
  assert.equal(answer, 'Document summary.'); assert.ok(sentMessages.some(message => message.role === 'system' && message.content.includes('private attachment body')));
  assert.equal(session.messages.some(message => String(message.content).includes('private attachment body')), false);
  assert.deepEqual(session.messages.map(message => message.role), ['user', 'assistant']);
});

test('attachment body is not persisted when a turn fails after a successful tool', async () => {
  const { workspace, sessions } = await fixture(); await workspace.write('notes.txt', 'readable fact'); const session = await sessions.create(); let calls = 0;
  const request = async messages => {
    calls++;
    if (calls === 1) return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) } }] } }] };
    assert.ok(messages.some(message => message.role === 'system' && message.content.includes('ephemeral attachment body')));
    throw Object.assign(new Error('model unavailable'), { code: 'SERVER' });
  };
  await assert.rejects(runTurn({ session, input: 'Summarize attachment', workspace, policy: new PermissionPolicy(), attachmentContext: 'ephemeral attachment body', request }));
  assert.ok(session.messages.some(message => message.role === 'user' && message.content === 'Summarize attachment'));
  assert.equal(session.messages.some(message => String(message.content).includes('ephemeral attachment body')), false);
});
