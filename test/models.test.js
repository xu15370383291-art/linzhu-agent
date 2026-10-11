import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Models, endpointFor } from '../backend/models.js';
import { createServer } from '../backend/model-server.js';

test('model server serves relocated frontend assets without exposing backend files', async t => {
  const server = createServer({});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [url, file, type] of [
    ['/', 'index.html', 'text/html'],
    ['/app.js', 'app.js', 'text/javascript'],
    ['/style.css', 'style.css', 'text/css'],
  ]) {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type').startsWith(type));
    assert.equal(await response.text(), await readFile(new URL(`../frontend/models/${file}`, import.meta.url), 'utf8'));
  }
  assert.equal((await fetch(`${base}/backend/models.js`)).status, 404);
});

test('model configuration stays private and selection persists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-models-'));
  const store = new Models(root);
  const first = await store.upsert({ name: 'One', model: 'one', url: 'https://example.com/v1', apiKey: 'secret' });
  assert.equal(first.items[0].hasKey, true);
  assert.equal(JSON.stringify(first).includes('secret'), false);
  const id = first.items[0].id;
  await store.upsert({ name: 'Updated', model: 'one', url: 'https://example.com/v1', fullUrl: false }, id);
  assert.equal((await store.get(id)).apiKey, 'secret');
  assert.equal((await store.get(id)).streaming, true);
  await store.upsert({ name: 'Updated', model: 'one', url: 'https://example.com/v1', streaming: false }, id);
  assert.equal((await store.get(id)).streaming, false);
  await store.upsert({ name: 'Updated', model: 'one', url: 'https://example.com/v1' }, id);
  assert.equal((await store.get(id)).streaming, false);
  assert.equal((await store.list()).items[0].name, 'Updated');
  assert.equal((await store.list()).selectedId, id);
  await store.remove(id);
  assert.equal((await store.list()).selectedId, null);
  assert.equal(endpointFor({ url: 'https://example.com/v1', fullUrl: false }), 'https://example.com/v1/chat/completions');
  assert.throws(() => endpointFor({ url: 'http://example.com', fullUrl: true }), /HTTPS/);
});

test('model context settings persist and reject impossible budgets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-model-budget-'));
  const store = new Models(root);
  const data = { name: 'Small', model: 'small', url: 'https://example.com/v1', contextWindow: 8192, outputReserve: 1024 };
  const saved = await store.upsert(data);
  assert.equal((await store.get(saved.selectedId)).contextWindow, 8192);
  assert.equal((await store.get(saved.selectedId)).outputReserve, 1024);
  await assert.rejects(store.upsert({ ...data, contextWindow: 2048, outputReserve: 1500 }), /Output reserve/);
  assert.equal((await store.get(saved.selectedId)).contextWindow, 8192);
});

test('model identity and reasoning intensity persist without exposing secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-model-reasoning-'));
  const store = new Models(root);
  const saved = await store.upsert({ name: 'GPT 6 工作模型', model: 'gpt-6', url: 'https://example.com/v1', reasoningEffort: 'high', apiKey: 'secret' });
  const item = await store.get(saved.selectedId);
  assert.equal(item.model, 'gpt-6');
  assert.equal(item.reasoningEffort, 'high');
  assert.equal((await store.list()).items[0].hasKey, true);
  await assert.rejects(store.upsert({ name: 'Invalid', model: 'x', url: 'https://example.com/v1', reasoningEffort: 'maximum' }), /思考挡位/);
});

test('legacy plaintext model keys migrate to DPAPI references before models.json is rewritten', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-model-migrate-'));
  const directory = path.join(root, '.agent-data');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'models.json'), JSON.stringify({ selectedId: '11111111-1111-4111-8111-111111111111', items: [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Legacy', model: 'old-model', url: 'https://example.com/v1', apiKey: 'legacy-secret-value' },
  ] }));
  const store = new Models(root);
  assert.equal((await store.get()).apiKey, 'legacy-secret-value');
  const saved = await readFile(path.join(directory, 'models.json'), 'utf8');
  assert.equal(saved.includes('legacy-secret-value'), false);
  assert.match(saved, /secret:\/\/provider\./);
  assert.equal((await new Models(root).get()).apiKey, 'legacy-secret-value');
});

test('Ollama provider stores and requests without an API key', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-ollama-'));
  let authorization;
  const upstream = http.createServer(async (req, res) => {
    authorization = req.headers.authorization;
    req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })); });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const store = new Models(root);
  const item = await store.upsert({ name: 'Local', model: 'qwen', provider: 'ollama', auth: 'none', url: `http://127.0.0.1:${upstream.address().port}/v1` });
  const selected = await store.get(item.selectedId);
  assert.equal(selected.apiKey, undefined);
  const { createQueryRequest } = await import('../backend/query-engine.js');
  const response = await createQueryRequest(selected)([{ role: 'user', content: 'hi' }], [], { stream: false });
  assert.equal(response.choices[0].message.content, 'ok');
  assert.equal(authorization, undefined);
});

