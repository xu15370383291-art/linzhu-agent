import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../backend/memory/store.js';
import { memoryContext } from '../backend/memory/prompt.js';

test('Memory semantic mode is optional and falls back to keyword search', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-semantic-')); const embedding = { provider: 'fake-local', model: 'v1', dimensions: 2, async embed(text) { return text.includes('猫') || text.includes('动物') ? [1, 0] : [0, 1]; } };
  let memory; let reopened; let changed; let fallback;
  try {
    memory = new MemoryStore(root, { embedding, mode: 'hybrid' });
    const first = await memory.create({ content: '我喜欢猫', scope: 'global', kind: 'preference' }); await memory.create({ content: '我喜欢狗', scope: 'global', kind: 'preference' });
    assert.equal((await memory.search('动物')).at(0).id, first.id);
    assert.equal((await memory.status()).embedded, 2);
    assert.equal((await memory.status()).embeddingIdentity, 'fake-local:v1:2');
    reopened = new MemoryStore(root, { embedding, mode: 'semantic' }); assert.equal((await reopened.search('猫')).at(0).id, first.id);
    changed = new MemoryStore(root, { embedding: { ...embedding, model: 'v2', async embed() { return [0, 1]; } }, mode: 'semantic' });
    assert.equal((await changed.status()).stale, 2);
    const rebuilt = await changed.reembed({ limit: 1 }); assert.equal(rebuilt.processed, 1); assert.equal(rebuilt.remaining, 1);
    await changed.reembed({ limit: 10 }); assert.equal((await changed.status()).stale, 0);
    fallback = new MemoryStore(root, { embedding: { provider: 'down', model: 'v1', embed: async () => { throw Object.assign(new Error('unavailable'), { code: 'OFFLINE' }); } }, mode: 'semantic' });
    assert.ok(Array.isArray(await fallback.search('猫'))); assert.equal((await fallback.status()).embeddingError, 'OFFLINE');
  } finally { await memory?.close?.(); await reopened?.close?.(); await changed?.close?.(); await fallback?.close?.(); await rm(root, { recursive: true, force: true }); }
});

test('sensitive memories never reach local embedding and embedding vectors follow memory deletion/review', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-sensitive-')); let store; t.after(async () => { await store?.close(); await rm(root, { recursive: true, force: true }); }); const calls = [];
  store = new MemoryStore(root, { embedding: { provider: 'fake', model: 'v1', async embed(text) { calls.push(text); return [1, 0]; } }, mode: 'semantic' });
  const candidate = await store.suggest({ content: 'Private but non-secret detail', sensitive: true }); await store.reembed(); assert.equal(calls.length, 0);
  await store.review(candidate.id, 'active'); assert.equal(calls.length, 0);
  assert.equal((await memoryContext(store, 'Private')).includes('Private'), false);
  await store.remove(candidate.id); assert.equal((await store.status()).embedded, 0);
});

test('semantic candidates obey memory scope and changed vector dimensions are stale until rebuilt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-scope-')); let store; let changed;
  const embedding = { provider: 'fake-local', model: 'scope-v1', async embed(text) { return text.includes('first') ? [1, 0] : [0, 1]; } };
  store = new MemoryStore(root, { embedding, mode: 'semantic' });
  try {
    const localItem = await store.create({ content: 'first project note', scope: 'project' });
    await store.create({ content: 'second global note', scope: 'global' });
    const projectResults = await store.search('first project', 5, { scope: 'project' }); assert.deepEqual(projectResults.map(item => item.id), [localItem.id]);
    changed = new MemoryStore(root, { embedding: { provider: 'fake-local', model: 'scope-v2', dimensions: 3, async embed() { return [0, 0, 1]; } }, mode: 'semantic' });
    assert.equal((await changed.status()).stale, 2); const result = await changed.reembed(); assert.equal(result.processed, 2); assert.equal((await changed.status()).stale, 0); assert.equal((await changed.status()).embeddingIdentity, 'fake-local:scope-v2:3');
  } finally { await changed?.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

test('unexpected provider dimension changes invalidate old vectors and fall back to keyword search', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-dimension-change-')); let oldStore; let changedStore;
  try {
    oldStore = new MemoryStore(root, { embedding: { provider: 'local', model: 'same', dimensions: 2, async embed() { return [1, 0]; } }, mode: 'semantic' });
    await oldStore.create({ content: 'dimension probe phrase', scope: 'global' });
    changedStore = new MemoryStore(root, { embedding: { provider: 'local', model: 'same', async embed() { return [1, 0, 0]; } }, mode: 'semantic' });
    assert.equal((await changedStore.search('dimension probe')).length, 1);
    assert.equal((await changedStore.status()).embeddingIdentity, 'local:same:3');
    assert.equal((await changedStore.status()).stale, 1);
  } finally { await changedStore?.close(); await oldStore?.close(); await rm(root, { recursive: true, force: true }); }
});
