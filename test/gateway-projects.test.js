import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore, pickProjectDirectory } from '../backend/gateway/projects.js';
import { Sessions } from '../backend/sessions.js';
import { createGatewayTurnRunner } from '../backend/gateway/turn-runner.js';
import { LocalGateway } from '../backend/gateway/server.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';

test('project store registers a chosen folder, reuses it and treats picker cancel as no-op', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-project-store-'));
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'gateway-project-folder-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(projectPath, { recursive: true, force: true })]));
  let selection = projectPath;
  const store = new ProjectStore(root, { picker: async () => selection });
  const first = await store.pick();
  assert.equal(first.path, path.resolve(projectPath));
  assert.equal((await store.get(first.id)).path, path.resolve(projectPath));
  const reused = await store.pick();
  assert.equal(reused.id, first.id);
  selection = null;
  assert.equal(await store.pick(), null);
  assert.equal((await store.list()).length, 0, 'a selection without a conversation is not a recent project');
  await assert.rejects(new ProjectStore(root).get(first.id), { code: 'PROJECT_NOT_FOUND' });
});

test('folder picker handles cancel and refuses unsupported platforms', async () => {
  let command;
  assert.equal(await pickProjectDirectory({ platform: 'win32', exec: async (_file, args) => { command = args.at(-1); return { stdout: '' }; } }), null);
  assert.match(command, /IFileOpenDialog/);
  assert.match(command, /options \| 0x20/);
  assert.match(command, /选择项目文件夹/);
  assert.doesNotMatch(command, /FolderBrowserDialog/);
  await assert.rejects(pickProjectDirectory({ platform: 'linux' }), { code: 'PROJECT_PICKER_UNAVAILABLE' });
});

test('project selection API creates project-bound sessions while legacy sessions remain ordinary', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-project-api-'));
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'gateway-project-api-folder-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(projectPath, { recursive: true, force: true })]));
  const projects = new ProjectStore(root, { picker: async () => projectPath });
  const sessions = new Sessions(root);
  const gateway = new LocalGateway({ root, projects, sessions, approvals: new ApprovalManager(), models: {}, memory: {}, skills: {}, tasks: {}, messages: {} });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ordinary = await (await post('/api/sessions', {})).json();
  assert.equal(ordinary.project, undefined);
  const picked = await (await post('/api/projects/pick', {})).json();
  assert.equal(picked.project.path, path.resolve(projectPath));
  assert.deepEqual((await (await fetch(`${base}/api/projects`)).json()).items, []);
  const bound = await (await post('/api/sessions', { projectId: picked.project.id })).json();
  assert.equal(bound.project.id, picked.project.id);
  assert.deepEqual((await (await fetch(`${base}/api/projects`)).json()).items, []);
  bound.messages.push({ role: 'user', content: '这是项目对话' });
  await sessions.save(bound);
  const recent = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(recent.items.length, 1);
  assert.equal(recent.items[0].id, picked.project.id);
  assert.equal((await fetch(`${base}/api/sessions`)).status, 200);
  assert.equal((await fetch(`${base}/api/sessions/${ordinary.id}`)).status, 200);
  const invalid = await post('/api/sessions', { projectId: 'not-a-project' });
  assert.equal(invalid.status, 422);
});

test('turn runner binds each session workspace to its saved project folder', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-project-runner-'));
  const projectPath = await mkdtemp(path.join(os.tmpdir(), 'gateway-project-workspace-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(projectPath, { recursive: true, force: true })]));
  await writeFile(path.join(projectPath, 'project-marker.txt'), 'project workspace');
  await writeFile(path.join(root, 'root-marker.txt'), 'ordinary workspace');
  const sessions = new Sessions(root);
  const projectSession = await sessions.create({ project: { id: 'project-1', name: 'Example', path: projectPath } });
  const ordinarySession = await sessions.create();
  const seen = [];
  const runner = createGatewayTurnRunner({ root, sessions, models: { async get() { return { model: 'fake', apiKey: 'test', streaming: false, url: 'http://127.0.0.1:1' }; } },
    audit: { auditReady: true, async record() {} }, sandbox: null, getSecurityMode: async () => 'personal',
    structuredPlanning: false });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    const alreadyCalled = request.messages.some(message => message.role === 'tool');
    const message = alreadyCalled
      ? { role: 'assistant', content: 'ok' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'list-1', type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ path: '.' }) } }] };
    if (alreadyCalled) {
      const result = request.messages.find(item => item.role === 'tool')?.content || '';
      seen.push(result);
    }
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const session of [projectSession, ordinarySession]) {
      await runner({ input: '列出当前工作区文件', sessionId: session.id, turnId: `turn-${session.id}` });
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.match(seen[0], /project-marker\.txt/);
  assert.doesNotMatch(seen[0], /root-marker\.txt/);
  assert.match(seen[1], /root-marker\.txt/);
  assert.doesNotMatch(seen[1], /project-marker\.txt/);
  assert.equal((await sessions.get(projectSession.id)).project.path, projectPath);
  assert.equal(await readFile(path.join(root, 'root-marker.txt'), 'utf8'), 'ordinary workspace');
});
