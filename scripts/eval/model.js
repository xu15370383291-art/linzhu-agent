import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createQueryRequest } from '../../backend/query-engine.js';
import { normalizeUsage } from '../../backend/usage/schema.js';

export function modelObserver({ getRecord, budget, signal, fetchImpl = fetch }) {
  return (item, settings = {}) => {
    const request = createQueryRequest(item, { ...settings, fetchImpl: async (url, init) => {
      if (signal.aborted) throw signal.reason;
      if (budget.sent >= budget.maxAttempts) throw Object.assign(new Error('模型 HTTP 尝试数预算耗尽'), { code: 'EVAL_BUDGET' });
      budget.sent++;
      const record = getRecord(); const attempt = { id: randomUUID(), attempt: budget.sent, status: null };
      record?.modelAttempts.push(attempt); const start = performance.now();
      try { const response = await fetchImpl(url, init); attempt.status = response.status; return response; }
      catch (error) { attempt.errorCode = error.code || error.name; throw error; }
      finally { attempt.headersMs = performance.now() - start; }
    } });
    return async (messages, tools, options = {}) => {
      const record = getRecord(); const call = { id: randomUUID(), durationMs: null, status: 'running', usage: null, firstContentMs: null };
      record?.modelCalls.push(call); const start = performance.now();
      try {
        const response = await request(messages, tools, { ...options, signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]),
          ...(options.onDelta ? { onDelta: text => { if (text && call.firstContentMs === null) call.firstContentMs = performance.now() - start; options.onDelta(text); } } : {}) });
        const usage = normalizeUsage(response.usage);
        call.usage = usage && [usage.inputTokens, usage.outputTokens, usage.totalTokens].some(value => value !== null) ? usage : null;
        call.status = 'success'; return response;
      } catch (error) { call.status = 'failed'; call.errorCode = error.code || error.name; throw error; }
      finally { call.durationMs = performance.now() - start; }
    };
  };
}

export function usageSummary(record, prices, synthetic = false) {
  const complete = record.modelCalls.length > 0 && record.modelCalls.every(call => call.status === 'success' && call.usage?.inputTokens !== null &&
    call.usage?.inputTokens !== undefined && call.usage?.outputTokens !== null && call.usage?.outputTokens !== undefined) &&
    record.modelAttempts.length === record.modelCalls.length && record.modelAttempts.every(attempt => attempt.status === 200);
  const reportedInput = record.modelCalls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0);
  const reportedOutput = record.modelCalls.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0);
  const cachedKnown = record.modelCalls.every(call => call.usage?.cachedInputTokens !== undefined);
  const cached = record.modelCalls.reduce((sum, call) => sum + (call.usage?.cachedInputTokens ?? 0), 0);
  const priced = complete && !synthetic && prices && (prices.cached === prices.input || cachedKnown);
  return { source: synthetic ? 'synthetic-fixture' : 'provider-reported', complete, reportedInput, reportedOutput,
    totalInput: complete ? reportedInput : null, totalOutput: complete ? reportedOutput : null,
    estimatedCost: priced ? ((reportedInput - cached) * prices.input + cached * prices.cached + reportedOutput * prices.output) / 1_000_000 : null,
    currency: prices?.currency ?? null, costSource: priced ? 'configured-unit-price-estimate-not-bill' : 'unavailable' };
}

export async function startMockModel(getCase) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); const testCase = getCase();
      const last = body.messages.at(-1);
      let message;
      if (body.messages[0]?.content?.includes('任务路由分类器')) message = { role: 'assistant', content: 'DIRECT' };
      else if (testCase.evidenceTool && last?.role !== 'tool') {
        const name = testCase.evidenceTool;
        const args = testCase.url ? { url: testCase.url, ...(testCase.targetUrl ? { targetUrl: testCase.targetUrl } : {}) }
          : { path: testCase.path, ...(testCase.range ? { startLine: 10, lineCount: 6 } : {}), ...(name === 'search_text' ? { query: 'BENCH_MARKER_7319' } : {}) };
        message = { role: 'assistant', content: null, tool_calls: [{ id: `call-${randomUUID()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      } else message = { role: 'assistant', content: JSON.stringify(testCase.expected ?? {}) };
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }], usage })); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) } : { content: message.content };
      res.end(`data: ${JSON.stringify({ choices: [{ delta }], usage })}\n\ndata: [DONE]\n\n`);
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { item: { model: 'deterministic-fixture', provider: 'openai-compatible', auth: 'none', streaming: true,
    url: `http://127.0.0.1:${server.address().port}/v1`, outputReserve: 1024 },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
