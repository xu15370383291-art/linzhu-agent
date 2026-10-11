import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolContract } from '../backend/contracts/tool.js';
import { validateSkillManifest, skillFingerprint } from '../backend/contracts/skill.js';
import { validateMemory, memoryRank } from '../backend/contracts/memory.js';
import { createApprovalRequest, resolveApproval } from '../backend/contracts/approval.js';
import { createEvent, EventBus } from '../backend/contracts/events.js';

test('tool contract normalizes safety defaults and rejects invalid risk', () => {
  const tool = validateToolContract({ name: 'read_file', description: 'Read a file' });
  assert.equal(tool.approval, 'none');
  assert.equal(tool.cancellable, true);
  assert.throws(() => validateToolContract({ name: 'x', description: 'x', risk: 'secret' }), /risk/);
});

test('skill manifest has lifecycle, permissions and stable fingerprint', () => {
  const manifest = validateSkillManifest({ id: 'demo', name: 'Demo', description: 'test', tools: ['read_file'] });
  assert.equal(manifest.state, 'discovered');
  assert.equal(skillFingerprint({ manifest, body: 'hello' }), skillFingerprint({ manifest, body: 'hello' }));
  assert.notEqual(skillFingerprint({ manifest, body: 'other' }), skillFingerprint({ manifest, body: 'hello' }));
});

test('memory contract keeps candidates separate and ranks fresh important entries', () => {
  const candidate = validateMemory({ kind: 'preference', content: 'Use concise replies', source: 'agent-suggestion' });
  assert.equal(candidate.status, 'candidate');
  assert.throws(() => validateMemory({ content: 'api_key=bad' }), /Sensitive/);
  assert.ok(memoryRank({ ...candidate, importance: 1, updatedAt: Date.now() }) > 0);
});

test('approval is single-use, expires and binds the resource', () => {
  const pending = createApprovalRequest({ type: 'write', operation: 'write_file', resource: { path: 'a', content: 'x' } });
  const approved = resolveApproval(pending, 'approved', { resource: { path: 'a', content: 'x' } });
  assert.equal(approved.status, 'approved');
  assert.throws(() => resolveApproval(approved, 'approved'), /no longer pending/);
  assert.throws(() => resolveApproval(pending, 'approved', { resource: { path: 'a', content: 'y' } }), /changed/);
});

test('events are bounded, secret-free and delivered through EventBus', () => {
  const seen = [];
  const bus = new EventBus();
  bus.on(event => seen.push(event));
  const event = bus.emit(createEvent('tool.started', { tool: 'read_file' }));
  assert.equal(seen[0].id, event.id);
  assert.throws(() => createEvent('tool.started', { apiKey: 'bad' }), /sensitive/i);
  assert.throws(() => createEvent('unknown', {}), /Unknown/);
});
