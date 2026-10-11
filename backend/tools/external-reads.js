import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../workspace.js';
import { assertSafePath } from '../security/path-policy.js';

const privateName = value => {
  const name = value.toLowerCase();
  return name === '.agent-data' || name === '.git' || name === 'node_modules' || name === '.env' || name.startsWith('.env.');
};
const denied = message => Object.assign(new Error(message), { code: 'WORKSPACE_ACCESS_DENIED' });
const isAbsolute = value => path.isAbsolute(value) || path.win32.isAbsolute(value);

export class ExternalReads {
  constructor({ approve = async () => false, root = null, resolvePath = value => value, autoApprove = false } = {}) { this.approve = approve; this.root = root ? path.resolve(root) : null; this.resolvePath = resolvePath; this.autoApprove = autoApprove; }

  async target(absolutePath, name) {
    if (absolutePath === undefined || absolutePath === null) {
      if (!this.root || !['external_list_files', 'external_find_files', 'external_search_text'].includes(name)) throw denied('Provide a file or directory path');
    } else if (typeof absolutePath !== 'string' || !absolutePath.trim()) throw denied('Provide a file or directory path');
    const rawRequested = absolutePath === undefined || absolutePath === null ? undefined : absolutePath.trim();
    const resolved = await this.resolvePath(rawRequested, name);
    const requested = resolved === undefined || resolved === null || resolved === '' ? '.' : resolved;
    if (typeof requested !== 'string' || !requested.trim()) throw denied('Provide a file or directory path');
    if (!this.root && !isAbsolute(requested)) throw denied('Provide an absolute path');
    const target = this.root && !isAbsolute(requested) ? path.resolve(this.root, requested) : path.resolve(requested);
    if (this.root && !isWithin(this.root, target)) throw denied(`Path must stay inside the approved read-only root: ${this.root}`);
    try { assertSafePath(null, target, { operation: 'external-read' }); }
    catch (error) { throw denied(error.message); }
    if (target.split(path.sep).some(privateName)) throw denied('Private agent, environment and dependency paths are not available');
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || await realpath(target) !== target) throw denied('Linked paths are not available');
    if (['external_list_files', 'external_find_files', 'external_search_text'].includes(name) && !stat.isDirectory())
      throw new Error('Path is not a directory');
    if (name === 'external_read_file' && !stat.isFile()) throw new Error('Path is not a regular file');
    if (!stat.isFile() && !stat.isDirectory()) throw denied('Only regular files and directories are available');
    if (stat.isFile() && stat.nlink !== 1) throw denied('Hard-linked files are not available');
    const workspace = new Workspace(stat.isDirectory() ? target : path.dirname(target));
    const relative = stat.isDirectory() ? '.' : path.basename(target);
    if (!stat.isDirectory()) await workspace.resolve(relative);
    return { target, workspace, relative, identity: { dev: stat.dev, ino: stat.ino,
      mtimeMs: stat.mtimeMs, size: stat.size, type: stat.isDirectory() ? 'directory' : 'file' } };
  }

  async authorize(target, name) { return this.autoApprove === true || (await this.approve({ path: target, tool: name })) === true; }

  async revalidate(selection) {
    const current = await this.target(selection.target, 'external_file_info');
    if (current.identity.dev !== selection.identity.dev || current.identity.ino !== selection.identity.ino ||
        current.identity.mtimeMs !== selection.identity.mtimeMs || current.identity.size !== selection.identity.size ||
        current.identity.type !== selection.identity.type)
      throw denied('External read target changed since approval');
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
