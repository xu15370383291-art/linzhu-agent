import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { WslSandbox } from '../sandbox/wsl.js';

const MAX_COMMAND = 2000;

function linuxPath(root) {
  const absolute = path.win32.resolve(root);
  const match = /^([a-z]):\\(.*)$/i.exec(absolute);
  if (!match) throw new Error('WSL process runner requires a local Windows drive path');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

function validateCwd(root, cwd) {
  const target = path.resolve(root, cwd ?? '.');
  const relative = path.relative(path.resolve(root), target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw Object.assign(new Error('Process cwd must stay inside the workspace'), { code: 'PROCESS_CWD_DENIED' });
  return target;
}

export class WslProcessRunner {
  constructor(root, { distro = 'Ubuntu', sandbox = new WslSandbox(root), spawnImpl = nodeSpawn } = {}) {
    this.root = path.resolve(root);
    this.distro = distro;
    this.sandbox = sandbox;
    this.spawnImpl = spawnImpl;
    this.verified = false;
    this.isolated = false;
    this.mode = 'wsl-bwrap-readonly-process';
  }

  async verify() {
    if (this.verified) return this.isolated;
    this.verified = true;
    try { this.isolated = await this.sandbox.verify(); } catch { this.isolated = false; }
    return this.isolated;
  }

  async start({ command, cwd = '.', timeoutMs = 30_000, onOutput = () => {}, signal } = {}) {
    if (!this.isolated && !(await this.verify())) throw Object.assign(new Error('WSL process isolation is not verified'), { code: 'PROCESS_UNAVAILABLE' });
    if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND || /[\x00-\x1f\x7f]/.test(command))
      throw Object.assign(new Error('Invalid process command'), { code: 'PROCESS_REQUEST_DENIED' });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600_000)
      throw Object.assign(new Error('Invalid process timeout'), { code: 'PROCESS_REQUEST_DENIED' });
    const target = validateCwd(this.root, cwd);
    const workspace = linuxPath(this.root);
    const working = linuxPath(target).replace(workspace, '/workspace');
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const args = ['-d', this.distro, '--exec', '/usr/bin/bwrap', '--unshare-all', '--new-session', '--die-with-parent', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--ro-bind', workspace, '/workspace', '--chdir', working,
      '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin', '/usr/bin/timeout', '--signal=TERM', String(seconds), '/bin/sh', '-c', command];
    const child = this.spawnImpl('wsl.exe', args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
    let output = '';
    const append = chunk => { output = `${output}${String(chunk)}`.slice(-64 * 1024); onOutput(String(chunk)); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let settled = false;
    let exitCode = null;
    let error = null;
    const done = new Promise(resolve => {
      child.once('error', reason => { error = reason; settled = true; resolve(); });
      child.once('close', code => { exitCode = code; settled = true; resolve(); });
    });
    const abort = () => child.kill?.();
    signal?.addEventListener('abort', abort, { once: true });
    return {
      poll: async () => { if (!settled) await Promise.race([done, Promise.resolve()]); return { done: settled, code: error ? null : exitCode }; },
      kill: async () => { child.kill?.(); await done; },
      output: () => output,
      cleanup: () => signal?.removeEventListener('abort', abort),
    };
  }
}
