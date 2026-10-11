import test from 'node:test';
import assert from 'node:assert/strict';
import { previewDiff } from '../backend/tools/diff.js';

test('preview distinguishes a missing final newline', () => {
  const diff = previewDiff('line', 'line\n');
  assert.match(diff.text, /- line \[no newline\]/);
  assert.match(diff.text, /\+ line/);
});
