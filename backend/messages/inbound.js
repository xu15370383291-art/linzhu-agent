import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BODY = 128 * 1024;
const MAX_TEXT = 32_000;
const MAX_SKEW_MS = 5 * 60_000;
const MAX_DELIVERIES = 2000;
const MAX_ATTEMPTS = 5;
const DELIVERY_RETENTION_MS = 24 * 60 * 60_000;

function signature(secret, timestamp, body) {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function equalSignature(expected, actual) {
  const left = Buffer.from(String(expected)); const right = Buffer.from(String(actual));
  return left.length === right.length && timingSafeEqual(left, right);
}

export class InboundMessageStore {
  constructor(root, { secrets = null, now = () => Date.now(), onMessage = async () => {}, onEvent = async () => {}, createSession = null, retryBaseMs = 1000, autoProcess = true } = {}) {
    this.file = path.join(path.resolve(root), '.agent-data', 'inbound-messages.json'); this.secrets = secrets; this.now = now; this.onMessage = onMessage; this.onEvent = onEvent; this.createSession = createSession; this.retryBaseMs = retryBaseMs; this.autoProcess = autoProcess; this.data = null; this.active = new Set(); this.sessionQueues = new Map(); this.acceptQueue = Promise.resolve(); this.saveQueue = Promise.resolve(); this.timer = null;
  }
  async load() {
    if (this.data) return this.data;
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { version: 1, channels: {}, mappings: {}, deliveries: {} }; }
    this.data.channels ??= {}; this.data.mappings ??= {}; this.data.deliveries ??= {};
    for (const delivery of Object.values(this.data.deliveries)) if (delivery.status === 'processing') { delivery.status = 'retry'; delivery.nextAttemptAt = this.now(); delivery.lastCode = 'GATEWAY_RESTARTED'; }
    await this.save();
    return this.data;
  }
  async save() {
    if (!this.data) return;
    const operation = this.saveQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file); }
      finally { try { await (await import('node:fs/promises')).unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    });
    this.saveQueue = operation.catch(() => {}); return operation;
  }
  async configure({ id, secretRef, enabled = true, maxSkewMs = MAX_SKEW_MS, allowedSources = [] }) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || typeof secretRef !== 'string' || !secretRef.startsWith('secret://')) throw Object.assign(new Error('Invalid inbound channel'), { code: 'INBOUND_CONFIG_INVALID' });
    if (!Number.isSafeInteger(maxSkewMs) || !Array.isArray(allowedSources) || !allowedSources.length || allowedSources.length > 100 || allowedSources.some(value => typeof value !== 'string' || !value.trim() || value.length > 256)) throw Object.assign(new Error('Inbound source allowlist and timestamp window are required'), { code: 'INBOUND_CONFIG_INVALID' });
    const data = await this.load(); data.channels[id] = { id, secretRef, enabled: enabled === true, allowedSources: [...new Set(allowedSources)], maxSkewMs: Math.min(MAX_SKEW_MS, Math.max(1000, maxSkewMs)) }; await this.save(); return { id, enabled: data.channels[id].enabled, secretConfigured: true, allowedSources: [...data.channels[id].allowedSources] };
  }
  async listChannels() { return Object.values((await this.load()).channels).map(item => ({ id: item.id, enabled: item.enabled, allowedSources: [...(item.allowedSources ?? [])], maxSkewMs: item.maxSkewMs, secretConfigured: true })); }
  async setEnabled(id, enabled) { const data = await this.load(); const item = data.channels[id]; if (!item) throw Object.assign(new Error('Inbound channel not found'), { code: 'INBOUND_CHANNEL_UNAVAILABLE' }); item.enabled = enabled === true; await this.save(); return { id, enabled: item.enabled, allowedSources: [...(item.allowedSources ?? [])], secretConfigured: true }; }
  async verify({ channel, timestamp, signature: supplied, body }) {
    const data = await this.load(); const config = data.channels[channel]; if (!config?.enabled) throw Object.assign(new Error('Inbound channel is unavailable'), { code: 'INBOUND_CHANNEL_UNAVAILABLE' });
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY) throw Object.assign(new Error('Inbound payload too large'), { code: 'INBOUND_PAYLOAD_TOO_LARGE' });
    const timestampMs = Number(timestamp) * 1000; if (!Number.isSafeInteger(timestampMs) || Math.abs(this.now() - timestampMs) > config.maxSkewMs) throw Object.assign(new Error('Inbound timestamp expired'), { code: 'INBOUND_TIMESTAMP_EXPIRED' });
    if (!this.secrets) throw Object.assign(new Error('Inbound Secret Store unavailable'), { code: 'SECRET_STORE_UNAVAILABLE' });
    const secret = await this.secrets.resolve(config.secretRef); if (!equalSignature(signature(secret, timestamp, body), supplied)) throw Object.assign(new Error('Inbound signature invalid'), { code: 'INBOUND_SIGNATURE_INVALID' });
    return config;
  }
  async accept(message) {
    const operation = this.acceptQueue.then(() => this.acceptOne(message));
    this.acceptQueue = operation.catch(() => {});
    return operation;
  }
  async acceptOne({ channel, externalConversation, messageId, text, source = null, timestamp, signature: supplied, body }) {
    await this.verify({ channel, timestamp, signature: supplied, body });
    if (typeof externalConversation !== 'string' || !externalConversation || externalConversation.length > 256 || typeof messageId !== 'string' || !messageId || messageId.length > 256 || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT)
      throw Object.assign(new Error('Inbound message shape invalid'), { code: 'INBOUND_MESSAGE_INVALID' });
    const data = await this.load(); const config = data.channels[channel];
    let signedBody;
    try { signedBody = JSON.parse(body); } catch { throw Object.assign(new Error('Inbound body must be JSON'), { code: 'INBOUND_MESSAGE_INVALID' }); }
    if (signedBody.conversation !== externalConversation || signedBody.messageId !== messageId || signedBody.text !== text || signedBody.source !== source)
      throw Object.assign(new Error('Inbound fields do not match the signed payload'), { code: 'INBOUND_MESSAGE_INVALID' });
    if (!Array.isArray(config.allowedSources) || !config.allowedSources.length || typeof source !== 'string' || !config.allowedSources.includes(source))
      throw Object.assign(new Error('Inbound source is not allowlisted'), { code: 'INBOUND_SOURCE_DENIED' });
    const deliveryKey = `${channel}:${source}:${messageId}`; const existing = data.deliveries[deliveryKey]; if (existing) return { ...this.publicDelivery(existing), duplicate: true };
    this.prune();
    if (Object.keys(data.deliveries).length >= MAX_DELIVERIES) throw Object.assign(new Error('Inbound delivery capacity reached'), { code: 'INBOUND_CAPACITY_REACHED' });
    const mappingKey = `${channel}:${source}:${externalConversation}`; let sessionId = data.mappings[mappingKey]?.sessionId;
    if (!sessionId) { const session = this.createSession ? await this.createSession({ channel, externalConversation, source }) : null; sessionId = session?.id ?? randomUUID(); data.mappings[mappingKey] = { channel, externalConversation, sessionId, source, updatedAt: this.now() }; }
    const id = randomUUID(); const textRef = `secret://inbound.message.${id}`;
    if (!this.secrets?.set) throw Object.assign(new Error('Inbound Secret Store unavailable'), { code: 'SECRET_STORE_UNAVAILABLE' });
    await this.secrets.set(`inbound.message.${id}`, text);
    const delivery = { id, key: deliveryKey, channel, externalConversation, source, messageId, sessionId, textRef, status: 'accepted', attempts: 0, createdAt: this.now(), updatedAt: this.now(), nextAttemptAt: this.now(), lastCode: null };
    data.deliveries[deliveryKey] = delivery;
    try { await this.save(); } catch (error) { await this.secrets.delete?.(`inbound.message.${id}`).catch(() => {}); delete data.deliveries[deliveryKey]; throw error; }
    if (this.autoProcess) this.scheduleProcess(delivery);
    return { ...this.publicDelivery(delivery), duplicate: false };
  }
  scheduleProcess(delivery) { setImmediate(() => { void this.process(delivery).catch(() => {}); }); }
  async listMappings() { return Object.values((await this.load()).mappings); }
  publicDelivery(delivery) { const { text, textRef, ...safe } = delivery; return { ...safe, hasText: Boolean(textRef) }; }
  async listDeliveries() { return Object.values((await this.load()).deliveries).map(item => this.publicDelivery(item)); }
  async diagnostics() { const items = Object.values((await this.load()).deliveries); return { channels: Object.keys(this.data.channels).length, accepted: items.filter(item => item.status === 'accepted').length, processing: items.filter(item => item.status === 'processing').length, retry: items.filter(item => item.status === 'retry').length, deadLetter: items.filter(item => item.status === 'dead_letter').length, completed: items.filter(item => item.status === 'processed').length, active: this.active.size }; }
  async process(deliveryOrId) {
    const data = await this.load();
    const delivery = typeof deliveryOrId === 'string' ? Object.values(data.deliveries).find(item => item.id === deliveryOrId) : deliveryOrId;
    if (!delivery) throw Object.assign(new Error('Inbound delivery not found'), { code: 'INBOUND_NOT_FOUND' });
    if (delivery.status === 'processed') return this.publicDelivery(delivery);
    if (this.active.has(delivery.key)) return this.publicDelivery(delivery);
    this.active.add(delivery.key);
    try {
      const prior = this.sessionQueues.get(delivery.sessionId) ?? Promise.resolve();
      const operation = prior.catch(() => {}).then(async () => {
        delivery.status = 'processing'; delivery.attempts++; delivery.updatedAt = this.now(); delivery.nextAttemptAt = null; await this.save();
        let result;
        let messageText;
        try { messageText = await this.secrets.resolve(delivery.textRef); result = await this.onMessage({ ...this.publicDelivery(delivery), text: messageText }); }
        catch (error) { result = { status: 'failed', code: error.code ?? 'INBOUND_PROCESSING_FAILED' }; }
        const completed = result?.status === 'processed' || result?.ok === true || typeof result?.answer === 'string';
        if (completed) { delivery.status = 'processed'; delivery.lastCode = result.code ?? 'OK'; }
        else {
          delivery.lastCode = typeof result?.code === 'string' ? result.code.slice(0, 80) : 'INBOUND_PROCESSING_FAILED';
          if (delivery.attempts >= MAX_ATTEMPTS) { delivery.status = 'dead_letter'; delivery.deadLetterAt = this.now(); }
          else { delivery.status = 'retry'; delivery.nextAttemptAt = this.now() + Math.min(60_000, this.retryBaseMs * 2 ** (delivery.attempts - 1)); }
        }
        delivery.updatedAt = this.now();
        if (completed) { const textRef = delivery.textRef; delete delivery.textRef; try { await this.save(); } catch (error) { delivery.textRef = textRef; delivery.status = 'retry'; delivery.lastCode = 'INBOUND_STATE_SAVE_FAILED'; delivery.nextAttemptAt = this.now() + this.retryBaseMs; throw error; } await this.secrets.delete?.(textRef.slice('secret://'.length)); }
        else await this.save();
        await this.onEvent({ type: 'message.updated', delivery: this.publicDelivery(delivery) });
        return this.publicDelivery(delivery);
      });
      this.sessionQueues.set(delivery.sessionId, operation);
      try { return await operation; } finally { if (this.sessionQueues.get(delivery.sessionId) === operation) this.sessionQueues.delete(delivery.sessionId); }
    } finally { this.active.delete(delivery.key); }
  }
  async retry(id) { const data = await this.load(); const delivery = Object.values(data.deliveries).find(item => item.id === id); if (!delivery) throw Object.assign(new Error('Inbound delivery not found'), { code: 'INBOUND_NOT_FOUND' }); if (delivery.status !== 'retry' && delivery.status !== 'dead_letter') throw Object.assign(new Error('Inbound delivery is not retryable'), { code: 'INBOUND_NOT_RETRYABLE' }); delivery.status = 'retry'; delivery.attempts = 0; delivery.nextAttemptAt = this.now(); delivery.lastCode = null; await this.save(); if (this.autoProcess) this.scheduleProcess(delivery); return this.publicDelivery(delivery); }
  async recoverDue() { const data = await this.load(); const due = Object.values(data.deliveries).filter(item => ['accepted', 'retry'].includes(item.status) && item.nextAttemptAt <= this.now()).slice(0, 32); return Promise.all(due.map(item => this.process(item))); }
  async startScheduler({ pollMs = 1000 } = {}) { if (this.timer) return; await this.load(); await this.recoverDue(); this.timer = setInterval(() => this.recoverDue().catch(() => {}), Math.max(250, pollMs)); this.timer.unref?.(); }
  stopScheduler() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async prune() {
    for (const item of Object.values(this.data.deliveries)) {
      if (['processed', 'dead_letter'].includes(item.status) && this.now() - item.updatedAt > DELIVERY_RETENTION_MS) {
        if (item.textRef) await this.secrets?.delete?.(item.textRef.slice('secret://'.length));
        delete this.data.deliveries[item.key];
      }
    }
  }
}
