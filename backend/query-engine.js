import { endpointFor, reasoningProfile } from './models.js';
import { cacheEligible, cacheKey } from './cache/store.js';

const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

export class QueryError extends Error {
  constructor(code, message, { status = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'QueryError';
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
  }
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason ?? new QueryError('CANCELLED', 'Request cancelled'));
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', cancel); resolve(); }
  function cancel() { clearTimeout(timer); reject(signal.reason ?? new QueryError('CANCELLED', 'Request cancelled')); }
  signal?.addEventListener('abort', cancel, { once: true });
});

function retryDelay(response, attempt) {
  const value = response?.headers?.get('retry-after');
  const seconds = Number(value);
  const date = Date.parse(value);
  if (value && (Number.isFinite(seconds) || Number.isFinite(date))) {
    return Math.max(0, Math.min(5000, Number.isFinite(seconds) ? seconds * 1000 : date - Date.now()));
  }
  return Math.min(2000, 300 * 2 ** attempt);
}

function classifyStatus(status, text, apiKey) {
  const detail = text.slice(0, 300).split(apiKey).join('[redacted]').replace(/Bearer\s+\S+|sk-[\w-]+/gi, '[redacted]');
  const code = status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status >= 500 ? 'SERVER' :
    /context.{0,30}(length|window|limit|exceed|large)|too many tokens/i.test(detail) ? 'CONTEXT_OVERFLOW' : 'REQUEST';
  return new QueryError(code, `模型接口返回 HTTP ${status}：${detail}`, { status });
}

