import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../workspace.js';
import { previewDiff } from '../tools/diff.js';
import { withSnapshot } from './snapshot.js';
import { CapabilityBroker } from '../security/capability.js';
import { OperationBroker } from '../security/broker.js';
import { TransactionJournal } from '../security/transaction-journal.js';

export class WritableSandbox {
  constructor(root, { runCommand, commitBroker, operationBroker = null, transactionJournal = null } = {}) { this.root = path.resolve(root); this.runCommand = runCommand; this.commitBroker = commitBroker; this.operationBroker = operationBroker ?? new OperationBroker({ capabilities: new CapabilityBroker(), root: this.root }); this.transactionJournal = transactionJournal ?? new TransactionJournal(this.root); this.changes = new Map(); }
  async prepare() {
    const source = await stat(this.root); if (!source.isDirectory()) throw new Error('Workspace must be a directory');
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-writable-sandbox-'));
    try {
      const copy = snapshot => cp(snapshot, directory, { recursive: true, filter: sourcePath => {
        const relative = path.relative(snapshot, sourcePath).replaceAll('\\', '/');
        return relative === '' || !relative.split('/').some(part => ['.agent-data', '.git', 'node_modules'].includes(part) || part.startsWith('.env'));
      } });
      if (process.platform === 'win32') await withSnapshot(this.root, copy, { mode: 'full' });
      else await copy(this.root);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    const id = randomUUID(); this.changes.set(id, { id, directory, createdAt: Date.now(), original: this.root }); return { id, directory };
  }
  async execute(id, command, options = {}) {
    const item = this.changes.get(id); if (!item) throw new Error('Writable sandbox not found or expired');
    if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\x00-\x1f\x7f]/.test(command)) throw new Error('Invalid writable sandbox command');
    if (!this.runCommand) throw new Error('Writable sandbox executor unavailable');
    try { return await this.runCommand(command, { cwd: item.directory, signal: options.signal }); }
    catch (error) { await this.discard(id); throw error; }
  }
  async collect(id) {
    const item = this.changes.get(id); if (!item) throw new Error('Writable sandbox not found or expired');
    const source = new Workspace(item.original); const sandbox = new Workspace(item.directory); const files = new Set();
    const walk = async (workspace, relative) => { const current = await workspace.list(relative); for (const entry of current.items) { const next = relative === '.' ? entry.path : `${relative}/${path.basename(entry.path)}`; if (entry.type === 'directory') await walk(workspace, next); else files.add(next); } };
    await walk(sandbox, '.'); await walk(source, '.');
    const changes = []; let totalBytes = 0;
    for (const relative of files) {
      const after = await sandbox.read(relative).catch(() => null); const before = await source.read(relative).catch(() => null);
      if (after !== before) {
        totalBytes += Buffer.byteLength(after ?? '');
        if (changes.length >= 100 || totalBytes > 10 * 1024 * 1024) throw new Error('Writable sandbox change quota exceeded');
        changes.push({ path: relative, target: path.resolve(item.original, relative), before, after, diff: previewDiff(before ?? '', after ?? '') });
      }
    }
    item.collected = changes; return { id, changes };
  }
  async commit(id, approve = async () => false) {
    const item = this.changes.get(id); if (!item?.collected) throw new Error('Collect changes before commit');
    if (!item.collected.length) { await this.discard(id); return { committed: true, changes: [] }; }
    if (!await approve(structuredClone(item.collected))) return { committed: false, denied: true, changes: item.collected };
    const resource = item.collected.map(change => ({ path: change.path, before: change.before, after: change.after }));
    const capability = this.operationBroker.issue({ tool: 'sandbox_command_write', operation: 'commit', resource });
    this.operationBroker.consume({ token: capability.id, tool: 'sandbox_command_write', operation: 'commit', resource });
    const workspace = new Workspace(item.original, { commitBroker: this.commitBroker });
    const prepared = [];
    for (const change of item.collected) {
      if (change.after === null) throw new Error('Deletes are not supported in the first writable sandbox release');
      const next = await workspace.prepareChange(change.path, { content: change.after });
      if (next.before !== change.before) throw new Error(`File changed since sandbox snapshot: ${change.path}`);
      prepared.push(next);
    }
    const transactionChanges = item.collected.map(change => ({ target: path.resolve(item.original, change.path), before: change.before, after: change.after }));
    try {
      await this.transactionJournal.commit(transactionChanges, {
        apply: async (_change, index) => workspace.commitChange(prepared[index]),
        write: async ({ target, content }) => {
          const relative = path.relative(item.original, target);
          const rollback = await workspace.prepareChange(relative, { content });
          await workspace.commitChange(rollback);
        },
      });
    } catch (error) {
      throw Object.assign(new Error(`Writable sandbox transaction failed: ${error.message}`), { code: error.code ?? 'TRANSACTION_FAILED', committed: error.transaction?.committed ?? [] });
    }
    await this.discard(id); return { committed: true, changes: item.collected };
  }
  async discard(id) { const item = this.changes.get(id); if (!item) return; this.changes.delete(id); await rm(item.directory, { recursive: true, force: true }); }
}
