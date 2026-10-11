import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../workspace.js';
import { assertSafePath } from '../security/path-policy.js';
import { CapabilityBroker } from '../security/capability.js';
import { OperationBroker } from '../security/broker.js';

const isAbsolute = value => path.isAbsolute(value) || path.win32.isAbsolute(value);
const privateSegment = value => {
  const name = value.toLowerCase();
  return name === '.agent-data' || name === '.git' || name === 'node_modules' || name === '.env' ||
    name.startsWith('.env.') || name.startsWith('.agent-stage-');
};
const denied = message => Object.assign(new Error(message), { code: 'WORKSPACE_ACCESS_DENIED' });

export class ExternalWrites {
  constructor({ root, commitBroker, capabilities = new CapabilityBroker(), operationBroker = null, resolvePath = value => value, allowWorkspace = false, allowExternalPaths = true, projectBoundary = null } = {}) {
    this.root = root ? path.resolve(root) : null;
    this.commitBroker = commitBroker;
    this.capabilities = operationBroker?.capabilities ?? capabilities;
    this.operationBroker = operationBroker ?? new OperationBroker({ capabilities, root: this.root });
    this.resolvePath = resolvePath;
    this.allowWorkspace = allowWorkspace;
    this.allowExternalPaths = allowExternalPaths;
    this.projectBoundary = projectBoundary;
  }

  enabled(value) { return typeof value === 'function' ? value() === true : value === true; }

  async target(absolutePath) {
    if (typeof absolutePath !== 'string' || !absolutePath.trim()) throw denied('Provide an absolute path');
    const resolved = await this.resolvePath(absolutePath.trim());
    if (typeof resolved !== 'string' || !isAbsolute(resolved)) throw denied('Provide an absolute path or an authorized alias');
    const target = path.resolve(resolved);
    try { assertSafePath(this.root, target, { operation: 'external-write' }); }
    catch (error) { throw denied(error.message); }
    if (this.root) {
      const relative = path.relative(this.root, target);
      const inside = !relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      if (inside && !this.enabled(this.allowWorkspace)) throw denied('External write path must be outside the workspace');
      if (!inside && !this.enabled(this.allowExternalPaths)) throw denied('External write path requires an approved external directory');
      if (this.projectBoundary) await this.projectBoundary(target);
    }
    const segments = target.replaceAll('\\', '/').split('/').filter(Boolean);
    if (segments.some(privateSegment) || segments.some(segment => segment.endsWith('.') || segment.endsWith(' ')))
      throw denied('Private, ambiguous or dependency paths cannot be written');
    if (path.win32.isAbsolute(target) && target.slice(2).includes(':')) throw denied('Alternate data streams are not available');
    if (target === path.parse(target).root) throw denied('A regular file path is required');

    const parent = path.dirname(target);
    const parentStat = await lstat(parent).catch(error => {
      if (error.code === 'ENOENT') throw denied('Parent directory does not exist');
      throw error;
    });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw denied('Linked parent directories are not available');
    await this.assertRealPath(parent);

    let stat = null;
    try { stat = await lstat(target); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
      throw denied('Only regular, unlinked files are available');
    const insideWorkspace = this.root ? (() => {
      const relative = path.relative(this.root, target);
      return !relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    })() : false;
    return { target, parent, relative: insideWorkspace ? path.relative(this.root, target) : path.basename(target), workspaceRoot: insideWorkspace ? this.root : parent,
      insideWorkspace, exists: Boolean(stat), stat,
      parentIdentity: { dev: parentStat.dev, ino: parentStat.ino, mtimeMs: parentStat.mtimeMs } };
  }

  async assertRealPath(target) {
    let actual;
    try { actual = await realpath(target); }
    catch (error) { throw denied(`Cannot verify external target: ${error.message}`); }
    if (path.normalize(actual).toLowerCase() !== path.normalize(target).toLowerCase())
      throw denied('Linked paths are not available');
  }

  async prepare(absolutePath, name, args) {
    const selection = await this.target(absolutePath);
    selection.tool = name;
    const workspace = new Workspace(selection.workspaceRoot, { commitBroker: this.commitBroker });
    const change = await workspace.prepareChange(selection.relative,
      name === 'external_write_file'
        ? { content: args.content, displayPath: selection.target }
        : { oldText: args.oldText, content: args.newText, displayPath: selection.target });
    const capability = this.capabilities.issue({ tool: name, operation: 'external-write-commit', resource: {
      target: selection.target, before: change.before, after: change.after, metadata: change.metadata ?? null,
    } });
    return { workspace, selection, change, capability };
  }

  consumeCapability(prepared) {
    return this.operationBroker.consume({ token: prepared.capability.id, path: prepared.selection.target, tool: prepared.selection.tool,
      operation: 'external-write-commit',
      resource: { target: prepared.selection.target, before: prepared.change.before, after: prepared.change.after, metadata: prepared.change.metadata ?? null },
    });
  }

  async revalidate(selection) {
    const current = await this.target(selection.target);
    const before = selection.stat;
    const after = current.stat;
    const parentStat = await lstat(current.parent);
    const parent = selection.parentIdentity;
    if (Boolean(before) !== Boolean(after) || current.parent !== selection.parent ||
        parentStat.dev !== parent.dev || parentStat.ino !== parent.ino || parentStat.mtimeMs !== parent.mtimeMs)
      throw denied('External write target changed since approval');
    if (before && (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.nlink !== after.nlink))
      throw denied('External write target changed since approval');
    return current;
  }
}
