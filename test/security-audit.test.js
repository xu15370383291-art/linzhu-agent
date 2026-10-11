import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SecurityAudit } from '../backend/permissions/audit.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { Workspace } from '../backend/workspace.js';
import { routeTool } from '../backend/tools/registry.js';

test('audit correlates success, denial and invalid calls without storing content or arguments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-audit-'));
  await writeFile(path.join(root, 'file.txt'), 'secret-content');
  const audit = new SecurityAudit(root);
  await audit.initialize();
  const workspace = new Workspace(root);
  const policy = new PermissionPolicy({ audit, requireAudit: true });
  policy.auditReady = true;
  const invoke = (name, args) => routeTool({ function: { name, arguments: JSON.stringify(args) } }, { workspace, policy });
  assert.equal((await invoke('read_file', { path: 'file.txt' })).isError, false);
  assert.equal((await invoke('write_file', { path: 'file.txt', content: 'secret-new' })).errorCode, 'USER_DENIED');
  assert.equal((await invoke('secret-unknown-name', {})).errorCode, 'TOOL_NOT_AVAILABLE');
  const raw = await readFile(audit.file, 'utf8');
  assert.doesNotMatch(raw, /secret|file\.txt/);
  const events = raw.trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 7);
  for (let i = 1; i < events.length; i += 2) assert.equal(events[i].id, events[i + 1].id);
  assert.deepEqual(events.filter(event => event.phase === 'finish').map(event => event.outcome), ['success', 'USER_DENIED', 'TOOL_NOT_AVAILABLE']);
});

test('audit failure before execution blocks effects; final failure disables future operations', async () => {
  let records = 0;
  let writes = 0;
  const policy = new PermissionPolicy({ requireAudit: true, audit: { record: async () => { if (++records === 2) throw new Error('disk full'); } }, approveWrite: async () => true });
  policy.auditReady = true;
  const workspace = { prepareChange: async () => ({ path: 'file.txt' }), commitChange: async () => { writes++; return 'done'; } };
  const call = { function: { name: 'write_file', arguments: '{"path":"file.txt","content":"test"}' } };
  assert.equal((await routeTool(call, { policy, workspace })).errorCode, 'AUDIT_FAILED');
  assert.equal(writes, 1);
  assert.equal((await routeTool(call, { policy, workspace })).errorCode, 'PERMISSION_DENIED');
  assert.equal(writes, 1);
  policy.auditReady = true;
  policy.audit.record = async () => { throw new Error('unavailable'); };
  assert.equal((await routeTool(call, { policy, workspace })).errorCode, 'PERMISSION_DENIED');
  assert.equal(writes, 1);
});

test('audit rotates oversized files and rejects hard-linked log files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-audit-rotation-'));
  const audit = new SecurityAudit(root);
  await audit.initialize();
  await writeFile(audit.file, 'x'.repeat(2_000_001));
  await audit.record({ id: 'rotation', tool: 'system', phase: 'ready', outcome: 'ready' });
  assert.equal((await readFile(`${audit.file}.previous`, 'utf8')).length, 2_000_001);
  assert.match(await readFile(audit.file, 'utf8'), /rotation/);
  await link(audit.file, path.join(root, 'alias'));
  await assert.rejects(audit.record({ id: 'denied', tool: 'system', phase: 'start', outcome: 'requested' }), /Unsafe audit file/);
});
