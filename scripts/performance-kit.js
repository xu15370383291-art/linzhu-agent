import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';

export const cases = Object.freeze({
  qa: '只回答一个数字，不调用工具：17 加 25 等于多少？',
  read: '读取工作区 test/fixtures/performance/project.md，只返回项目名称、版本号、负责人、订单编号和退款金额。',
  range: '读取工作区 test/fixtures/performance/project.md 的第 10 到第 15 行，逐行给出行号和原文。',
  search: '在工作区 test/fixtures/performance 目录内搜索 BENCH_MARKER_7319，列出匹配文件的相对路径和行号。',
  missing: '读取工作区 test/fixtures/performance/does-not-exist.txt；文件不存在时明确说明，不得猜测内容。',
  meeting: '读取工作区 test/fixtures/performance/meeting.md，整理三个人的行动项及截止日期，并说明本次会议明确不做的功能。',
});

export function summarize(samples) {
  const values = samples.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  return { n: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    min: values[0] ?? null, p50: percentile(0.5), p95: percentile(0.95),
    p99: values.length >= 1000 ? percentile(0.99) : null, max: values.at(-1) ?? null };
}

export function parseEventBlocks(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop(); const events = [];
  for (const block of blocks) {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) events.push(JSON.parse(data));
  }
  return { events, rest };
}

export function taskMetrics(events) {
  const start = events.find(event => event.type === 'turn.started');
  const terminal = events.find(event => ['turn.completed', 'turn.failed'].includes(event.type));
  const end = terminal?.at ?? null;
  const first = events.find(event => event.type === 'turn.delta');
  let waiting = null; let approvalMs = 0;
  for (const event of events) {
    if (event.type === 'turn.awaiting_approval' && waiting === null) waiting = event.at;
    if (event.type === 'approval.resolved' && waiting !== null) { approvalMs += event.at - waiting; waiting = null; }
  }
  if (waiting !== null && end !== null) approvalMs += end - waiting;
  const total = start && end !== null ? end - start.at : null;
  return { observedStart: Boolean(start), terminalObserved: Boolean(terminal),
    firstOutputFromStartedMs: start && first ? first.at - start.at : null,
    fromStartedToTerminalMs: total, approvalWaitMs: approvalMs,
    excludingApprovalMs: total === null ? null : total - approvalMs,
    status: terminal?.payload?.status ?? terminal?.payload?.errorCode ?? 'incomplete',
    toolAttempts: events.filter(event => event.type === 'tool.started').length,
    successfulToolCalls: events.filter(event => event.type === 'tool.finished' && event.payload.ok === true).length,
    failedToolCalls: events.filter(event => event.type === 'tool.finished' && event.payload.ok === false && event.payload.errorCode !== 'APPROVAL_REQUIRED').length,
    taskSuccess: null, tokenUsage: null, cost: null };
}

export function toolDuration(step) {
  const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  const start = timestamp(step.startedAt); const end = timestamp(step.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function recordSummary(records) {
  const completed = records.filter(record => record.snapshot?.status === 'completed' && record.terminalObserved);
  const tools = new Map();
  for (const record of records) {
    for (const step of record.snapshot?.tools ?? []) {
      if (step.status !== 'completed' || !Number.isFinite(step.durationMs)) continue;
      if (!tools.has(step.tool)) tools.set(step.tool, []);
      tools.get(step.tool).push(step.durationMs);
    }
  }
  return { completedCount: completed.length, completedFromStartedMs: summarize(completed.map(record => record.fromStartedToTerminalMs)),
    completedFirstOutputFromStartedMs: summarize(completed.map(record => record.firstOutputFromStartedMs)),
    completedExcludingApprovalMs: summarize(completed.map(record => record.excludingApprovalMs)),
    successfulToolDurationMs: Object.fromEntries([...tools].map(([name, durations]) => [name, summarize(durations)])) };
}

function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数格式：--名称 值');
    result[args[i].slice(2)] = args[i + 1];
  }
  return result;
}

function bounded(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`数值必须在 ${min}-${max} 之间`);
  return n;
}

function connection(base, token) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('只允许本机 http://127.0.0.1:<端口>，不能压测第三方地址');
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return { base: url.origin, headers };
}

