import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { LocalGateway } from '../backend/gateway/server.js';
import { Sessions } from '../backend/sessions.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';
import { AttachmentStore } from '../backend/attachments/store.js';

test('Gateway previews workspace text attachments and rejects paths outside the workspace', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-attachments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'docs')); await writeFile(path.join(root, 'docs', 'notes.md'), '# Local notes\nUse the workspace.');
  const sessions = new Sessions(root);
  const gateway = new LocalGateway({ root, sessions, approvals: new ApprovalManager(), models: {}, memory: {}, skills: {}, tasks: {}, messages: {} });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json' };
  const preview = await fetch(`${base}/api/attachments/preview`, { method: 'POST', headers, body: JSON.stringify({ path: 'docs/notes.md' }) });
  assert.equal(preview.status, 200); const body = await preview.json(); assert.match(body.content, /Use the workspace/); assert.equal(body.mediaType, 'text/plain');
  const outside = await fetch(`${base}/api/attachments/preview`, { method: 'POST', headers, body: JSON.stringify({ path: '../outside.txt' }) });
  assert.equal(outside.status, 422); assert.equal((await outside.json()).code, 'WORKSPACE_ACCESS_DENIED');
});

test('Gateway turn runner includes the extracted attachment as untrusted context', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-attachment-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'context.txt'), 'attachment context marker');
  let requestBody;
  const upstream = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; requestBody = JSON.parse(raw); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收到附件' } }] })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const models = { get: async () => ({ model: 'test', apiKey: 'test', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) };
  const gateway = new LocalGateway({ root, sessions: new Sessions(root), models, approvals: new ApprovalManager(), memory: {}, skills: {}, tasks: {}, messages: {}, runTurn: null });
  const { createGatewayTurnRunner } = await import('../backend/gateway/turn-runner.js');
  gateway.runTurn = createGatewayTurnRunner({ root, models, approvals: gateway.approvals, sandbox: { verify: async () => true, readOperation: async () => '', readExternal: async () => '', execute: async () => ({}) }, audit: { auditReady: true, record: async () => {} } });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '总结附件', attachmentPath: 'context.txt' }) });
  assert.equal(response.status, 200); assert.ok(requestBody.messages.some(message => String(message.content).includes('attachment context marker')));
});

