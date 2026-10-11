import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { createGatewayTurnRunner } from '../backend/gateway/turn-runner.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';
import { ExternalReads } from '../backend/tools/external-reads.js';
import { classifyIntent } from '../backend/agent/intent.js';
import { readFile, writeFile } from 'node:fs/promises';

test('External disk read requests route to read-only tools', () => {
  assert.equal(classifyIntent('读取 D:\\资料\\说明.txt').preferredTool, 'external_read_file');
  assert.equal(classifyIntent('列出 D盘里的文件夹').preferredTool, 'external_list_files');
  assert.equal(classifyIntent('搜索 D:\\资料 中包含合同的内容').preferredTool, 'external_search_text');
  assert.equal(classifyIntent('修改 D:\\资料\\说明.txt').preferredTool, 'external_edit_file');
});

test('External directory tools may omit path and use the approved disk root', async () => {
  const root = path.parse(process.cwd()).root;
  const reads = new ExternalReads({ root, approve: async () => true });
  const selection = await reads.target(undefined, 'external_list_files');
  assert.equal(selection.target, root);
  assert.equal(selection.relative, '.');
});

test('ExternalReads resolves relative paths under the approved disk root only', async t => {
  const root = await mkdtemp(path.join(process.cwd(), '.external-read-root-'));
  await import('node:fs/promises').then(fs => fs.writeFile(path.join(root, 'relative.txt'), 'relative content'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const reads = new ExternalReads({ root: path.parse(root).root, approve: async () => true });
  const selection = await reads.target(path.relative(path.parse(root).root, path.join(root, 'relative.txt')), 'external_read_file');
  assert.equal(selection.target, path.join(root, 'relative.txt'));
  await assert.rejects(reads.target('C:\\Windows', 'external_list_files'), { code: 'WORKSPACE_ACCESS_DENIED' });
  if (path.parse(root).root.toUpperCase() !== 'C:\\') await assert.rejects(reads.target('C:\\Windows', 'external_list_files'), { code: 'WORKSPACE_ACCESS_DENIED' });
});

test('Gateway exposes external reads and writes behind approval', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-external-read-'));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'gateway-external-target-'));
  const externalFile = path.join(externalRoot, 'notes.txt');
  await import('node:fs/promises').then(fs => fs.writeFile(externalFile, 'external read only'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(externalRoot, { recursive: true, force: true }); });
  let requestCount = 0;
  let operation = 'read';
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requestCount++;
    const names = body.tools.map(tool => tool.function.name);
    if (operation === 'read') assert.ok(names.includes('external_read_file'));
    if (operation === 'write') {
      assert.ok(names.includes('external_write_file')); assert.ok(names.includes('external_edit_file'));
    }
    const successfulTool = body.messages.find(message => message.role === 'tool' && JSON.parse(message.content).isError !== true);
    if (operation === 'write') {
      const message = successfulTool ? { role: 'assistant', content: '写入完成' } : { role: 'assistant', content: null, tool_calls: [{ id: 'external-write', type: 'function', function: { name: 'external_write_file', arguments: JSON.stringify({ path: externalFile, content: 'updated externally' }) } }] };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] })); return;
    }
    const hasSuccessfulExternalRead = body.messages.some(message => message.role === 'tool' && message.content.includes('external read only'));
    const message = hasSuccessfulExternalRead ? { role: 'assistant', content: '读取完成' } : { role: 'assistant', content: null, tool_calls: [{ id: 'external-read', type: 'function', function: { name: 'external_read_file', arguments: JSON.stringify({ path: externalFile }) } }] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => upstream.close(resolve)));
  const models = { get: async () => ({ model: 'test', apiKey: 'test', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) };
  const approvals = new ApprovalManager();
  const sandbox = { verify: async () => true, readOperation: async () => '', readExternal: async (_name, _args, target) => target === externalFile ? 'external read only' : 'wrong target', execute: async () => ({}) };
  const runner = createGatewayTurnRunner({ root, models, approvals, sandbox, audit: { auditReady: true, record: async () => {} } });
  let pending;
  await assert.rejects(runner({ input: `读取文件 ${externalFile}`, turnId: 'external-read-1' }), error => { pending = error; return error.code === 'APPROVAL_REQUIRED'; });
  const approval = approvals.get(pending.approvalId);
  assert.equal(approval.metadata.summary.path, externalFile); assert.equal(approval.metadata.summary.mode, 'read-only');
  await approvals.resolve(pending.approvalId, 'approved');
  const result = await runner({ input: `读取文件 ${externalFile}`, turnId: 'external-read-1', sessionId: pending.sessionId, approvalId: pending.approvalId });
  assert.equal(result.answer, '读取完成'); assert.ok(requestCount >= 2);

  operation = 'write'; requestCount = 0;
  const writeInput = `写入 ${externalFile}`;
  await assert.rejects(runner({ input: writeInput, turnId: 'external-write-1' }), error => { pending = error; return error.code === 'APPROVAL_REQUIRED'; });
  const writeApproval = approvals.get(pending.approvalId);
  assert.equal(writeApproval.operation, 'external_write_file');
  assert.equal(writeApproval.metadata.summary.path, externalFile);
  assert.match(writeApproval.metadata.summary.diffPreview, /updated externally/);
  await approvals.resolve(pending.approvalId, 'approved');
  const written = await runner({ input: writeInput, turnId: 'external-write-1', sessionId: pending.sessionId, approvalId: pending.approvalId });
  assert.equal(written.answer, '写入完成');
  assert.equal(await readFile(externalFile, 'utf8'), 'updated externally');
});

