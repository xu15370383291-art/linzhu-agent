import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmbeddingProvider, validateEmbeddingSettings } from '../backend/memory/embedding-provider.js';
import { EmbeddingConfigStore } from '../backend/memory/embedding-config.js';
import { MemoryStore } from '../backend/memory/store.js';

const local = { provider: 'ollama', model: 'nomic-embed-text', baseUrl: 'http://127.0.0.1:11434' };
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

test('embedding config accepts only local Ollama and rejects remote/custom endpoints', () => {
  assert.equal(validateEmbeddingSettings(local).provider, 'ollama');
  for (const baseUrl of ['http://10.0.0.2:11434', 'https://localhost:11434', 'http://localhost:9000', 'http://localhost:11434/?secret=x'])
    assert.throws(() => validateEmbeddingSettings({ ...local, baseUrl }), { code: 'EMBEDDING_CONFIG_INVALID' });
  assert.throws(() => validateEmbeddingSettings({ provider: 'openai-compatible', model: 'x', baseUrl: 'https://api.example.com/v1', allowExternal: true }), { code: 'EMBEDDING_CONFIG_INVALID' });
});

test('local embedding adapter validates request, response, dimensions and cancellation', async () => {
  const calls = [];
  const embedding = createEmbeddingProvider({ ...local, dimensions: 2 }, { fetchImpl: async (url, options) => { calls.push({ url, options }); return response({ embeddings: [[3, 4]] }); } });
  const vector = await embedding.embed('local text'); assert.deepEqual(vector, [0.6, 0.8]);
  assert.equal(calls[0].url, `${local.baseUrl}/api/embed`); assert.equal(calls[0].options.redirect, 'error'); assert.equal(JSON.parse(calls[0].options.body).input, 'local text');
  const wrongDimensions = createEmbeddingProvider({ ...local, dimensions: 3 }, { fetchImpl: async () => response({ embeddings: [[1, 0]] }) });
  await assert.rejects(wrongDimensions.embed('x'), { code: 'EMBEDDING_VECTOR_INVALID' });
  const malformed = createEmbeddingProvider(local, { fetchImpl: async () => new Response('not-json', { status: 200 }) });
  await assert.rejects(malformed.embed('x'), { code: 'EMBEDDING_RESPONSE_INVALID' });
  await assert.rejects(embedding.embed('x'.repeat(8001)), { code: 'EMBEDDING_INPUT_INVALID' });
  const controller = new AbortController(); controller.abort();
  const cancellable = createEmbeddingProvider(local, { fetchImpl: async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  await assert.rejects(cancellable.embed('x', { signal: controller.signal }), { code: 'CANCELLED' });
});

test('embedding configuration persists metadata only and can be disabled', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-embedding-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = new EmbeddingConfigStore(root); assert.equal((await config.get()).configured, false);
  const saved = await config.set(local); assert.equal(saved.configured, true);
  const raw = await readFile(config.file, 'utf8'); assert.equal(raw.includes('apiKey'), false); assert.equal(raw.includes('secret'), false);
  assert.equal((await new EmbeddingConfigStore(root).get()).model, local.model);
  assert.equal((await config.clear()).configured, false);
});

test('semantic mode is disabled by default, persists after explicit config, and falls back after disable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-embedding-mode-')); const config = new EmbeddingConfigStore(root); const store = new MemoryStore(root); let configured; let fallback;
  t.after(async () => { await store.close(); await configured?.close(); await fallback?.close(); await rm(root, { recursive: true, force: true }); });
  const item = await store.create({ content: 'Prefer direct answers', scope: 'global' }); assert.equal(store.mode, 'keyword'); assert.equal(store.embedding, null);
  const saved = await config.set(local); configured = new MemoryStore(root, { embedding: createEmbeddingProvider(saved, { fetchImpl: async () => response({ embeddings: [[1, 0]] }) }), mode: 'hybrid' });
  await configured.reembed(); assert.equal((await configured.status()).embedded, 1);
  await config.clear(); fallback = new MemoryStore(root); assert.equal(fallback.mode, 'keyword'); assert.equal((await fallback.get(item.id)).content, 'Prefer direct answers');
});
