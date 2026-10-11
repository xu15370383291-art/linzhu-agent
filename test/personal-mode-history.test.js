import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTurn } from '../backend/agent.js';
import { PermissionPolicy } from '../backend/permissions/policy.js';
import { Workspace } from '../backend/workspace.js';

const call = (name, args) => ({ id: `history-${name}`, function: { name, arguments: JSON.stringify(args) } });

test('current personal-mode intent overrides stale refusal in an existing session', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-personal-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requestCount = 0;
  let routed;
  const externalWrites = {
    async prepare(target, name) { routed = { target, name }; return { change: { unchanged: true } }; },
  };
  const session = { messages: [
    { role: 'user', content: '在D盘创建一个名为a的文件' },
    { role: 'assistant', content: '外部写入工具不可用，只能由用户手动创建。' },
  ] };
  const answer = await runTurn({
    session,
    input: '在D盘创建一个名为a的文件',
    workspace: new Workspace(root),
    externalWrites,
    policy: new PermissionPolicy({ personalMode: true, autoApproveFileOperations: true }),
    request: async (messages) => {
      requestCount++;
      if (requestCount === 1) {
        const system = messages.find(message => message.role === 'system')?.content || '';
        assert.match(system, /忽略这些过时结论/);
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [call('write_file', { path: 'a', content: '' })] } }] };
      }
      return { choices: [{ message: { role: 'assistant', content: '已完成' } }] };
    },
  });
  assert.equal(answer, '已完成');
  assert.deepEqual(routed, { target: 'D:\\a', name: 'external_write_file' });
});
