import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { CapabilityBroker } from '../backend/security/capability.js';
import { OperationBroker } from '../backend/security/broker.js';
import { ChangePlanStore } from '../backend/security/change-plan.js';

test('ChangePlanStore consumes through the shared OperationBroker capability store', () => {
  const capabilities = new CapabilityBroker();
  const broker = new OperationBroker({ capabilities, root: path.join(os.tmpdir(), 'broker-root') });
  const plans = new ChangePlanStore({ root: path.join(os.tmpdir(), 'broker-root'), operationBroker: broker });
  const plan = plans.prepare([{ path: 'a.txt', after: 'x' }]);
  plans.approve(plan.id, plan.fingerprint);
  assert.equal(plans.consume(plan.id, plan.fingerprint).id, plan.id);
  assert.throws(() => plans.consume(plan.id, plan.fingerprint), { code: 'CHANGE_PLAN_NOT_APPROVED' });
});