async function jsonRequest(client, pathname, data, signal) {
  const response = await fetch(client.base + pathname, { headers: { ...client.headers, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    method: data ? 'POST' : 'GET', ...(data ? { body: JSON.stringify(data) } : {}), signal });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { code: body.code, body });
  return body;
}

export async function listen(client, onEvent, { signal } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const readyTimeout = setTimeout(() => controller.abort(new Error('事件流订阅超时')), 10000);
  let response;
  try { response = await fetch(client.base + '/api/events', { headers: client.headers, signal: controller.signal }); }
  catch (error) { clearTimeout(readyTimeout); signal?.removeEventListener('abort', cancel); throw error; }
  if (!response.ok) { clearTimeout(readyTimeout); signal?.removeEventListener('abort', cancel); controller.abort(); throw new Error(`事件流 HTTP ${response.status}`); }
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  // The first connected comment confirms subscription before a task is submitted.
  let first;
  try { first = await reader.read(); }
  catch (error) { clearTimeout(readyTimeout); signal?.removeEventListener('abort', cancel); controller.abort(); throw error; }
  clearTimeout(readyTimeout);
  if (first.done) { signal?.removeEventListener('abort', cancel); controller.abort(); throw new Error('事件流意外结束'); }
  let streamError = null;
  const pending = (async () => {
    let buffer = decoder.decode(first.value, { stream: true });
    while (true) {
      const parsed = parseEventBlocks(buffer); buffer = parsed.rest;
      for (const event of parsed.events) onEvent(event, performance.now());
      const part = await reader.read();
      if (part.done) { if (!controller.signal.aborted) throw new Error('事件流在采集完成前断开，当前批次不完整'); break; }
      buffer += decoder.decode(part.value, { stream: true });
    }
  })().catch(error => { if (!controller.signal.aborted) streamError = error; });
  return async () => { controller.abort(); signal?.removeEventListener('abort', cancel); await pending; if (streamError) throw streamError; };
}

function safeEvent(event, at) {
  const payload = event.payload ?? {};
  return { type: event.type, at, serverTime: event.time,
    payload: { turnId: payload.turnId ?? payload.approval?.metadata?.turnId, sessionId: payload.sessionId,
      status: payload.status, name: payload.name, ok: payload.ok, errorCode: payload.errorCode } };
}

async function taskSnapshot(client, turnId) {
  const turn = await jsonRequest(client, `/api/turns/${encodeURIComponent(turnId)}`, null, AbortSignal.timeout(10000));
  return { status: turn.status, errorCode: turn.errorCode,
    tools: (turn.plan?.steps ?? []).filter(step => step.tool).map(step => ({ tool: step.tool, status: step.status,
      errorCode: step.errorCode, durationMs: toolDuration(step) })) };
}

async function apiBench(client, opts) {
  const endpoint = opts.endpoint ?? '/api/tools';
  if (!['/api/tools', '/api/health'].includes(endpoint)) throw new Error('接口基线只允许 /api/tools 或 /api/health');
  const count = bounded(opts.count, 100, 1, 1000); const concurrency = bounded(opts.concurrency, 1, 1, 16);
  for (let i = 0; i < 5; i++) await jsonRequest(client, endpoint, null, AbortSignal.timeout(10000));
  const samples = []; let cursor = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < count) {
      const index = cursor++; const start = performance.now();
      try { await jsonRequest(client, endpoint, null, AbortSignal.timeout(10000)); samples.push({ index, ok: true, ms: performance.now() - start }); }
      catch (error) { samples.push({ index, ok: false, ms: performance.now() - start, error: error.code || error.name }); }
    }
  }));
  const elapsedMs = performance.now() - started; const successes = samples.filter(sample => sample.ok);
  return { kind: 'api-baseline', endpoint, count, concurrency, warmups: 5, elapsedMs,
    successCount: successes.length, errorCount: count - successes.length,
    successfulRequestsPerSecond: successes.length / (elapsedMs / 1000), successfulLatencyMs: summarize(successes.map(sample => sample.ms)), samples };
}

