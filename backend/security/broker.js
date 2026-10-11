import { assertSafePath } from './path-policy.js';

export class OperationBroker {
  constructor({ capabilities, audit = null, root = null, onEvent = async () => {} } = {}) { this.capabilities = capabilities; this.audit = audit; this.root = root; this.onEvent = onEvent; }

  issue({ tool, operation, resource, ttlMs, metadata } = {}) {
    return this.capabilities.issue({ tool, operation, resource, ttlMs, metadata });
  }

  async authorize({ token, tool, operation, resource, path, bytes = 0, reserve = null }) {
    if (path) assertSafePath(this.root, path, { operation });
    if (reserve && !reserve(bytes)) throw Object.assign(new Error('Operation resource limit exceeded'), { code: 'RESOURCE_LIMIT' });
    const consumed = this.capabilities.consume(token, { tool, operation, resource });
    await this.audit?.record?.({ id: consumed.id, tool, phase: 'capability-consumed', outcome: 'approved' });
    return consumed;
  }

  consume({ token, tool, operation, resource, path, bytes = 0, reserve = null }) {
    if (path) assertSafePath(this.root, path, { operation });
    if (reserve && !reserve(bytes)) throw Object.assign(new Error('Operation resource limit exceeded'), { code: 'RESOURCE_LIMIT' });
    const consumed = this.capabilities.consume(token, { tool, operation, resource });
    void this.audit?.record?.({ id: consumed.id, tool, phase: 'capability-consumed', outcome: 'approved' });
    void this.onEvent({ type: 'operation.authorized', operation: { id: consumed.id, tool, operation } });
    return consumed;
  }

  checkPath(path, operation = 'operation') {
    return assertSafePath(this.root, path, { operation });
  }
}
