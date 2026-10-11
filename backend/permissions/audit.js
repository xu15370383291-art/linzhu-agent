import { mkdir, lstat, open, rename } from 'node:fs/promises';
import path from 'node:path';

export class SecurityAudit {
  #queue = Promise.resolve();
  constructor(root) {
    this.root = path.resolve(root);
    this.directory = path.join(this.root, '.agent-data', 'security');
    this.file = path.join(this.directory, 'audit.jsonl');
  }

  async initialize() {
    let current = this.root;
    for (const component of ['.agent-data', 'security']) {
      current = path.join(current, component);
      try { await mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe audit directory');
    }
    await this.record({ id: 'startup', tool: 'system', phase: 'ready', outcome: 'ready' });
  }

  record({ id, tool, phase, outcome, durationMs }) {
    // Only structural fields are persisted; tool arguments and results are excluded.
    const event = { time: new Date().toISOString(), id, tool, phase, outcome,
      ...(durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(durationMs)) }) };
    const pending = this.#queue.then(async () => {
      for (const directory of [this.root, path.dirname(this.directory), this.directory]) {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe audit directory');
      }
      let identity;
      try {
        identity = await lstat(this.file);
        if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) throw new Error('Unsafe audit file');
        if (identity.size > 2_000_000) {
          const previous = `${this.file}.previous`;
          try {
            const stat = await lstat(previous);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe previous audit file');
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await rename(this.file, previous);
          identity = null;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const handle = await open(this.file, identity ? 'a' : 'ax', 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || identity && (stat.dev !== identity.dev || stat.ino !== identity.ino))
          throw new Error('Audit file changed');
        await handle.writeFile(`${JSON.stringify(event)}\n`);
        await handle.sync();
      } finally { await handle.close(); }
    });
    this.#queue = pending.catch(() => {});
    return pending;
  }
}
