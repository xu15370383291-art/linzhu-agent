import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createGatewayTurnRunner } from '../backend/gateway/turn-runner.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';
import { classifyIntent } from '../backend/agent/intent.js';
import { WebTools } from '../backend/tools/web.js';
import { ControlledBrowser } from '../backend/browser/session.js';

test('Gateway verified tools support approval resume, denial, and fail-closed audit', async t => {
  const root = await mkdtemp(path.join(process.cwd(), '.test-gateway-sandbox-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let toolName = 'write_file';
  let toolsSeen = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); toolsSeen = (body.tools || []).map(tool => tool.function.name);
    const observed = body.messages.some(message => message.role === 'tool' && JSON.parse(message.content).isError !== true);
    const message = observed ? { role: 'assistant', content: 'done' } : {
      role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: {
        name: toolName, arguments: JSON.stringify(toolName === 'write_file' ? { path: 'verified.txt', content: 'verified' } : { command: 'pwd' }),
      } }],
    };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const models = { get: async () => ({ model: 'test', apiKey: 'test-only', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) };
  const approvals = new ApprovalManager();
  const audit = { auditReady: true, record: async () => {} };
  let commands = 0;
  const sandbox = { verify: async () => true, readOperation: async () => 'read', readExternal: async () => 'read', execute: async () => { commands++; return { exitCode: 0, stdout: '/workspace', stderr: '' }; } };
  const runner = createGatewayTurnRunner({ root, models, approvals, audit, sandbox });
  let pending;
  const input = '请调用 write_file 创建 verified.txt 文件';
  assert.equal(classifyIntent(input).kind, 'workspace_write');
  await assert.rejects(runner({ input, turnId: 'write-1' }), error => { pending = error; return error.code === 'APPROVAL_REQUIRED'; });
  assert.ok(toolsSeen.includes('write_file'));
  assert.ok(!toolsSeen.includes('send_message'));
  await assert.rejects(readFile(path.join(root, 'verified.txt')), { code: 'ENOENT' });
  await approvals.resolve(pending.approvalId, 'approved');
  await runner({ input, turnId: 'write-1', sessionId: pending.sessionId, approvalId: pending.approvalId });
  assert.equal(await readFile(path.join(root, 'verified.txt'), 'utf8'), 'verified');

  toolName = 'sandbox_command';
  await assert.rejects(runner({ input: '执行命令 pwd', turnId: 'command-1' }), error => { pending = error; return error.code === 'APPROVAL_REQUIRED'; });
  assert.equal(commands, 0);
  await approvals.resolve(pending.approvalId, 'denied');
  await assert.rejects(runner({ input: '执行命令 pwd', turnId: 'command-1', sessionId: pending.sessionId, approvalId: pending.approvalId }));
  assert.equal(commands, 0);

  const unavailable = createGatewayTurnRunner({ root, models, sandbox, audit: { initialize: async () => { throw new Error('audit unavailable'); } } });
  await assert.rejects(unavailable({ input: '执行命令 pwd' }), { code: 'AUDIT_UNAVAILABLE' });
  assert.equal(commands, 0);
});

test('Gateway approval metadata exposes bounded redacted previews without changing approval binding', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-approval-preview-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  const upstream = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); const approved = body.messages.some(message => message.role === 'tool' && JSON.parse(message.content).isError !== true); const message = approved ? { role: 'assistant', content: 'done' } : { role: 'assistant', content: null, tool_calls: [{ id: 'preview', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'preview.txt', content: 'new secret=sk-abcdefghijklmnopqrstuvwxyz' }) } }] }; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] })); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => upstream.close(resolve)));
  const models = { get: async () => ({ model: 'test', apiKey: 'test', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) };
  const approvals = new ApprovalManager(); const runner = createGatewayTurnRunner({ root, models, approvals, audit: { auditReady: true, record: async () => {} }, sandbox: { verify: async () => true, readOperation: async () => '', readExternal: async () => '', execute: async () => ({}) } });
  let pending; await assert.rejects(runner({ input: '请创建 preview.txt', turnId: 'preview-1' }), error => { pending = error; return error.code === 'APPROVAL_REQUIRED'; });
  const approval = approvals.get(pending.approvalId); const preview = approval.metadata.summary;
  assert.match(preview.diffPreview, /\+ new/); assert.doesNotMatch(preview.diffPreview, /sk-abcdefghijklmnopqrstuvwxyz/); assert.ok(preview.diffPreview.length <= 40_000);
});