async function runCase(client, opts) {
  if (!Object.hasOwn(cases, opts.case ?? 'qa')) throw new Error(`可选题目：${Object.keys(cases).join(', ')}`);
  const caseId = opts.case ?? 'qa'; const count = bounded(opts.count, 1, 1, 30);
  const records = [];
  for (let i = 0; i < count; i++) {
    const session = await jsonRequest(client, '/api/sessions', {}, AbortSignal.timeout(10000));
    const turnId = `perf-${randomUUID()}`; const events = [];
    const stop = await listen(client, (event, at) => {
      if ((event.payload?.turnId ?? event.payload?.approval?.metadata?.turnId) === turnId) events.push(safeEvent(event, at));
    });
    const started = performance.now(); let error = null;
    try { await jsonRequest(client, '/api/turns', { sessionId: session.id, turnId, input: cases[caseId] }, AbortSignal.timeout(180000)); }
    catch (caught) {
      error = caught.code || caught.name;
      if (caught.name === 'TimeoutError') await jsonRequest(client, `/api/turns/${turnId}/cancel`, {}, AbortSignal.timeout(10000)).catch(() => {});
    }
    const clientElapsedMs = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 50)); await stop();
    const metrics = taskMetrics(events); const snapshot = await taskSnapshot(client, turnId).catch(() => null);
    const first = events.find(event => event.type === 'turn.delta');
    records.push({ caseId, iteration: i + 1, sessionId: session.id, turnId, clientElapsedMs, events,
      firstOutputFromSubmitMs: first ? first.at - started : null, error, ...metrics, snapshot });
    console.log(`样本 ${i + 1}/${count}: ${snapshot?.status ?? metrics.status}, ${clientElapsedMs.toFixed(1)} ms；任务正确性待人工验收`);
    if (snapshot && ['awaiting_approval', 'awaiting_clarification', 'running', 'cancelling'].includes(snapshot.status)) {
      console.log('遇到审批、澄清或仍在执行的任务，停止批量测试；请在当前客户端身份下核实并处理，不自动批准。'); break;
    }
  }
  return { kind: 'real-agent', caseId, count: records.length, records,
    ...recordSummary(records),
    completedLatencyMs: summarize(records.filter(record => record.snapshot?.status === 'completed').map(record => record.clientElapsedMs)),
    completedFirstOutputFromSubmitMs: summarize(records.filter(record => record.snapshot?.status === 'completed').map(record => record.firstOutputFromSubmitMs)),
    taskSuccessRate: null, tokenUsage: null, note: 'completed 不代表任务正确；真实模型可能产生费用；每个样本使用独立新会话；不自动审批' };
}

async function observe(client, opts) {
  const seconds = bounded(opts.seconds, 300, 5, 3600); const groups = new Map();
  const stop = await listen(client, (event, at) => {
    const safe = safeEvent(event, at); const id = safe.payload.turnId;
    if (!id) return;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(safe);
  });
  console.log(`采集已开始。请在 Workbench 新建测试会话并发送题目；将在 ${seconds} 秒后结束。`);
  await new Promise(resolve => setTimeout(resolve, seconds * 1000)); await stop();
  const records = [];
  for (const [turnId, events] of groups) records.push({ turnId, events, ...taskMetrics(events),
    snapshot: await taskSnapshot(client, turnId).catch(() => null) });
  return { kind: 'workbench-observer', seconds, records, ...recordSummary(records),
    note: '从收到 turn.started 起计时，不包含点击发送至 started 的时间；不等于浏览器实际绘制耗时；正确性、Token 和成本待独立验收' };
}

async function main() {
  const mode = process.argv[2]; const opts = options(process.argv.slice(3));
  if (!['api', 'run', 'observe'].includes(mode)) throw new Error('用法：node scripts/performance-kit.js api|run|observe [--名称 值]');
  const client = connection(opts.base ?? 'http://127.0.0.1:59160', process.env.AGENT_GATEWAY_TOKEN);
  const execute = { api: apiBench, run: runCase, observe }[mode];
  const startTime = new Date().toISOString();
  const result = await execute(client, opts);
  const report = { startTime, endTime: new Date().toISOString(), base: client.base,
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() }, ...result };
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../artifacts/performance');
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, `${mode}-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(output, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
  console.log(`数据已保存：${output}`);
  if (report.successfulLatencyMs) console.log(JSON.stringify(report.successfulLatencyMs, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
