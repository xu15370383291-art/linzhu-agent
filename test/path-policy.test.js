import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { pathPolicy, assertSafePath } from '../backend/security/path-policy.js';

test('path policy allows ordinary external paths and blocks protected private paths', () => {
  const root = path.join(os.tmpdir(), 'agent-policy-workspace');
  const ordinary = path.join(os.tmpdir(), 'agent-policy-target', 'notes.txt');
  assert.equal(pathPolicy(root, ordinary, { operation: 'external-write' }).allowed, true);
  assert.equal(pathPolicy(root, path.join(root, '.agent-data', 'models.json')).code, 'PROTECTED_PATH');
  assert.equal(pathPolicy(root, path.join(root, '.env')).allowed, false);
});

test('path policy blocks Windows system and credential locations without relying on model behavior', () => {
  if (process.platform !== 'win32') return;
  const profile = process.env.USERPROFILE || os.homedir();
  assert.equal(pathPolicy(null, path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts')).allowed, false);
  assert.equal(pathPolicy(null, path.join(profile, '.ssh', 'id_rsa')).allowed, false);
  assert.equal(pathPolicy(null, path.join(profile, 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cookies')).allowed, false);
});

test('assertSafePath returns a structured protected-path denial', () => {
  assert.throws(() => assertSafePath(null, path.join(os.homedir(), '.ssh', 'config')), { code: 'PROTECTED_PATH' });
});
