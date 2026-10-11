import test from 'node:test';
import assert from 'node:assert/strict';
import { completedTurns, assertToolPairs, projectToolResults } from '../backend/context/history.js';

const exchange = [
  { role: 'user', content: 'read' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
  { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(200) },
  { role: 'assistant', content: 'done' },
  { role: 'user', content: 'again' },
];

test('turn boundaries preserve tool calls with paired results', () => {
  assert.deepEqual(completedTurns(exchange).map(turn => [turn.start, turn.end]), [[0, 4], [4, 5]]);
  assert.doesNotThrow(() => assertToolPairs(exchange));
  assert.throws(() => assertToolPairs(exchange.slice(0, 2)), /Unpaired tool call/);
  assert.throws(() => assertToolPairs([exchange[2]]), /Unpaired tool result/);
});

test('old tool result is shortened only in the request view', () => {
  const view = projectToolResults(exchange, { maxChars: 80, aggregateChars: 80, protectedFrom: 4 });
  assert.match(view.messages[2].content, /truncated/);
  assert.equal(exchange[2].content.length, 200);
  assert.equal(view.messages[2].tool_call_id, 'a');
  assert.equal(projectToolResults(exchange, { maxChars: 80, protectedFrom: 2 }).messages[2].content.length, 200);
});

test('structured tool results remain valid JSON after truncation', () => {
  const result = { role: 'tool', tool_call_id: 'a', content: JSON.stringify({ content: 'x'.repeat(30000), isError: false }) };
  const view = projectToolResults([result], { maxChars: 1000, aggregateChars: 1000 });
  const parsed = JSON.parse(view.messages[0].content);
  assert.equal(parsed.isError, false);
  assert.equal(parsed.truncated, true);
  assert.match(parsed.content, /truncated/);
  assert.equal(JSON.parse(result.content).content.length, 30000);
});
