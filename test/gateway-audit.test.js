import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecurityAudit } from '../backend/permissions/audit.js';
import { OperationBroker } from '../backend/security/broker.js';
import { CapabilityBroker } from '../backend/security/capability.js';

test('shared OperationBroker records capability consumption without payload or secret values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-broker-audit-')); const audit = new SecurityAudit(root); await audit.initialize();
  const broker = new OperationBroker({ root, audit, capabilities: new CapabilityBroker() });
  const token = broker.issue({ tool: 'test_operation', operation: 'commit', resource: { path: path.join(root, 'file.txt'), after: 'secret-value' } });
  broker.consume({ token: token.id, tool: 'test_operation', operation: 'commit', resource: { path: path.join(root, 'file.txt'), after: 'secret-value' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  const log = await readFile(audit.file, 'utf8');
  assert.match(log, /capability-consumed/); assert.doesNotMatch(log, /secret-value/); assert.doesNotMatch(log, /file\.txt/);
});
