import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSafePath, isWithin } from './path-policy.js';

const VERSION = 1;
const MAX_ITEMS = 64;
const ALIAS = /^@[a-z][a-z0-9_-]{0,31}$/i;
const PERMISSIONS = new Set(['read', 'write']);
const SCOPES = new Set(['session', 'persistent']);

const error = (code, message) => Object.assign(new Error(message), { code });
const key = value => String(value).toLowerCase();

export class AccessGrantStore {
  constructor(root, { now = () => Date.now() } = {}) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, '.agent-data', 'access-grants.json');
    this.now = now;
    this.items = null;
    this.sessionItems = new Map();
  }

  async load() {
    if (this.items) return this.items;
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      this.items = Array.isArray(data.items) ? data.items.filter(item => item?.scope === 'persistent') : [];
    } catch (errorValue) {
      if (errorValue.code !== 'ENOENT') throw errorValue;
      this.items = [];
    }
    return this.items;
  }

  async persist() {
    const items = await this.load();
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: VERSION, items }, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.file);
    } finally {
      await import('node:fs/promises').then(fs => fs.unlink(temporary)).catch(errorValue => {
        if (errorValue.code !== 'ENOENT') throw errorValue;
      });
    }
  }

  async validateRoot(value) {
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) && !path.win32.isAbsolute(value))
      throw error('ACCESS_GRANT_PATH_INVALID', '授权目录必须是绝对路径');
    const target = path.resolve(value);
    assertSafePath(null, target, { operation: 'access-grant' });
    if (isWithin(target, this.root)) throw error('ACCESS_GRANT_WORKSPACE', '授权目录不能位于当前 Agent 工作区内');
    const stat = await lstat(target).catch(errorValue => {
      if (errorValue.code === 'ENOENT') throw error('ACCESS_GRANT_PATH_INVALID', '授权目录不存在');
      throw errorValue;
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('ACCESS_GRANT_PATH_INVALID', '授权目标必须是真实目录');
    const actual = await realpath(target);
    if (key(actual) !== key(target)) throw error('ACCESS_GRANT_LINKED_PATH', '符号链接或 junction 目录不能作为授权根目录');
    return { target, identity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs } };
  }

  normalize(input, clientIdentity) {
    const alias = String(input.alias ?? '').trim();
    if (!ALIAS.test(alias)) throw error('ACCESS_GRANT_ALIAS_INVALID', '别名必须类似 @project，只能包含字母、数字、下划线和短横线');
    const permissions = [...new Set(Array.isArray(input.permissions) ? input.permissions : [])].map(String).sort();
    if (!permissions.length || permissions.some(value => !PERMISSIONS.has(value))) throw error('ACCESS_GRANT_PERMISSION_INVALID', '当前阶段只支持 read 和 write 权限');
    const scope = input.scope ?? 'session';
    if (!SCOPES.has(scope)) throw error('ACCESS_GRANT_SCOPE_INVALID', '授权范围必须是 session 或 persistent');
    const sessionId = input.sessionId ?? null;
    if (scope === 'session' && (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId))) throw error('ACCESS_GRANT_SESSION_REQUIRED', '会话授权需要有效的 sessionId');
    return { alias, permissions, scope, sessionId: scope === 'session' ? sessionId : null, clientIdentity: String(clientIdentity ?? 'local') };
  }

  async validate(input, clientIdentity = 'local') {
    const normalized = this.normalize(input, clientIdentity);
    const root = await this.validateRoot(input.path);
    return { ...normalized, path: root.target, identity: root.identity };
  }

  async grant(input, clientIdentity = 'local') {
    const normalized = this.normalize(input, clientIdentity);
    const root = await this.validateRoot(input.path);
    const all = await this.list({ clientIdentity, sessionId: normalized.sessionId });
    if (all.some(item => key(item.alias) === key(normalized.alias))) throw error('ACCESS_GRANT_ALIAS_EXISTS', `别名 ${normalized.alias} 已存在`);
    const item = { id: randomUUID(), alias: normalized.alias, path: root.target, permissions: normalized.permissions,
      scope: normalized.scope, sessionId: normalized.scope === 'session' ? normalized.sessionId : null,
      clientIdentity: normalized.clientIdentity, identity: root.identity, createdAt: this.now(), updatedAt: this.now() };
    if (normalized.scope === 'persistent') {
      const items = await this.load();
      if (items.length >= MAX_ITEMS) throw error('ACCESS_GRANT_LIMIT', '持久化授权数量已达到上限');
      items.push(item); await this.persist();
    } else {
      const sessionKey = this.sessionKey(normalized.clientIdentity, normalized.sessionId);
      const items = this.sessionItems.get(sessionKey) ?? [];
      if (items.length >= MAX_ITEMS) throw error('ACCESS_GRANT_LIMIT', '会话授权数量已达到上限');
      items.push(item); this.sessionItems.set(sessionKey, items);
    }
    return this.public(item);
  }

  sessionKey(clientIdentity, sessionId) { return `${clientIdentity}:${sessionId}`; }

  async list({ clientIdentity = 'local', sessionId = null } = {}) {
    const persistent = (await this.load()).filter(item => item.clientIdentity === String(clientIdentity));
    const session = sessionId ? this.sessionItems.get(this.sessionKey(clientIdentity, sessionId)) ?? [] : [];
    return [...persistent, ...session].map(item => this.public(item));
  }

  async remove(id, { clientIdentity = 'local', sessionId = null } = {}) {
    const persistent = await this.load();
    const index = persistent.findIndex(item => item.id === id && item.clientIdentity === String(clientIdentity));
    if (index >= 0) { persistent.splice(index, 1); await this.persist(); return true; }
    if (sessionId) {
      const sessionKey = this.sessionKey(clientIdentity, sessionId);
      const items = this.sessionItems.get(sessionKey) ?? [];
      const sessionIndex = items.findIndex(item => item.id === id);
      if (sessionIndex >= 0) { items.splice(sessionIndex, 1); this.sessionItems.set(sessionKey, items); return true; }
    }
    throw error('ACCESS_GRANT_NOT_FOUND', '授权不存在');
  }

  async findForPath(target, permission, { clientIdentity = 'local', sessionId = null } = {}) {
    const absolute = path.resolve(target);
    const items = await this.itemsFor(clientIdentity, sessionId);
    for (const item of items) {
      if (!item.permissions.includes(permission) || !isWithin(absolute, item.path)) continue;
      if (!await this.rootMatches(item)) continue;
      return item;
    }
    return null;
  }

  async itemsFor(clientIdentity, sessionId) {
    const persistent = (await this.load()).filter(item => item.clientIdentity === String(clientIdentity));
    const session = sessionId ? this.sessionItems.get(this.sessionKey(clientIdentity, sessionId)) ?? [] : [];
    return [...persistent, ...session];
  }

  async rootMatches(item) {
    try {
      const stat = await lstat(item.path);
      const actual = await realpath(item.path);
      return stat.isDirectory() && !stat.isSymbolicLink() && key(actual) === key(item.path) && stat.dev === item.identity.dev && stat.ino === item.identity.ino;
    } catch { return false; }
  }

  async resolve(requested, { permission = 'read', clientIdentity = 'local', sessionId = null } = {}) {
    if (typeof requested !== 'string' || !requested.trim()) return requested;
    const match = requested.trim().match(/^(@[a-z][a-z0-9_-]{0,31})(?:[\\/](.*))?$/i);
    if (!match) return requested;
    const items = await this.itemsFor(clientIdentity, sessionId);
    const item = items.find(candidate => key(candidate.alias) === key(match[1]) && candidate.permissions.includes(permission));
    if (!item) throw error('ACCESS_GRANT_PERMISSION_DENIED', `没有 ${match[1]} 的 ${permission} 权限`);
    if (!await this.rootMatches(item)) throw error('ACCESS_GRANT_ROOT_CHANGED', `授权目录 ${match[1]} 已变化，请重新授权`);
    const target = path.resolve(item.path, match[2] ?? '.');
    if (!isWithin(target, item.path)) throw error('ACCESS_GRANT_SCOPE_DENIED', '路径超出了授权目录范围');
    return target;
  }

  public(item) {
    const { clientIdentity, identity, ...safe } = item;
    return { ...safe, permissions: [...item.permissions] };
  }
}
