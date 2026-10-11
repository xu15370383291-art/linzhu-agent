import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../backend/workspace.js';
import { ChangePlanStore } from '../backend/security/change-plan.js';
import { OperationBroker } from '../backend/security/broker.js';
import { CapabilityBroker } from '../backend/security/capability.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { routeTool } from '../backend/tools/registry.js';

const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });

test('apply_change_plan commits bounded multi-file changes only after approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plan-tool-')); const workspace = new Workspace(root, { changePlans: new ChangePlanStore({ root, operationBroker: new OperationBroker({ capabilities: new CapabilityBroker(), root }) }) });
  const policy = new PermissionPolicy({ changePlanReady: true, approveWrite: async () => true });
  const result = await routeTool(call('apply_change_plan', { changes: [{ path: 'a.txt', content: 'a' }, { path: 'b.txt', content: 'b' }] }), { workspace, policy });
  assert.equal(result.isError, false); assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'a'); assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'b');
});

test('apply_change_plan prepares every file before consuming the plan', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-plan-prepare-')); const workspace = new Workspace(root, { changePlans: new ChangePlanStore({ root, operationBroker: new OperationBroker({ capabilities: new CapabilityBroker(), root }) }) });
  const policy = new PermissionPolicy({ changePlanReady: true, approveWrite: async () => true });
  const result = await routeTool(call('apply_change_plan', { changes: [{ path: 'ok.txt', content: 'ok' }, { path: '../outside.txt', content: 'bad' }] }), { workspace, policy });
  assert.equal(result.isError, true); assert.equal(result.errorCode, 'TOOL_EXECUTION_ERROR'); assert.equal(await readFile(path.join(root, 'ok.txt')).catch(() => null), null);
});
