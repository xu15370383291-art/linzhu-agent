import test from 'node:test';
import assert from 'node:assert/strict';
import { WritableSandbox } from '../backend/sandbox/writable.js';
import { CapabilityBroker } from '../backend/security/capability.js';
import { OperationBroker } from '../backend/security/broker.js';

test('writable sandbox commit consumes a shared OperationBroker capability after diff approval', async () => {
  const capabilities = new CapabilityBroker();
  const broker = new OperationBroker({ capabilities, root: 'C:\\workspace' });
  const sandbox = new WritableSandbox('C:\\workspace', { operationBroker: broker });
  sandbox.changes.set('change', { id: 'change', original: 'C:\\workspace', directory: 'C:\\temp', collected: [] });
  const result = await sandbox.commit('change', async () => true);
  assert.equal(result.committed, true);
});
