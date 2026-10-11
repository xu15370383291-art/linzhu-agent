import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Workspace } from '../backend/workspace.js';
import { Sessions } from '../backend/sessions.js';
import { Models } from '../backend/models.js';
import { SecurityAudit } from '../backend/permissions/audit.js';
import { LocalGateway } from '../backend/gateway/server.js';
import { createGatewayTurnRunner } from '../backend/gateway/turn-runner.js';
import { ApprovalManager } from '../backend/gateway/approval-manager.js';
import { resourceFingerprint } from '../backend/contracts/approval.js';
import { WslSandbox } from '../backend/sandbox/wsl.js';
import { createQueryRequest } from '../backend/query-engine.js';
import { WebTools, webUrl } from '../backend/tools/web.js';
import { createControlledBrowser } from '../backend/browser/session.js';
import { listen, summarize } from './performance-kit.js';
import { buildCases, grade, validateCall } from './eval/cases.js';
import { modelObserver, startMockModel, usageSummary } from './eval/model.js';
import { aggregate, markdown } from './eval/report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseConfig(args) {
  const mode = args[0];
  if (!['smoke', 'local', 'real'].includes(mode)) throw new Error('模式必须是 smoke、local 或 real');
  const config = { mode, count: mode === 'smoke' ? 1 : mode === 'local' ? 5 : 3, warmup: mode === 'smoke' ? 0 : 1,
    apiCount: mode === 'smoke' ? 10 : 100, apiBatches: mode === 'smoke' ? 1 : 3, maxAttempts: mode === 'real' ? 120 : 2000, seconds: 600, stabilitySeconds: 0, allowPaid: false, origin: null, prices: null };
  const allowed = new Set(['count', 'warmup', 'max-attempts', 'seconds', 'stability-seconds', 'allow-paid', 'origin', 'input-price', 'output-price', 'cached-price', 'currency']);
  const values = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.has(key)) throw new Error(`未知参数：${args[i]}`);
    if (Object.hasOwn(values, key)) throw new Error(`重复参数：${key}`);
    if (key === 'allow-paid') { values[key] = true; continue; }
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`参数 ${key} 缺少值`);
    values[key] = args[++i];
  }
  for (const [key, option, min, max] of [['count', 'count', 1, 30], ['warmup', 'warmup', 0, 5], ['max-attempts', 'maxAttempts', 1, 3000], ['seconds', 'seconds', 5, 3600], ['stability-seconds', 'stabilitySeconds', 0, 1800]]) {
    if (values[key] !== undefined) { const n = Number(values[key]); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} 必须在 ${min}-${max} 之间`); config[option] = n; }
  }
  config.allowPaid = values['allow-paid'] === true;
  if (config.stabilitySeconds >= config.seconds) throw new Error('稳定性时长必须小于总时长预算');
  if (mode === 'real' && !config.allowPaid) throw new Error('真实模型可能产生费用；必须显式传入 --allow-paid');
  if (values.origin) {
    const url = webUrl(values.origin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) throw new Error('origin 必须是你控制的公开 HTTPS 来源，不包含路径、查询或片段');
    config.origin = url.origin;
  }
  if (['input-price', 'output-price', 'cached-price', 'currency'].some(key => values[key] !== undefined)) {
    const input = Number(values['input-price']); const output = Number(values['output-price']); const cached = Number(values['cached-price'] ?? values['input-price']);
    if (![input, output, cached].every(value => Number.isFinite(value) && value >= 0) || !/^[A-Z]{3}$/.test(values.currency ?? 'USD')) throw new Error('价格必须完整提供 input-price/output-price，为每百万 Token 单价，币种为三位大写代码');
    config.prices = { input, output, cached, currency: values.currency ?? 'USD' };
  }
  return config;
}

async function prepare(directory) {
  const workspaceRoot = path.join(directory, 'workspace'); const fixtureDir = path.join(workspaceRoot, 'eval-data');
  await mkdir(fixtureDir, { recursive: true }); const hashes = {};
  for (const name of ['project.md', 'meeting.md']) {
    const content = await readFile(path.join(root, 'test/fixtures/performance', name));
    await writeFile(path.join(fixtureDir, name), content, { flag: 'wx' }); hashes[name] = createHash('sha256').update(content).digest('hex');
  }
  for (const size of [10, 100, 250]) {
    const dir = path.join(workspaceRoot, `scale-${size}`); await mkdir(dir);
    for (let i = 0; i < size; i++) await writeFile(path.join(dir, `file-${String(i).padStart(4, '0')}.txt`), `record ${i}\nSCALE_MARKER\n`, { flag: 'wx' });
  }
  return { workspaceRoot, hashes };
}

function resourceSampler() {
  const samples = []; let previous = process.cpuUsage(); let at = performance.now();
  const collect = () => {
    const now = performance.now(); const cpu = process.cpuUsage(); const memory = process.memoryUsage();
    samples.push({ time: new Date().toISOString(), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
      cpuOneCorePercent: now > at ? ((cpu.user - previous.user + cpu.system - previous.system) / 1000) / (now - at) * 100 : null });
    previous = cpu; at = now;
  };
  collect(); const timer = setInterval(collect, 1000); timer.unref();
  return () => { clearInterval(timer); collect(); return { scope: '仅本评测 Node 进程：含运行器、客户端、模拟服务和 Gateway；不含 Edge/WSL 子进程；1 秒采样，短时峰值可能漏采',
    peakRssBytes: Math.max(...samples.map(sample => sample.rssBytes)), samples }; };
}

function emptyRecord(suite, caseId, iteration, warmup) {
  return { suite, caseId, iteration, warmup, status: 'running', answer: null, calls: [], evidence: [], errorEvidence: [], failures: [], approvals: [], modelCalls: [], modelAttempts: [], toolTimes: [], firstOutputMs: null };
}

async function request(base, token, pathname, data, signal) {
  const response = await fetch(base + pathname, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal });
  const body = await response.json(); return { ok: response.ok, status: response.status, body };
}

async function apiBaseline(base, token, count, concurrency, signal) {
  for (let i = 0; i < 5; i++) { const value = await request(base, token, '/api/tools', undefined, signal); if (!value.ok) throw new Error('接口预热失败'); }
  let index = 0; const samples = []; const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < count && !signal.aborted) {
      const id = index++; const started = performance.now();
      try { const value = await request(base, token, '/api/tools', undefined, AbortSignal.any([signal, AbortSignal.timeout(10000)])); samples.push({ id, ok: value.ok, httpStatus: value.status, durationMs: performance.now() - started }); }
      catch (error) { samples.push({ id, ok: false, errorCode: error.code || error.name, durationMs: performance.now() - started }); }
    }
  }));
  const elapsedMs = performance.now() - start; const success = samples.filter(sample => sample.ok);
  return { concurrency, count, attempted: samples.length, warmup: 5, successCount: success.length, errorCount: samples.length - success.length,
    complete: samples.length === count, elapsedMs, throughput: success.length / (elapsedMs / 1000), latency: summarize(success.map(sample => sample.durationMs)), samples };
}

async function runAgent(context, testCase, iteration, warmup) {
  const { gateway, base, token, signal, setCurrent, config } = context;
  const record = emptyRecord(config.mode === 'real' ? 'real-agent' : 'mock-agent', testCase.id, iteration, warmup);
    record.prompt = testCase.prompt;
  if (testCase.browser && !context.browserReady || config.mode === 'real' && testCase.browser && !config.origin || config.mode === 'real' && !testCase.browser && testCase.evidenceTool && !context.sandboxReady) {
    record.status = 'skipped'; record.reason = testCase.browser ? '浏览器不可用或未配置自有公开 HTTPS 来源' : '已验证 WSL 沙箱不可用，不降级到主机读取';
    return { ...record, ...grade(testCase, record) };
  }
  setCurrent(record, testCase);
  const session = await context.sessions.create(); record.sessionId = session.id; record.turnId = `eval-${randomUUID()}`;
  let start; const events = []; const unsubscribe = gateway.events.on(event => {
    const turnId = event.payload?.turnId ?? event.payload?.approval?.metadata?.turnId;
    if (turnId !== record.turnId || start === undefined) return;
    const at = performance.now() - start;
    if (event.type === 'turn.delta' && event.payload.text && record.firstOutputMs === null) record.firstOutputMs = at;
    if (event.type === 'turn.awaiting_approval') events.push({ type: event.type, at });
    if (event.type === 'approval.resolved') events.push({ type: event.type, at });
  });
  // Subscribe over HTTP as well, to measure delivery rather than only server emission.
  const stop = await listen({ base, headers: { Authorization: `Bearer ${token}` } }, (event, at) => {
    if (event.payload?.turnId !== record.turnId || start === undefined) return;
    if (event.type === 'turn.delta' && event.payload.text && record.firstDeliveredOutputMs === undefined) record.firstDeliveredOutputMs = at - start;
    if (['turn.completed', 'turn.failed'].includes(event.type)) record.terminalDeliveredMs = at - start;
  }, { signal });
  const localSignal = AbortSignal.any([signal, AbortSignal.timeout(180000)]);
  const input = { input: testCase.prompt, sessionId: session.id, turnId: record.turnId };
  start = performance.now();
  try {
    for (let resume = 0; resume < 3; resume++) {
      const response = await request(base, token, '/api/turns', input, localSignal);
      if (response.body.code !== 'APPROVAL_REQUIRED') {
        if (response.ok && response.status === 200) record.answer = response.body.answer;
        else record.errorCode = response.body.code || 'UNEXPECTED_HTTP_STATUS';
        break;
      }
      const approval = gateway.approvals.get(response.body.approvalId);
      const call = record.calls.at(-1);
      const bound = { turnId: record.turnId, sessionId: record.sessionId, clientIdentity: createHash('sha256').update(`Bearer ${token}`).digest('hex').slice(0, 24), input: input.input, tool: call?.tool, details: call?.args };
      if (!approval || approval.resourceHash !== resourceFingerprint(bound) || !call || !validateCall(testCase, call.tool, call.args) || call.tool !== 'browser_open') throw Object.assign(new Error('测试审批资源不匹配，禁止自动批准'), { code: 'EVAL_APPROVAL_MISMATCH' });
      const decision = testCase.deny ? 'denied' : 'approved';
      const resolved = await request(base, token, `/api/approvals/${approval.id}`, { decision }, localSignal);
      if (!resolved.ok) throw Object.assign(new Error('测试审批失败'), { code: 'EVAL_APPROVAL_FAILED' });
      record.approvals.push({ decision, atMs: performance.now() - start });
      if (decision === 'denied') break;
      input.approvalId = approval.id;
    }
  } catch (error) {
    record.errorCode = error.code || error.name;
    await request(base, token, `/api/turns/${record.turnId}/cancel`, {}, AbortSignal.timeout(10000)).catch(() => {});
  } finally {
    record.elapsedMs = performance.now() - start;
    for (let i = 0; i < 50 && record.terminalDeliveredMs === undefined; i++) {
      if (testCase.deny && record.approvals.length || record.errorCode) break;
      await delay(10);
    }
    unsubscribe(); await stop().catch(() => { record.measurementError = 'SSE_DISCONNECTED'; });
    const turn = await gateway.turns.get(record.turnId, createHash('sha256').update(`Bearer ${token}`).digest('hex').slice(0, 24));
    record.status = turn?.status ?? 'unknown';
    if (record.status === 'completed' && record.terminalDeliveredMs === undefined) record.measurementError = 'SSE_TERMINAL_MISSING';
    let waiting = null; let approvalMs = 0;
    for (const event of events) { if (event.type === 'turn.awaiting_approval') waiting = event.at;
      else if (waiting !== null) { approvalMs += event.at - waiting; waiting = null; } }
    record.approvalMs = approvalMs;
    record.usage = usageSummary(record, config.prices, config.mode !== 'real');
    Object.assign(record, grade(testCase, record));
    if (record.errorCode || record.measurementError) { record.verdict = 'failed'; record.reason = `执行或测量异常：${record.errorCode || record.measurementError}`; }
    if (['running', 'awaiting_approval', 'awaiting_clarification', 'cancelling'].includes(record.status)) {
      await request(base, token, `/api/turns/${record.turnId}/cancel`, {}, AbortSignal.timeout(10000)).catch(() => {});
      record.verdict = 'failed'; record.reason = '回合未结束；已请求取消，不自动批准未知操作';
    }
    record.firstDeliveredOutputMs ??= null;
  }
  return record;
}

async function componentTests(workspace, save, config, signal) {
  for (const size of [10, 100, 250]) {
    for (const operation of ['pagination', 'search', 'read']) {
    for (let i = 0; i < config.warmup + config.count; i++) {
      signal.throwIfAborted(); const record = emptyRecord('host-workspace-component', `${operation}-${size}`, i + 1, i < config.warmup);
      const start = performance.now(); let cursor; const found = [];
      try {
        if (operation === 'read') {
          const contents = await workspace.read(`scale-${size}/file-0000.txt`);
          record.verdict = contents === 'record 0\nSCALE_MARKER\n' ? 'passed' : 'failed';
          record.reason = '固定小文件读取；size 是父目录项数，不是文件字节大小';
        } else {
          do {
            signal.throwIfAborted();
            const page = operation === 'pagination' ? await workspace.list(`scale-${size}`, { limit: 100, cursor })
              : await workspace.scanPage('search', 'SCALE_MARKER', `scale-${size}`, { limit: 100, cursor });
            found.push(...(page.items ?? page.matches)); cursor = page.nextCursor;
          } while (cursor);
          const expectedPaths = new Set(Array.from({ length: size }, (_, index) => `scale-${size}/file-${String(index).padStart(4, '0')}.txt`));
          record.verdict = found.length === size && new Set(found.map(item => item.path)).size === size && found.every(item => expectedPaths.has(item.path) &&
            (operation !== 'search' || item.line === 2 && item.text === 'SCALE_MARKER')) ? 'passed' : 'failed';
          record.reason = '分页结果路径、数量、去重及搜索行号检查';
        }
        record.status = 'completed';
      } catch (error) { record.status = 'failed'; record.verdict = 'failed'; record.reason = error.code || error.name; }
      record.elapsedMs = performance.now() - start; await save(record);
    }
    }
  }
}

async function reliabilityTests(save, signal) {
  for (const code of [429, 500, 401]) {
    const record = emptyRecord('mock-provider-reliability', `http-${code}`, 1, false); let attempts = 0;
    const requestModel = createQueryRequest({ model: 'fixture', auth: 'none', url: 'http://127.0.0.1/v1' }, {
      fetchImpl: async () => { attempts++; return attempts === 1 || code === 401 ? new Response('{}', { status: code, headers: { 'retry-after': '0' } }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }); },
    });
    const start = performance.now(); let errorCode = null; let answer;
    try { answer = await requestModel([{ role: 'user', content: 'hello' }], [], { signal }); } catch (error) { errorCode = error.code; }
    record.elapsedMs = performance.now() - start; record.status = 'completed'; record.attempts = attempts;
    record.verdict = code === 401 ? (attempts === 1 && errorCode === 'AUTH' ? 'passed' : 'failed') : (attempts === 2 && answer?.choices[0].message.content === 'OK' ? 'passed' : 'failed');
    record.reason = '注入 HTTP 状态验证重试行为，非真实公网性能'; await save(record);
  }
  const broken = emptyRecord('mock-provider-reliability', 'truncated-stream', 1, false); let streamAttempts = 0; let streamError = null;
  const brokenRequest = createQueryRequest({ model: 'fixture', auth: 'none', url: 'http://127.0.0.1/v1' }, { fetchImpl: async () => {
    streamAttempts++; return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  const streamStart = performance.now();
  try { await brokenRequest([], [], { signal, onDelta: () => {} }); } catch (error) { streamError = error.code; }
  broken.elapsedMs = performance.now() - streamStart; broken.status = 'completed'; broken.attempts = streamAttempts;
  broken.verdict = streamAttempts === 1 && streamError === 'INVALID_RESPONSE' ? 'passed' : 'failed';
  broken.reason = '注入缺失 DONE 的流；不得当作成功或自动重试'; await save(broken);
  const record = emptyRecord('mock-provider-reliability', 'cancel', 1, false); const controller = new AbortController(); let observedAbort = false;
  const requestModel = createQueryRequest({ model: 'fixture', auth: 'none', url: 'http://127.0.0.1/v1' }, { fetchImpl: async (_url, init) => {
    try { await delay(60000, null, { signal: init.signal }); } catch (error) { observedAbort = init.signal.aborted; throw error; }
  } });
  const timer = setTimeout(() => controller.abort(), 30); const start = performance.now(); let result;
  try { await requestModel([], [], { signal: controller.signal }); } catch (error) { result = error.code; } finally { clearTimeout(timer); }
  record.elapsedMs = performance.now() - start; record.status = 'completed'; record.verdict = observedAbort && result === 'CANCELLED' ? 'passed' : 'failed';
  record.reason = '模型请求取消验证；耗时包含注入的 30ms 等待，不是 Gateway 取消延迟'; await save(record);

  const gateway = new LocalGateway({ approvals: new ApprovalManager(), runTurn: async ({ signal: turnSignal }) => {
    await delay(60000, null, { signal: turnSignal }); return { answer: 'unexpected' };
  } });
  const server = gateway.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const turnId = `cancel-${randomUUID()}`; const base = `http://127.0.0.1:${server.address().port}`; const token = 'cancel-fixture';
    let error = null;
    const pending = request(base, token, '/api/turns', { input: 'cancel fixture', turnId }, signal).catch(caught => { error = caught; });
    for (let i = 0; i < 100 && !gateway.turns.controllers.has(turnId); i++) await delay(5, null, { signal });
    const sample = emptyRecord('gateway-reliability', 'cancel-turn', 1, false); const startCancel = performance.now();
    const cancellation = await request(base, token, `/api/turns/${turnId}/cancel`, {}, signal);
    await pending;
    const turn = await gateway.turns.get(turnId, createHash('sha256').update(`Bearer ${token}`).digest('hex').slice(0, 24));
    sample.elapsedMs = performance.now() - startCancel; sample.status = turn?.status ?? 'unknown';
    sample.verdict = !error && cancellation.ok && turn?.status === 'cancelled' && !gateway.turns.controllers.has(turnId) ? 'passed' : 'failed';
    sample.reason = '从 HTTP 取消请求发起到原请求结束并核实 cancelled；只测注入等待任务，不代表 WSL/Edge 清理时延';
    await save(sample);
  } finally { gateway.turns.abortActive(); gateway.closeClients(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

async function stabilityTest(base, token, seconds, signal) {
  const samples = []; const start = performance.now(); let previousBucket = -1;
  while (performance.now() - start < seconds * 1000 && !signal.aborted) {
    const at = performance.now();
    try { const response = await request(base, token, '/api/tools', undefined, AbortSignal.any([signal, AbortSignal.timeout(10000)])); samples.push({ atMs: at - start, ok: response.ok, durationMs: performance.now() - at }); }
    catch (error) { samples.push({ atMs: at - start, ok: false, errorCode: error.code || error.name, durationMs: performance.now() - at }); }
    const bucket = Math.floor((performance.now() - start) / 10000);
    if (bucket !== previousBucket) { previousBucket = bucket; console.log(`稳定性采集：${Math.floor((performance.now() - start) / 1000)}/${seconds} 秒`); }
    try { await delay(100, null, { signal }); } catch (error) { if (!signal.aborted) throw error; break; }
  }
  return { scope: '仅独立 Gateway /api/tools，串行闭环请求，间隔至少 100ms；不调用真实模型，不测 Agent 长任务稳定性',
    requestedSeconds: seconds, elapsedMs: performance.now() - start, complete: !signal.aborted && performance.now() - start >= seconds * 1000, samples,
    windows: [...new Set(samples.map(sample => Math.floor(sample.atMs / 60000)))].map(minute => {
      const window = samples.filter(sample => Math.floor(sample.atMs / 60000) === minute);
      return { minute, count: window.length, failed: window.filter(sample => !sample.ok).length, successfulLatencyMs: summarize(window.filter(sample => sample.ok).map(sample => sample.durationMs)) };
    }) };
}

export async function evaluate(config) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, 'artifacts/performance', id); await mkdir(directory, { recursive: true });
  const report = { id, mode: config.mode, config, startTime: new Date().toISOString(), records: [], api: [], notes: [],
    environment: { node: process.version, platform: process.platform, osRelease: os.release(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() } };
  const controller = new AbortController(); const signal = controller.signal;
  const interrupt = () => controller.abort(Object.assign(new Error('评测取消'), { code: 'EVAL_CANCELLED' }));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const timeout = setTimeout(() => controller.abort(Object.assign(new Error('评测总时长预算耗尽'), { code: 'EVAL_TIMEOUT' })), config.seconds * 1000);
  const endResources = resourceSampler(); const budget = { sent: 0, maxAttempts: config.maxAttempts }; const closers = [];
  const save = async record => { report.records.push(record); await appendFile(path.join(directory, 'samples.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    console.log(`${record.warmup ? '预热' : '正式'} ${record.suite}/${record.caseId}: ${record.verdict} ${Number.isFinite(record.elapsedMs) ? record.elapsedMs.toFixed(1) + ' ms' : ''}`); };
  let current; let currentCase;
  try {
    report.codeHashes = {};
    for (const file of ['backend/agent.js', 'backend/query-engine.js', 'backend/gateway/turn-runner.js', 'backend/browser/session.js',
      'scripts/auto-eval.js', 'scripts/eval/cases.js', 'scripts/eval/model.js', 'scripts/eval/report.js']) {
      report.codeHashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
    }
    const prepared = await prepare(directory); report.fixtureHashes = prepared.hashes;
    for (const file of ['dynamic.html', 'detail.html', 'static.html', 'app.js']) report.fixtureHashes[`site/${file}`] = createHash('sha256').update(await readFile(path.join(root, 'test/fixtures/performance/site', file))).digest('hex');
    const workspaceRoot = prepared.workspaceRoot; report.workspaceRoot = workspaceRoot;
    const workspace = new Workspace(workspaceRoot); const sessions = new Sessions(workspaceRoot);
    const approvals = new ApprovalManager({ root: workspaceRoot }); const audit = new SecurityAudit(workspaceRoot); await audit.initialize(); audit.auditReady = true;
    let item; let mock;
    if (config.mode === 'real') {
      item = await new Models(root).get(); if (!item) throw new Error('没有选中的模型连接，请先配置模型');
      report.notes.push('真实模式使用所选模型；配置与密钥只在内存使用，不复制到测试报告。');
    } else { mock = await startMockModel(() => currentCase); item = mock.item; closers.push(mock.close); }
    report.model = { model: item.model, provider: item.provider, streaming: item.streaming !== false, reasoningEffort: item.reasoningEffort ?? 'default', outputReserve: item.outputReserve ?? 4096 };
    let sandbox = null; let sandboxReady = false;
    if (config.mode === 'real' && process.platform === 'win32') { sandbox = new WslSandbox(workspaceRoot); sandboxReady = await sandbox.verify().catch(() => false); }
    report.sandboxReady = sandboxReady;
    report.notes.push(config.mode === 'real' ? '真实模式保留 Safe 策略；沙箱不可用时文件任务跳过。' : '本地模拟 Agent 使用独立工作区的主机只读工具，不测量 WSL 隔离性能；模拟模型用量为合成值。');
    const browserResult = await createControlledBrowser(); report.browser = browserResult.status;
    const browser = browserResult.browser; if (browser) closers.push(() => browser.close());
    const web = new WebTools({ browser, approve: async () => false });
    if (config.mode !== 'real' && browser) {
      web.resolver = async () => [{ address: '93.184.216.34', family: 4 }];
      web.transport = async url => {
        if (url.origin !== 'https://fixture.invalid' || !['/dynamic.html', '/detail.html', '/app.js', '/static.html'].includes(url.pathname)) throw new Error('测试素材范围之外的请求');
        return { status: 200, url: url.href, headers: { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }, body: await readFile(path.join(root, 'test/fixtures/performance/site', url.pathname.slice(1)), 'utf8') };
      };
    }
    if (browser) browser.web = web;
    const hooks = {
      before: ({ tool, args }) => {
        const call = { tool: tool.name, args: structuredClone(args) }; current.calls.push(call);
        if (!validateCall(currentCase, tool.name, args)) throw Object.assign(new Error('工具超出当前固定题目范围'), { code: 'EVAL_SCOPE_DENIED' });
      },
      after: ({ tool, args, result }) => { current.evidence.push({ tool: tool.name, args: structuredClone(args), result: structuredClone(result) }); },
      evaluate: async (phase, details) => { if (phase === 'on-error') current.errorEvidence.push({ tool: details.tool, args: structuredClone(details.args), message: details.error }); return { allow: true }; },
    };
    const runner = createGatewayTurnRunner({ root: workspaceRoot, sessions, models: { get: async () => item }, audit, approvals, web,
      sandbox: config.mode === 'real' ? sandbox : {}, sandboxReady, browserReady: browserResult.status.available, structuredPlanning: true,
      getSecurityMode: async () => config.mode === 'real' ? 'safe' : 'personal', hooks,
      requestFactory: modelObserver({ getRecord: () => current, budget, signal }) });
    const token = randomUUID();
    const gateway = new LocalGateway({ root: workspaceRoot, token, sessions, models: {}, approvals, memory: {}, skills: {}, tasks: {}, messages: {},
      runTurn: async params => runner({ ...params, onStatus: async status => {
        if (status.phase === 'tool_finished') {
          current.toolTimes.push({ tool: status.name, durationMs: status.durationMs, ok: status.ok, errorCode: status.errorCode ?? null });
          if (!status.ok) current.failures.push({ tool: status.name, errorCode: status.errorCode ?? null });
        }
        await params.onStatus(status);
      } }) });
    const server = gateway.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    closers.push(async () => { gateway.turns.abortActive(); gateway.closeClients(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`; report.endpointScope = '独立 Gateway，无 Workbench 预览代理';
    for (let batch = 1; batch <= config.apiBatches; batch++) {
      for (const concurrency of config.mode === 'smoke' ? [1] : [1, 2, 4, 8]) {
        signal.throwIfAborted(); report.api.push({ batch, ...await apiBaseline(base, token, config.apiCount, concurrency, signal) });
      }
    }
    await componentTests(workspace, save, config, signal);
    const context = { gateway, base, token, sessions, signal, config, sandboxReady, browserReady: browserResult.status.available,
      setCurrent: (record, testCase) => { current = record; currentCase = testCase; } };
    for (const testCase of buildCases(config.origin ?? 'https://fixture.invalid')) {
      for (let i = 0; i < config.warmup + config.count; i++) {
        signal.throwIfAborted(); if (budget.sent >= budget.maxAttempts) throw Object.assign(new Error('模型请求预算耗尽'), { code: 'EVAL_BUDGET' });
        const record = await runAgent(context, testCase, i + 1, i < config.warmup); await save(record);
      }
    }
    await reliabilityTests(save, signal);
    if (config.stabilitySeconds) report.stability = await stabilityTest(base, token, config.stabilitySeconds, signal);
    signal.throwIfAborted();
    report.notes.push('浏览器本地模式使用真实 Edge 与内存固定素材，不验证公网 DNS/TLS 性能；公网测试需自有 origin。',
      '独立 Gateway、模拟服务和客户端同处本评测进程；首段分别记录服务器发出与 HTTP SSE 收到，不等于 UI 绘制或最终答案时间。',
      '严格 JSON 合同验收；格式不符也算本合同失败，不宣称开放式问答质量。预热、跳过、失败分别保留；浏览器首次启动等冷路径可能进入 smoke 或零预热样本，不能称为热路径基准。',
      '接口为闭环固定并发；Agent 串行；接口吞吐不能解释为 Agent 并发容量。每百万 Token 配置价格估算不等于实际账单。');
  } catch (error) { report.fatalError = error.code || error.message; console.error(`评测停止：${report.fatalError}`); }
  finally {
    clearTimeout(timeout); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    report.cleanupErrors = [];
    for (const close of closers.reverse()) { try { await close(); } catch (error) { report.cleanupErrors.push(error.code || error.name); } }
    report.resources = endResources(); report.endTime = new Date().toISOString(); report.modelAttempts = budget.sent;
    report.notes.push('测试工作区保留在本批次目录便于复核；未删除任何已有文件。进程只关闭本次创建的 HTTP 服务与浏览器。',
      '报告首段输出表使用客户端收到 SSE 的时间；服务器发出时间单独保存。缺失首段输出不按 0ms 统计。资源不含浏览器及 WSL 子进程。');
    report.summary = aggregate(report.records);
    report.result = report.fatalError || report.cleanupErrors.length || report.records.some(record => record.verdict === 'failed') || report.api.some(batch => batch.errorCount || !batch.complete) || report.stability?.samples.some(sample => !sample.ok) ? 'failed' : report.records.some(record => !record.warmup && record.verdict === 'skipped') ? 'partial' : 'passed';
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify(report, null, 2));
    await writeFile(path.join(directory, 'report.md'), markdown(report));
    console.log(`评测结果：${report.result}\n报告：${path.join(directory, 'report.md')}`);
  }
  return { report, directory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const { report } = await evaluate(parseConfig(process.argv.slice(2))); process.exitCode = report.result === 'failed' ? 1 : 0; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