function assemble(events) {
  const calls = new Map();
  let content = '';
  let usage;
  for (const event of events) {
    if (event.usage) usage = event.usage;
    const delta = event.choices?.[0]?.delta;
    if (!delta) continue;
    if (typeof delta.content === 'string') content += delta.content;
    for (const item of delta.tool_calls ?? []) {
      if (!Number.isInteger(item.index)) throw new QueryError('INVALID_RESPONSE', 'Tool call is missing its index');
      const call = calls.get(item.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (item.id) call.id += item.id;
      if (item.function?.name) call.function.name += item.function.name;
      if (item.function?.arguments) call.function.arguments += item.function.arguments;
      calls.set(item.index, call);
    }
  }
  if (!events.length) throw new QueryError('INVALID_RESPONSE', 'Empty model stream');
  const tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (tool_calls.some(call => !call.id || !call.function.name)) throw new QueryError('INVALID_RESPONSE', 'Incomplete tool call');
  if (!content && !tool_calls.length) throw new QueryError('INVALID_RESPONSE', 'Model stream has no answer or tool call');
  return { choices: [{ message: { role: 'assistant', content: content || null, ...(tool_calls.length ? { tool_calls } : {}) } }], ...(usage ? { usage } : {}) };
}

async function parseStream(response, onDelta, signal) {
  if (!response.body) throw new QueryError('INVALID_RESPONSE', 'Missing model stream');
  const contentType = response.headers.get('content-type');
  if (contentType && !/^text\/event-stream(?:\s*;|\s*$)/i.test(contentType)) {
    throw new QueryError('UNSUPPORTED_STREAM', 'Model returned a non-streaming response. Disable streaming for this connection in the model settings.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  let done = false;
  let pendingCR = false;
  let totalBytes = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!done) {
      if (signal?.aborted) throw signal.reason;
      const part = await reader.read();
      totalBytes += part.value?.byteLength ?? 0;
      if (totalBytes > MAX_STREAM_BYTES) throw new QueryError('INVALID_RESPONSE', 'Model stream is too large');
      let text = decoder.decode(part.value ?? new Uint8Array(), { stream: !part.done });
      if (pendingCR) { text = `\r${text}`; pendingCR = false; }
      if (text.endsWith('\r') && !part.done) { text = text.slice(0, -1); pendingCR = true; }
      buffer += text.replace(/\r\n?/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        if (boundary > MAX_EVENT_BYTES) throw new QueryError('INVALID_RESPONSE', 'Model stream event is too large');
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        if (data === '[DONE]') { done = true; break; }
        try { events.push(JSON.parse(data)); }
        catch { throw new QueryError('INVALID_RESPONSE', 'Malformed model stream event'); }
        const delta = events.at(-1).choices?.[0]?.delta?.content;
        if (typeof delta === 'string') onDelta?.(delta);
      }
      if (buffer.length > MAX_EVENT_BYTES) throw new QueryError('INVALID_RESPONSE', 'Model stream event is too large');
      if (part.done) break;
    }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  if (!done) throw new QueryError('INVALID_RESPONSE', 'Model stream ended before [DONE]');
  return assemble(events);
}

export function createQueryRequest(item, { fetchImpl = fetch, sleep = pause, cache } = {}) {
  if (!item) throw new QueryError('CONFIG', '尚未选择模型。请先运行 npm run models 配置');
  if (!item.apiKey && item.auth !== 'none' && item.provider !== 'ollama') throw new QueryError('CONFIG', '所选模型尚未配置 API Key');
  const url = endpointFor(item);
  return async (messages, tools, options = {}) => {
    const streaming = Boolean(options.onDelta && options.stream !== false && item.streaming !== false);
    const profile = reasoningProfile(item);
    // DeepSeek Thinking rejects tool_choice=required. Keep the agent-side
    // evidence enforcement, but let the provider choose a tool with auto.
    const providerToolChoice = profile.protocol === 'deepseek' && options.toolChoice === 'required'
      ? 'auto' : options.toolChoice;
    const eligible = cache && cacheEligible({ messages, tools, toolChoice: providerToolChoice, stream: streaming, realtime: options.realtime, cache: options.cache !== false });
    const key = eligible ? cacheKey({ endpoint: url, model: item.model, reasoningProtocol: profile.protocol, reasoningEffort: item.reasoningEffort, messages, tools, toolChoice: providerToolChoice, maxTokens: options.maxTokens }) : null;
    if (key) { const hit = await cache.get(key); if (hit) return hit; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new QueryError('TIMEOUT', 'Model request timed out')), 60_000);
    const cancel = () => controller.abort(new QueryError('CANCELLED', 'Model request cancelled'));
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (controller.signal.aborted) throw controller.signal.reason;
        let response;
        try {
          response = await fetchImpl(url, {
            method: 'POST', headers: { ...(item.apiKey ? { Authorization: `Bearer ${item.apiKey}` } : {}), 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: item.model, messages, ...(tools?.length ? { tools, tool_choice: providerToolChoice ?? 'auto' } : {}),
              ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
              ...(profile.protocol === 'openai' && item.reasoningEffort && !['auto', 'default', 'none', 'disabled'].includes(item.reasoningEffort) ? { reasoning_effort: item.reasoningEffort } : {}),
              ...(profile.protocol === 'deepseek' && item.reasoningEffort && !['auto', 'default', 'enabled', 'disabled'].includes(item.reasoningEffort) ? { reasoning_effort: item.reasoningEffort } : {}),
              ...(streaming ? { stream: true } : {}) }),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (attempt < 2) {
            const delay = retryDelay(null, attempt);
            options.onRetry?.({ attempt: attempt + 2, delay, code: 'NETWORK' });
            await sleep(delay, controller.signal);
            continue;
          }
          throw new QueryError('NETWORK', 'Model network request failed', { cause: error });
        }
        if (!response.ok) {
          const error = classifyStatus(response.status, await response.text(), item.apiKey);
          if ((error.code === 'RATE_LIMIT' || error.code === 'SERVER') && attempt < 2) {
            const delay = retryDelay(response, attempt);
            options.onRetry?.({ attempt: attempt + 2, delay, code: error.code });
            await sleep(delay, controller.signal);
            continue;
          }
          throw error;
        }
        if (streaming) {
          try { return await parseStream(response, options.onDelta, controller.signal); }
          catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
        }
        let result;
        try { result = await response.json(); }
        catch { if (controller.signal.aborted) throw controller.signal.reason; throw new QueryError('INVALID_RESPONSE', 'Invalid model JSON response'); }
        if (!result?.choices?.[0]?.message) throw new QueryError('INVALID_RESPONSE', 'Model response has no message');
        if (key && result?.choices?.[0]?.message && !result.choices[0].message.tool_calls) await cache.set(key, result);
        return result;
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
    }
  };
}
