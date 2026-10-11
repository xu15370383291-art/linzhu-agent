import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Models, endpointFor } from './models.js';
import { listProviders, normalizeProviderConfig, capabilitySnapshot } from './providers/registry.js';
import { acquireGatewayLock } from './gateway/runtime.js';

const models = new Models(process.cwd());
const staticDir = fileURLToPath(new URL('../frontend/models/', import.meta.url));
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

function connectionError(error) {
  if (error?.name === 'TimeoutError' || error?.code === 'TIMEOUT') return { code: 'TIMEOUT', message: '连接超时，请检查地址、网络或服务端响应速度' };
  if (error?.name === 'TypeError') return { code: 'NETWORK', message: '无法连接到请求地址，请检查地址和网络' };
  if (error?.status === 401 || error?.status === 403) return { code: 'AUTH', message: `鉴权失败（HTTP ${error.status}），请检查 API Key` };
  if (error?.status === 400 || error?.status === 404) return { code: 'MODEL_OR_ENDPOINT', message: `请求参数、地址或模型 ID 无效（HTTP ${error.status}），请核对服务商文档` };
  if (error?.status === 429) return { code: 'RATE_LIMIT', message: '服务商限流（HTTP 429），请稍后重试' };
  if (error?.status >= 500) return { code: 'PROVIDER', message: `服务商暂时不可用（HTTP ${error.status}）` };
  if (error?.code === 'CONFIG') return { code: 'CONFIG', message: '请先配置 API Key' };
  return { code: 'INVALID_RESPONSE', message: '服务返回格式不符合 OpenAI Chat Completions，请检查接口协议' };
}

async function readLimited(response, limit = 1024 * 1024) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('响应为空');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('响应过大');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function testConnection(item, timeoutMs) {
  if (!item.apiKey && item.auth !== 'none' && item.provider !== 'ollama') throw Object.assign(new Error('请先配置 API Key'), { code: 'CONFIG' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('连接测试超时'), { code: 'TIMEOUT' })), timeoutMs);
  const started = performance.now();
  try {
    let response;
    try {
      response = await fetch(endpointFor(item), {
        method: 'POST',
        headers: { ...(item.apiKey ? { Authorization: `Bearer ${item.apiKey}` } : {}), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: item.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error('服务商请求失败'), { status: response.status });
    }
    let result;
    try { result = JSON.parse(await readLimited(response)); }
    catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
    if (!result?.choices?.[0]?.message) throw new Error('服务返回的格式不是 Chat Completions');
    return { ok: true, code: 'OK', elapsedMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

export function createServer(store = models, { connectionTimeoutMs = 20_000 } = {}) {
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(data));
    };
    if (req.headers.host !== `127.0.0.1:${port}`) return reply(403, { error: 'Invalid host' });
    const url = new URL(req.url, origin);
    if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json')) {
      return reply(403, { error: 'Invalid origin or content type' });
    }
    try {
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, type] = files[url.pathname];
        const body = await readFile(path.join(staticDir, file));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'" });
        return res.end(body);
      }
      if (req.method === 'GET' && url.pathname === '/api/models') return reply(200, await store.list());
      if (req.method === 'GET' && url.pathname === '/api/providers') return reply(200, { items: listProviders() });
      if (!url.pathname.startsWith('/api/')) return reply(404, { error: 'Not found' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 12_000) return reply(413, { error: 'Request too large' });
      }
      const body = JSON.parse(raw || '{}');
      if (req.method === 'POST' && url.pathname === '/api/models') return reply(200, await store.upsert(normalizeProviderConfig(body)));
      if (req.method === 'POST' && url.pathname === '/api/models/test') {
        const item = normalizeProviderConfig(await store.preview(body, body.id));
        if (body.id && body.apiKey === undefined) item.apiKey = (await store.get(body.id))?.apiKey;
        try { return reply(200, await testConnection(item, connectionTimeoutMs)); }
        catch (error) { return reply(200, { ok: false, ...connectionError(error) }); }
      }
      const match = url.pathname.match(/^\/api\/models\/([0-9a-f-]{36})(?:\/(select|test))?$/);
      if (!match) return reply(404, { error: 'Not found' });
      const [, id, action] = match;
      if (req.method === 'PUT' && !action) return reply(200, await store.upsert(normalizeProviderConfig(body), id));
      if (req.method === 'DELETE' && !action) return reply(200, await store.remove(id));
      if (req.method === 'POST' && action === 'select') return reply(200, await store.select(id));
      if (req.method === 'POST' && action === 'test') {
        const item = await store.get(id);
        if (!item) throw new Error('模型不存在');
        try { return reply(200, await testConnection(item, connectionTimeoutMs)); }
        catch (error) { return reply(200, { ok: false, ...connectionError(error) }); }
      }
      return reply(404, { error: 'Not found' });
    } catch (error) {
      reply(error instanceof SyntaxError ? 400 : 422, { error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
  });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MODEL_PORT || process.env.PORT || 59161);
  const lock = await acquireGatewayLock(process.cwd(), { lockName: 'models.lock', label: 'Model config server' });
  const server = createServer();
  let closing = false;
  const close = async (exitCode = 0) => {
    if (closing) return;
    closing = true;
    await new Promise(resolve => server.close(() => resolve()));
    await lock.release().catch(() => {});
    if (exitCode !== null) process.exitCode = exitCode;
  };
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') console.error(`模型配置服务端口 ${port} 已被占用，请访问已有服务或更换 MODEL_PORT。`);
    else console.error(error);
    void close(1);
  });
  server.listen(port, '127.0.0.1', () => console.log(`模型配置界面: http://127.0.0.1:${port}/`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void close(0));
  process.once('exit', () => { void lock.release().catch(() => {}); });
}
