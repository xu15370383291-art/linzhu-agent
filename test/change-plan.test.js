import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ChangePlanStore } from '../backend/security/change-plan.js';

test('change plans enforce file/byte limits and protected paths', () => {
  const store = new ChangePlanStore({ root: path.join(os.tmpdir(), 'agent-plan-root'), limits: { maxFiles: 2, maxBytes: 10 } });
  assert.throws(() => store.prepare([{ path: 'a.txt', after: '12345678901' }]), { code: 'CHANGE_LIMIT' });
  assert.throws(() => store.prepare([{ path: '.ssh/id_rsa', after: 'x' }]), { code: 'PROTECTED_PATH' });
  assert.throws(() => store.prepare([{ path: 'a.txt', after: 'x' }, { path: 'b.txt', after: 'y' }, { path: 'c.txt', after: 'z' }]), { code: 'CHANGE_LIMIT' });
});

test('change plans require review fingerprint and are single-use', () => {
  const store = new ChangePlanStore({ root: path.join(os.tmpdir(), 'agent-plan-root') });
  const plan = store.prepare([{ path: 'a.txt', after: 'new' }]);
  assert.throws(() => store.consume(plan.id, plan.fingerprint), { code: 'CHANGE_PLAN_NOT_APPROVED' });
  const approved = store.approve(plan.id, plan.fingerprint);
  assert.equal(approved.status, 'approved');
  const committed = store.consume(plan.id, plan.fingerprint);
  assert.equal(committed.id, plan.id);
  assert.throws(() => store.consume(plan.id, plan.fingerprint), { code: 'CHANGE_PLAN_NOT_APPROVED' });
});

test('relative change paths are resolved under the plan root, never the process cwd', () => {
  const root = path.join(os.tmpdir(), 'agent-plan-root-bound');
  const store = new ChangePlanStore({ root });
  const plan = store.prepare([{ path: 'nested/a.txt', after: 'x' }]);
  assert.equal(plan.changes[0].path, path.join(root, 'nested', 'a.txt'));
  assert.throws(() => store.prepare([{ path: '../outside.txt', after: 'x' }]), { code: 'CHANGE_SCOPE' });
});