test('local API rejects foreign origins and does not expose keys', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-model-api-'));
  const server = createServer(new Models(root));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const data = { name: 'Test', model: 'test', url: 'https://example.com/v1', apiKey: 'secret', streaming: false };
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  const forbidden = await fetch(`${base}/api/models`, { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: JSON.stringify(data) });
  assert.equal(forbidden.status, 403);
  const created = await fetch(`${base}/api/models`, { method: 'POST', headers, body: JSON.stringify(data) });
  assert.equal(created.status, 200);
  assert.equal((await created.text()).includes('secret'), false);
  const listed = await fetch(`${base}/api/models`);
  const listedItem = (await listed.json()).items[0];
  assert.equal(listedItem.hasKey, true);
  assert.equal(listedItem.streaming, false);
});

test('connection test checks unsaved values without selecting or saving them', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-test-connection-'));
  let status = 200;
  let payload = { choices: [{ message: { role: 'assistant', content: 'OK' } }] };
  let requested;
  const upstream = http.createServer(async (req, res) => {
    requested = { path: req.url, authorization: req.headers.authorization, body: JSON.parse(await new Promise(resolve => {
      let text = ''; req.on('data', chunk => { text += chunk; }); req.on('end', () => resolve(text));
    })) };
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const apiServer = createServer(new Models(root));
  await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => apiServer.close(resolve)));
  const base = `http://127.0.0.1:${apiServer.address().port}`;
  const headers = { Origin: base, 'Content-Type': 'application/json' };
  const url = `http://127.0.0.1:${upstream.address().port}/v1`;
  const post = async data => {
    const response = await fetch(`${base}/api/models/test`, { method: 'POST', headers, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  const config = { name: 'Draft', model: 'available', url, apiKey: 'secret-test' };
  const success = await post(config);
  assert.equal(success.status, 200);
  assert.equal(success.body.code, 'OK');
  assert.ok(success.body.elapsedMs >= 0);
  assert.equal(requested.path, '/v1/chat/completions');
  assert.equal(requested.authorization, 'Bearer secret-test');
  assert.equal(requested.body.model, 'available');
  assert.deepEqual((await fetch(`${base}/api/models`).then(res => res.json())).items, []);

  const created = await fetch(`${base}/api/models`, { method: 'POST', headers, body: JSON.stringify(config) }).then(res => res.json());
  const id = created.selectedId;
  const edited = await post({ ...config, id, model: 'changed' });
  assert.equal(edited.body.ok, true);
  assert.equal(requested.body.model, 'changed');
  assert.equal((await new Models(root).get(id)).model, 'available');
  assert.equal((await new Models(root).list()).selectedId, id);

  const savedTest = await post({ name: 'Draft', model: 'available', url, id });
  assert.equal(savedTest.body.ok, true);
  assert.equal(requested.authorization, 'Bearer secret-test');

  status = 401; payload = { error: { message: 'secret-test' } };
  assert.deepEqual((await post(config)).body, { ok: false, code: 'AUTH', message: '鉴权失败（HTTP 401），请检查 API Key' });
  status = 404;
  assert.equal((await post(config)).body.code, 'MODEL_OR_ENDPOINT');
  status = 429;
  assert.equal((await post(config)).body.code, 'RATE_LIMIT');
  status = 503;
  assert.equal((await post(config)).body.code, 'PROVIDER');
  status = 200; payload = { choices: [] };
  assert.equal((await post(config)).body.code, 'INVALID_RESPONSE');
  assert.equal((await post({ ...config, apiKey: '' })).body.code, 'CONFIG');
  assert.equal((await post({ ...config, url: 'not-a-url' })).status, 422);
  assert.equal(JSON.stringify(await post(config)).includes('secret-test'), false);
  const unreachable = await post({ ...config, url: 'http://127.0.0.1:1/v1' });
  assert.equal(unreachable.body.code, 'NETWORK');
});

test('model secret failures have a safe actionable error code', async () => {
  const store = new Models('unused', { secrets: { resolve: async () => { throw new Error('private helper output'); } } });
  store.load = async () => ({ selectedId: 'model', items: [{ id: 'model', secretRef: 'secret://model' }] });
  await assert.rejects(store.get(), error => error.code === 'MODEL_SECRET_UNAVAILABLE' && !error.message.includes('private helper output'));
});

test('connection test times out when an upstream response stalls', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-test-timeout-'));
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"choices":');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const apiServer = createServer(new Models(root), { connectionTimeoutMs: 50 });
  await new Promise(resolve => apiServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => apiServer.close(resolve)));
  const base = `http://127.0.0.1:${apiServer.address().port}`;
  const response = await fetch(`${base}/api/models/test`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Slow', model: 'slow', apiKey: 'secret', url: `http://127.0.0.1:${upstream.address().port}/v1` }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, 'TIMEOUT');
});
