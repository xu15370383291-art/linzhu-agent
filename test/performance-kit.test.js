import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import { summarize, parseEventBlocks, taskMetrics, toolDuration, cases } from '../scripts/performance-kit.js';

test('performance summary uses nearest-rank percentiles and does not claim small-sample P99', () => {
  assert.deepEqual(summarize([]), { n: 0, mean: null, min: null, p50: null, p95: null, p99: null, max: null });
  const result = summarize([1, 5, NaN, 3, 2, 4]);
  assert.equal(result.mean, 3); assert.equal(result.p50, 3); assert.equal(result.p95, 5); assert.equal(result.p99, null);
  assert.equal(summarize(Array.from({ length: 1000 }, (_, i) => i + 1)).p99, 990);
});

test('SSE parser handles comments, CRLF and fragmented data', () => {
  const first = parseEventBlocks(': connected\r\n\r\ndata: {"type":"turn.');
  assert.equal(first.events.length, 0);
  const next = parseEventBlocks(first.rest + 'started"}\r\n\r\n');
  assert.deepEqual(next.events, [{ type: 'turn.started' }]); assert.equal(next.rest, '');
});

test('task metrics separate approvals and failures from successful execution', () => {
  const e = (type, at, payload = {}) => ({ type, at, payload });
  const result = taskMetrics([e('turn.started', 100), e('tool.started', 120),
    e('tool.finished', 140, { ok: false, errorCode: 'APPROVAL_REQUIRED' }),
    e('turn.awaiting_approval', 150), e('approval.resolved', 450),
    e('turn.started', 470), e('tool.started', 480), e('tool.finished', 500, { ok: true }),
    e('turn.delta', 520), e('turn.completed', 600, { status: 'completed' })]);
  assert.equal(result.fromStartedToTerminalMs, 500); assert.equal(result.approvalWaitMs, 300);
  assert.equal(result.excludingApprovalMs, 200); assert.equal(result.firstOutputFromStartedMs, 420);
  assert.equal(result.failedToolCalls, 0); assert.equal(result.successfulToolCalls, 1);
  assert.equal(result.taskSuccess, null); assert.equal(result.tokenUsage, null);
  assert.equal(taskMetrics([]).fromStartedToTerminalMs, null);
});

test('fixed question fixtures contain known ground truth and accurate line ranges', async () => {
  const text = await readFile(new URL('../test/fixtures/performance/project.md', import.meta.url), 'utf8');
  const lines = text.split('\n');
  assert.equal(lines[9], '版本号：2.3.1'); assert.equal(lines[14], '问题状态：已解决');
  assert.ok(cases.search.includes('BENCH_MARKER_7319')); assert.ok(text.includes('BENCH_MARKER_7319'));
});

test('tool duration supports actual Gateway millisecond timestamps and missing measurements', () => {
  assert.equal(toolDuration({ startedAt: 1000, finishedAt: 1055 }), 55);
  assert.equal(toolDuration({ startedAt: '2026-10-11T00:00:00Z', finishedAt: '2026-10-11T00:00:01Z' }), 1000);
  assert.equal(toolDuration({ startedAt: 1000 }), null);
  assert.equal(toolDuration({ startedAt: 1000, finishedAt: 500 }), null);
});

test('API collector measures bounded local GET requests and exports real sample counts', async t => {
  let count = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/api/tools'); count++;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ items: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/performance-kit.js', 'api', '--base',
    `http://127.0.0.1:${server.address().port}`, '--count', '6', '--concurrency', '2'], { timeout: 15000 });
  const output = stdout.match(/数据已保存：([^\r\n]+)/)?.[1]; assert.ok(output);
  t.after(() => rm(output, { force: true }));
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(count, 11); assert.equal(report.successCount, 6); assert.equal(report.samples.length, 6);
  assert.equal(report.successfulLatencyMs.n, 6); assert.equal(report.successfulLatencyMs.p99, null);
});

test('collector rejects external endpoints before making a request', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/performance-kit.js', 'api', '--base', 'https://example.com']),
    error => error.stderr.includes('只允许本机'));
});

test('real-task collector subscribes before submit, separates new sessions and leaves correctness ungraded', async t => {
  const clients = new Set(); const turns = new Map(); const sessions = []; let sequence = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/events') {
      res.setHeader('Content-Type', 'text/event-stream'); res.write(': connected\n\n'); clients.add(res);
      res.on('close', () => clients.delete(res)); return;
    }
    if (req.url === '/api/sessions') { const id = `session-${++sequence}`; sessions.push(id); res.end(JSON.stringify({ id })); return; }
    if (req.url === '/api/turns') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks)); assert.equal(input.input, cases.qa); assert.equal(clients.size, 1);
      const emit = (type, payload) => { for (const client of clients) client.write(`data: ${JSON.stringify({ type, payload: { turnId: input.turnId, sessionId: input.sessionId, ...payload } })}\n\n`); };
      emit('turn.started', {}); emit('turn.delta', { text: '42' }); emit('turn.completed', { status: 'completed' });
      turns.set(input.turnId, { status: 'completed', plan: { steps: [{ tool: 'fake_tool', status: 'completed', startedAt: 1000, finishedAt: 1020 }] } }); res.end(JSON.stringify({ answer: '42', ...input })); return;
    }
    const id = req.url.split('/').at(-1); res.end(JSON.stringify(turns.get(id)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/performance-kit.js', 'run', '--base',
    `http://127.0.0.1:${server.address().port}`, '--case', 'qa', '--count', '2'], { timeout: 15000 });
  const output = stdout.match(/数据已保存：([^\r\n]+)/)?.[1]; assert.ok(output); t.after(() => rm(output, { force: true }));
  const report = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(new Set(sessions).size, 2); assert.equal(report.records.length, 2);
  assert.equal(report.successfulToolDurationMs.fake_tool.p50, 20);
  for (const record of report.records) {
    assert.equal(record.status, 'completed'); assert.equal(record.observedStart, true);
    assert.equal(record.terminalObserved, true); assert.ok(record.firstOutputFromSubmitMs >= 0);
    assert.equal(record.taskSuccess, null); assert.equal(record.tokenUsage, null);
  }
});

test('Workbench observer collects approval timing without submitting or approving a task', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    if (req.url === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n');
      const emit = (type, payload = {}) => res.write(`data: ${JSON.stringify({ type, payload: { turnId: 'manual-test', ...payload } })}\n\n`);
      emit('turn.started'); emit('turn.awaiting_approval');
      const timer = setTimeout(() => { emit('approval.resolved'); emit('turn.delta', { text: '不写入报告的正文' }); emit('turn.completed', { status: 'completed' }); }, 80);
      res.on('close', () => clearTimeout(timer)); return;
    }
    assert.equal(req.url, '/api/turns/manual-test');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'completed', plan: { steps: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/performance-kit.js', 'observe', '--base',
    `http://127.0.0.1:${server.address().port}`, '--seconds', '5'], { timeout: 15000 });
  const output = stdout.match(/数据已保存：([^\r\n]+)/)?.[1]; assert.ok(output); t.after(() => rm(output, { force: true }));
  const raw = await readFile(output, 'utf8'); const report = JSON.parse(raw);
  assert.equal(report.records.length, 1); assert.equal(report.completedCount, 1);
  assert.ok(report.records[0].approvalWaitMs >= 0); assert.equal(raw.includes('不写入报告的正文'), false);
});
