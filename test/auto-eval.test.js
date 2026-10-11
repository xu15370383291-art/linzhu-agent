import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { parseConfig } from '../scripts/auto-eval.js';
import { buildCases, grade, validateCall } from '../scripts/eval/cases.js';
import { aggregate } from '../scripts/eval/report.js';
import { modelObserver, usageSummary } from '../scripts/eval/model.js';
import { classifyIntent } from '../backend/agent/intent.js';
import { runTurn } from '../backend/agent.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { WebTools } from '../backend/tools/web.js';

const findCase = id => buildCases().find(item => item.id === id);
const baseRecord = testCase => ({ status: 'completed', answer: JSON.stringify(testCase.expected), calls: [], evidence: [], failures: [], errorEvidence: [], approvals: [] });

test('config rejects paid runs without explicit opt-in and bounds repetitions, duration and request budget', () => {
  assert.throws(() => parseConfig(['real']), /allow-paid/);
  assert.equal(parseConfig(['real', '--allow-paid', '--count', '2']).count, 2);
  for (const args of [['local', '--count', '0'], ['local', '--count', '100'], ['local', '--count', '2', '--count', '3'], ['local', '--unknown', '1'], ['local', '--seconds', '0'], ['real', '--allow-paid', '--origin', 'http://127.0.0.1']]) assert.throws(() => parseConfig(args));
  assert.throws(() => parseConfig(['real', '--allow-paid', '--input-price', '1']), /价格/);
  assert.equal(parseConfig(['real', '--allow-paid', '--input-price', '1', '--output-price', '3']).prices.cached, 1);
  assert.throws(() => parseConfig(['local', '--stability-seconds', '600', '--seconds', '600']), /稳定性/);
});

test('fixed evaluation questions route to their intended read/network surface', () => {
  for (const id of ['read', 'range', 'missing', 'meeting']) assert.equal(classifyIntent(findCase(id).prompt).kind, 'workspace_read');
  assert.equal(classifyIntent(findCase('search').prompt).kind, 'workspace_search');
  assert.equal(classifyIntent(findCase('browser').prompt).kind, 'web_fetch');
});

test('strict grading cannot pass fabricated answers, incorrect ranges, unexpected tools or generic missing-file failures', () => {
  const qa = findCase('qa'); const record = baseRecord(qa);
  assert.equal(grade(qa, record).verdict, 'passed'); record.answer = '{"answer":41}'; assert.equal(grade(qa, record).verdict, 'failed');
  const read = findCase('read'); const fake = baseRecord(read); assert.equal(grade(read, fake).verdict, 'failed');
  fake.calls.push({ tool: 'read_file', args: { path: read.path } }); fake.evidence.push({ tool: 'read_file', args: { path: read.path }, result: 'content' });
  assert.equal(grade(read, fake).verdict, 'failed');
  fake.evidence[0].result = '星桥资料助手 2.3.1 林远 ORDER-7319 128 元';
  assert.equal(grade(read, fake).verdict, 'passed');
  fake.calls.push({ tool: 'write_file', args: { path: read.path, content: 'change' } }); assert.equal(grade(read, fake).verdict, 'failed');
  const range = findCase('range'); assert.equal(validateCall(range, 'read_file', { path: range.path, startLine: 9, lineCount: 6 }), false);
  const missing = findCase('missing'); const error = baseRecord(missing); error.failures.push({ tool: 'read_file', errorCode: 'TOOL_EXECUTION_ERROR' });
  assert.equal(grade(missing, error).verdict, 'failed'); error.errorEvidence.push({ tool: 'read_file', args: { path: missing.path }, message: 'ENOENT: no such file' });
  assert.equal(grade(missing, error).verdict, 'passed');
});

