import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertSafePath, isWithin } from './path-policy.js';
import { CapabilityBroker } from './capability.js';
import { OperationBroker } from './broker.js';
import { TransactionJournal } from './transaction-journal.js';

export const DEFAULT_LIMITS = Object.freeze({ maxFiles: 32, maxBytes: 2 * 1024 * 1024, maxPathLength: 2048 });

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class ChangePlanStore {
  constructor({ root = null, limits = {}, now = () => Date.now(), operationBroker = null, transactionJournal = null } = {}) {
    this.root = root;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.now = now;
    this.items = new Map();
    this.capabilities = operationBroker?.capabilities ?? new CapabilityBroker({ now });
    this.operationBroker = operationBroker ?? new OperationBroker({ capabilities: this.capabilities, root: this.root });
    this.transactionJournal = transactionJournal ?? (this.root ? new TransactionJournal(this.root) : null);
  }

  prepare(changes, { scope = 'external-write', expiresInMs = 5 * 60_000 } = {}) {
    if (!Array.isArray(changes) || !changes.length) throw new Error('Change plan must contain at least one file');
    if (changes.length > this.limits.maxFiles) throw Object.assign(new Error('Change plan exceeds file limit'), { code: 'CHANGE_LIMIT' });
    const normalized = changes.map((change, index) => {
      if (!change || typeof change.path !== 'string' || change.path.length > this.limits.maxPathLength) throw new Error(`Invalid change path at index ${index}`);
      if (typeof change.after !== 'string') throw new Error(`Invalid change content at index ${index}`);
      const target = this.root && !path.isAbsolute(change.path) && !path.win32.isAbsolute(change.path)
        ? path.resolve(this.root, change.path) : path.resolve(change.path);
      if (this.root && !isWithin(target, this.root)) throw Object.assign(new Error('Change path is outside the plan root'), { code: 'CHANGE_SCOPE' });
      assertSafePath(this.root, target, { operation: scope });
      return { path: target, beforeHash: change.beforeHash ?? null, afterHash: fingerprint(change.after), bytes: Buffer.byteLength(change.after), after: change.after };
    });
    const bytes = normalized.reduce((total, change) => total + change.bytes, 0);
    if (bytes > this.limits.maxBytes) throw Object.assign(new Error('Change plan exceeds byte limit'), { code: 'CHANGE_LIMIT' });
    const id = randomUUID();
    const planFingerprint = fingerprint(normalized.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })));
    const capability = this.capabilities.issue({ tool: 'change_plan', operation: 'commit', resource: { planFingerprint, scope, totalFiles: normalized.length, totalBytes: bytes }, ttlMs: expiresInMs });
    const plan = { id, scope, changes: normalized, totalFiles: normalized.length, totalBytes: bytes, fingerprint: planFingerprint, capabilityId: capability.id, createdAt: this.now(), expiresAt: this.now() + expiresInMs, status: 'pending' };
    this.items.set(id, plan);
    return this.public(plan);
  }

  approve(id, fingerprintValue) {
    const plan = this.items.get(id);
    if (!plan || plan.expiresAt <= this.now()) throw Object.assign(new Error('Change plan expired or not found'), { code: 'CHANGE_PLAN_EXPIRED' });
    if (fingerprintValue !== plan.fingerprint) throw Object.assign(new Error('Change plan changed since review'), { code: 'CHANGE_PLAN_CHANGED' });
    plan.status = 'approved'; plan.approvedAt = this.now();
    return this.public(plan);
  }

  consume(id, fingerprintValue) {
    const plan = this.items.get(id);
    if (!plan || plan.status !== 'approved') throw Object.assign(new Error('Change plan is not approved'), { code: 'CHANGE_PLAN_NOT_APPROVED' });
    if (fingerprintValue !== plan.fingerprint) throw Object.assign(new Error('Change plan changed before commit'), { code: 'CHANGE_PLAN_CHANGED' });
    this.operationBroker.consume({ token: plan.capabilityId, tool: 'change_plan', operation: 'commit', resource: { planFingerprint: plan.fingerprint, scope: plan.scope, totalFiles: plan.totalFiles, totalBytes: plan.totalBytes } });
    this.items.delete(id);
    return this.public(plan);
  }

  public(plan) {
    return { ...plan, changes: plan.changes.map(({ after, ...change }) => change) };
  }
}
