import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sessions } from '../backend/sessions.js';
import { branchMessages, ensureBranches, forkBranch, rewindBranch } from '../backend/sessions/branches.js';
import { normalizeUsage, usageEstimate } from '../backend/usage/schema.js';
import { Pricing } from '../backend/usage/pricing.js';
import { UsageLedger } from '../backend/usage/ledger.js';

test('legacy sessions gain stable message IDs only at persistence boundaries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-m0-'));
  const sessions = new Sessions(root);
  const session = await sessions.create();
  session.messages.push({ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' });
  const before = session.messages.map(({ role, content }) => ({ role, content }));
  assert.deepEqual(branchMessages(session), before);
  await sessions.save(session);
  const restored = await sessions.get(session.id);
  assert.ok(restored.messages.every(message => message.messageId && message.branchId));
  assert.equal(branchMessages(restored).length, 2);
});

test('branches fork and rewind without changing the source branch', () => {
  const session = ensureBranches({ id: 's', createdAt: new Date().toISOString(), messages: [
    { role: 'user', content: 'one' }, { role: 'assistant', content: 'a' },
  ] });
  const sourceHead = session.branches[0].headMessageId;
  const branch = forkBranch(session, 'experiment');
  assert.equal(branch.forkedFrom, sourceHead);
  session.messages.push({ messageId: 'new', parentMessageId: sourceHead, branchId: branch.id, role: 'user', content: 'branch question' });
  branch.headMessageId = 'new';
  assert.equal(branchMessages(session).at(-1).content, 'branch question');
  rewindBranch(session, sourceHead);
  assert.equal(branchMessages(session).at(-1).messageId, sourceHead);
});

test('usage schema normalizes provider fields and rejects contradictory totals', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }), { inputTokens: 3, outputTokens: 2, totalTokens: 5, source: 'provider' });
  assert.equal(normalizeUsage({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 4 }), null);
  assert.equal(usageEstimate([{ role: 'user', content: 'hello' }]).source, 'tokenizer_estimate');
});

test('pricing and usage ledger are local, atomic and omit message content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-usage-'));
  const pricing = new Pricing(root);
  await pricing.set({ model: 'mock', inputPerMillion: 1, outputPerMillion: 2 });
  assert.deepEqual(await pricing.cost('mock', { inputTokens: 1000, outputTokens: 500 }), { amount: 0.002, currency: 'USD', configured: true });
  const ledger = new UsageLedger(root, pricing);
  await ledger.record({ requestId: 'r1', model: 'mock', usage: { inputTokens: 1, outputTokens: 2 }, content: 'secret' });
  const events = await ledger.list();
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes('secret'), false);
  assert.equal(JSON.parse(await readFile(path.join(root, '.agent-data', 'pricing.json'), 'utf8')).items[0].model, 'mock');
});

test('usage ledger persists calculated cost as a separate redacted field', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-usage-cost-'));
  const pricing = new Pricing(root); await pricing.set({ model: 'mock', inputPerMillion: 1, outputPerMillion: 2 });
  const ledger = new UsageLedger(root, pricing); const usage = { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, source: 'provider' };
  await ledger.record({ requestId: 'r2', model: 'mock', usage, cost: await pricing.cost('mock', usage) });
  assert.deepEqual((await ledger.list())[0].cost, { amount: 0.002, currency: 'USD', configured: true });
});