test('Gateway browser turn approval is one-time, client-bound, URL-bound and resumable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-browser-turn-'));
  let calls = 0;
  const seenTools = [];
  const toolResults = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seenTools.push((body.tools ?? []).map(item => item.function.name));
    const tool = body.tools?.find(item => item.function.name === 'browser_open');
    assert.ok(body.tools.some(item => item.function.name === 'browser_open'));
    toolResults.push(...body.messages.filter(message => message.role === 'tool').map(message => message.content));
    const toolResult = body.messages.some(message => message.role === 'tool' && JSON.parse(message.content).isError !== true);
    if (!toolResult) {
      calls++;
        res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `browser-${calls}`, type: 'function', function: { name: 'browser_open', arguments: JSON.stringify({ url: 'https://example.com/' }) } }] } }] }));
    } else {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'rendered page verified' } }] }));
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));

  const models = { get: async () => ({ model: 'test', apiKey: 'test-only', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) };
  const approvals = new ApprovalManager();
  let networkRequests = 0;
  const web = new WebTools({ resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async url => { networkRequests++; return { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>ok</body></html>', url: url.href }; },
    browser: new ControlledBrowser({ chromiumApi: { launch: async () => ({ isConnected: () => true, newContext: async () => {
      const frame = {};
      const page = { mainFrame: () => frame, route: async () => {}, routeWebSocket: async () => {}, addInitScript: async () => {}, on: () => {},
        goto: async () => {}, waitForTimeout: async () => {}, evaluate: async () => ({ title: 'Example', text: 'Rendered page', links: [], forms: [], startChar: 0, nextStartChar: null, totalChars: 13, truncated: false, untrusted: true }) };
      return { newPage: async () => page, route: async (_pattern, handler) => {
        const request = { frame: () => page.mainFrame(), method: () => 'GET', resourceType: () => 'document', isNavigationRequest: () => true, url: () => 'https://example.com/' };
        await handler({ request: () => request, fulfill: async () => {}, abort: async reason => { throw new Error(`unexpected browser request abort: ${reason}`); } });
      }, on: () => {}, close: async () => {} };
    }, close: async () => {} }) } }) });
  const runner = createGatewayTurnRunner({ root, models, approvals, web, browserReady: true,
    audit: { auditReady: true, async record() {} }, sandbox: { async verify() { return true; }, async readOperation() { return ''; }, async execute() { return {}; } } });
  const input = '请用浏览器打开 https://example.com/ 并总结页面';
  let pending;
  const first = await runner({ input, turnId: 'browser-turn', clientIdentity: 'client-a' }).catch(error => { pending = error; return null; });
  assert.ok(pending, `expected network approval, got result=${JSON.stringify(first)} calls=${calls} networkRequests=${networkRequests} tools=${JSON.stringify(seenTools)} results=${JSON.stringify(toolResults)}`);
  assert.equal(pending.code, 'APPROVAL_REQUIRED');
  const approval = approvals.get(pending.approvalId);
  assert.equal(approval.operation, 'browser_open');
  assert.equal(approval.metadata.summary.origin, 'https://example.com');
  assert.equal(Object.hasOwn(approval.metadata.summary, 'url'), false);
  await approvals.resolve(pending.approvalId, 'approved');
  const resumed = await runner({ input, turnId: 'browser-turn', sessionId: pending.sessionId, approvalId: pending.approvalId, clientIdentity: 'client-a' });
  assert.equal(resumed.answer, 'rendered page verified');
  assert.equal(calls, 2);
  assert.equal(networkRequests, 1);
});

test('Gateway link approval shows source and target and rejects a changed target on resume', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-browser-link-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const approved = body.messages.some(message => message.role === 'tool' && JSON.parse(message.content).isError !== true);
    const targetUrl = calls === 0 ? 'https://example.com/next' : 'https://example.com/changed';
    calls++;
    const message = approved ? { role: 'assistant', content: 'done' } : { role: 'assistant', content: null, tool_calls: [{ id: `link-${calls}`, type: 'function', function: { name: 'browser_open', arguments: JSON.stringify({ url: 'https://example.com/', targetUrl }) } }] };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const approvals = new ApprovalManager();
  const web = new WebTools({ browser: { render: async () => ({ title: 'unused', text: '', links: [], forms: [], untrusted: true }) } });
  const runner = createGatewayTurnRunner({ root, models: { get: async () => ({ model: 'test', apiKey: 'test-only', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) }, approvals, web, browserReady: true,
    audit: { auditReady: true, async record() {} }, sandbox: { async verify() { return true; }, async readOperation() { return ''; }, async readExternal() { return ''; }, async execute() { return {}; } } });
  const input = '浏览网页并打开下一页 https://example.com/';
  let pending;
  await assert.rejects(runner({ input, turnId: 'browser-link', clientIdentity: 'client-a' }), error => { pending = error; return error.code === 'APPROVAL_REQUIRED'; });
  const approval = approvals.get(pending.approvalId);
  assert.equal(approval.operation, 'browser_open');
  assert.equal(approval.metadata.summary.origin, 'https://example.com');
  assert.equal(approval.metadata.summary.action, 'follow_link');
  assert.equal(approval.metadata.summary.targetOrigin, 'https://example.com');
  assert.equal(Object.hasOwn(approval.metadata.summary, 'targetUrl'), false);
  await approvals.resolve(pending.approvalId, 'approved');
  await assert.rejects(runner({ input, turnId: 'browser-link', sessionId: pending.sessionId, approvalId: pending.approvalId, clientIdentity: 'client-a' }), { code: 'APPROVAL_RESOURCE_CHANGED' });
});

test('Gateway does not expose network tools on turns without explicit web intent', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-browser-hidden-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true })));
  let visible = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    visible = (body.tools ?? []).map(tool => tool.function.name);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const runner = createGatewayTurnRunner({ root,
    models: { get: async () => ({ model: 'test', apiKey: 'test-only', streaming: false, url: `http://127.0.0.1:${upstream.address().port}/v1` }) },
    approvals: new ApprovalManager(), web: new WebTools({ browser: { render: async () => assert.fail('browser must not be called') } }), browserReady: true,
    audit: { auditReady: true, async record() {} },
    sandbox: { async verify() { return true; }, async readOperation() { return ''; }, async readExternal() { return ''; }, async execute() { return {}; } },
  });
  const result = await runner({ input: '你好', turnId: 'browser-hidden' });
  assert.equal(result.answer, 'hello');
  assert.equal(visible.some(name => ['web_fetch', 'web_search', 'browser_open'].includes(name)), false);
});
