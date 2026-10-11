import { createHash, randomUUID } from 'node:crypto';

const MAX_TTL = 10 * 60_000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function resourceFingerprint(resource) {
  return createHash('sha256').update(JSON.stringify(stable(resource))).digest('hex');
}

export class CapabilityBroker {
  constructor({ now = () => Date.now(), maxTtlMs = MAX_TTL } = {}) { this.now = now; this.maxTtlMs = maxTtlMs; this.items = new Map(); }

  issue({ tool, operation, resource, ttlMs = 5 * 60_000, metadata = {} }) {
    if (typeof tool !== 'string' || !tool || typeof operation !== 'string' || !operation) throw new Error('Capability tool and operation are required');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > this.maxTtlMs) throw new Error('Invalid capability TTL');
    const token = { id: randomUUID(), tool, operation, resourceHash: resourceFingerprint(resource), issuedAt: this.now(), expiresAt: this.now() + ttlMs, metadata: structuredClone(metadata), status: 'active' };
    this.items.set(token.id, token);
    return this.public(token);
  }

  consume(id, { tool, operation, resource }) {
    const token = this.items.get(id);
    if (!token || token.status !== 'active') throw Object.assign(new Error('Capability is unavailable or already used'), { code: 'CAPABILITY_UNAVAILABLE' });
    if (token.expiresAt <= this.now()) { token.status = 'expired'; throw Object.assign(new Error('Capability expired'), { code: 'CAPABILITY_EXPIRED' }); }
    if (token.tool !== tool || token.operation !== operation || token.resourceHash !== resourceFingerprint(resource))
      throw Object.assign(new Error('Capability scope changed'), { code: 'CAPABILITY_SCOPE_CHANGED' });
    token.status = 'consumed'; token.consumedAt = this.now(); this.items.delete(id);
    return this.public(token);
  }

  revoke(id) { const token = this.items.get(id); if (!token) return false; token.status = 'revoked'; this.items.delete(id); return true; }
  public(token) { return { ...token, metadata: structuredClone(token.metadata) }; }
}
