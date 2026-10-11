import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class UsageLedger {
  constructor(root, pricing) { this.file = path.join(root, '.agent-data', 'usage.jsonl'); this.pricing = pricing; }
  async record(event) {
    const cost = event.cost && Number.isFinite(event.cost.amount) ? { amount: event.cost.amount, currency: String(event.cost.currency ?? 'USD').slice(0, 12), configured: Boolean(event.cost.configured) } : undefined;
    const safe = { id: randomUUID(), time: new Date().toISOString(),
      ...(event.requestId ? { requestId: String(event.requestId).slice(0, 100) } : {}),
      ...(event.sessionId ? { sessionId: String(event.sessionId).slice(0, 100) } : {}),
      ...(event.model ? { model: String(event.model).slice(0, 160) } : {}),
      ...(event.status ? { status: String(event.status).slice(0, 40) } : {}),
      ...(event.cacheHit === undefined ? {} : { cacheHit: Boolean(event.cacheHit) }),
      ...(event.usage ? { usage: event.usage } : {}), ...(cost ? { cost } : {}) };
    const line = JSON.stringify(safe) + '\n';
    await mkdir(path.dirname(this.file), { recursive: true });
    let existing = ''; try { existing = await readFile(this.file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = path.join(path.dirname(this.file), `${randomUUID()}.tmp`);
    await writeFile(temp, existing + line, { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file);
  }
  async list() { try { return (await readFile(this.file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
  async summarize({ sessionId, start, end } = {}) {
    const events = (await this.list()).filter(event => (!sessionId || event.sessionId === sessionId) && (!start || event.time >= start) && (!end || event.time < end));
    return events.reduce((summary, event) => {
      summary.requests++;
      summary.inputTokens += event.usage?.inputTokens ?? 0;
      summary.outputTokens += event.usage?.outputTokens ?? 0;
      summary.totalTokens += event.usage?.totalTokens ?? 0;
      if (event.usage?.source !== 'provider') summary.estimatedRequests++;
      if (event.cost?.configured && Number.isFinite(event.cost.amount)) { summary.cost += event.cost.amount; summary.currency = event.cost.currency; }
      return summary;
    }, { requests: 0, estimatedRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, currency: 'USD' });
  }
  async exportSafe() { return (await this.list()).map(({ id, time, requestId, sessionId, model, status, usage, cost, cacheHit }) => ({ id, time, requestId, sessionId, model, status, usage, cost, cacheHit })); }
}
