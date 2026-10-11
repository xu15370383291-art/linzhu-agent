import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureBranches, forkBranch, rewindBranch, switchBranch } from './sessions/branches.js';

export class Sessions {
  constructor(root) {
    this.dir = path.join(root, '.agent-data', 'sessions');
  }

  file(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid session ID');
    return path.join(this.dir, `${id}.json`);
  }

  async create({ project = null } = {}) {
    const session = ensureBranches({ id: randomUUID(), createdAt: new Date().toISOString(), messages: [], ...(project ? { project: structuredClone(project) } : {}) });
    await this.save(session);
    return session;
  }

  async get(id) {
    return ensureBranches(JSON.parse(await readFile(this.file(id), 'utf8')));
  }

  async save(session) {
    ensureBranches(session);
    const existing = await this.get(session.id).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const first = session.messages.find(message => message.role === 'user' && typeof message.content === 'string');
    if (!session.title || (session.title === '新会话' && !existing?.messages?.length && first)) {
      session.title = first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 80) : '新会话';
    }
    session.updatedAt = new Date().toISOString();
    await mkdir(this.dir, { recursive: true });
    const target = this.file(session.id);
    const temp = path.join(this.dir, `${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(session, null, 2), 'utf8');
    await rename(temp, target);
  }

  async list() {
    try {
      return (await readdir(this.dir)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).map((name) => name.slice(0, -5));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async summaries(query = '', { archived = false } = {}) {
    const entries = await Promise.all((await this.list()).map(async id => {
      try {
        const session = await this.get(id);
        const info = await stat(this.file(id));
        const first = session.messages?.find(message => message.role === 'user' && typeof message.content === 'string');
        return { id, title: session.title || (first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 80) : '新会话'), ...(session.project ? { project: structuredClone(session.project) } : {}),
          createdAt: session.createdAt, updatedAt: session.updatedAt || info.mtime.toISOString(), ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}),
          messageCount: session.messages?.filter(message => message.role === 'user').length ?? 0 };
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
      }
    }));
    return entries.filter(entry => entry && Boolean(entry.archivedAt) === archived && `${entry.title} ${entry.id}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async archive(id) {
    const session = await this.get(id);
    if (!session.archivedAt) {
      session.archivedAt = new Date().toISOString();
      await this.save(session);
    }
    return session;
  }

  async restore(id) {
    const session = await this.get(id);
    if (session.archivedAt) {
      delete session.archivedAt;
      await this.save(session);
    }
    return session;
  }

  async rename(id, title) {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 80) throw new Error('Title must be 1-80 characters');
    const session = await this.get(id);
    session.title = title.trim();
    await this.save(session);
    return session;
  }

  async branches(id) { const session = await this.get(id); return session.branches; }
  async fork(id, name) { const session = await this.get(id); const branch = forkBranch(session, name); await this.save(session); return { session, branch }; }
  async useBranch(id, branchId) { const session = await this.get(id); const branch = switchBranch(session, branchId); await this.save(session); return { session, branch }; }
  async rewind(id, messageId) { const session = await this.get(id); const branch = rewindBranch(session, messageId); await this.save(session); return { session, branch }; }
}
