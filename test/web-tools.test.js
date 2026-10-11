import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { approveNetwork } from '../backend/network-approval.js';
import { publicAddress, webUrl, resolvePublic, extractPage, pinnedRequest, WebTools } from '../backend/tools/web.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { routeTool } from '../backend/tools/registry.js';
import { classifyIntent } from '../backend/agent/intent.js';
import { runTurn, SYSTEM_PROMPT } from '../backend/agent.js';

const resolver = async () => [{ address: '93.184.216.34', family: 4 }];
const response = (body = '<title>Test</title><p>Hello</p>', headers = { 'content-type': 'text/html; charset=utf-8' }) => ({ status: 200, headers, body });
const call = (name, args) => ({ id: 'web1', function: { name, arguments: JSON.stringify(args) } });
const setup = options => new WebTools({ resolver, approve: async () => true, transport: async () => response(), ...options });

test('system language preference covers replies, errors and approvals without translating commands', () => {
  assert.match(SYSTEM_PROMPT, /默认使用简体中文/);
  assert.match(SYSTEM_PROMPT, /请求用户确认/);
  assert.match(SYSTEM_PROMPT, /非必要不用英文/);
  assert.match(SYSTEM_PROMPT, /用户明确要求其他语言/);
  assert.match(SYSTEM_PROMPT, /不要翻译可执行内容/);
});

test('web addresses reject local, private, reserved, credentials, ports and protocols', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2001:100::1', '2002:808:808::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of ['file:///a', 'ftp://example.com', 'http://localhost', 'http://2130706433', 'http://127.1', 'http://[::1]', 'https://u:p@example.com', 'http://example.com:8080', 'https://a.local', 'https://host', 'https://example.com.']) assert.throws(() => webUrl(url));
  await assert.rejects(resolvePublic(webUrl('https://example.com'), async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]), /nonpublic/);
});

test('fetch extracts static text, strips controls and paginates without truncating silently', async () => {
  const web = setup({ transport: async () => response('<title>A &amp; B</title><script>bad()</script><p>' + 'x'.repeat(15000) + '</p>') });
  const first = await web.execute('web_fetch', { url: 'https://example.com' });
  assert.equal(first.title, 'A & B'); assert.equal(first.text.length, 12000);
  assert.equal(first.nextStartChar, 12000); assert.equal(first.untrusted, true);
  const second = await web.execute('web_fetch', { url: 'https://example.com', startChar: 12000 });
  assert.equal(second.nextStartChar, null); assert.ok(second.text.length >= 3000);
  assert.equal(extractPage('a\x1bb', 'text/plain').text, 'ab');
  assert.throws(() => extractPage('x', 'application/pdf'), /Unsupported/);
  assert.throws(() => extractPage('x', 'text/html; charset=gbk'), /charset/);
});

test('network denial prevents sockets; grants are origin scoped and revocable', async () => {
  let approvals = 0, connections = 0;
  const web = setup({ approve: async () => { approvals++; return 'session'; }, transport: async () => { connections++; return response(); } });
  await web.execute('web_fetch', { url: 'https://example.com/a' });
  await web.execute('web_fetch', { url: 'https://example.com/b' });
  assert.equal(approvals, 1); assert.equal(connections, 2);
  web.clearGrants(); await web.execute('web_fetch', { url: 'https://example.com/c' });
  assert.equal(approvals, 2);
  await assert.rejects(setup({ approve: async () => false, transport: async () => { throw new Error('must not connect'); } }).execute('web_fetch', { url: 'https://example.com' }), { code: 'USER_DENIED' });
});

