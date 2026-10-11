import { id, text, finiteInt, noSecrets } from './common.js';

export const MEMORY_STATUSES = new Set(['candidate', 'active', 'superseded', 'expired', 'deleted']);
export const MEMORY_SCOPES = new Set(['global', 'project', 'session', 'task']);
export const MEMORY_SOURCES = new Set(['user', 'agent-suggestion', 'import', 'system']);

export function validateMemory(input, { allowCandidate = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid memory');
  const status = input.status ?? (allowCandidate ? 'candidate' : 'active');
  const memory = {
    ...(input.id === undefined ? {} : { id: id(input.id, 'memory.id') }),
    kind: text(input.kind ?? 'fact', 'memory.kind', { max: 64 }),
    scope: input.scope ?? 'global',
    status,
    source: input.source ?? 'user',
    content: text(input.content, 'memory.content', { max: 8_000 }),
    ...(input.projectId === undefined ? {} : { projectId: id(input.projectId, 'memory.projectId') }),
    ...(input.sessionId === undefined ? {} : { sessionId: id(input.sessionId, 'memory.sessionId') }),
    ...(input.taskId === undefined ? {} : { taskId: id(input.taskId, 'memory.taskId') }),
    confidence: input.confidence === undefined ? 1 : input.confidence,
    importance: input.importance === undefined ? 0.5 : input.importance,
    sensitive: input.sensitive === true,
    ...(input.expiresAt === null || input.expiresAt === undefined ? {} : { expiresAt: finiteInt(input.expiresAt, 'memory.expiresAt') }),
  };
  if (!MEMORY_SCOPES.has(memory.scope) || !MEMORY_STATUSES.has(memory.status) || !MEMORY_SOURCES.has(memory.source)) throw new TypeError('Invalid memory scope, status or source');
  if (!Number.isFinite(memory.confidence) || memory.confidence < 0 || memory.confidence > 1) throw new TypeError('Invalid memory.confidence');
  if (!Number.isFinite(memory.importance) || memory.importance < 0 || memory.importance > 1) throw new TypeError('Invalid memory.importance');
  if (memory.status === 'candidate' && !allowCandidate) throw new TypeError('Candidate memory is not allowed here');
  if (!noSecrets(memory)) throw Object.assign(new TypeError('Sensitive content cannot be stored in memory'), { code: 'MEMORY_SENSITIVE' });
  return Object.freeze(memory);
}

export function memoryRank(memory, { queryScore = 0, now = Date.now() } = {}) {
  const age = Math.max(0, now - (memory.updatedAt ?? memory.createdAt ?? now));
  const freshness = Math.exp(-age / (30 * 24 * 60 * 60 * 1000));
  return queryScore * 0.6 + (memory.importance ?? 0.5) * 0.2 + (memory.confidence ?? 1) * 0.1 + freshness * 0.1;
}
