import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_PROJECTS = 30;

export async function pickProjectDirectory({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform !== 'win32') throw Object.assign(new Error('系统文件夹选择器目前仅支持 Windows'), { code: 'PROJECT_PICKER_UNAVAILABLE' });
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$source = @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    '[ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    'interface IFileOpenDialog {',
    '  [PreserveSig] int Show(IntPtr owner);',
    '  void SetFileTypes(uint count, IntPtr specs); void SetFileTypeIndex(uint index); void GetFileTypeIndex(out uint index);',
    '  void Advise(IntPtr events, out uint cookie); void Unadvise(uint cookie); void SetOptions(uint options); void GetOptions(out uint options);',
    '  void SetDefaultFolder(IntPtr item); void SetFolder(IntPtr item); void GetFolder(out IntPtr item); void GetCurrentSelection(out IntPtr item);',
    '  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name); void GetFileName(out IntPtr name);',
    '  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);',
    '  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label); void GetResult(out IShellItem item);',
    '  void AddPlace(IntPtr item, uint alignment); void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);',
    '  void Close(int result); void SetClientGuid(ref Guid guid); void ClearClientData(); void SetFilter(IntPtr filter);',
    '  void GetResults(out IntPtr items); void GetSelectedItems(out IntPtr items);',
    '}',
    '[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    'interface IShellItem {',
    '  void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid iid, out IntPtr result);',
    '  void GetParent(out IntPtr parent);',
    '  void GetDisplayName(uint nameType, out IntPtr name);',
    '  void GetAttributes(uint mask, out uint attributes); void Compare(IShellItem other, uint hint, out int order);',
    '}',
    'public static class NativeFolderPicker {',
    '  [DllImport("ole32.dll", PreserveSig=false)] static extern void CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, out IFileOpenDialog dialog);',
    '  public static string Pick() {',
    '    Guid clsid = new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7"), iid = new Guid("D57C7288-D4AD-4768-BE02-9D969532D960");',
    '    IFileOpenDialog dialog; CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out dialog);',
    '    uint options; dialog.GetOptions(out options); dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x8); dialog.SetTitle("选择项目文件夹"); dialog.SetOkButtonLabel("选择文件夹");',
    '    int result = dialog.Show(IntPtr.Zero); if (result == unchecked((int)0x800704C7)) return null; Marshal.ThrowExceptionForHR(result);',
    '    IShellItem item; dialog.GetResult(out item); IntPtr display; item.GetDisplayName(0x80058000, out display);',
    '    try { return Marshal.PtrToStringUni(display); } finally { Marshal.FreeCoTaskMem(display); Marshal.ReleaseComObject(item); Marshal.ReleaseComObject(dialog); }',
    '  }',
    '}',
    "'@",
    'Add-Type -TypeDefinition $source',
    '$selected = [NativeFolderPicker]::Pick()',
    'if ($selected) { [Console]::Out.Write($selected) }',
  ].join('\r\n');
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true, timeout: 120_000, maxBuffer: 16_384 });
  const selected = stdout.trim();
  if (!selected) return null;
  const resolved = path.resolve(selected);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw Object.assign(new Error('所选路径不是文件夹'), { code: 'PROJECT_DIRECTORY_INVALID' });
  return resolved;
}

export class ProjectStore {
  constructor(root, { picker = pickProjectDirectory } = {}) {
    this.file = path.join(path.resolve(root), '.agent-data', 'projects.json');
    this.picker = picker;
    this.items = null;
    this.pending = new Map();
    this.queue = Promise.resolve();
  }

  async load() {
    if (this.items) return this.items;
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.items = Array.isArray(data.items) ? data.items.filter(item => item && /^[0-9a-f-]{36}$/.test(item.id) && typeof item.path === 'string').slice(0, MAX_PROJECTS) : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.items = [];
    }
    return this.items;
  }

  async persist() {
    const operation = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify({ version: 1, items: this.items.slice(0, MAX_PROJECTS) }, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.file);
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async pick() {
    const selected = await this.picker();
    if (!selected) return null;
    const root = path.resolve(selected);
    if (!(await stat(root)).isDirectory()) throw Object.assign(new Error('所选路径不是文件夹'), { code: 'PROJECT_DIRECTORY_INVALID' });
    const items = await this.load();
    const key = root.toLowerCase();
    let project = items.find(item => item.path.toLowerCase() === key) || [...this.pending.values()].find(item => item.path.toLowerCase() === key);
    if (!project) project = { id: randomUUID(), name: path.basename(root) || root, path: root, addedAt: new Date().toISOString() };
    else project = { ...project, name: path.basename(root) || root, path: root };
    this.pending.set(project.id, project);
    return structuredClone(project);
  }

  async list(sessions = []) {
    const projects = new Map();
    for (const session of sessions) {
      if ((session.messageCount ?? 0) < 1 || !session.project?.id || typeof session.project.path !== 'string') continue;
      projects.set(session.project.id, structuredClone(session.project));
    }
    const items = [...projects.values()].slice(0, MAX_PROJECTS);
    const stored = await this.load();
    const storedById = new Map(stored.map(item => [item.id, item]));
    this.items = items.map(project => ({ ...storedById.get(project.id), ...project }));
    for (const project of items) this.pending.delete(project.id);
    if (JSON.stringify(stored) !== JSON.stringify(this.items)) await this.persist();
    return structuredClone(this.items);
  }

  async get(id) {
    const project = (await this.load()).find(item => item.id === id) || this.pending.get(id);
    if (!project) throw Object.assign(new Error('项目不存在或已从最近项目中移除'), { code: 'PROJECT_NOT_FOUND' });
    const info = await stat(project.path).catch(error => {
      throw Object.assign(new Error(`项目目录不可用：${error.message}`), { code: 'PROJECT_DIRECTORY_UNAVAILABLE' });
    });
    if (!info.isDirectory()) throw Object.assign(new Error('项目路径不再是文件夹'), { code: 'PROJECT_DIRECTORY_INVALID' });
    return structuredClone(project);
  }
}
