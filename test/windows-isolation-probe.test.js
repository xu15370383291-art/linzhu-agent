import test from 'node:test';
import assert from 'node:assert/strict';
import { probeWindowsIsolation } from '../backend/security/windows-isolation-probe.js';

test('Windows isolation probe fails closed without a verified probe', async () => {
  const result = await probeWindowsIsolation();
  if (process.platform === 'win32') { assert.equal(result.supported, true); assert.equal(result.available, false); }
  else { assert.equal(result.supported, false); assert.equal(result.available, false); }
});

test('Windows isolation probe accepts only an explicitly verified restricted runner', async () => {
  const result = await probeWindowsIsolation({ probe: async () => ({ available: true, mode: 'restricted-token-test' }) });
  if (process.platform === 'win32') { assert.equal(result.available, true); assert.equal(result.mode, 'restricted-token-test'); }
  else assert.equal(result.available, false);
});

test('Windows isolation probe preserves the real worker mode and availability result', async () => {
  const result = await probeWindowsIsolation({ probe: async () => ({ available: true, mode: 'windows-restricted-token-job-low-integrity' }) });
  if (process.platform === 'win32') {
    assert.equal(result.available, true);
    assert.equal(result.mode, 'windows-restricted-token-job-low-integrity');
  } else assert.equal(result.available, false);
});
