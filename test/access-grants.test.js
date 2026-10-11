import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccessGrantStore } from '../backend/security/access-grants.js';
import { createLocalGateway } from '../backend/gateway/factory.js';
import { classifyIntent } from '../backend/agent/intent.js';
import { ExternalReads } from '../backend/tools/external-reads.js';
import { ExternalWrites } from '../backend/tools/external-writes.js';
import { routeTool } from '../backend/tools/registry.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { Workspace } from '../backend/workspace.js';

test('AccessGrantStore keeps persistent grants isolated by client and resolves aliases safely', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-access-workspace-'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'agent-access-external-'));
  await writeFile(path.join(external, 'notes.txt'), 'hello');
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]));
  const store = new AccessGrantStore(workspace);
  const persistent = await store.grant({ alias: '@docs', path: external, permissions: ['read', 'write'], scope: 'persistent' }, 'client-a');
  assert.equal(persistent.alias, '@docs');
  assert.equal((await store.list({ clientIdentity: 'client-b' })).length, 0);
  assert.equal(await store.resolve('@docs/notes.txt', { permission: 'read', clientIdentity: 'client-a' }), path.join(external, 'notes.txt'));
  assert.equal(await store.resolve('@docs', { permission: 'write', clientIdentity: 'client-a' }), external);
  await assert.rejects(store.resolve('@docs/../outside.txt', { permission: 'read', clientIdentity: 'client-a' }), { code: 'ACCESS_GRANT_SCOPE_DENIED' });
  await assert.rejects(store.resolve('@docs/notes.txt', { permission: 'read', clientIdentity: 'client-b' }), { code: 'ACCESS_GRANT_PERMISSION_DENIED' });
  const reloaded = new AccessGrantStore(workspace);
  assert.equal((await reloaded.list({ clientIdentity: 'client-a' })).length, 1);
  await rm(external, { recursive: true, force: true });
  await assert.rejects(reloaded.resolve('@docs/notes.txt', { permission: 'read', clientIdentity: 'client-a' }), { code: 'ACCESS_GRANT_ROOT_CHANGED' });
  await reloaded.remove(persistent.id, { clientIdentity: 'client-a' });
  assert.equal((await reloaded.list({ clientIdentity: 'client-a' })).length, 0);
});

test('AccessGrantStore keeps session grants in memory and rejects unsafe roots', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-access-session-workspace-'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'agent-access-session-external-'));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]));
  const store = new AccessGrantStore(workspace);
  const grant = await store.grant({ alias: '@session', path: external, permissions: ['read'], scope: 'session', sessionId: 'session-1' }, 'client-a');
  assert.equal((await store.list({ clientIdentity: 'client-a', sessionId: 'session-1' })).length, 1);
  const restarted = new AccessGrantStore(workspace);
  assert.equal((await restarted.list({ clientIdentity: 'client-a', sessionId: 'session-1' })).length, 0);
  await assert.rejects(store.grant({ alias: '@workspace', path: workspace, permissions: ['read'], scope: 'persistent' }, 'client-a'), { code: 'ACCESS_GRANT_WORKSPACE' });
  await mkdir(path.join(external, '.git'));
  await assert.rejects(store.grant({ alias: '@private', path: path.join(external, '.git'), permissions: ['read'], scope: 'persistent' }, 'client-a'), { code: 'PROTECTED_PATH' });
  await store.remove(grant.id, { clientIdentity: 'client-a', sessionId: 'session-1' });
});

test('Access aliases are classified as external read or write intents', () => {
  assert.equal(classifyIntent('读取 @docs/notes.txt').preferredTool, 'external_read_file');
  assert.equal(classifyIntent('修改 @docs/notes.txt').preferredTool, 'external_edit_file');
});

test('Authorized aliases reach the existing external read and write tool boundaries', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'agent-access-route-workspace-'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'agent-access-route-external-'));
  const target = path.join(external, 'notes.txt');
  await writeFile(target, 'before');
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]));
  const grants = new AccessGrantStore(workspace);
  await grants.grant({ alias: '@demo', path: external, permissions: ['read', 'write'], scope: 'persistent' }, 'client-a');
  const reads = new ExternalReads({ resolvePath: requested => grants.resolve(requested, { permission: 'read', clientIdentity: 'client-a' }), approve: async () => true });
  const writes = new ExternalWrites({ root: workspace, resolvePath: requested => grants.resolve(requested, { permission: 'write', clientIdentity: 'client-a' }) });
  const policy = new PermissionPolicy({ approveWrite: async () => true });
  const readResult = await routeTool({ id: 'alias-read', function: { name: 'external_read_file', arguments: JSON.stringify({ path: '@demo/notes.txt' }) } }, {
    workspace: new Workspace(workspace), externalReads: reads, policy,
  });
  assert.equal(readResult.content, 'before');
  const writeResult = await routeTool({ id: 'alias-write', function: { name: 'external_edit_file', arguments: JSON.stringify({ path: '@demo/notes.txt', oldText: 'before', newText: 'after' }) } }, {
    workspace: new Workspace(workspace), externalWrites: writes, policy,
  });
  assert.match(writeResult.content, /Wrote/);
  assert.equal(await readFile(target, 'utf8'), 'after');
  const deniedWrites = new ExternalWrites({ root: workspace, resolvePath: requested => grants.resolve(requested, { permission: 'write', clientIdentity: 'client-b' }) });
  const denied = await routeTool({ id: 'alias-denied', function: { name: 'external_edit_file', arguments: JSON.stringify({ path: '@demo/notes.txt', oldText: 'after', newText: 'denied' }) } }, {
    workspace: new Workspace(workspace), externalWrites: deniedWrites, policy,
  });
  assert.equal(denied.errorCode, 'WORKSPACE_ACCESS_DENIED');
});

test('Gateway access grant API binds approvals to the client and persists approved grants', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-access-api-'));
  const target = await mkdtemp(path.join(os.tmpdir(), 'agent-access-api-target-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(target, { recursive: true, force: true })]));
  const services = createLocalGateway(root);
  const server = services.gateway.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer access-client', 'Content-Type': 'application/json' };
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const pending = await post('/api/access/grants', { alias: '@demo', path: target, permissions: ['read'], scope: 'persistent' });
  assert.equal(pending.status, 202);
  const pendingBody = await pending.json();
  const approvals = services.gateway.approvals;
  const approval = approvals.get(pendingBody.approvalId);
  assert.equal(approval.metadata.clientIdentity, services.gateway.clientIdentity({ headers }));
  await post(`/api/approvals/${pendingBody.approvalId}`, { decision: 'approved' });
  const created = await post('/api/access/grants', { alias: '@demo', path: target, permissions: ['read'], scope: 'persistent', approvalId: pendingBody.approvalId });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).alias, '@demo');
  const listed = await fetch(`${base}/api/access/grants`, { headers });
  assert.equal((await listed.json()).items.length, 1);
  services.close();
});
