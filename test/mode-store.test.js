import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecurityModeStore } from '../backend/security/mode-store.js';

test('security mode store persists requested mode and rejects invalid values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-security-mode-')); const store = new SecurityModeStore(root);
  assert.equal(await store.getRequested(), 'safe'); await store.setRequested('personal'); assert.equal(await new SecurityModeStore(root).getRequested(), 'personal');
  await assert.rejects(store.setRequested('full-access'), { code: 'SECURITY_MODE_INVALID' });
});