test('Gateway session directory approval allows relative reads on later turns only within that directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-relative-read-'));
  const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'gateway-relative-target-'));
  const externalFile = path.join(externalRoot, 'notes.txt');
  await writeFile(externalFile, 'scoped relative content');
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(externalRoot, { recursive: true, force: true }); });
  let requestCount = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requestCount++;
    const successful = body.messages.some(message => message.role === 'tool' && message.content.includes('scoped relative content'));
    const message = successful ? { role: 'assistant', content: '读取完成' } : requestCount === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'directory-read', type: 'function', function: { name: 'external_list_files', arguments: JSON.stringify({ path: externalRoot }) } }] }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'relative-read', type: 'function', function: { name: 'external_read_file', arguments: JSON.stringify({ path: 'notes.txt' }) } }] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const models = { get: async () => ({ model: 'test', apiKey: 'test', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) };
  const approvals = new ApprovalManager();
  const sandbox = { verify: async () => true, readOperation: async () => '', readExternal: async (name, _args, target) => name === 'list_files'
    ? { items: [{ path: 'notes.txt', type: 'file' }], nextOffset: null }
    : readFile(target, 'utf8'), execute: async () => ({}) };
  const runner = createGatewayTurnRunner({ root, models, approvals, sandbox, audit: { auditReady: true, record: async () => {} } });
  let pending;
  const firstInput = `列出 ${externalRoot} 目录中的文件`;
  await assert.rejects(runner({ input: firstInput, turnId: 'relative-read-1' }), error => { pending = error; return error.code === 'APPROVAL_REQUIRED'; });
  await approvals.resolve(pending.approvalId, 'approved', undefined, { readScope: 'session' });
  const first = await runner({ input: firstInput, turnId: 'relative-read-1', sessionId: pending.sessionId, approvalId: pending.approvalId });
  assert.match(first.answer, /读取完成|部分结果/);

  requestCount = 1;
  const nextInput = '读取 notes.txt';
  const second = await runner({ input: nextInput, turnId: 'relative-read-2', sessionId: pending.sessionId });
  assert.equal(second.answer, '读取完成');
  assert.ok(requestCount >= 3);

});
