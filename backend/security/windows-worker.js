import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('./windows-worker.cs', import.meta.url));
const MAX_OUTPUT = 128 * 1024;
const MAX_COMMAND = 256;

function runProcess(file, args, input, { timeoutMs = 30_000, outputLimit = MAX_OUTPUT, signal, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exceeded = false, timedOut = false, settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
    const kill = () => { try { child.kill(); } catch {} };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => { kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    const append = (target, chunk) => { if (target === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString(); if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > outputLimit) { exceeded = true; kill(); } };
    child.stdout.on('data', chunk => append('stdout', chunk)); child.stderr.on('data', chunk => append('stderr', chunk));
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); finish(reject, error); });
    child.once('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (signal?.aborted) return finish(reject, Object.assign(new Error('Worker cancelled'), { name: 'AbortError' })); if (timedOut) return finish(reject, Object.assign(new Error('Worker timed out'), { code: 'WORKER_TIMEOUT' })); if (exceeded) return finish(reject, Object.assign(new Error('Worker output limit exceeded'), { code: 'WORKER_OUTPUT_LIMIT' })); finish(resolve, { code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

export class WindowsWorkerRunner {
  constructor(root, { compiler = null, sourceFile = source, spawnImpl = spawn } = {}) {
    this.root = path.resolve(root); this.compiler = compiler ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'); this.sourceFile = sourceFile; this.spawnImpl = spawnImpl; this.mode = 'windows-restricted-token-job-low-integrity'; this.isolated = false; this.verified = false; this.directory = null; this.binary = null;
  }
  async compile() {
    if (this.binary) return this.binary;
    if (process.platform !== 'win32') throw Object.assign(new Error('Windows Worker requires Windows'), { code: 'WORKER_UNAVAILABLE' });
    this.directory = await mkdtemp(path.join(os.tmpdir(), 'personal-agent-worker-'));
    this.binary = path.join(this.directory, 'windows-worker.exe');
    const result = await runProcess(this.compiler, ['/nologo', '/target:exe', `/out:${this.binary}`, '/reference:System.Web.Extensions.dll', this.sourceFile], '', { timeoutMs: 30_000, outputLimit: 32 * 1024, signal: null, spawnImpl: this.spawnImpl });
    if (result.code !== 0) { await this.close(); throw Object.assign(new Error(`Windows Worker compilation failed: ${result.stdout.slice(0, 500)} ${result.stderr.slice(0, 500)}`), { code: 'WORKER_UNAVAILABLE' }); }
    return this.binary;
  }
  async invoke(request, { signal } = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.operation !== 'readonly-command' && request.operation !== 'probe') throw Object.assign(new Error('Worker request is not allowed'), { code: 'WORKER_REQUEST_DENIED' });
    if (request.operation === 'readonly-command' && (typeof request.command !== 'string' || !request.command.trim() || request.command.length > MAX_COMMAND || /[\x00-\x1f\x7f"&|<>`]/.test(request.command))) throw Object.assign(new Error('Worker command is not read-only'), { code: 'WORKER_REQUEST_DENIED' });
    const binary = await this.compile();
    const result = await runProcess(binary, [], JSON.stringify(request), { timeoutMs: request.timeoutMs ?? 20_000, signal, outputLimit: MAX_OUTPUT, spawnImpl: this.spawnImpl });
    let value; try { value = JSON.parse(result.stdout); } catch { throw Object.assign(new Error('Worker returned invalid protocol data'), { code: 'WORKER_PROTOCOL_ERROR' }); }
    if (value.ok !== true || value.restrictedToken !== true || value.lowIntegrity !== true || value.jobObject !== true) {
      const detail = [value.message, value.stderr, `restricted=${value.restrictedToken}`, `lowIntegrity=${value.lowIntegrity}`, `job=${value.jobObject}`, `exit=${value.exitCode}`].filter(Boolean).join('; ').slice(0, 600);
      throw Object.assign(new Error(detail || 'Worker isolation verification failed'), { code: 'WORKER_UNAVAILABLE' });
    }
    return value;
  }
  async verify() { if (this.verified) return this.isolated; this.verified = true; try { const result = await this.invoke({ operation: 'probe' }); this.isolated = result.ok === true && result.restrictedToken === true && result.lowIntegrity === true && result.jobObject === true; } catch { this.isolated = false; } return this.isolated; }
  readiness() { return { available: this.isolated === true, mode: this.mode, reason: this.isolated ? null : 'Windows restricted-token worker is not verified' }; }
  async run(request, options = {}) { if (!this.isolated && !(await this.verify())) throw Object.assign(new Error('Windows Worker is not verified'), { code: 'WORKER_UNAVAILABLE' }); return this.invoke(request, options); }
  async close() { if (this.directory) { const target = path.resolve(this.directory); if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('personal-agent-worker-')) throw new Error('Unsafe Worker cleanup target'); await rm(target, { recursive: true, force: true }); } this.directory = null; this.binary = null; this.isolated = false; }
}
