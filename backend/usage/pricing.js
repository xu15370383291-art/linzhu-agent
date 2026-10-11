import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const defaults = { version: 1, currency: 'USD', items: [] };

export class Pricing {
  constructor(root) { this.file = path.join(root, '.agent-data', 'pricing.json'); }
  async load() {
    try { return { ...defaults, ...(JSON.parse(await readFile(this.file, 'utf8'))) }; }
    catch (error) { if (error.code === 'ENOENT') return structuredClone(defaults); throw error; }
  }
  async save(data) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = path.join(path.dirname(this.file), `${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.file);
  }
  async set(item) {
    if (!item?.model || !Number.isFinite(item.inputPerMillion) || !Number.isFinite(item.outputPerMillion)) throw new Error('Invalid model pricing');
    const data = await this.load();
    data.items = data.items.filter(value => value.model !== item.model);
    data.items.push({ model: item.model, inputPerMillion: Math.max(0, item.inputPerMillion), outputPerMillion: Math.max(0, item.outputPerMillion), cachedInputPerMillion: Math.max(0, item.cachedInputPerMillion ?? item.inputPerMillion) });
    await this.save(data); return data;
  }
  async cost(model, usage) {
    const data = await this.load(); const item = data.items.find(value => value.model === model);
    if (!item || !usage) return { amount: null, currency: data.currency, configured: false };
    const input = Math.max(0, usage.inputTokens ?? 0) - Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens ?? 0);
    const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens ?? 0);
    const output = usage.outputTokens ?? 0;
    const amount = (input * item.inputPerMillion + cached * item.cachedInputPerMillion + output * item.outputPerMillion) / 1_000_000;
    return { amount, currency: data.currency, configured: true };
  }
}
