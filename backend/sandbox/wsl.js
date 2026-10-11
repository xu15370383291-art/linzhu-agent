import { spawn } from 'node:child_process';
import path from 'node:path';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withSnapshot } from './snapshot.js';

const MAX_OUTPUT = 64_000;
const MAX_READ_OUTPUT = 256_000;
const MAX_TIME = 15_000;
const readerScript = fileURLToPath(new URL('./read-worker.py', import.meta.url));
const supervisorScript = fileURLToPath(new URL('./supervisor.py', import.meta.url));
const privateName = name => ['.agent-data', '.git', 'node_modules', '.env'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('.env.');

function linuxPath(root) {
  const absolute = path.win32.resolve(root);
  const match = /^([a-z]):\\(.*)$/i.exec(absolute);
  if (!match) throw new Error('Sandbox requires a local Windows drive path');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

function capture(file, args, { timeoutMs = MAX_TIME, signal, outputLimit = MAX_OUTPUT } = {}) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('Sandbox execution cancelled'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let exceeded = false;
    let timedOut = false;
    let killTimer;
    const cancel = () => {
      child.stdin.end();
      killTimer ??= setTimeout(() => child.kill(), 1000);
    };
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs + 5000);
    const add = (stream, current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > outputLimit) { exceeded = true; cancel(); return current; }
      return next;
    };
    child.stdout.on('data', chunk => { stdout = add(child.stdout, stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = add(child.stderr, stderr, chunk); });
    const abort = cancel;
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (exceeded) return reject(new Error('Sandbox output limit exceeded'));
      if (signal?.aborted) return reject(Object.assign(new Error('Sandbox execution cancelled'), { name: 'AbortError' }));
      if (timedOut) return reject(new Error('Sandbox execution timed out'));
      if (code === 124) return reject(new Error('Sandbox execution timed out'));
      if (code === 130) return reject(new Error('Sandbox execution cancelled'));
      resolve({ exitCode: code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

export class WslSandbox {
  constructor(root, { distro = 'Ubuntu', runTask = action => action(undefined), snapshot = withSnapshot } = {}) {
    this.root = path.resolve(root);
    this.distro = distro;
    this.runTask = runTask;
    this.snapshot = snapshot;
  }

  async launch(mounts, program, { timeoutMs = MAX_TIME, signal, reader = false } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIME) throw new Error('Invalid sandbox timeout');
    const args = ['-d', this.distro, '--exec', '/usr/bin/systemd-run', '--user', '--quiet', '--wait', '--pipe', '--collect',
      '--property=MemoryMax=384M', '--property=MemorySwapMax=0', '--property=TasksMax=64', '--property=CPUQuota=100%',
      '--property=RuntimeMaxSec=20', '--property=TimeoutStopSec=1', '--property=KillMode=control-group',
      '/usr/bin/bwrap', '--unshare-all', '--new-session', '--die-with-parent', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', ...mounts,
      ...(reader ? ['--ro-bind', linuxPath(readerScript), '/reader.py'] : []),
      '--ro-bind', linuxPath(supervisorScript), '/supervisor.py',
      '--chdir', '/workspace', '--setenv', 'HOME', '/tmp', '--setenv', 'PATH', '/usr/bin:/bin',
      '/usr/bin/python3', '/supervisor.py', String(timeoutMs / 1000), ...program];
    return this.runTask(taskSignal => capture('wsl.exe', args, { timeoutMs,
      signal: signal && taskSignal ? AbortSignal.any([signal, taskSignal]) : signal ?? taskSignal,
      outputLimit: reader ? MAX_READ_OUTPUT : MAX_OUTPUT }));
  }

  async execute(command, { timeoutMs = MAX_TIME, signal } = {}) {
    if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\x00-\x1f\x7f]/.test(command))
      throw new Error('Invalid sandbox command');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIME) throw new Error('Invalid sandbox timeout');
    return this.run(['/bin/sh', '-c', command], { timeoutMs, signal });
  }

  async executeSkillScript({ directory, scriptName, input = '', timeoutMs = 5000, signal } = {}) {
    if (typeof scriptName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.py$/.test(scriptName)) throw new Error('Invalid skill script name');
    if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 16 * 1024) throw new Error('Skill script input exceeds 16 KB');
    const target = path.resolve(directory);
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Skill directory must be a real directory');
    const script = `/skill/scripts/${scriptName}`;
    const command = `printf %s ${shellQuote(Buffer.from(input).toString('base64'))} | base64 -d | /usr/bin/python3 ${shellQuote(script)}`;
    return this.snapshot(target, async snapshot => {
      const result = await this.launch(['--ro-bind', linuxPath(snapshot), '/skill'], ['/bin/sh', '-c', command], { timeoutMs, signal });
      return { exitCode: result.exitCode, stdout: result.stdout.slice(0, 32000), stderr: result.stderr.slice(0, 8000), sandboxed: true, network: 'disabled', filesystem: 'skill-snapshot-read-only' };
    }, { mode: 'full' });
  }

  async executeWritable(directory, command, { timeoutMs = MAX_TIME, signal } = {}) {
    if (typeof command !== 'string' || !command.trim() || command.length > 2000 || /[\x00-\x1f\x7f]/.test(command)) throw new Error('Invalid writable sandbox command');
    const target = path.resolve(directory);
    if (!path.basename(target).startsWith('agent-writable-sandbox-') || path.dirname(target) !== path.resolve(os.tmpdir())) throw new Error('Writable sandbox directory is not an approved disposable path');
    const stat = await lstat(target); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Writable sandbox directory must be real');
    return this.launch(['--bind', linuxPath(target), '/workspace'], ['/bin/sh', '-c', command], { timeoutMs, signal });
  }

  async run(program, { timeoutMs = MAX_TIME, signal, reader = false } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('Sandbox execution cancelled'), { name: 'AbortError' });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIME) throw new Error('Invalid sandbox timeout');
    linuxPath(this.root);
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Sandbox workspace must be a real directory');
    return withSnapshot(this.root, snapshot => this.launch(
      ['--dir', '/workspace', '--ro-bind', linuxPath(snapshot), '/workspace'], program,
      { timeoutMs, signal, reader }));
  }

  async readExternal(name, args, target) {
    if (!['file_info', 'read_file', 'list_files', 'find_files', 'search_text'].includes(name)) throw new Error('Unsupported isolated file operation');
    // Windows may deny opening a whole drive root with the file broker. The
    // verified WSL reader can mount that root read-only without host writes.
    if (path.win32.parse(path.resolve(target)).root.toLowerCase() === path.resolve(target).toLowerCase() &&
        path.win32.parse(target).root.toLowerCase() === path.resolve(target).toLowerCase()) {
      const stat = await lstat(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('External read target changed');
      return this.readExternalSnapshot(name, args, target, '');
    }
    return withSnapshot(target, async (snapshot, metadata) => {
      const result = await this.readExternalSnapshot(name, args, snapshot, path.basename(target));
      if (name === 'file_info') return { ...result, ...metadata['.'], path: metadata['.'].type === 'directory' ? '.' : path.basename(target),
        totalLines: metadata['.'].sizeBytes > 2_000_000 ? null : result.totalLines };
      return result;
    }, { mode: name });
  }

  async readExternalSnapshot(name, args, target, filename) {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || (!stat.isFile() && !stat.isDirectory()))
      throw new Error('External read target changed');
    const payload = Buffer.from(JSON.stringify({ name, args: { ...args,
      path: stat.isDirectory() ? '.' : filename } })).toString('base64url');
    if (payload.length > 8000) throw new Error('File operation arguments too large');
    const guest = linuxPath(target);
    const mounts = stat.isDirectory()
      ? ['--ro-bind', guest, '/workspace']
      : ['--dir', '/workspace', '--ro-bind', guest, `/workspace/${filename}`];
    const result = await this.launch(mounts, ['/usr/bin/python3', '/reader.py', payload],
    { timeoutMs: 10_000, reader: true });
    if (result.exitCode !== 0) throw new Error(`Isolated external read failed: ${result.stderr.trim().slice(0, 300)}`);
    const reply = JSON.parse(result.stdout);
    if (!reply.ok) throw Object.assign(new Error(reply.message), { code: reply.code });
    return reply.value;
  }

  async readOperation(name, args) {
    if (!['file_info', 'read_file', 'list_files', 'find_files', 'search_text'].includes(name)) throw new Error('Unsupported isolated file operation');
    const relative = (args.path ?? '.').replaceAll('\\', '/');
    if (path.win32.isAbsolute(relative) || relative.includes(':') || relative.split('/').some(part => part === '..' || privateName(part)))
      throw Object.assign(new Error('Path escapes or accesses private agent data'), { code: 'WORKSPACE_ACCESS_DENIED' });
    const target = path.resolve(this.root, relative);
    return withSnapshot(target, async (snapshot, metadata) => {
      const result = await this.readExternalSnapshot(name, args, snapshot, path.basename(target));
      if (name === 'file_info') return { ...result, ...metadata['.'], path: args.path, totalLines: metadata['.'].sizeBytes > 2_000_000 ? null : result.totalLines };
      if (result && typeof result === 'object') {
        const prefix = relative === '.' ? '' : `${relative.replace(/^\.\//, '').replace(/\/$/, '')}/`;
        if (Array.isArray(result.items)) result.items = result.items.map(item => ({ ...item, path: prefix + item.path }));
        if (Array.isArray(result.matches)) result.matches = result.matches.map(item => ({ ...item, path: prefix + item.path }));
        if (name === 'read_file') result.path = args.path;
      }
      return result;
    }, { mode: name });
  }

  async verify() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-sandbox-probe-'));
    const execute = command => this.launch(['--ro-bind', linuxPath(directory), '/workspace'], ['/bin/sh', '-c', command]);
    try {
    await withSnapshot(directory, async () => {});
    const probe = await execute('test ! -e /mnt/c && test ! -e /mnt/d && test ! -e /home && test ! -e /init && test ! -e /proc/sys/fs/binfmt_misc/WSLInterop && ! touch .sandbox-write-probe 2>/dev/null');
    if (probe.exitCode !== 0) throw new Error(`Sandbox filesystem probe failed: ${probe.stderr}`);
    const network = await execute('cat /proc/net/route');
    if (network.exitCode !== 0 || network.stdout.trim().split('\n').length > 1) throw new Error('Sandbox network probe failed');
    const connection = await execute("python3 -c 'import socket; s=socket.socket(); s.settimeout(1); s.connect((\"1.1.1.1\", 80))'");
    if (connection.exitCode === 0 || !/Network is unreachable|Permission denied|Operation not permitted/.test(connection.stderr))
      throw new Error('Sandbox network denial could not be verified');
    return true;
    } finally {
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('agent-sandbox-probe-'))
        throw new Error('Unsafe sandbox probe cleanup target');
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
