import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalGateway } from '../backend/gateway/factory.js';

test('Gateway factory uses an injected task runner and preserves task permission snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-task-runner-'));
  let seen;
  const services = createLocalGateway(root, { runTask: async (task, permissions) => { seen = { task, permissions }; return { ok: true, code: 'DONE' }; } });
  const item = await services.tasks.create({ name: 'safe', schedule: { type: 'once', at: Date.now() + 1000 }, payload: { input: 'read the report' }, permissions: { tools: ['read_file'], roots: [root], network: false, messages: false } });
  const result = await services.tasks.run(item.id);
  assert.equal(result.result.code, 'DONE'); assert.deepEqual(seen.permissions.tools, ['read_file']); assert.equal(seen.permissions.network, false); services.close();
});
