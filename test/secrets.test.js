import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecretStore } from '../backend/secrets/store.js';
import { redact } from '../backend/secrets/redact.js';
import { listProviders, capabilitySnapshot } from '../backend/providers/registry.js';

test('Windows SecretStore protects, resolves, lists metadata and survives a new instance', async t => {
  if (process.platform !== 'win32') return t.skip('DPAPI test requires Windows');
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-secret-'));
  const store = new SecretStore(root);
  assert.deepEqual(await store.available(), { available: true, backend: 'dpapi' });
  await store.set('probe-key', 'very-secret-value');
  assert.equal(await store.resolve('secret://probe-key'), 'very-secret-value');
  assert.equal((await new SecretStore(root).get('probe-key')), 'very-secret-value');
  assert.equal(JSON.stringify(await store.listMetadata()).includes('very-secret-value'), false);
  assert.equal((await readFile(store.file, 'utf8')).includes('very-secret-value'), false);
});

test('redactor strips credential fields and known credential values', () => {
  assert.deepEqual(redact({ apiKey: 'a', nested: 'Bearer abc', note: 'raw-secret' }, ['raw-secret']), { apiKey: '[redacted]', nested: '[redacted]', note: '[redacted]' });
});

test('long-lived SecretStore reloads keys saved by another instance', async t => {
  if (process.platform !== 'win32') return t.skip('DPAPI test requires Windows');
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-secret-reload-'));
  const writer = new SecretStore(root);
  const reader = new SecretStore(root);
  await writer.set('model-key', 'old-test-key');
  assert.equal(await reader.get('model-key'), 'old-test-key');
  await writer.set('model-key', 'new-test-key');
  assert.equal(await reader.get('model-key'), 'new-test-key');
  await reader.set('second-key', 'second-value');
  assert.equal(await writer.get('second-key'), 'second-value');
  await writer.delete('model-key');
  assert.equal(await reader.get('model-key'), null);
});

test('provider registry exposes supported local and compatible provider capabilities', () => {
  assert.deepEqual(listProviders().map(item => item.id), ['openai-compatible', 'ollama']);
  assert.equal(capabilitySnapshot({ provider: 'ollama', capabilities: { tools: true } }).tools, true);
});
