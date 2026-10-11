import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { availableTools, registeredTools, routeTool } from '../backend/tools/registry.js';
import { WslSandbox } from '../backend/sandbox/wsl.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../backend/workspace.js';
import { ExternalReads } from '../backend/tools/external-reads.js';

const call = name => ({ function: { name, arguments: JSON.stringify(name === 'write_file'
  ? { path: 'a.txt', content: 'test' } : name === 'sandbox_command' ? { command: 'pwd' } : { path: 'a.txt' }) } });

test('strict sandbox failure disables every tool without touching host or asking approval', async () => {
  const forbidden = () => { assert.fail('Host fallback or approval must never run'); };
  const policy = new PermissionPolicy({ requireSandbox: true, approveWrite: forbidden, approveCommand: forbidden });
  assert.deepEqual(availableTools(policy), []);
  for (const tool of registeredTools()) {
    assert.equal(policy.visible(tool.name), false);
    const result = await routeTool(call(tool.name), { policy,
      workspace: { read: forbidden, prepareChange: forbidden }, externalReads: { target: forbidden } });
    assert.equal(result.errorCode, 'TOOL_NOT_AVAILABLE');
  }
});

test('strict policy refuses incomplete backend even after readiness is set', async () => {
  const policy = new PermissionPolicy({ requireSandbox: true, sandboxReady: true });
  const result = await routeTool(call('write_file'), { policy, sandbox: { execute() {} },
    workspace: { prepareChange() { assert.fail('Must not prepare host write'); } } });
  assert.equal(result.errorCode, 'PERMISSION_DENIED');
});

test('external change while isolated reader is running prevents content disclosure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-external-race-'));
  const file = path.join(root, 'file.txt');
  await writeFile(file, 'original');
  const result = await routeTool({ function: { name: 'external_read_file', arguments: JSON.stringify({ path: file }) } }, {
    workspace: new Workspace(root), policy: new PermissionPolicy({ sandboxReady: true }),
    externalReads: new ExternalReads({ approve: async () => true }),
    sandbox: { readExternal: async () => { await writeFile(file, 'different length'); return 'unverified content'; } },
  });
  assert.equal(result.errorCode, 'WORKSPACE_ACCESS_DENIED');
  assert.doesNotMatch(result.content, /unverified content/);
});

test('shared sandbox launcher honors terminal cancellation before starting WSL', async () => {
  const controller = new AbortController();
  controller.abort();
  const sandbox = new WslSandbox('D:\\agent', { runTask: action => action(controller.signal) });
  await assert.rejects(sandbox.launch([], ['/bin/true']), /cancelled/);
});
