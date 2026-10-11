import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../backend/memory/store.js';
import { memoryContext } from '../backend/memory/prompt.js';
import { extractMemorySuggestion } from '../backend/memory/suggest.js';

test('memory creates, searches, scopes, deletes and filters secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-')); const store = new MemoryStore(root);
  try {
  const item = await store.create({ kind: 'preference', content: '用户偏好使用简体中文回答' });
  assert.equal((await memoryContext(store, '中文回答')).includes('简体中文'), true);
  await assert.rejects(store.create({ content: 'api_key=secret' }), { code: 'MEMORY_SENSITIVE' });
  assert.equal((await store.list()).length, 1); await store.remove(item.id); assert.equal((await store.list()).length, 0);
  } finally { await store.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }); }
});

test('memory suggestions require review, deduplicate and preserve project scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-lifecycle-')); const store = new MemoryStore(root);
  try {
  const candidate = await store.suggest({ kind: 'decision', scope: 'project', content: 'Use SQLite for local state' });
  assert.equal(candidate.status, 'candidate');
  assert.equal((await store.list()).length, 0);
  const duplicate = await store.suggest({ kind: 'decision', scope: 'project', content: 'Use SQLite for local state' });
  assert.equal(duplicate.duplicateOf, candidate.id);
  const approved = await store.review(candidate.id, 'active');
  assert.equal(approved.status, 'active');
  assert.equal((await store.search('SQLite')).length, 1);
  } finally { await store.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }); }
});

test('memory markdown export/import is bounded and filters secret content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-markdown-')); const store = new MemoryStore(root);
  try {
  await store.create({ kind: 'preference', scope: 'global', content: 'Prefer concise technical answers' });
  const markdown = await store.exportMarkdown();
  assert.match(markdown, /Prefer concise/);
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-import-')); const other = new MemoryStore(otherRoot);
  try {
  assert.equal((await other.importMarkdown(markdown)).length, 1);
  assert.equal((await other.importMarkdown(`${markdown}\n## secret | global | x\n\napi_key=bad`)).length, 0);
  } finally { await other.close(); await (await import('node:fs/promises')).rm(otherRoot, { recursive: true, force: true }); }
  } finally { await store.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }); }
});

test('memory keeps scoped records isolated and supports Chinese fallback search', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-scope-')); const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-scope-other-'));
  const store = new MemoryStore(root); const other = new MemoryStore(otherRoot);
  try {
    const global = await store.create({ content: '用户偏好简体中文回答', kind: 'preference', scope: 'global' });
    const session = await store.create({ content: '本轮只使用测试数据', kind: 'fact', scope: 'session', sessionId: 'session-a' });
    await store.create({ content: '另一个会话的测试数据', kind: 'fact', scope: 'session', sessionId: 'session-b' });
    const project = await store.create({ content: '项目使用 Node.js', kind: 'decision', scope: 'project' });
    assert.equal((await store.search('中文回复')).at(0).id, global.id);
    assert.deepEqual((await store.search('测试数据', 5, { sessionId: 'session-a' })).map(item => item.id), [session.id]);
    assert.deepEqual((await store.search('项目使用', 5, { projectRoot: root })).map(item => item.id), [project.id]);
    assert.deepEqual((await other.search('项目使用', 5, { projectRoot: root })).map(item => item.id), []);
  } finally { await store.close(); await other.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }); await (await import('node:fs/promises')).rm(otherRoot, { recursive: true, force: true }); }
});

test('memory candidates can replace an active record and explicit persistence phrases create candidates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-update-')); const store = new MemoryStore(root);
  try {
    const old = await store.create({ content: '偏好详细回答', kind: 'preference', scope: 'global' });
    const candidate = await store.suggest({ content: '偏好简洁回答', kind: 'preference', scope: 'global' });
    const approved = await store.review(candidate.id, { status: 'active', supersedesId: old.id });
    assert.equal(approved.status, 'active'); assert.equal((await store.get(old.id, { includeInactive: true })).status, 'superseded');
    assert.equal((await store.search('回答')).at(0).id, candidate.id);
    assert.deepEqual(extractMemorySuggestion('请记住：我偏好简洁回答。'), { content: '我偏好简洁回答', scope: 'global', kind: 'preference' });
    assert.deepEqual(extractMemorySuggestion('本项目采用 Node.js'), { content: 'Node.js', scope: 'project', kind: 'decision' });
    assert.equal(extractMemorySuggestion('请记住 api_key=secret'), null);
  } finally { await store.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }); }
});

test('memory provenance and version history support audit and restore', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-memory-history-')); const store = new MemoryStore(root);
  try {
    const item = await store.suggest({ content: '偏好简洁回答', kind: 'preference', scope: 'global', provenance: { sourceType: 'auto_suggestion', sourceText: '请记住：我偏好简洁回答', reason: '明确持久化表达', sessionId: 'session-a', messageId: 'message-a' } });
    const candidate = await store.get(item.id, { includeInactive: true });
    assert.equal(candidate.provenance.sourceType, 'auto_suggestion'); assert.equal(candidate.provenance.reason, '明确持久化表达');
    await store.review(item.id, 'active'); await store.update(item.id, '偏好短回答', { provenance: { sourceType: 'manual_edit', sourceText: '/memory edit', reason: '用户修正偏好' } });
    const history = await store.history(item.id); assert.equal(history.length, 3); assert.equal(history[0].action, 'updated'); assert.equal(history[1].action, 'reviewed');
    const restored = await store.restore(item.id, 1); assert.equal(restored.content, '偏好简洁回答'); assert.equal((await store.history(item.id))[0].action, 'restored');
    await assert.rejects(store.suggest({ content: 'bad', provenance: { sourceType: 'auto_suggestion', sourceText: 'api_key=secret' } }), { code: 'MEMORY_PROVENANCE_SENSITIVE' });
  } finally { await store.close(); await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }); }
});
