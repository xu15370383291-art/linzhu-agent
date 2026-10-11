import { open, rename, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWrite(target, content, { validate, existing = false, mode, beforePublish = async () => {} } = {}) {
  const staged = path.join(path.dirname(target), `.agent-stage-${randomUUID()}`);
  let handle;
  try {
    handle = await open(staged, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (mode !== undefined) await chmod(staged, mode);
    await beforePublish();
    await validate();
    if (existing) await rename(staged, target);
    else {
      // Hard-link publication fails if a concurrently created target exists.
      const { link } = await import('node:fs/promises');
      await link(staged, target);
    }
  } finally {
    await handle?.close();
    await unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
