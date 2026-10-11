import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CapabilityBroker } from '../security/capability.js';
import { OperationBroker } from '../security/broker.js';

function checkUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Webhook requires HTTPS or localhost HTTP');
  if (url.username || url.password || url.hash) throw new Error('Webhook URL cannot contain credentials or fragments');
  return url.href;
}

export class MessageStore {
  constructor(root, { secrets = null, fetchImpl = fetch, transport = null, onEvent = async () => {}, operationBroker = null } = {}) {
    this.file = path.join(path.resolve(root), '.agent-data', 'messages.json'); this.secrets = secrets; this.fetch = fetchImpl; this.transport = transport; this.onEvent = onEvent; this.data = null; this.capabilities = operationBroker?.capabilities ?? new CapabilityBroker(); this.operationBroker = operationBroker ?? new OperationBroker({ capabilities: this.capabilities });
  }
  async load() { if (this.data) return this.data; try { this.data = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { version: 1, channels: {}, deliveries: {} }; } return this.data; }
  async save() { const data = await this.load(); await mkdir(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file); }
  async addWebhook({ id, url, secretRef = null, enabled = false }) { if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) throw new Error('Invalid channel ID'); const data = await this.load(); data.channels[id] = { id, type: 'webhook', url: checkUrl(url), secretRef, enabled: enabled === true }; await this.save(); return this.publicChannel(data.channels[id]); }
  async listChannels() { return Object.values((await this.load()).channels).map(item => this.publicChannel(item)); }
  async setEnabled(id, enabled) { const data = await this.load(); if (!data.channels[id]) throw new Error('Message channel not found'); data.channels[id].enabled = enabled === true; await this.save(); return this.publicChannel(data.channels[id]); }
  publicChannel(item) { return { id: item.id, type: item.type, url: item.url, secretRef: Boolean(item.secretRef), enabled: item.enabled }; }
  async send({ channel, conversation, text, idempotencyKey = randomUUID(), attachments = [] }, { signal } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 32_000) throw new Error('Invalid message text');
    const data = await this.load(); const target = data.channels[channel]; if (!target || !target.enabled) throw Object.assign(new Error('Message channel is unavailable'), { code: 'CHANNEL_UNAVAILABLE' });
    const existing = data.deliveries[idempotencyKey]; if (existing) return existing;
    const capability = this.capabilities.issue({ tool: 'send_message', operation: 'deliver', resource: { channel, conversation, text, idempotencyKey } });
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey };
    if (target.secretRef) { if (!this.secrets) throw Object.assign(new Error('Message Secret Store unavailable'), { code: 'SECRET_STORE_UNAVAILABLE' }); headers.Authorization = `Bearer ${await this.secrets.resolve(target.secretRef)}`; }
    const payload = { channel, conversation, text, attachments: Array.isArray(attachments) ? attachments.slice(0, 10) : [] };
    this.operationBroker.consume({ token: capability.id, tool: 'send_message', operation: 'deliver', resource: { channel, conversation, text, idempotencyKey } });
    const result = this.transport ? await this.transport(target, payload, { headers, signal }) : await this.fetch(target.url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    if (!result || result.ok === false) throw Object.assign(new Error('Message delivery failed'), { code: 'DELIVERY_FAILED' });
    const delivery = { id: randomUUID(), idempotencyKey, channel, status: 'delivered', createdAt: Date.now() }; data.deliveries[idempotencyKey] = delivery; await this.save(); await this.onEvent({ type: 'message.updated', delivery }); return delivery;
  }
  async action(action, { channel, messageId, conversation, text, attachment, idempotencyKey = randomUUID() }, { signal } = {}) {
    if (!['edit', 'delete', 'react', 'file'].includes(action)) throw new Error('Unsupported message action');
    const data = await this.load(); const target = data.channels[channel]; if (!target || !target.enabled) throw Object.assign(new Error('Message channel is unavailable'), { code: 'CHANNEL_UNAVAILABLE' });
    if (!messageId || typeof messageId !== 'string' || messageId.length > 256) throw new Error('Invalid message ID');
    if (action === 'edit' && (typeof text !== 'string' || !text.trim() || text.length > 32_000)) throw new Error('Invalid message text');
    if (action === 'file' && (!attachment || typeof attachment !== 'object')) throw new Error('Invalid message attachment');
    const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey };
    if (target.secretRef) { if (!this.secrets) throw Object.assign(new Error('Message Secret Store unavailable'), { code: 'SECRET_STORE_UNAVAILABLE' }); headers.Authorization = `Bearer ${await this.secrets.resolve(target.secretRef)}`; }
    const payload = { action, messageId, conversation, ...(text === undefined ? {} : { text }), ...(attachment === undefined ? {} : { attachment }) };
    const capability = this.capabilities.issue({ tool: `${action}_message`, operation: 'deliver', resource: { channel, messageId, conversation, text: text ?? null, attachment: attachment ?? null, idempotencyKey } });
    this.operationBroker.consume({ token: capability.id, tool: `${action}_message`, operation: 'deliver', resource: { channel, messageId, conversation, text: text ?? null, attachment: attachment ?? null, idempotencyKey } });
    const result = this.transport ? await this.transport(target, payload, { headers, signal }) : await this.fetch(target.url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    if (!result || result.ok === false) throw Object.assign(new Error('Message delivery failed'), { code: 'DELIVERY_FAILED' });
    const delivery = { id: randomUUID(), idempotencyKey, channel, messageId, action, status: 'delivered', createdAt: Date.now() }; data.deliveries[idempotencyKey] = delivery; await this.save(); await this.onEvent({ type: 'message.updated', delivery }); return delivery;
  }
  async deliveries() { return Object.values((await this.load()).deliveries); }
}