test('Gateway accepts a local file upload and binds it to the next turn without writing it to the workspace', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-attachment-upload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requestBody;
  const upstream = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; requestBody = JSON.parse(raw); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收到上传文件' } }] })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const models = { get: async () => ({ model: 'test', apiKey: 'test', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) };
  const gateway = new LocalGateway({ root, sessions: new Sessions(root), models, approvals: new ApprovalManager(), memory: {}, skills: {}, tasks: {}, messages: {} });
  const { createGatewayTurnRunner } = await import('../backend/gateway/turn-runner.js');
  gateway.runTurn = createGatewayTurnRunner({ root, models, approvals: gateway.approvals, sandbox: { verify: async () => true, readOperation: async () => '', readExternal: async () => '', execute: async () => ({}) }, audit: { auditReady: true, record: async () => {} } });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = await fetch(`${base}/api/attachments/upload`, { method: 'POST', headers: { 'Content-Type': 'text/markdown', 'X-Agent-File-Name': encodeURIComponent('local-notes.md') }, body: Buffer.from('# uploaded locally') });
  assert.equal(upload.status, 200); const uploaded = await upload.json(); assert.equal(uploaded.name, 'local-notes.md'); assert.equal('preview' in uploaded, false);
  const response = await fetch(`${base}/api/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '总结上传文件', attachmentId: uploaded.id }) });
  assert.equal(response.status, 200); assert.ok(requestBody.messages.some(message => String(message.content).includes('uploaded locally')));
  const turn = await response.json(); const history = await fetch(`${base}/api/sessions/${turn.sessionId}`).then(result => result.json());
  const userMessage = history.messages.find(message => message.role === 'user');
  assert.equal(userMessage.attachment.id, uploaded.id); assert.equal(userMessage.attachment.name, 'local-notes.md');
  const opened = await fetch(`${base}/api/attachments/${uploaded.id}/open`);
  assert.equal(opened.status, 200); assert.equal(await opened.text(), '# uploaded locally');
  assert.equal((await (await import('node:fs/promises')).readdir(root)).includes('local-notes.md'), false);
});

test('Gateway rehydrates attachments from the shared session context on later turns', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-attachment-shared-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const upstream = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; requests.push(JSON.parse(raw)); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已处理' } }] })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const models = { get: async () => ({ model: 'test', apiKey: 'test', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) };
  const sessions = new Sessions(root);
  const gateway = new LocalGateway({ root, sessions, models, approvals: new ApprovalManager(), memory: {}, skills: {}, tasks: {}, messages: {} });
  const { createGatewayTurnRunner } = await import('../backend/gateway/turn-runner.js');
  gateway.runTurn = createGatewayTurnRunner({ root, models, sessions, attachmentStore: gateway.attachmentStore, approvals: gateway.approvals, sandbox: { verify: async () => true, readOperation: async () => '', readExternal: async () => '', execute: async () => ({}) }, audit: { auditReady: true, record: async () => {} } });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = await fetch(`${base}/api/attachments/upload`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Agent-File-Name': encodeURIComponent('shared.txt') }, body: Buffer.from('shared session attachment marker') });
  const uploaded = await upload.json();
  const session = await (await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const first = await fetch(`${base}/api/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '记住这个文件', sessionId: session.id, attachmentId: uploaded.id }) });
  assert.equal(first.status, 200);
  const index = JSON.parse(await readFile(path.join(root, '.agent-data', 'attachments', 'index.json'), 'utf8'));
  assert.equal('content' in index.items[0].attachment, false);
  const second = await fetch(`${base}/api/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '继续分析刚才的文件', sessionId: session.id }) });
  assert.equal(second.status, 200);
  assert.ok(requests[1].messages.some(message => String(message.content).includes('shared session attachment marker')));
});

test('Gateway restores uploaded attachments after restart and keeps them private to the uploading client', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-attachment-persistent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const createGateway = () => new LocalGateway({ root, sessions: new Sessions(root), approvals: new ApprovalManager(), models: {}, memory: {}, skills: {}, tasks: {}, messages: {} });
  const first = createGateway(); const server = first.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = await fetch(`${base}/api/attachments/upload`, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Agent-File-Name': encodeURIComponent('restart.txt') }, body: Buffer.from('survives restart') });
  assert.equal(upload.status, 200); const uploaded = await upload.json();
  const storeIndex = JSON.parse(await readFile(path.join(root, '.agent-data', 'attachments', 'index.json'), 'utf8'));
  assert.equal(storeIndex.items.length, 1);

  const second = createGateway();
  const restored = await second.getUploadedAttachment(uploaded.id, second.clientIdentity({ headers: {} }));
  assert.equal(restored.bytes.toString(), 'survives restart');
  await assert.rejects(() => second.getUploadedAttachment(uploaded.id, 'different-client'), error => error.code === 'ATTACHMENT_NOT_FOUND');
});

test('Attachment store expires files and ignores unsafe index paths', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'attachment-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const store = new AttachmentStore(root, { now: () => now, ttlMs: 100 });
  const item = await store.put({ clientIdentity: 'client-a', bytes: Buffer.from('temporary'), attachment: { path: 'temporary.txt', mediaType: 'text/plain', sizeBytes: 9 } });
  assert.equal((await store.get(item.id, 'client-a')).bytes.toString(), 'temporary');
  now += 101;
  await assert.rejects(() => store.get(item.id, 'client-a'), error => error.code === 'ATTACHMENT_NOT_FOUND');
  await assert.rejects(() => readFile(path.join(root, '.agent-data', 'attachments', `${item.id}.bin`)));

  await writeFile(path.join(root, '.agent-data', 'attachments', 'index.json'), JSON.stringify({ version: 1, items: [{ id: item.id, clientIdentity: 'client-a', storageName: '../../outside.txt', attachment: item.attachment, expiresAt: now + 1 }] }));
  const reloaded = new AttachmentStore(root, { now: () => now });
  await assert.rejects(() => reloaded.get(item.id, 'client-a'), error => error.code === 'ATTACHMENT_NOT_FOUND');
});