test('redirects revalidate DNS and approval and block local/downgrade/loops', async () => {
  const origins = [];
  const web = setup({ approve: async details => { origins.push(details.origin); return true; },
    transport: async url => url.hostname === 'example.com' ? { status: 302, headers: { location: 'https://other.com/page' } } : response() });
  assert.equal((await web.execute('web_fetch', { url: 'https://example.com' })).source, 'https://other.com/page');
  assert.deepEqual(origins, ['https://example.com', 'https://other.com']);
  for (const target of ['http://127.0.0.1', 'http://example.com', 'https://example.com']) {
    await assert.rejects(setup({ transport: async () => ({ status: 302, headers: { location: target } }) }).execute('web_fetch', { url: 'https://example.com' }));
  }
  await assert.rejects(setup({ resolver: async () => [{ address: '10.0.0.1' }] }).execute('web_fetch', { url: 'https://example.com' }), /nonpublic/);
});

test('web operations bound DNS waits, cancellation, errors and output', async () => {
  await assert.rejects(setup({ timeoutMs: 20, resolver: () => new Promise(() => {}) }).execute('web_fetch', { url: 'https://example.com' }), { name: 'TimeoutError' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().execute('web_fetch', { url: 'https://example.com' }, controller.signal), { name: 'AbortError' });
  for (const result of [{ status: 404, headers: {}, body: '' }, response('x'.repeat(1048577)), response('x', { 'content-type': 'text/plain', 'content-encoding': 'gzip' })])
    await assert.rejects(setup({ transport: async () => result }).execute('web_fetch', { url: 'https://example.com' }));
});

test('search requires key, sends it only to fixed provider and validates results', async () => {
  await assert.rejects(setup({ searchKey: '' }).execute('web_search', { query: 'node' }), /BRAVE_SEARCH_API_KEY/);
  const web = setup({ searchKey: 'test-secret', transport: async (url, ip, options) => {
    assert.equal(url.origin, 'https://api.search.brave.com'); assert.equal(options.headers['X-Subscription-Token'], 'test-secret');
    return response(JSON.stringify({ web: { results: [{ title: 'Node', url: 'https://nodejs.org', description: '<b>Runtime</b>' }, { url: 'http://127.0.0.1' }] } }), { 'content-type': 'application/json' });
  } });
  const result = await web.execute('web_search', { query: 'node', count: 2 });
  assert.equal(result.results.length, 1); assert.equal(result.results[0].description, 'Runtime');
  assert.ok(!JSON.stringify(result).includes('test-secret'));
  for (const result of [response('not json'), response('{}'), { status: 302, headers: { location: 'https://other.com' } }])
    await assert.rejects(setup({ searchKey: 'key', transport: async () => result }).execute('web_search', { query: 'node' }));
});

test('web routing, argument validation, tool allowlist and strict sandbox gate hold', async () => {
  assert.deepEqual(classifyIntent('读取 https://example.com 网页').groups, ['network.read']);
  assert.ok(classifyIntent('联网查资料保存到文件').groups.includes('workspace.write'));
  const policy = new PermissionPolicy({ networkReady: true });
  assert.equal((await routeTool(call('web_fetch', { url: 'https://example.com', extra: 1 }), { policy, web: setup() })).errorCode, 'INVALID_ARGUMENTS');
  assert.equal((await routeTool(call('web_search', { query: 'x', count: 6 }), { policy, web: setup() })).errorCode, 'INVALID_ARGUMENTS');
  assert.equal((await routeTool(call('web_fetch', { url: 'https://example.com' }), { policy, web: setup(), allowedTools: new Set(['read_file']) })).errorCode, 'TOOL_NOT_AVAILABLE');
  assert.equal((await routeTool(call('web_fetch', { url: 'https://example.com' }), { policy: new PermissionPolicy({ networkReady: true, requireSandbox: true }), web: setup() })).errorCode, 'TOOL_NOT_AVAILABLE');
  const session = { messages: [] };
  const answer = await runTurn({ session, input: '读取 https://example.com 网页', policy, web: setup(), request: async (messages, tools) => {
    assert.ok(tools.every(tool => tool.function.name.startsWith('web_')));
    return { choices: [{ message: messages.at(-1).role === 'user' ? { role: 'assistant', tool_calls: [call('web_fetch', { url: 'https://example.com' })] } : { role: 'assistant', content: 'Hello https://example.com/' } }] };
  } });
  assert.match(answer, /Hello/); assert.equal(session.messages.filter(message => message.role === 'tool').length, 1);
});

test('real HTTP transport pins DNS and enforces streaming download limits', async () => {
  // Local server is a transport fixture only: production URL validation blocks it.
  const server = http.createServer((request, response) => { response.setHeader('Content-Type', 'text/plain'); response.end('hello world'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = new URL(`http://unresolvable.invalid:${server.address().port}/`);
    const address = { address: '127.0.0.1', family: 4 };
    assert.equal((await pinnedRequest(url, address)).body, 'hello world');
    await assert.rejects(pinnedRequest(url, address, { maxBytes: 3 }), /limit/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('network terminal approval restores input for once/session/denial and undersized screens', async () => {
  for (const [key, expected] of [['y', true], ['s', 'session'], ['n', false], ['\x03', false], ['\x1b', false]]) {
    const input = new PassThrough(), output = new PassThrough();
    input.isTTY = output.isTTY = true; input.isRaw = false;
    input.setRawMode = value => { input.isRaw = value; };
    output.rows = 24; output.columns = 80;
    const pending = approveNetwork({ tool: 'web_fetch', origin: 'https://example.com', url: 'https://example.com/' }, { input, output });
    input.write(key);
    assert.equal(await pending, expected); assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0);
  }
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.setRawMode = value => { input.isRaw = value; }; output.columns = 10;
  await assert.rejects(approveNetwork({ tool: 'web_fetch', origin: 'https://example.com', url: 'https://example.com' }, { input, output }), /resize/);
  assert.equal(input.isRaw, false);
});

test('DNS cancellation releases terminal input and allows the next prompt', async () => {
  const { withRequestInput } = await import('../backend/request-input.js');
  const { questionWithCommands } = await import('../backend/command-prompt.js');
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  output.rows = 24; output.columns = 80;
  const web = setup({ resolver: () => new Promise(() => {}), runTask: action => withRequestInput(input, action) });
  const pending = web.execute('web_fetch', { url: 'https://example.com' });
  input.write('\x03');
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0);
  const prompt = questionWithCommands({ pause() {}, resume() {} }, input, output);
  input.write('hello\r'); assert.equal(await prompt, 'hello');
});

test('parent cancellation releases approval input without a keypress', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; }; output.rows = 24; output.columns = 80;
  const web = setup({ timeoutMs: 20, approve: details => approveNetwork(details, { input, output }) });
  const controller = new AbortController();
  const cancel = setTimeout(() => controller.abort(), 50);
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(web.execute('web_fetch', { url: 'https://example.com' }, controller.signal), { name: 'AbortError' }); }
  finally { clearTimeout(keepAlive); clearTimeout(cancel); }
  assert.equal(input.isRaw, false); assert.equal(input.listenerCount('keypress'), 0);
});

test('time spent reading approval does not consume network timeout', async () => {
  const web = setup({ timeoutMs: 30, approve: async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    return true;
  } });
  const result = await web.execute('web_fetch', { url: 'https://example.com' });
  assert.equal(result.title, 'Test');
});

test('download timeout identifies its phase and aborts transport', async () => {
  let aborted = false;
  const web = setup({ timeoutMs: 30, transport: (_url, _ip, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  await assert.rejects(web.execute('web_fetch', { url: 'https://example.com' }), /download timed out/);
  assert.equal(aborted, true);
});

test('cancelled tool ends the turn without another model request and pairs pending calls', async () => {
  const session = { messages: [] }; let requests = 0;
  await assert.rejects(runTurn({ session, input: '读取 https://example.com', policy: new PermissionPolicy({ networkReady: true }),
    web: setup({ transport: async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); } }),
    request: async () => { requests++; return { choices: [{ message: { role: 'assistant', tool_calls: [call('web_fetch', { url: 'https://example.com' }), { ...call('web_fetch', { url: 'https://other.com' }), id: 'web2' }] } }] }; },
  }), { code: 'CANCELLED' });
  assert.equal(requests, 1);
  assert.equal(session.messages.filter(message => message.role === 'tool').length, 2);
});
