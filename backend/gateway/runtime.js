import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function acquireGatewayLock(root, { pid = process.pid, now = () => Date.now(), lockName = 'gateway.lock', label = 'Gateway' } = {}) {
  const file = path.join(path.resolve(root), '.agent-data', lockName);
  await mkdir(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const record = { version: 1, pid, token, root: path.resolve(root), startedAt: now(), platform: process.platform };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record)); await handle.close();
      let released = false;
      return {
        file, record,
        async release() {
          if (released) return; released = true;
          try {
            const current = JSON.parse(await readFile(file, 'utf8'));
            if (current.token === token) await unlink(file);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let current = null;
      try { current = JSON.parse(await readFile(file, 'utf8')); } catch (readError) { if (readError.code !== 'ENOENT') throw readError; continue; }
      if (processIsAlive(current?.pid)) {
        const code = lockName === 'gateway.lock' ? 'GATEWAY_ALREADY_RUNNING'
          : lockName === 'preview.lock' ? 'PREVIEW_ALREADY_RUNNING'
            : 'SERVICE_ALREADY_RUNNING';
        throw Object.assign(new Error(`${label} is already running (pid ${current.pid})`), { code, pid: current.pid });
      }
      try { await unlink(file); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
    }
  }
  throw Object.assign(new Error('Gateway lock could not be acquired'), { code: 'GATEWAY_LOCK_UNAVAILABLE' });
}

export async function readGatewayLock(root, lockName = 'gateway.lock') {
  try { return JSON.parse(await readFile(path.join(path.resolve(root), '.agent-data', lockName), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