test('browser grading requires final source, dynamic output, follow evidence and explicit denial without success evidence', () => {
  const follow = findCase('follow'); const record = baseRecord(follow); const args = { url: follow.url, targetUrl: follow.targetUrl };
  record.calls.push({ tool: 'browser_open', args });
  record.evidence.push({ tool: 'browser_open', args, result: { source: follow.expected.source, text: follow.expected.marker + ' 库存 37 件', action: { url: follow.targetUrl } } });
  assert.equal(grade(follow, record).verdict, 'passed'); record.evidence[0].result.source = 'https://other.invalid';
  assert.equal(grade(follow, record).verdict, 'failed');
  const denied = { ...baseRecord(findCase('deny')), status: 'denied', approvals: [{ decision: 'denied' }] };
  assert.equal(grade(findCase('deny'), denied).verdict, 'passed'); denied.evidence.push({ tool: 'browser_open' });
  assert.equal(grade(findCase('deny'), denied).verdict, 'failed');
});

test('aggregation separates warmups, skips, failures and missing first output without inventing zeros', () => {
  const record = { suite: 'fixture', caseId: 'qa', warmup: false, status: 'completed', verdict: 'passed', elapsedMs: 10, firstDeliveredOutputMs: null };
  const [result] = aggregate([record, { ...record, verdict: 'failed', elapsedMs: 100 }, { ...record, verdict: 'skipped' }, { ...record, warmup: true, elapsedMs: 999 }]);
  assert.equal(result.evaluated, 2); assert.equal(result.skipped, 1); assert.equal(result.successRate, 0.5);
  assert.equal(result.passedLatencyMs.p50, 10); assert.equal(result.allObservedLatencyMs.p95, 100);
  assert.equal(result.passedFirstOutputMs.n, 0); assert.equal(result.passedFirstOutputMs.p50, null);
});

test('provider measurement counts retries, excludes missing usage and never labels estimates as bills', async () => {
  const record = { modelCalls: [], modelAttempts: [] }; const budget = { sent: 0, maxAttempts: 2 };
  const signal = new AbortController().signal; let n = 0;
  const factory = modelObserver({ getRecord: () => record, budget, signal, fetchImpl: async () => {
    n++; return n === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  } });
  await factory({ model: 'fixture', auth: 'none', url: 'http://127.0.0.1/v1' })([], []);
  assert.equal(budget.sent, 2); assert.equal(record.modelCalls.length, 1); assert.equal(record.modelAttempts.length, 2);
  const summary = usageSummary(record, { input: 1, output: 3, cached: 1, currency: 'USD' });
  assert.equal(summary.complete, false); assert.equal(summary.estimatedCost, null); assert.equal(summary.reportedInput, 100);
  const one = { modelCalls: [{ status: 'success', usage: { inputTokens: 100, outputTokens: 20 } }], modelAttempts: [{ status: 200 }] };
  assert.equal(usageSummary(one, { input: 1, output: 3, cached: 0.5 }).estimatedCost, null);
  assert.ok(Math.abs(usageSummary(one, { input: 1, output: 3, cached: 1 }).estimatedCost - 0.00016) < 1e-10);
  assert.equal(usageSummary(one, { input: 1, output: 3, cached: 1 }, true).estimatedCost, null);
  assert.equal(usageSummary({ modelCalls: [{ status: 'success', usage: null }], modelAttempts: [{ status: 200 }] }).complete, false);
});

test('model HTTP attempt cap is enforced even across query-engine retries', async () => {
  const record = { modelCalls: [], modelAttempts: [] }; const budget = { sent: 0, maxAttempts: 1 }; let externalCalls = 0;
  const request = modelObserver({ getRecord: () => record, budget, signal: new AbortController().signal, fetchImpl: async () => { externalCalls++; throw new Error('network'); } })({ model: 'fixture', auth: 'none', url: 'http://127.0.0.1/v1' });
  await assert.rejects(request([], [])); assert.equal(externalCalls, 1); assert.equal(budget.sent, 1);
});

