import os from 'node:os';
import path from 'node:path';

const privateSegments = new Set(['.agent-data', '.git', 'node_modules', '.ssh', '.aws', '.azure', '.gnupg', '.kube']);

function normalize(value) {
  return path.resolve(String(value)).replace(/[\\/]+/g, path.sep).replace(/[\\/]$/, '').toLowerCase();
}

function isWithin(target, root) {
  const value = normalize(target);
  const base = normalize(root);
  return value === base || value.startsWith(`${base}${path.sep}`);
}

function descendantsOf(segment, target) {
  const value = normalize(target);
  return value.split(/[\\/]+/).some(part => part === segment);
}

function protectedRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    const windows = process.env.WINDIR || 'C:\\Windows';
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env['ProgramFiles(x86)'];
    const programData = process.env.ProgramData;
    for (const root of [windows, programFiles, programFilesX86, programData]) if (root) roots.push({ root, reason: '系统目录' });
    const profile = process.env.USERPROFILE || os.homedir();
    for (const name of [
      '.ssh', '.aws', '.azure', '.gnupg', '.kube',
      'AppData\\Roaming\\Microsoft\\Credentials',
      'AppData\\Local\\Microsoft\\Credentials',
      'AppData\\Roaming\\Microsoft\\Protect',
      'AppData\\Local\\Google\\Chrome\\User Data',
      'AppData\\Local\\Microsoft\\Edge\\User Data',
      'AppData\\Roaming\\Mozilla\\Firefox\\Profiles',
    ]) roots.push({ root: path.join(profile, name), reason: '用户凭据或浏览器数据' });
  } else {
    for (const root of ['/etc', '/root', '/usr', '/var/lib']) roots.push({ root, reason: '系统目录' });
    for (const name of ['.ssh', '.aws', '.azure', '.gnupg', '.kube']) roots.push({ root: path.join(os.homedir(), name), reason: '用户凭据' });
  }
  return roots;
}

export function pathPolicy(root, target, { operation = 'access' } = {}) {
  const absolute = normalize(target);
  const workspace = root ? normalize(root) : null;
  const segments = absolute.split(/[\\/]+/).filter(Boolean);
  if (segments.some(segment => privateSegments.has(segment) || segment === '.env' || segment.startsWith('.env.'))) {
    return { allowed: false, code: 'PROTECTED_PATH', reason: 'Agent 私有、依赖或环境配置路径', path: absolute, operation };
  }
  for (const item of protectedRoots()) {
    if (isWithin(absolute, item.root)) return { allowed: false, code: 'PROTECTED_PATH', reason: item.reason, path: absolute, operation };
  }
  return { allowed: true, path: absolute, operation, workspace: workspace ? isWithin(absolute, workspace) : false };
}

export function assertSafePath(root, target, options = {}) {
  const result = pathPolicy(root, target, options);
  if (!result.allowed) throw Object.assign(new Error(`Protected path denied: ${result.reason}`), { code: result.code, path: result.path });
  return result;
}

export { isWithin, normalize };
