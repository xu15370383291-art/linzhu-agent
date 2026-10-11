import test from 'node:test';
import assert from 'node:assert/strict';
import { contextStatus, estimateTokens, resolveBudget } from '../backend/context/budget.js';

test('context budget includes messages and tool definitions', () => {
  const status = contextStatus([{ role: 'user', content: 'hello' }], [{ name: 'read_file' }]);
  assert.equal(status.inputLimit, 32768 - 4096 - 1024);
  assert.equal(status.estimatedInput, status.messageTokens + status.toolTokens);
  assert.equal(status.fits, true);
});

test('token estimate is conservative for multibyte content', () => {
  assert.ok(estimateTokens('你好世界') >= 4);
});

test('invalid context budgets fail early', () => {
  assert.throws(() => resolveBudget({ contextWindow: 1024 }), /Context window/);
  assert.throws(() => resolveBudget({ contextWindow: 2048, outputReserve: 1500 }), /Output reserve|input/i);
});