test('successful browser tool is evidence and completes without an unnecessary second approval', async () => {
  const call = { id: 'browser-call', type: 'function', function: { name: 'browser_open', arguments: '{"url":"https://example.com/"}' } };
  let requests = 0; let tools = 0;
  const answer = await runTurn({ session: { id: 'fixture-session', messages: [] }, input: '读取网页 https://example.com/',
    policy: new PermissionPolicy({ networkReady: true, browserReady: true }),
    web: { openBrowser: async () => { tools++; return { text: 'verified page', source: 'https://example.com/' }; } },
    request: async () => { requests++; return { choices: [{ message: requests === 1 ? { role: 'assistant', tool_calls: [call] } : { role: 'assistant', content: 'verified page' } }] }; } });
  assert.equal(answer, 'verified page'); assert.equal(requests, 2); assert.equal(tools, 1);
});

test('real WebTools rejects local URLs with zero fixture network calls', async () => {
  let calls = 0;
  const web = new WebTools({ approve: async () => true, transport: async () => { calls++; throw new Error('must not connect'); } });
  await assert.rejects(web.execute('web_fetch', { url: 'http://127.0.0.1/private' })); assert.equal(calls, 0);
});

test('one-command smoke produces reproducible evidence, a raw record file and a scoped Chinese report', { timeout: 60000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/auto-eval.js', 'smoke', '--stability-seconds', '1'], { timeout: 55000, maxBuffer: 2 * 1024 * 1024 });
  const reportPath = stdout.match(/报告：([^\r\n]+)/)?.[1]; assert.ok(reportPath);
  const directory = reportPath.replace(/[\\/]report\.md$/, '');
  const report = JSON.parse(await readFile(directory + '/summary.json', 'utf8'));
  assert.ok(['passed', 'partial'].includes(report.result)); assert.equal(report.cleanupErrors.length, 0);
  assert.equal(report.records.filter(item => item.verdict === 'failed').length, 0);
  assert.equal(report.stability.complete, true); assert.ok(report.stability.samples.length > 0);
  assert.ok(report.records.some(item => item.caseId === 'read' && item.verdict === 'passed'));
  assert.ok(report.records.some(item => item.caseId === 'cancel-turn' && item.verdict === 'passed'));
  assert.equal(new Set(report.records.filter(item => item.sessionId).map(item => item.sessionId)).size, report.records.filter(item => item.sessionId).length);
  assert.ok(report.modelAttempts > 0); assert.ok(report.notes.some(note => note.includes('不含')));
  const raw = await readFile(directory + '/samples.jsonl', 'utf8'); assert.equal(raw.trim().split('\n').length, report.records.length);
  const markdown = await readFile(reportPath, 'utf8'); assert.ok(markdown.includes('自动评测报告'));
  assert.equal(raw.includes('apiKey'), false); assert.equal(JSON.stringify(report).includes('Bearer'), false);
  assert.ok(report.codeHashes['backend/agent.js']);
});

test('exhausted model budget exits with failure while preserving partial data and explicit incomplete report', { timeout: 60000 }, async () => {
  let result;
  try { await promisify(execFile)(process.execPath, ['scripts/auto-eval.js', 'smoke', '--max-attempts', '1'], { timeout: 55000 }); }
  catch (error) { result = error; }
  assert.equal(result?.code, 1);
  const reportPath = result.stdout.match(/报告：([^\r\n]+)/)?.[1]; assert.ok(reportPath);
  const report = JSON.parse(await readFile(reportPath.replace(/report\.md$/, 'summary.json'), 'utf8'));
  assert.equal(report.result, 'failed'); assert.equal(report.fatalError, 'EVAL_BUDGET'); assert.equal(report.modelAttempts, 1);
  assert.ok(report.records.length > 0); assert.equal(report.cleanupErrors.length, 0);
  assert.ok((await readFile(reportPath, 'utf8')).includes('批次未完整执行：EVAL_BUDGET'));
});
