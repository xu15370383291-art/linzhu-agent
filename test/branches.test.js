import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sessions } from '../backend/sessions.js';
import { branchMessages } from '../backend/sessions/branches.js';
import { ContextManager } from '../backend/context/manager.js';

test('session API persists fork, switch and rewind with old messages intact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-branches-'));
  const sessions = new Sessions(root);
  let session = await sessions.create();
  session.messages.push({ role: 'user', content: 'one' }, { role: 'assistant', content: 'a' });
  await sessions.save(session);
  const sourceHead = session.branches[0].headMessageId;
  let result = await sessions.fork(session.id, 'experiment');
  session = result.session;
  session.messages.push({ role: 'user', content: 'branch only' });
  await sessions.save(session);
  assert.equal(branchMessages(session).at(-1).content, 'branch only');
  result = await sessions.useBranch(session.id, 'main'); session = result.session;
  assert.equal(branchMessages(session).at(-1).messageId, sourceHead);
  result = await sessions.rewind(session.id, sourceHead); session = result.session;
  assert.equal(branchMessages(session).length, 2);
  assert.equal(session.messages.length, 3);
});

test('context projection follows active branch and resets branch checkpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-branch-context-'));
  const sessions = new Sessions(root);
  let session = await sessions.create();
  session.messages.push({ role: 'user', content: 'base' }, { role: 'assistant', content: 'base answer' });
  await sessions.save(session);
  ({ session } = await sessions.fork(session.id, 'branch'));
  session.messages.push({ role: 'user', content: 'only branch' }, { role: 'assistant', content: 'branch answer' });
  await sessions.save(session);
  const view = new ContextManager(session).project().messages;
  assert.ok(view.some(message => message.content === 'only branch'));
  assert.ok(view.some(message => message.content === 'base'));
});
