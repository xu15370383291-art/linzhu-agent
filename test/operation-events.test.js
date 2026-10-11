import test from 'node:test';
import assert from 'node:assert/strict';
import { CapabilityBroker } from '../backend/security/capability.js';
import { OperationBroker } from '../backend/security/broker.js';

test('OperationBroker emits metadata-only authorization events', () => {
  const events = []; const broker = new OperationBroker({ capabilities: new CapabilityBroker(), onEvent: event => events.push(event) });
  const token = broker.issue({ tool: 'test', operation: 'commit', resource: { secret: 'do-not-emit' } });
  broker.consume({ token: token.id, tool: 'test', operation: 'commit', resource: { secret: 'do-not-emit' } });
  assert.deepEqual(events[0], { type: 'operation.authorized', operation: { id: token.id, tool: 'test', operation: 'commit' } });
  assert.equal(JSON.stringify(events).includes('do-not-emit'), false);
});
