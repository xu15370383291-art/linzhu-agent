import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QueryCache, cacheEligible, cacheKey } from '../backend/cache/store.js';
import { createQueryRequest } from '../backend/query-engine.js';

test('cache eligibility excludes tools, streams and realtime requests', () => {
  assert.equal(cacheEligible({ tools: [], toolChoice: 'none', stream: false }), true);
  assert.equal(cacheEligible({ tools: [{ type: 'function' }], toolChoice: 'auto', stream: false }), false);
  assert.equal(cacheEligible({ tools: [], toolChoice: 'none', stream: true }), false);
  assert.equal(cacheEligible({ tools: [], toolChoice: 'none', stream: false, realtime: true }), false);
  assert.notEqual(cacheKey({ endpoint: 'a', model: 'm', messages: [{ role: 'user', content: 'a' }] }), cacheKey({ endpoint: 'a', model: 'm', messages: [{ role: 'user', content: 'b' }] }));
});

test('query cache stores pure JSON responses and honors clear/expiry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cache-')); const cache = new QueryCache(root, { ttlMs: 20 });
  const item = { apiKey: 'secret', url: 'https://example.com/v1', model: 'm', streaming: false }; let requests = 0;
  const request = createQueryRequest(item, { cache, fetchImpl: async () => { requests++; return Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }); } });
  assert.equal((await request([{ role: 'user', content: 'same' }], [], { toolChoice: 'none' })).choices[0].message.content, 'ok');
  assert.equal((await request([{ role: 'user', content: 'same' }], [], { toolChoice: 'none' })).cached, true);
  assert.equal(requests, 1); await new Promise(resolve => setTimeout(resolve, 30)); await request([{ role: 'user', content: 'same' }], [], { toolChoice: 'none' }); assert.equal(requests, 2);
  await cache.clear(); assert.equal((await cache.status()).entries, 0);
});
