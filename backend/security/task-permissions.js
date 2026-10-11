import path from 'node:path';

const messageTools = new Set(['send_message', 'edit_message', 'delete_message', 'react_message', 'send_file']);
const networkTools = new Set(['web_fetch', 'web_search']);

function inside(target, root) {
  const value = path.resolve(target).toLowerCase();
  const base = path.resolve(root).toLowerCase();
  return value === base || value.startsWith(`${base}${path.sep}`);
}

export class TaskPermissionPolicy {
  constructor(snapshot = {}, { workspaceRoot = process.cwd() } = {}) {
    this.tools = new Set(snapshot.tools ?? []);
    this.roots = (snapshot.roots ?? []).map(value => path.resolve(value));
    this.network = snapshot.network === true;
    this.messages = snapshot.messages === true;
    this.maxFiles = snapshot.maxFiles ?? 100;
    this.maxBytes = snapshot.maxBytes ?? 2 * 1024 * 1024;
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.files = 0;
    this.bytes = 0;
  }

  allowsTool(name) {
    if (this.tools.size && !this.tools.has(name) && ![...this.tools].some(pattern => pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1)))) return false;
    if (networkTools.has(name) && !this.network) return false;
    if (messageTools.has(name) && !this.messages) return false;
    return this.tools.size > 0 || networkTools.has(name) && this.network || messageTools.has(name) && this.messages;
  }

  allowsPath(name, args = {}) {
    if (!['read_file', 'file_info', 'list_files', 'find_files', 'search_text', 'write_file', 'edit_file', 'external_read_file', 'external_file_info', 'external_list_files', 'external_find_files', 'external_search_text', 'external_write_file', 'external_edit_file'].includes(name)) return true;
    if (typeof args.path !== 'string') return false;
    const absolute = name.startsWith('external_') ? path.resolve(args.path) : path.resolve(this.workspaceRoot, args.path);
    return this.roots.some(root => inside(absolute, root));
  }

  reserve(bytes = 0) {
    if (this.files + 1 > this.maxFiles || this.bytes + Math.max(0, bytes) > this.maxBytes) return false;
    this.files += 1; this.bytes += Math.max(0, bytes); return true;
  }
}
