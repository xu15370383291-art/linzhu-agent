import { createApprovalRequest, resolveApproval, resourceFingerprint } from '../contracts/approval.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ApprovalManager {
  constructor({ onEvent = async () => {}, root = null } = {}) { this.items = new Map(); this.onEvent = onEvent; this.file = root ? path.join(path.resolve(root), '.agent-data', 'approvals.json') : null; this.loaded = false; this.loading = null; }
  async load() { if (this.loaded) return; if (this.loading) return this.loading; this.loading = (async () => { if (this.file) { try { const data = JSON.parse(await readFile(this.file, 'utf8')); for (const item of data.items ?? []) this.items.set(item.id, item); } catch (error) { if (error.code !== 'ENOENT') throw error; } } this.loaded = true; this.loading = null; })(); return this.loading; }
  async persist() { if (!this.file) return; await mkdir(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify({ version: 1, items: [...this.items.values()].slice(-256) }, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file); }
  async request(details) { await this.load(); const request = createApprovalRequest(details); this.items.set(request.id, request); await this.persist(); await this.onEvent({ type: 'approval.required', approval: this.public(request) }); return this.public(request); }
  async resolve(id, decision, resource, metadata = undefined) { await this.load(); const request = this.items.get(id); if (!request) throw new Error('Approval not found'); const resolved = resolveApproval(request, decision, { resource, metadata }); this.items.set(id, resolved); await this.persist(); await this.onEvent({ type: 'approval.resolved', approval: this.public(resolved) }); return this.public(resolved); }
  get(id) { return this.items.get(id) ? this.public(this.items.get(id)) : null; }
  consumeApproved(id, resource) {
    const request = this.items.get(id);
    if (!request || request.status !== 'approved') return false;
    if (Date.now() >= request.expiresAt) return false;
    if (resourceFingerprint(resource) !== request.resourceHash) throw Object.assign(new Error('Approval resource changed'), { code: 'APPROVAL_RESOURCE_CHANGED' });
    this.items.delete(id);
    void this.persist();
    return true;
  }
  list() { return [...this.items.values()].map(item => this.public(item)); }
  public(item) { return { ...item, metadata: item.metadata ? structuredClone(item.metadata) : {} }; }
}
