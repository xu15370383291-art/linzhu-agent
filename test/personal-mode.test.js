import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createGatewayTurnRunner } from '../backend/gateway/turn-runner.js';
import { routeTool } from '../backend/tools/registry.js';
import { ExternalReads } from '../backend/tools/external-reads.js';
import { ExternalWrites } from '../backend/tools/external-writes.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { Workspace } from '../backend/workspace.js';
import { assertNotAnotherProject } from '../backend/security/project-boundary.js';
import { runTurn } from '../backend/agent.js';

const call = (name, args) => ({ id: `personal-${name}`, function: { name, arguments: JSON.stringify(args) } });

test('personal file mode reads and writes an absolute ordinary path without access grant approval', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-personal-mode-root-'));
  const target = path.join(root, 'notes.txt');
  await writeFile(target, 'before');
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = new PermissionPolicy({ personalMode: true, autoApproveFileOperations: true });
  const reads = new ExternalReads({ autoApprove: true });
  const writes = new ExternalWrites({ root, allowWorkspace: true, allowExternalPaths: true });
  const read = await routeTool(call('external_read_file', { path: target }), { workspace: new Workspace(root), externalReads: reads, policy });
  assert.equal(read.content, 'before');
  const write = await routeTool(call('external_edit_file', { path: target, oldText: 'before', newText: 'after' }), { workspace: new Workspace(root), externalWrites: writes, policy });
  assert.match(write.content, /Wrote/);
  assert.equal(await readFile(target, 'utf8'), 'after');
});

test('personal file mode rejects writes into another detected project', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-personal-mode-root-'));
  const other = await mkdtemp(path.join(os.tmpdir(), 'agent-personal-mode-other-'));
  await mkdir(path.join(other, '.git'));
  const target = path.join(other, 'notes.txt');
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]));
  await assert.rejects(assertNotAnotherProject(target, root), { code: 'OTHER_PROJECT_DENIED' });
  const policy = new PermissionPolicy({ personalMode: true, autoApproveFileOperations: true });
  const writes = new ExternalWrites({ root, allowWorkspace: true, allowExternalPaths: true, projectBoundary: value => assertNotAnotherProject(value, root) });
  const result = await routeTool(call('external_write_file', { path: target, content: 'blocked' }), { workspace: new Workspace(root), externalWrites: writes, policy });
  assert.equal(result.errorCode, 'OTHER_PROJECT_DENIED');
});

test('Gateway routes a Chinese drive-letter request to the external writer in personal mode', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-personal-gateway-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let modelCalls = 0;
  let submittedPath;
  let offeredExternalWriter = false;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    modelCalls++;
    offeredExternalWriter = payload.tools.some(tool => tool.function.name === 'external_write_file');
    const message = modelCalls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'write-a', type: 'function', function: { name: 'external_write_file', arguments: JSON.stringify({ path: 'a', content: 'test' }) } }] }
      : { role: 'assistant', content: '已创建' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const runner = createGatewayTurnRunner({
    root,
    models: { async get() { return { model: 'mock', apiKey: 'test', streaming: false, url: `http://127.0.0.1:${server.address().port}/v1` }; } },
    audit: { auditReady: true, async record() {} },
    sandbox: { async verify() { return false; } },
    getSecurityMode: async () => 'personal',
    externalWrites: new ExternalWrites({
      root,
      allowWorkspace: true,
      allowExternalPaths: true,
      resolvePath: value => path.win32.isAbsolute(value) ? value : `D:\\${value}`,
      commitBroker: async change => { submittedPath = change.target; },
    }),
  });
  const result = await runner({ input: '在 D 盘创建 a 文件', turnId: 'personal-drive-write' });
  assert.equal(result.answer, '已创建');
  assert.equal(offeredExternalWriter, true);
  assert.equal(submittedPath, 'D:\\a');
});

test('external write intent corrects a model write_file call before dispatch', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-personal-normalize-root-'));
  const target = path.join(root, 'a.txt');
  t.after(() => rm(root, { recursive: true, force: true }));
  let received;
  const externalWrites = {
    async prepare(pathValue, name, args) { received = { pathValue, name, args }; return { change: { unchanged: true } }; },
  };
  const session = { messages: [] };
  await runTurn({
    session,
    input: '在 D 盘创建 a.txt 文件',
    workspace: new Workspace(root),
    externalWrites,
    policy: new PermissionPolicy({ personalMode: true, autoApproveFileOperations: true }),
    request: async (messages, tools) => {
      if (messages.at(-1).role === 'user') return { choices: [{ message: { role: 'assistant', tool_calls: [call('write_file', { path: 'a.txt', content: 'x' })] } }] };
      return { choices: [{ message: { role: 'assistant', content: '完成' } }] };
    },
  });
  assert.equal(received.name, 'external_write_file');
  assert.equal(received.pathValue, 'D:\\a.txt');
});
