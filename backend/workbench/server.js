import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGateway } from '../gateway/host.js';
import { acquireGatewayLock } from '../gateway/runtime.js';
import { ExtensionsStore } from './extensions-store.js';
import { SkillStore } from '../skills/store.js';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
const root = path.join(workspaceRoot, 'frontend', 'workbench');
const port = Number(process.env.PORT || 4173);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
let gatewayPromise;
function getGateway() { return gatewayPromise ??= startGateway({ root: workspaceRoot, port: 0, skills }); }
const skills = new SkillStore(process.env.SKILLS_DATA_ROOT || workspaceRoot);
const extensions = new ExtensionsStore(process.env.EXTENSIONS_DATA_ROOT || workspaceRoot, { skills });

async function readJson(request, limit = 512 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('请求 JSON 格式无效'), { status: 400 }); }
}
async function readBinary(request, limit = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) throw Object.assign(new Error('技能包不能超过 2 MB'), { status: 413 }); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function extensionJson(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); }
const previewLock = await acquireGatewayLock(workspaceRoot, { lockName: 'preview.lock', label: 'Preview server' });

const server = http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/') {
    response.writeHead(302, { Location: '/live.html', 'Cache-Control': 'no-store' });
    response.end();
    return;
  }
  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/extensions' || pathname.startsWith('/api/extensions/') || pathname === '/api/skills/import-pack') {
      try {
        const url = new URL(request.url, 'http://localhost');
        const segments = pathname.split('/').slice(3).map(segment => decodeURIComponent(segment));
        if (pathname === '/api/extensions' && request.method === 'GET') {
          const type = url.searchParams.get('type');
          if (!['plugin', 'skill'].includes(type)) throw Object.assign(new Error('条目类型无效'), { status: 400 });
          return extensionJson(response, 200, await extensions.list(type));
        }
        if (pathname === '/api/extensions/preferences' && request.method === 'PUT') return extensionJson(response, 200, await extensions.savePreferences(await readJson(request)));
        if (pathname === '/api/extensions/import' && request.method === 'POST') return extensionJson(response, 201, { items: await extensions.importData(await readJson(request)) });
        if (pathname === '/api/skills/import-pack' && request.method === 'POST') return extensionJson(response, 201, await skills.importPack(await readBinary(request)));
        if (pathname === '/api/extensions/export' && request.method === 'GET') return extensionJson(response, 200, await extensions.exportData(url.searchParams.get('id')));
        if (pathname === '/api/extensions/items' && request.method === 'POST') return extensionJson(response, 201, await extensions.saveItem(await readJson(request)));
        if (segments.length === 1 && request.method === 'GET') return extensionJson(response, 200, await extensions.get(segments[0]));
        if (segments.length === 2 && segments[1] === 'install' && request.method === 'POST') return extensionJson(response, 201, await extensions.install(segments[0]));
        if (segments.length === 2 && segments[1] === 'uninstall' && request.method === 'POST') return extensionJson(response, 200, await extensions.uninstall(segments[0]));
        if (segments.length === 2 && segments[1] === 'enable' && request.method === 'POST') return extensionJson(response, 200, await extensions.setEnabled(segments[0], true));
        if (segments.length === 2 && segments[1] === 'disable' && request.method === 'POST') return extensionJson(response, 200, await extensions.setEnabled(segments[0], false));
        if (segments.length === 2 && segments[1] === 'delete' && request.method === 'POST') return extensionJson(response, 200, await extensions.deletePersonal(segments[0]));
        return extensionJson(response, 404, { error: '扩展管理接口不存在' });
      } catch (error) { return extensionJson(response, error.status || 500, { error: error.message || '扩展管理数据操作失败' }); }
    }
    if (pathname === '/api/health') {
      return response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, pid: process.pid, root: workspaceRoot, port: server.address()?.port ?? port }));
    }
    let gateway;
    try { gateway = await getGateway(); } catch { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'Gateway failed to start' })); return; }
    const { origin, ...headers } = request.headers;
    const target = http.request({ hostname: '127.0.0.1', port: gateway.address.port, path: request.url, method: request.method, headers: { ...headers, host: `127.0.0.1:${gateway.address.port}` } }, upstream => {
      response.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(response);
    });
    target.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Gateway unavailable'); });
    request.pipe(target);
    return;
  }
  if (pathname === '/extensions' || pathname.startsWith('/extensions/')) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(await readFile(path.join(root, 'extensions.html')));
    return;
  }
  const requested = path.resolve(root, `.${pathname}`);
  if (!requested.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    const info = await stat(requested);
    if (!info.isFile()) throw Object.assign(new Error('Not a file'), { code: 'ENOENT' });
    const body = await readFile(requested);
    response.writeHead(200, { 'Content-Type': mime[path.extname(requested)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': body.length, 'X-Content-Type-Options': 'nosniff' });
    response.end(body);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error.code === 'ENOENT' ? '未找到页面' : '预览服务读取文件失败');
  }
});

let closing = false;
const sockets = new Set();
server.on('connection', socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});

async function closeHttpServer() {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function closePreview(exitCode = 0) {
  if (closing) return;
  closing = true;
  const gateway = await gatewayPromise?.catch(() => null);
  await gateway?.close?.().catch(() => {});
  await closeHttpServer();
  await previewLock.release().catch(() => {});
  if (exitCode !== null) process.exitCode = exitCode;
}
server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`预览服务端口 ${port} 已被占用。请先关闭旧预览进程，或使用固定的其他 PORT 启动。`);
    void closePreview(1);
    return;
  }
  console.error(error);
  void closePreview(1);
});
server.listen(port, '127.0.0.1', () => console.log(`灵珠原型预览：http://127.0.0.1:${port} (pid ${process.pid})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void closePreview(0));
process.once('exit', () => { void previewLock.release().catch(() => {}); });
