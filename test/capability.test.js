import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityBroker } from '../backend/security/capability.js';

test('capability token is scoped, expiring and single-use', () => {
  let now = 1000;
  const broker = new CapabilityBroker({ now: () => now });
  const token = broker.issue({ tool: 'external_write_file', operation: 'commit', resource: { path: 'x', afterHash: 'a' } });
  assert.throws(() => broker.consume(token.id, { tool: 'external_write_file', operation: 'commit', resource: { path: 'x', afterHash: 'b' } }), { code: 'CAPABILITY_SCOPE_CHANGED' });
  assert.equal(broker.consume(token.id, { tool: 'external_write_file', operation: 'commit', resource: { path: 'x', afterHash: 'a' } }).id, token.id);
  assert.throws(() => broker.consume(token.id, { tool: 'external_write_file', operation: 'commit', resource: { path: 'x', afterHash: 'a' } }), { code: 'CAPABILITY_UNAVAILABLE' });
  const expiring = broker.issue({ tool: 'write_file', operation: 'commit', resource: { path: 'y' }, ttlMs: 10 });
  now += 11;
  assert.throws(() => broker.consume(expiring.id, { tool: 'write_file', operation: 'commit', resource: { path: 'y' } }), { code: 'CAPABILITY_EXPIRED' });
});
