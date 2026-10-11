import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueryRequest } from '../backend/query-engine.js';
import { runTurn } from '../backend/agent.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';

const item = { apiKey: 'secret', url: 'https://example.com/v1', model: 'example', streaming: true };
const messages = [{ role: 'user', content: 'hello' }];
const ok = { choices: [{ message: { role: 'assistant', content: 'OK' } }] };
const response = (status, body, headers = {}) => new Response(body, { status, headers });
const sse = body => response(200, body, { 'content-type': 'text/event-stream' });
const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;

test('ordinary JSON request preserves tool choice, usage and response', async () => {
  const request = createQueryRequest(item, { fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.tool_choice, 'required');
    assert.equal(body.max_tokens, 100);
    assert.equal(body.stream, undefined);
    return Response.json(ok);
  } });
  assert.deepEqual(await request(messages, [{ type: 'function', function: { name: 'test', parameters: { type: 'object' } } }], { toolChoice: 'required', maxTokens: 100 }), ok);
});

test('DeepSeek Thinking downgrades required tool choice for provider compatibility', async () => {
  const request = createQueryRequest({ ...item, model: 'deepseek-flash', reasoningEffort: 'high' }, {
    fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.tool_choice, 'auto');
      assert.equal(body.reasoning_effort, 'high');
      return Response.json(ok);
    },
  });
  await request(messages, [{ type: 'function', function: { name: 'test', parameters: { type: 'object' } } }], { toolChoice: 'required' });
});

test('reasoning intensity is sent only when explicitly enabled', async () => {
  for (const [reasoningEffort, expected] of [['high', 'high'], ['none', undefined], [undefined, undefined]]) {
    const request = createQueryRequest({ ...item, model: 'gpt-6', reasoningProtocol: 'openai', reasoningEffort }, { fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.reasoning_effort, expected);
      return Response.json(ok);
    } });
    await request(messages, []);
  }
});

test('DeepSeek thinking levels use the documented reasoning_effort values', async () => {
  for (const [reasoningEffort, expected] of [['none', 'none'], ['low', 'low'], ['high', 'high'], ['max', 'max'], ['default', undefined]]) {
    const request = createQueryRequest({ ...item, model: 'deepseek-v4-pro', reasoningEffort }, { fetchImpl: async (_, init) => {
      assert.equal(JSON.parse(init.body).reasoning_effort, expected);
      return Response.json(ok);
    } });
    await request(messages, []);
  }
});

test('chat without tools omits tool_choice in JSON and streaming requests', async () => {
  for (const streaming of [false, true]) {
    const request = createQueryRequest(item, { fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      assert.equal(Object.hasOwn(body, 'tools'), false);
      assert.equal(Object.hasOwn(body, 'tool_choice'), false);
      return streaming ? sse(event({ choices: [{ delta: { content: 'OK' } }] }) + 'data: [DONE]\n\n') : Response.json(ok);
    } });
    assert.equal((await request(messages, [], { toolChoice: 'none', ...(streaming ? { onDelta: () => {} } : {}) })).choices[0].message.content, 'OK');
  }
});

test('stream reassembles split UTF-8 events and fragmented tool calls', async () => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(event({ choices: [{ delta: { content: '你好' } }] }) +
    event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_', arguments: '{"path":' } }] } }] }) +
    event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '"a.txt"}' } }] } }] }) + 'data: [DONE]\r\n\r\n');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const deltas = [];
  const request = createQueryRequest(item, { fetchImpl: async (_, init) => {
    assert.equal(JSON.parse(init.body).stream, true);
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const result = await request(messages, [], { onDelta: text => deltas.push(text) });
  assert.deepEqual(deltas, ['你好']);
  assert.equal(result.choices[0].message.content, '你好');
  assert.deepEqual(result.choices[0].message.tool_calls[0], { id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } });
});

test('rate limit follows Retry-After while auth failures do not retry', async () => {
  let attempts = 0;
  const waits = [];
  const retries = [];
  const request = createQueryRequest(item, { fetchImpl: async () => ++attempts === 1 ? response(429, 'slow', { 'Retry-After': '1' }) : Response.json(ok), sleep: async ms => waits.push(ms) });
  assert.deepEqual(await request(messages, [], { onRetry: event => retries.push(event) }), ok);
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(retries, [{ attempt: 2, delay: 1000, code: 'RATE_LIMIT' }]);
  const denied = createQueryRequest(item, { fetchImpl: async () => { attempts++; return response(401, 'bad key'); } });
  await assert.rejects(denied(messages, []), { code: 'AUTH' });
  assert.equal(attempts, 3);
});

