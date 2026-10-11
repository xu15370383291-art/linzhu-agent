import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./file-broker.cs', import.meta.url));
let build;
function processResult(file, args, input, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    let exceeded = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 1_000_000) { exceeded = true; child.kill(); } });
    child.stderr.on('data', chunk => { error += chunk; if (error.length > 16_000) { exceeded = true; child.kill(); } });
    child.once('error', reason => { clearTimeout(timer); reject(reason); });
    child.once('close', code => { clearTimeout(timer); if (exceeded) reject(new Error('File broker output quota exceeded'));
      else resolve({ code, output, error }); });
  });
}

async function compile() {
  if (process.platform !== 'win32') throw new Error('Windows file broker unavailable');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-broker-'));
  const binary = path.join(directory, 'file-broker.exe');
  // Use a fresh build directory rather than trusting an existing temp executable.
  const compiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const result = await processResult(compiler, ['/nologo', '/target:exe', `/out:${binary}`, '/reference:System.Web.Extensions.dll', source], '');
  if (result.code !== 0) throw new Error(`Windows broker compilation failed: ${result.output.slice(0, 500)} ${result.error.slice(0, 500)}`);
  return binary;
}

export async function withSnapshot(target, action, { mode = 'full' } = {}) {
  build ??= compile().catch(error => { build = undefined; throw error; });
  const binary = await build;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-read-snapshot-'));
  const destination = path.join(directory, 'payload');
  try {
    const result = await processResult(binary, [], JSON.stringify({ source: path.resolve(target), destination, mode }));
    const reply = JSON.parse(result.output);
    if (result.code !== 0 || reply.ok !== true) throw Object.assign(new Error(`Locked snapshot failed: ${reply.message ?? result.error}`),
      { code: /Reparse|hard links|Alternate streams|private path/.test(reply.message ?? '') ? 'WORKSPACE_ACCESS_DENIED' : 'TOOL_EXECUTION_ERROR' });
    return await action(destination, reply.metadata);
  } finally {
    const absolute = path.resolve(directory);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('agent-read-snapshot-'))
      throw new Error('Unsafe snapshot cleanup target');
    await rm(absolute, { recursive: true, force: true });
  }
}

export async function commitWindowsChange(change) {
  build ??= compile().catch(error => { build = undefined; throw error; });
  const result = await processResult(await build, [], JSON.stringify({ operation: 'commit',
    source: change.target, content: change.after, expected: change.metadata?.hash ?? 'missing' }));
  const reply = JSON.parse(result.output);
  if (result.code !== 0 || reply.ok !== true) throw new Error(`Locked write failed: ${reply.message ?? result.error}`);
}
