import { mkdir, readFile, rename, chmod, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const MAX_SECRET = 16 * 1024;
let helperPromise;

function fileKey() {
  const value = process.env.AGENT_SECRET_KEY;
  if (!value || value.length < 16) throw Object.assign(new Error('Secret Store unavailable: set AGENT_SECRET_KEY for non-Windows fallback'), { code: 'SECRET_STORE_UNAVAILABLE' });
  return scryptSync(value, 'personal-agent-secret-store-v1', 32);
}

async function dpapi(command, value) {
  if (!helperPromise) helperPromise = buildHelper();
  const helper = await helperPromise;
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [command], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0 || !stdout.trim()) return reject(new Error(stderr.trim() || `DPAPI helper exited with ${code}`));
      resolve(stdout.trim());
    });
    child.stdin.end(value);
  });
}

async function buildHelper() {
  const directory = path.join(os.tmpdir(), 'personal-agent-runtime');
  const executable = path.join(directory, 'dpapi-helper.exe');
  await mkdir(directory, { recursive: true });
  try { await access(executable); return executable; } catch { /* compile once below */ }
  const sourcePath = fileURLToPath(new URL('./dpapi-helper.cs', import.meta.url));
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const tempExecutable = path.join(directory, `${randomUUID()}.exe`);
  await execFileAsync(compiler, ['/nologo', '/target:exe', `/out:${tempExecutable}`, '/r:System.Security.dll', sourcePath], { windowsHide: true, maxBuffer: 1024 * 1024 });
  await rename(tempExecutable, executable);
  return executable;
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fileKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `aesgcm:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function decrypt(value) {
  const [, ivText, tagText, dataText] = String(value).split(':');
  if (!ivText || !tagText || !dataText) throw new Error('Invalid encrypted secret');
  const decipher = createDecipheriv('aes-256-gcm', fileKey(), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8');
}

export class SecretStore {
  constructor(root) { this.file = path.join(path.resolve(root), '.agent-data', 'secrets.json'); this.cache = null; }

  backend() { return process.platform === 'win32' ? 'dpapi' : 'aesgcm'; }

  async available() {
    if (process.platform === 'win32') {
      try { await dpapi('protect', Buffer.from('agent-secret-store-probe', 'utf8').toString('base64')); return { available: true, backend: 'dpapi' }; }
      catch (error) { return { available: false, backend: 'dpapi', code: 'SECRET_STORE_UNAVAILABLE', message: error.message }; }
    }
    try { fileKey(); return { available: true, backend: 'aesgcm' }; }
    catch (error) { return { available: false, backend: 'aesgcm', code: error.code, message: error.message }; }
  }

  async load() {
    try { this.cache = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.cache = { version: 1, backend: this.backend(), items: {} }; }
    if (this.cache.version !== 1 || !this.cache.items || typeof this.cache.items !== 'object') throw new Error('Invalid Secret Store');
    return this.cache;
  }

  async save(data = this.cache) {
    if (!data) data = await this.load();
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = path.join(path.dirname(this.file), `${randomUUID()}.tmp`);
    await import('node:fs/promises').then(fs => fs.writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 }));
    try { await chmod(temp, 0o600); } catch { /* Windows ACLs are inherited from the user data directory. */ }
    await rename(temp, this.file);
  }

  async set(id, value) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('Invalid secret ID');
    if (typeof value !== 'string' || !value || value.length > MAX_SECRET) throw new Error('Invalid secret value');
    const data = await this.load();
    const stored = process.platform === 'win32' ? `dpapi:${await dpapi('protect', Buffer.from(value, 'utf8').toString('base64'))}` : encrypt(value);
    data.items[id] = { id, backend: this.backend(), value: stored, updatedAt: Date.now() };
    await this.save(data);
    return { id, updatedAt: data.items[id].updatedAt };
  }

  async protectValue(id, value) {
    if (process.platform !== 'win32') return encrypt(value);
    return `dpapi:${await dpapi('protect', Buffer.from(value, 'utf8').toString('base64'))}`;
  }

  async unprotectValue(stored, backend) {
    if (backend === 'dpapi') return dpapi('unprotect', stored.slice('dpapi:'.length)).then(value => Buffer.from(value, 'base64').toString('utf8'));
    if (backend === 'aesgcm') return decrypt(stored);
    throw new Error('Unsupported Secret Store backend');
  }

  async get(id) {
    const item = (await this.load()).items[id];
    if (!item) return null;
    return this.unprotectValue(item.value, item.backend);
  }

  async resolve(reference) {
    if (typeof reference !== 'string' || !reference.startsWith('secret://')) throw new Error('Invalid secret reference');
    return this.get(reference.slice('secret://'.length));
  }

  async delete(id) { const data = await this.load(); delete data.items[id]; await this.save(data); }
  async listMetadata() { return Object.values((await this.load()).items).map(({ id, backend, updatedAt }) => ({ id, backend, updatedAt })); }
}
