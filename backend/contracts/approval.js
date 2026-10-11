import { createHash, randomUUID } from 'node:crypto';
import { id, text, finiteInt, noSecrets } from './common.js';

export const APPROVAL_STATUSES = new Set(['pending', 'approved', 'denied', 'expired', 'cancelled']);

export function resourceFingerprint(resource) {
  const value = typeof resource === 'string' ? resource : JSON.stringify(resource);
  if (typeof value !== 'string' || value.length > 64 * 1024) throw new TypeError('Invalid approval resource');
  return createHash('sha256').update(value).digest('hex');
}

export function createApprovalRequest({ type, operation, resource, expiresInMs = 5 * 60_000, metadata = {} }) {
  const request = {
    id: randomUUID(), type: text(type, 'approval.type', { max: 64 }), operation: text(operation, 'approval.operation', { max: 128 }),
    resourceHash: resourceFingerprint(resource), status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + finiteInt(expiresInMs, 'approval.expiresInMs', { min: 1, max: 24 * 60 * 60_000 }),
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? structuredClone(metadata) : {},
  };
  if (!noSecrets(request.metadata)) throw new TypeError('Approval metadata contains sensitive values');
  return request;
}

export function resolveApproval(request, decision, { resource, metadata } = {}) {
  if (!request || !APPROVAL_STATUSES.has(request.status)) throw new TypeError('Invalid approval request');
  if (request.status !== 'pending') throw Object.assign(new Error('Approval is no longer pending'), { code: 'APPROVAL_NOT_PENDING' });
  if (Date.now() >= request.expiresAt) return { ...request, status: 'expired', resolvedAt: Date.now() };
  if (resource !== undefined && resourceFingerprint(resource) !== request.resourceHash) throw Object.assign(new Error('Approval resource changed'), { code: 'APPROVAL_RESOURCE_CHANGED' });
  if (!['approved', 'denied', 'cancelled'].includes(decision)) throw new TypeError('Invalid approval decision');
  return { ...request, status: decision, resolvedAt: Date.now(), ...(metadata && typeof metadata === 'object' ? { metadata: { ...request.metadata, ...structuredClone(metadata) } } : {}) };
}

export function approvalId(request) { return id(request?.id, 'approval.id'); }