test('broken stream reports error without retry or committing an answer', async () => {
  let attempts = 0;
  const request = createQueryRequest(item, { fetchImpl: async () => { attempts++; return sse(event({ choices: [{ delta: { content: 'partial' } }] })); } });
  const chunks = [];
  await assert.rejects(request(messages, [], { onDelta: chunk => chunks.push(chunk) }), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(chunks, ['partial']);
  assert.equal(attempts, 1);
});

test('cancellation interrupts retry wait and does not send another request', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const request = createQueryRequest(item, { fetchImpl: async () => { attempts++; return response(503, 'busy'); }, sleep: async () => { controller.abort(); } });
  await assert.rejects(request(messages, [], { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(attempts, 1);
});

test('streaming can be disabled per connection', async () => {
  const request = createQueryRequest({ ...item, streaming: false }, { fetchImpl: async (_, init) => {
    assert.equal(JSON.parse(init.body).stream, undefined);
    return Response.json(ok);
  } });
  assert.deepEqual(await request(messages, [], { onDelta() { throw new Error('unexpected delta'); } }), ok);
});

test('non-streaming response is rejected immediately with a clear remedy', async () => {
  const body = new ReadableStream({});
  const request = createQueryRequest(item, { fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(request(messages, [], { onDelta() {} }), error =>
    error.code === 'UNSUPPORTED_STREAM' && /Disable streaming/.test(error.message));
});

test('malformed unbounded stream is stopped before accumulating indefinitely', async () => {
  const request = createQueryRequest(item, { fetchImpl: async () => sse('x'.repeat(1024 * 1024 + 1)) });
  await assert.rejects(request(messages, [], { onDelta() {} }), { code: 'INVALID_RESPONSE' });
});

test('many small stream events are bounded as a whole', async () => {
  const chunk = event({ choices: [{ delta: { content: 'x'.repeat(1000) } }] });
  const request = createQueryRequest(item, { fetchImpl: async () => sse(chunk.repeat(17000)) });
  await assert.rejects(request(messages, [], { onDelta() {} }), { code: 'INVALID_RESPONSE' });
});

test('server error never echoes the configured API key', async () => {
  const request = createQueryRequest(item, { fetchImpl: async () => response(400, 'invalid credential secret') });
  await assert.rejects(request(messages, []), error => error.code === 'REQUEST' && !error.message.includes('secret'));
});

test('streamed tool call returns an observation before the final answer', async () => {
  let requests = 0;
  const stream = (...entries) => sse(entries.map(event).join('') + 'data: [DONE]\n\n');
  const request = createQueryRequest(item, { fetchImpl: async (_, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    if (requests++ === 0) return stream({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'call-1', function: { name: 'list_files', arguments: '{"path":"."}' } },
    ] } }] });
    assert.equal(body.messages.at(-1).role, 'tool');
    assert.match(body.messages.at(-1).content, /example.txt/);
    return stream({ choices: [{ delta: { content: 'example.txt' } }] });
  } });
  const session = { messages: [] };
  const deltas = [];
  const result = await runTurn({ session, input: '当前文件夹有哪些文件', request, policy: new PermissionPolicy(),
    workspace: { list: async () => ({ items: [{ path: 'example.txt', type: 'file' }], nextCursor: null }) }, onDelta: chunk => deltas.push(chunk) });
  assert.equal(result, 'example.txt');
  assert.deepEqual(deltas, ['example.txt']);
  assert.equal(session.messages.length, 4);
  assert.equal(requests, 2);
});

test('an interrupted stream leaves the session transcript unchanged', async () => {
  const request = createQueryRequest(item, { fetchImpl: async () => sse(event({ choices: [{ delta: { content: 'partial' } }] })) });
  const session = { messages: [] };
  await assert.rejects(runTurn({ session, input: 'hello', request, workspace: {}, onDelta() {} }), { code: 'INVALID_RESPONSE' });
  assert.deepEqual(session.messages, []);
});

test('cancelling while reading a stream reports cancellation and never retries', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const request = createQueryRequest(item, { fetchImpl: async () => {
    attempts++;
    const body = new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { content: 'partial' } }] })));
      controller.abort();
    } });
    return new Response(body);
  } });
  await assert.rejects(request(messages, [], { signal: controller.signal, onDelta() {} }), { code: 'CANCELLED' });
  assert.equal(attempts, 1);
});
