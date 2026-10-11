import test from 'node:test';
import assert from 'node:assert/strict';
import { securityModeStatus } from '../backend/security/mode.js';

test('safe and advanced modes fail closed when verified isolation is unavailable', () => {
  const readiness = { worker: { available: false }, windowsIsolation: { available: false } };
  assert.equal(securityModeStatus('safe', readiness).active, 'safe');
  assert.equal(securityModeStatus('personal', readiness).active, 'personal');
  assert.equal(securityModeStatus('advanced', readiness).code, 'SECURITY_MODE_UNAVAILABLE');
});

test('personal and advanced modes require their corresponding verified boundaries', () => {
  assert.equal(securityModeStatus('personal', { worker: { available: true }, windowsIsolation: { available: false } }).active, 'personal');
  assert.equal(securityModeStatus('advanced', { worker: { available: true }, windowsIsolation: { available: true } }).active, 'advanced');
  assert.throws(() => securityModeStatus('unknown'), { code: 'SECURITY_MODE_INVALID' });
});
