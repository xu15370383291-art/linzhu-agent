import { randomUUID } from 'node:crypto';
import { id, text, noSecrets } from './common.js';

export const EVENT_TYPES = new Set([
  'turn.started', 'turn.delta', 'turn.completed', 'turn.failed', 'turn.awaiting_approval', 'turn.awaiting_clarification',
  'tool.started', 'tool.finished', 'approval.required', 'approval.resolved',
  'task.plan.updated', 'task.structured_plan.updated', 'task.step.updated',
  'task.updated', 'message.updated', 'provider.updated', 'diagnostics.updated',
  'process.started', 'process.cancelled',
  'operation.authorized', 'operation.denied',
]);

export function createEvent(type, payload = {}, { correlationId = randomUUID(), source = 'agent' } = {}) {
  if (!EVENT_TYPES.has(type)) throw new TypeError('Unknown event type');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Invalid event payload');
  const event = { id: randomUUID(), type, source: text(source, 'event.source', { max: 64 }), correlationId: id(correlationId, 'event.correlationId'), time: new Date().toISOString(), payload: structuredClone(payload) };
  if (!noSecrets(event)) throw new TypeError('Event contains sensitive values');
  if (JSON.stringify(event).length > 128 * 1024) throw new TypeError('Event is too large');
  return Object.freeze(event);
}

export class EventBus {
  #listeners = new Set();
  on(listener) { if (typeof listener !== 'function') throw new TypeError('Event listener must be a function'); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  emit(event) { const checked = createEvent(event.type, event.payload, { correlationId: event.correlationId, source: event.source }); for (const listener of this.#listeners) { try { listener(checked); } catch { /* listeners cannot break the runtime */ } } return checked; }
}
