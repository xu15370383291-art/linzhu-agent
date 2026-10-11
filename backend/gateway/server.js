import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createEvent, EventBus } from '../contracts/events.js';
import { registeredTools } from '../tools/registry.js';
import { createHash } from 'node:crypto';
import { branchMessages } from '../sessions/branches.js';
import { GatewayTurnStore } from './turn-store.js';
import { redactText } from '../secrets/redact.js';
import { validateEmbeddingSettings, createEmbeddingProvider } from '../memory/embedding-provider.js';
import { AttachmentExtractor } from '../attachments/extract.js';
import { AttachmentStore } from '../attachments/store.js';
import { Workspace } from '../workspace.js';
import { modelConnectionError } from '../models.js';

const MAX_BODY = 256 * 1024;
const MAX_ATTACHMENT_BODY = 10 * 1024 * 1024;
const MAX_WS_FRAME = 128 * 1024;

function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); }
async function rawBody(req, limit = MAX_BODY) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request too large'), { code: 'REQUEST_TOO_LARGE' }); chunks.push(Buffer.from(chunk)); } return Buffer.concat(chunks); }
async function body(req) { return JSON.parse(await rawBody(req) || '{}'); }

export class LocalGateway {
  constructor({ root, models, sessions, projects = null, memory, memoryEmbedding = null, initializeMemory = async () => {}, getEmbeddingConfigError = () => null, skills, tasks, messages, inbound = null, mcp = null, plugins = null, accessGrants = null, autostart = null, approvals, securityModeStore = null, runTurn = null, attachmentStore = null, diagnostics = null, token = process.env.AGENT_GATEWAY_TOKEN || null, eventBus = new EventBus(), health = async () => ({ ok: true }) } = {}) {
    this.root = root; this.models = models; this.sessions = sessions; this.projects = projects; this.memory = memory; this.memoryEmbedding = memoryEmbedding; this.initializeMemory = initializeMemory; this.getEmbeddingConfigError = getEmbeddingConfigError; this.skills = skills; this.tasks = tasks; this.messages = messages; this.inbound = inbound; this.mcp = mcp; this.plugins = plugins; this.accessGrants = accessGrants; this.autostart = autostart; this.approvals = approvals; this.securityModeStore = securityModeStore; this.runTurn = runTurn; this.diagnostics = diagnostics; this.token = token; this.events = eventBus; this.health = health; this.clients = new Set();
    this.attachments = root ? new AttachmentExtractor(new Workspace(root)) : null;
    this.attachmentStore = attachmentStore ?? (root ? new AttachmentStore(root) : null);
    this.turns = new GatewayTurnStore(root, { approvals, emit: (type, payload, options) => this.emit(type, payload, options) });
    if (this.approvals) {
      const previous = this.approvals.onEvent;
      this.approvals.onEvent = async event => { await previous?.(event); this.emit(event.type, { approval: event.approval }); await this.turns.approvalEvent(event); };
    }
    for (const service of [this.tasks, this.messages]) if (service) service.onEvent = async event => this.emit(event.type, event);
  }
  eventVisible(event, clientIdentity) {
    const turnId = event.payload?.turnId ?? event.payload?.approval?.metadata?.turnId;
    const owner = event.payload?.approval?.metadata?.clientIdentity ?? (event.payload?.approval?.metadata?.turnId ? this.turns.items.get(turnId)?.clientIdentity : null);
    if (owner && owner !== clientIdentity) return false;
    return !turnId || this.turns.canAccess(turnId, clientIdentity);
  }
  writeEvent(client, event) {
    if (!this.eventVisible(event, client.clientIdentity)) return;
    const text = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
    try { client.write(text); } catch { this.clients.delete(client); }
  }
  closeClients() {
    for (const client of this.clients) {
      try { client.close?.(); } catch {}
    }
    this.clients.clear();
  }
  emit(type, payload, options = {}) {
    const event = this.events.emit(createEvent(type, payload, options));
    for (const client of this.clients) this.writeEvent(client, event);
    return event;
  }
  handleUpgrade(req, socket) {
    if (!this.authorized(req)) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const close = () => { this.clients.delete(client); try { socket.end(); } catch {} };
    const client = { clientIdentity: this.clientIdentity(req), write: data => writeWsText(socket, data), close }; this.clients.add(client);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_WS_FRAME) return close();
      while (buffer.length >= 2) {
        const first = buffer[0]; const second = buffer[1]; const opcode = first & 0x0f; const masked = (second & 0x80) !== 0; let length = second & 0x7f; let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127 || length > MAX_WS_FRAME) return close();
        if (!masked || buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4); offset += 4; const payload = Buffer.from(buffer.subarray(offset, offset + length)); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) return close();
        if (opcode === 0x9) writeWsFrame(socket, 0xA, payload);
        // Client data is intentionally ignored; this channel only publishes events.
      }
    });
    socket.on('close', () => this.clients.delete(client)); socket.on('error', close);
  }
  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const signedInbound = req.method === 'POST' && /^\/api\/messages\/inbound\/[a-z0-9][a-z0-9._-]{0,63}$/.test(url.pathname);
    if (!this.authorized(req) && !signedInbound) return json(res, 401, { error: 'Gateway authentication required' });
    await this.approvals?.load?.();
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: 'Invalid origin' });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, await this.health());
      if (req.method === 'GET' && url.pathname === '/api/diagnostics') return json(res, 200, this.diagnostics ? await this.diagnostics() : { available: false, code: 'DIAGNOSTICS_NOT_CONFIGURED' });
      if (req.method === 'GET' && url.pathname === '/api/security-mode') return json(res, 200, { requested: await this.securityModeStore?.getRequested?.() ?? 'safe' });
      if (req.method === 'GET' && url.pathname === '/api/gateway/autostart') return json(res, 200, this.autostart ? await this.autostart.get() : { available: false, code: 'AUTOSTART_NOT_CONFIGURED' });
    if (req.method === 'GET' && url.pathname === '/api/events') {
      await this.turns.load();
      const clientIdentity = this.clientIdentity(req); const turnId = url.searchParams.get('turnId');
      if (turnId && !this.turns.canAccess(turnId, clientIdentity)) return json(res, 404, { error: 'Turn not found', code: 'TURN_NOT_FOUND' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': connected\n\n');
      const replay = await this.turns.replay(req.headers['last-event-id'], { clientIdentity, turnId });
      const client = { clientIdentity, write: data => res.write(data), close: () => res.end() }; this.clients.add(client);
      for (const event of replay) this.writeEvent(client, event);
      res.on('close', () => this.clients.delete(client)); return;
    }
    const uploadRequest = req.method === 'POST' && url.pathname === '/api/attachments/upload';
    if (uploadRequest) {
      if (!this.attachments) return json(res, 503, { error: 'Attachment service unavailable', code: 'ATTACHMENT_UNAVAILABLE' });
      try {
        const bytes = await rawBody(req, MAX_ATTACHMENT_BODY);
        const encodedName = req.headers['x-agent-file-name'];
        const name = typeof encodedName === 'string' ? decodeURIComponent(encodedName) : '';
        const attachment = await this.attachments.readBuffer(name, bytes);
        const id = randomUUID(); const clientIdentity = this.clientIdentity(req);
        await this.attachmentStore.put({ id, clientIdentity, bytes, attachment });
        return json(res, 200, { id, name: attachment.path, mediaType: attachment.mediaType, pages: attachment.pages, partial: attachment.partial, sizeBytes: attachment.sizeBytes });
      } catch (error) { return json(res, error.code === 'REQUEST_TOO_LARGE' ? 413 : 422, { error: error.message, code: error.code ?? 'ATTACHMENT_UPLOAD_FAILED' }); }
    }
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'JSON required' });
    let input = {}; let rawInput = '';
    try { if (req.method !== 'GET') { const raw = await rawBody(req); rawInput = raw.toString('utf8'); input = JSON.parse(rawInput || '{}'); } } catch (error) { return json(res, error.code === 'REQUEST_TOO_LARGE' ? 413 : 400, { error: error.message }); }
    try {
      if (req.method === 'POST' && url.pathname === '/api/security-mode') {
        if (!this.securityModeStore) throw Object.assign(new Error('Security mode service unavailable'), { code: 'SECURITY_MODE_UNAVAILABLE' });
        if (!['safe', 'personal', 'advanced'].includes(input.mode)) throw Object.assign(new Error('Invalid security mode'), { code: 'SECURITY_MODE_INVALID' });
        // Changing the local security profile is itself the user's explicit
        // action. Do not put a second tool approval in front of the toggle.
        return json(res, 200, { requested: await this.securityModeStore.setRequested(input.mode) });
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        const sessions = await this.sessions.summaries();
        return json(res, 200, { items: await this.projects?.list?.(sessions) ?? [], available: Boolean(this.projects) });
      }
      if (url.pathname === '/api/projects/pick' && req.method === 'POST') {
        if (!this.projects) throw Object.assign(new Error('项目工作区不可用'), { code: 'PROJECTS_UNAVAILABLE' });
        const project = await this.projects.pick();
        return json(res, 200, { cancelled: !project, project });
      }
      if (url.pathname === '/api/diagnostics' || url.pathname === '/api/turns' || url.pathname.startsWith('/api/memory') || url.pathname.startsWith('/api/tasks')) await this.initializeMemory();
      const inboundMatch = url.pathname.match(/^\/api\/messages\/inbound\/([^/]+)$/);
      if (inboundMatch && req.method === 'POST') {
        if (!this.inbound) throw Object.assign(new Error('Inbound message service unavailable'), { code: 'INBOUND_UNAVAILABLE' });
        const timestamp = req.headers['x-agent-timestamp']; const signature = req.headers['x-agent-signature'];
        const accepted = await this.inbound.accept({ channel: inboundMatch[1], externalConversation: input.conversation, messageId: input.messageId, text: input.text, source: input.source, timestamp, signature, body: rawInput });
        return json(res, accepted.duplicate ? 200 : accepted.status === 'processed' ? 200 : 202, accepted);
      }
      if (url.pathname === '/api/inbound/channels' && req.method === 'GET') return json(res, 200, { items: await this.inbound?.listChannels?.() ?? [] });
      if (url.pathname === '/api/inbound/channels' && req.method === 'POST') {
        if (!this.inbound) throw Object.assign(new Error('Inbound message service unavailable'), { code: 'INBOUND_UNAVAILABLE' });
        if (typeof input.secret !== 'string' || input.secret.length < 16 || input.secret.length > 4096) throw Object.assign(new Error('Inbound secret must contain 16-4096 characters'), { code: 'INBOUND_SECRET_INVALID' });
        const secretId = `inbound.${input.id}`;
        const secretRef = `secret://${secretId}`;
        const resource = { id: input.id, secretRef, secretFingerprint: createHash('sha256').update(input.secret).digest('hex'), enabled: input.enabled === true, allowedSources: input.allowedSources ?? [], maxSkewMs: input.maxSkewMs ?? 300000, approvalId: input.approvalId };
        return json(res, 200, await this.approved('inbound.configure', resource, async () => {
          await this.inbound.secrets.set(secretId, input.secret);
          const { secretFingerprint, ...config } = resource;
          return this.inbound.configure(config);
        }));
      }
      const inboundChannelMatch = url.pathname.match(/^\/api\/inbound\/channels\/([^/]+)\/(enable|disable)$/);
      if (inboundChannelMatch && req.method === 'POST') {
        const enabled = inboundChannelMatch[2] === 'enable';
        return json(res, 200, await this.approved(`inbound.${inboundChannelMatch[2]}`, { id: inboundChannelMatch[1], enabled, approvalId: input.approvalId }, () => this.inbound.setEnabled(inboundChannelMatch[1], enabled)));
      }
      if (url.pathname === '/api/inbound/deliveries' && req.method === 'GET') return json(res, 200, { items: await this.inbound?.listDeliveries?.() ?? [] });
      if (url.pathname === '/api/inbound/diagnostics' && req.method === 'GET') return json(res, 200, await this.inbound?.diagnostics?.() ?? { available: false });
      const inboundDeliveryMatch = url.pathname.match(/^\/api\/inbound\/deliveries\/([^/]+)\/retry$/);
      if (inboundDeliveryMatch && req.method === 'POST') return json(res, 200, await this.approved('inbound.retry', { id: inboundDeliveryMatch[1], approvalId: input.approvalId }, () => this.inbound.retry(inboundDeliveryMatch[1])));
      if (url.pathname === '/api/models' && req.method === 'GET') return json(res, 200, await this.models.list());
      if (url.pathname === '/api/models' && req.method === 'POST') {
        if (typeof this.models.upsert !== 'function') return json(res, 404, { error: 'Model configuration service unavailable', code: 'MODELS_UNAVAILABLE' });
        return json(res, 200, await this.models.upsert(input));
      }
      const modelSelectMatch = url.pathname.match(/^\/api\/models\/([0-9a-f-]{36})\/select$/);
      if (modelSelectMatch && req.method === 'POST') return json(res, 200, await this.models.select(modelSelectMatch[1]));
      const modelTestMatch = url.pathname.match(/^\/api\/models\/([0-9a-f-]{36})\/test$/);
      if (modelTestMatch && req.method === 'POST') {
        const item = await this.models.get(modelTestMatch[1]);
        if (!item) throw new Error('模型不存在');
        try { return json(res, 200, await import('../models.js').then(({ testModelConnection }) => testModelConnection(item))); }
        catch (error) { return json(res, 200, { ok: false, ...modelConnectionError(error) }); }
      }
      if (url.pathname === '/api/models/test' && req.method === 'POST') {
        const item = await this.models.preview(input, input.id);
        if (input.id && input.apiKey === undefined) item.apiKey = (await this.models.get(input.id))?.apiKey;
        try { return json(res, 200, await import('../models.js').then(({ testModelConnection }) => testModelConnection(item))); }
        catch (error) { return json(res, 200, { ok: false, ...modelConnectionError(error) }); }
      }
      const modelMatch = url.pathname.match(/^\/api\/models\/([0-9a-f-]{36})$/);
      if (modelMatch && req.method === 'PUT') {
        if (typeof this.models.upsert !== 'function') return json(res, 404, { error: 'Model configuration service unavailable', code: 'MODELS_UNAVAILABLE' });
        return json(res, 200, await this.models.upsert(input, modelMatch[1]));
      }
      if (modelMatch && req.method === 'DELETE') return json(res, 200, await this.models.remove(modelMatch[1]));
      if (url.pathname === '/api/providers' && req.method === 'GET') return json(res, 200, { items: (await import('../providers/registry.js')).listProviders() });
      if (url.pathname === '/api/access/grants' && req.method === 'GET') {
        if (!this.accessGrants) throw Object.assign(new Error('Access grant service unavailable'), { code: 'ACCESS_GRANTS_UNAVAILABLE' });
        const sessionId = input.sessionId ?? url.searchParams.get('sessionId') ?? null;
        return json(res, 200, { items: await this.accessGrants.list({ clientIdentity: this.clientIdentity(req), sessionId }) });
      }
      if (url.pathname === '/api/access/grants' && req.method === 'POST') {
        if (!this.accessGrants) throw Object.assign(new Error('Access grant service unavailable'), { code: 'ACCESS_GRANTS_UNAVAILABLE' });
        const clientIdentity = this.clientIdentity(req);
        const sessionId = input.scope === 'session' ? input.sessionId ?? null : null;
        const validated = await this.accessGrants.validate({ ...input, sessionId }, clientIdentity);
        const resource = { alias: validated.alias, path: validated.path, permissions: validated.permissions, scope: validated.scope, sessionId: validated.sessionId, clientIdentity };
        if (validated.scope === 'session') return json(res, 200, await this.accessGrants.grant(resource, clientIdentity));
        return json(res, 200, await this.approved('access-grant.create', { ...resource, approvalId: input.approvalId }, () => this.accessGrants.grant(resource, clientIdentity)));
      }
      const accessGrantMatch = url.pathname.match(/^\/api\/access\/grants\/([0-9a-f-]{36})$/i);
      if (accessGrantMatch && req.method === 'DELETE') {
        if (!this.accessGrants) throw Object.assign(new Error('Access grant service unavailable'), { code: 'ACCESS_GRANTS_UNAVAILABLE' });
        const clientIdentity = this.clientIdentity(req);
        const sessionId = input.sessionId ?? url.searchParams.get('sessionId') ?? null;
        return json(res, 200, await this.approved('access-grant.remove', { id: accessGrantMatch[1], clientIdentity, sessionId, approvalId: input.approvalId }, () => this.accessGrants.remove(accessGrantMatch[1], { clientIdentity, sessionId })));
      }
      if (url.pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, await this.sessions.summaries(input.query ?? url.searchParams.get('q') ?? '', { archived: (input.archived ?? url.searchParams.get('archived')) === true || (input.archived ?? url.searchParams.get('archived')) === 'true' }));
      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        let project = null;
        if (input.projectId) {
          if (!this.projects) throw Object.assign(new Error('项目工作区不可用'), { code: 'PROJECTS_UNAVAILABLE' });
          project = await this.projects.get(input.projectId);
        }
        return json(res, 200, await this.sessions.create({ project }));
      }
      if (url.pathname === '/api/attachments/preview' && req.method === 'POST') {
        if (!this.attachments) throw Object.assign(new Error('Attachment service unavailable'), { code: 'ATTACHMENT_UNAVAILABLE' });
        const attachment = await this.attachments.read(input.path);
        return json(res, 200, { path: attachment.path, mediaType: attachment.mediaType, pages: attachment.pages, partial: attachment.partial, sizeBytes: attachment.sizeBytes, content: attachment.content });
      }
      const attachmentOpenMatch = url.pathname.match(/^\/api\/attachments\/([0-9a-f-]{36})\/open$/i);
      if (attachmentOpenMatch && req.method === 'GET') {
        const uploaded = await this.getUploadedAttachment(attachmentOpenMatch[1], this.clientIdentity(req));
        const name = uploaded.attachment.path.replace(/[\r\n"\\/]/g, '_');
        res.writeHead(200, { 'Content-Type': uploaded.attachment.mediaType, 'Content-Length': uploaded.bytes.length, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(uploaded.bytes);
        return;
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})$/);
      const sessionActionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/(rename|branches|fork|branch|archive|restore)$/);
      if (sessionMatch && req.method === 'GET') {
        const session = await this.sessions.get(sessionMatch[1]);
        const messages = branchMessages(session).filter(message => ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
          .map(({ role, content, messageId, createdAt, attachment }) => ({ role, content: redactText(content), messageId, createdAt, ...(attachment ? { attachment: publicAttachment(attachment) } : {}) }));
        return json(res, 200, { id: session.id, title: session.title ?? '新会话', activeBranchId: session.activeBranchId, ...(session.project ? { project: session.project } : {}), ...(session.archivedAt ? { archivedAt: session.archivedAt } : {}), messages });
      }
      if (sessionActionMatch && sessionActionMatch[2] === 'rename' && req.method === 'POST') {
        const session = await this.sessions.rename(sessionActionMatch[1], input.title);
        return json(res, 200, { id: session.id, title: session.title, updatedAt: session.updatedAt });
      }
      if (sessionActionMatch && ['archive', 'restore'].includes(sessionActionMatch[2]) && req.method === 'POST') {
        const sessionId = sessionActionMatch[1];
        const turns = [...this.turns.items.values()].filter(turn => turn.sessionId === sessionId && ['running', 'cancelling', 'awaiting_approval', 'awaiting_clarification'].includes(turn.status));
        if (sessionActionMatch[2] === 'archive' && turns.length) throw Object.assign(new Error('当前会话有尚未结束的回合，完成或停止后再归档'), { code: 'SESSION_TURN_ACTIVE' });
        const session = sessionActionMatch[2] === 'archive' ? await this.sessions.archive(sessionId) : await this.sessions.restore(sessionId);
        return json(res, 200, { id: session.id, title: session.title ?? '新会话', archivedAt: session.archivedAt ?? null });
      }
      if (sessionActionMatch && sessionActionMatch[2] === 'branches' && req.method === 'GET') {
        const session = await this.sessions.get(sessionActionMatch[1]);
        return json(res, 200, { items: await this.sessions.branches(sessionActionMatch[1]), activeBranchId: session.activeBranchId });
      }
      if (sessionActionMatch && sessionActionMatch[2] === 'fork' && req.method === 'POST') {
        const result = await this.sessions.fork(sessionActionMatch[1], input.name);
        return json(res, 200, { branch: result.branch, activeBranchId: result.session.activeBranchId });
      }
      if (sessionActionMatch && sessionActionMatch[2] === 'branch' && req.method === 'POST') {
        const result = await this.sessions.useBranch(sessionActionMatch[1], input.branchId);
        return json(res, 200, { branch: result.branch, activeBranchId: result.session.activeBranchId });
      }
      if (url.pathname === '/api/turns' && req.method === 'POST') {
        if (typeof this.runTurn !== 'function') throw Object.assign(new Error('Gateway turn runner is unavailable'), { code: 'TURN_UNAVAILABLE' });
        if (input.sessionId && (await this.sessions.get(input.sessionId)).archivedAt) throw Object.assign(new Error('请先恢复此归档会话，再继续发送消息'), { code: 'SESSION_ARCHIVED' });
        if (input.attachmentId !== undefined) {
          const uploaded = await this.getUploadedAttachment(input.attachmentId, this.clientIdentity(req));
          const extracted = await this.attachments.readBuffer(uploaded.attachment.path, uploaded.bytes);
          input = { ...input, uploadedAttachment: { ...extracted, id: uploaded.id } };
        }
        return json(res, 200, await this.turns.start(input, this.runTurn, this.clientIdentity(req)));
      }
      const turnMatch = url.pathname.match(/^\/api\/turns\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\/(cancel|retry|clarify|recover|retry-step))?$/);
      if (turnMatch && req.method === 'GET' && !turnMatch[2]) {
        const turn = await this.turns.get(turnMatch[1], this.clientIdentity(req));
        if (!turn) return json(res, 404, { error: 'Turn not found', code: 'TURN_NOT_FOUND' });
        return json(res, 200, turn);
      }
      if (turnMatch && req.method === 'POST' && turnMatch[2] === 'cancel')
        return json(res, 200, await this.turns.cancel(turnMatch[1], this.clientIdentity(req)));
      if (turnMatch && req.method === 'POST' && turnMatch[2] === 'recover') {
        if (typeof this.runTurn !== 'function') throw Object.assign(new Error('Gateway turn runner is unavailable'), { code: 'TURN_UNAVAILABLE' });
        const clientIdentity = this.clientIdentity(req);
        const previous = await this.turns.get(turnMatch[1], clientIdentity);
        if (!previous?.sessionId) throw Object.assign(new Error('Turn has no session to recover'), { code: 'PLAN_NOT_RECOVERABLE' });
        if ((await this.sessions.get(previous.sessionId)).archivedAt) throw Object.assign(new Error('请先恢复此归档会话，再恢复任务'), { code: 'SESSION_ARCHIVED' });
        const resource = await this.turns.getRecoveryRequest(turnMatch[1], clientIdentity);
        if (!resource?.input || createHash('sha256').update(`${resource.input}\u0000${resource.attachmentId ?? ''}${resource.skillId ? `\u0000${resource.skillId}` : ''}`).digest('hex') !== resource.inputHash)
          throw Object.assign(new Error('The original user request could not be verified'), { code: 'TURN_RESOURCE_CHANGED' });
        const attachmentId = resource.attachmentId;
        const uploadedAttachment = attachmentId ? await this.getUploadedAttachment(attachmentId, clientIdentity).then(async uploaded => ({ ...(await this.attachments.readBuffer(uploaded.attachment.path, uploaded.bytes)), id: uploaded.id })).catch(() => null) : null;
        return json(res, 200, await this.turns.recover(turnMatch[1], clientIdentity, this.runTurn, { input: resource.input, attachmentId, uploadedAttachment, skillId: resource.skillId, skillReference: resource.skillReference }));
      }
      if (turnMatch && req.method === 'POST' && turnMatch[2] === 'retry-step') {
        if (typeof this.runTurn !== 'function') throw Object.assign(new Error('Gateway turn runner is unavailable'), { code: 'TURN_UNAVAILABLE' });
        const clientIdentity = this.clientIdentity(req);
        const previous = await this.turns.get(turnMatch[1], clientIdentity);
        if (!previous?.sessionId) throw Object.assign(new Error('Turn has no session'), { code: 'TURN_NOT_RETRYABLE' });
        if ((await this.sessions.get(previous.sessionId)).archivedAt) throw Object.assign(new Error('请先恢复此归档会话，再重试步骤'), { code: 'SESSION_ARCHIVED' });
        if (typeof input.stepId !== 'string') throw Object.assign(new Error('A plan step ID is required'), { code: 'PLAN_STEP_NOT_FOUND' });
        const resource = await this.turns.getRecoveryRequest(turnMatch[1], clientIdentity);
        if (!resource?.input || createHash('sha256').update(`${resource.input}\u0000${resource.attachmentId ?? ''}${resource.skillId ? `\u0000${resource.skillId}` : ''}`).digest('hex') !== resource.inputHash)
          throw Object.assign(new Error('The original user request could not be verified'), { code: 'TURN_RESOURCE_CHANGED' });
        const attachmentId = resource.attachmentId;
        const uploadedAttachment = attachmentId ? await this.getUploadedAttachment(attachmentId, clientIdentity).then(async uploaded => ({ ...(await this.attachments.readBuffer(uploaded.attachment.path, uploaded.bytes)), id: uploaded.id })).catch(() => null) : null;
        return json(res, 200, await this.turns.retryStep(turnMatch[1], input.stepId, clientIdentity, this.runTurn, { input: resource.input, attachmentId, uploadedAttachment, skillId: resource.skillId, skillReference: resource.skillReference, confirmUncertain: input.confirmUncertain === true }));
      }
      if (turnMatch && req.method === 'POST' && turnMatch[2] === 'clarify') {
        const clientIdentity = this.clientIdentity(req);
        const previous = await this.turns.get(turnMatch[1], clientIdentity);
        if (!previous) throw Object.assign(new Error('Turn not found'), { code: 'TURN_NOT_FOUND' });
        if (previous.status !== 'awaiting_clarification' || !previous.clarification)
          throw Object.assign(new Error('Turn is not waiting for a user choice'), { code: 'TURN_NOT_WAITING_FOR_CLARIFICATION' });
        if (typeof input.optionId !== 'string') throw Object.assign(new Error('A clarification option is required'), { code: 'CLARIFICATION_OPTION_INVALID' });
        const option = previous.clarification.options.find(item => item.id === input.optionId);
        if (!option) throw Object.assign(new Error('That clarification option is not available'), { code: 'CLARIFICATION_OPTION_INVALID' });
        const session = await this.sessions.get(previous.sessionId);
        const messages = branchMessages(session);
        const userMessage = [...messages].reverse().find(message => message.role === 'user' && typeof message.content === 'string');
        if (!userMessage) throw Object.assign(new Error('Original user request is unavailable'), { code: 'TURN_NOT_RESUMABLE' });
        const attachmentId = userMessage.attachment?.id ?? null;
        const resource = await this.turns.getInputResource(turnMatch[1], clientIdentity);
        return json(res, 200, await this.turns.start({ input: userMessage.content, attachmentId, ...(resource?.skillId ? { skillId: resource.skillId } : {}), ...(resource?.skillReference ? { skillReference: resource.skillReference } : {}), sessionId: previous.sessionId, turnId: turnMatch[1], clarificationAnswer: option.label,
          clarificationContext: { ...previous.clarification, selectedId: option.id, selectedLabel: option.label } }, this.runTurn, clientIdentity));
      }
      if (turnMatch && req.method === 'POST' && turnMatch[2] === 'retry') {
        const clientIdentity = this.clientIdentity(req);
        const previous = await this.turns.get(turnMatch[1], clientIdentity);
        if (!previous) throw Object.assign(new Error('Turn not found'), { code: 'TURN_NOT_FOUND' });
        if (!['failed', 'cancelled', 'interrupted', 'denied', 'expired'].includes(previous.status))
          throw Object.assign(new Error('Only a finished failed or cancelled turn can be retried'), { code: 'TURN_NOT_RETRYABLE' });
        if (!previous.sessionId) throw Object.assign(new Error('Turn has no session to retry'), { code: 'TURN_NOT_RETRYABLE' });
        const session = await this.sessions.get(previous.sessionId);
        if (session.archivedAt) throw Object.assign(new Error('请先恢复此归档会话，再重试任务'), { code: 'SESSION_ARCHIVED' });
        const messages = branchMessages(session);
        const resource = await this.turns.getInputResource(turnMatch[1], clientIdentity);
        const originalHash = resource?.inputHash;
        const userMessage = [...messages].reverse().find(message => {
          if (message.role !== 'user' || typeof message.content !== 'string') return false;
          const attachmentId = message.attachment?.id ?? resource?.attachmentId ?? '';
          return originalHash && createHash('sha256').update(`${message.content}\u0000${attachmentId}${resource?.skillId ? `\u0000${resource.skillId}` : ''}`).digest('hex') === originalHash;
        });
        if (!userMessage)
          throw Object.assign(new Error('The session has changed since this turn; start a new request instead'), { code: 'TURN_RESOURCE_CHANGED' });
        const attachmentId = userMessage.attachment?.id ?? resource?.attachmentId ?? null;
        const retryId = randomUUID();
        return json(res, 200, await this.turns.start({ input: userMessage.content, attachmentId, ...(resource?.skillId ? { skillId: resource.skillId } : {}), ...(resource?.skillReference ? { skillReference: resource.skillReference } : {}), sessionId: previous.sessionId, turnId: retryId, retryOf: turnMatch[1], retryPlan: previous.plan }, this.runTurn, clientIdentity));
      }
      if (url.pathname === '/api/memory' && req.method === 'GET') {
        const sessionId = input.sessionId ?? url.searchParams.get('sessionId') ?? undefined;
        const session = sessionId ? await this.sessions.get(sessionId).catch(() => null) : null;
        const options = { scope: input.scope ?? url.searchParams.get('scope') ?? undefined, sessionId,
          taskId: input.taskId ?? url.searchParams.get('taskId') ?? undefined, projectRoot: session?.project?.path ?? this.root,
          includeCandidates: input.includeCandidates === true || url.searchParams.get('includeCandidates') === 'true', query: input.query ?? url.searchParams.get('query') ?? undefined };
        const query = input.query ?? url.searchParams.get('query');
        const active = query ? await this.memory.search(query, Number(input.limit ?? url.searchParams.get('limit') ?? 5), options) : await this.memory.list(options);
        const candidates = options.includeCandidates && this.memory.candidates ? await this.memory.candidates(options) : [];
        return json(res, 200, [...candidates, ...active.filter(item => item.status !== 'candidate')]);
      }
      if (url.pathname === '/api/memory' && req.method === 'POST') {
        const session = input.sessionId ? await this.sessions.get(input.sessionId).catch(() => null) : null;
        const projectRoot = session?.project?.path ?? this.root;
        const memoryInput = { ...input }; delete memoryInput.projectRoot;
        return json(res, 200, input.candidate ? await this.memory.suggest(memoryInput, { projectRoot }) : await this.memory.create(memoryInput, { projectRoot }));
      }
      const memoryItemMatch = url.pathname.match(/^\/api\/memory\/([^/]+)$/);
      if (memoryItemMatch && req.method === 'PATCH') return json(res, 200, await this.memory.update(memoryItemMatch[1], input.content, { provenance: input.provenance }));
      const memoryHistoryMatch = url.pathname.match(/^\/api\/memory\/([^/]+)\/history$/);
      if (memoryHistoryMatch && req.method === 'GET') return json(res, 200, await this.memory.history(memoryHistoryMatch[1]));
      const memoryRestoreMatch = url.pathname.match(/^\/api\/memory\/([^/]+)\/restore$/);
      if (memoryRestoreMatch && req.method === 'POST') return json(res, 200, await this.memory.restore(memoryRestoreMatch[1], input.versionNo));
      if (url.pathname === '/api/memory/embedding' && req.method === 'GET') return json(res, 200, { configuration: await this.memoryEmbedding?.get?.().catch?.(error => ({ configured: false, error: error.code ?? 'EMBEDDING_CONFIG_INVALID' })) ?? { configured: false }, status: { ...(await this.memory.status()), configError: this.getEmbeddingConfigError() } });
      if (url.pathname === '/api/memory/embedding' && req.method === 'POST') {
        const validated = validateEmbeddingSettings(input);
        const resource = { ...validated, approvalId: input.approvalId };
        return json(res, 200, await this.approved('memory.embedding.configure', resource, async () => {
          const config = await this.memoryEmbedding.set(validated); this.memory.configureEmbedding(createEmbeddingProvider(config), 'hybrid'); return { configuration: config, status: await this.memory.status() };
        }));
      }
      if (url.pathname === '/api/memory/embedding' && req.method === 'DELETE') return json(res, 200, await this.approved('memory.embedding.disable', { approvalId: input.approvalId }, async () => {
        const config = await this.memoryEmbedding.clear(); this.memory.configureEmbedding(null, 'keyword'); return { configuration: config, status: await this.memory.status() };
      }));
      if (url.pathname === '/api/memory/embedding/rebuild' && req.method === 'POST') {
        const limit = input.limit ?? 100;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('Embedding rebuild limit must be between 1 and 100'), { code: 'EMBEDDING_REBUILD_LIMIT' });
        return json(res, 200, await this.approved('memory.embedding.rebuild', { limit, approvalId: input.approvalId }, () => this.memory.reembed({ limit })));
      }
      const memoryMatch = url.pathname.match(/^\/api\/memory\/([^/]+)\/(review|delete)$/);
      if (memoryMatch && req.method === 'POST') return json(res, 200, memoryMatch[2] === 'review' ? await this.memory.review(memoryMatch[1], input.decision) : await this.memory.remove(memoryMatch[1]));
      if (url.pathname === '/api/skills' && req.method === 'GET') return json(res, 200, await this.skills.list({ ...input,
        includeInvalid: url.searchParams.get('includeInvalid') === 'true' || input.includeInvalid === true,
        enabledOnly: url.searchParams.get('enabledOnly') === 'true' || input.enabledOnly === true }));
      if (url.pathname === '/api/skills/validate' && req.method === 'GET') return json(res, 200, await this.skills.validate());
      if (url.pathname === '/api/skills' && req.method === 'POST') {
        if (!this.skills?.saveFields) throw Object.assign(new Error('技能存储服务不可用'), { code: 'SKILLS_UNAVAILABLE' });
        const saved = await this.skills.saveFields({ id: input.id, name: input.name, description: input.description, body: input.body, category: input.category, icon: input.icon, version: input.version });
        await this.skills.setInstalled(saved.id, true);
        return json(res, 201, await this.skills.inspect(saved.id));
      }
      const skillItemMatch = url.pathname.match(/^\/api\/skills\/([a-z0-9][a-z0-9-]{0,63})$/);
      if (skillItemMatch && req.method === 'GET') return json(res, 200, await this.skills.inspect(skillItemMatch[1]));
      if (skillItemMatch && req.method === 'PUT') {
        if (input.id !== skillItemMatch[1]) throw Object.assign(new Error('技能 ID 不可通过编辑修改'), { code: 'SKILL_ID_MISMATCH' });
        return json(res, 200, await this.skills.saveFields({ id: skillItemMatch[1], name: input.name, description: input.description, body: input.body, category: input.category, icon: input.icon, version: input.version }));
      }
      if (skillItemMatch && req.method === 'DELETE') return json(res, 200, await this.skills.delete(skillItemMatch[1]));
      const skillMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/(enable|disable|inspect)$/);
      if (skillMatch && req.method === 'POST') {
        if (skillMatch[2] === 'inspect') return json(res, 200, await this.skills.inspect(skillMatch[1]));
        const enabled = skillMatch[2] === 'enable';
        return json(res, 200, await this.approved(`skill.${skillMatch[2]}`, { id: skillMatch[1], enabled, approvalId: input.approvalId }, () => this.skills.setEnabled(skillMatch[1], enabled)));
      }
      if (url.pathname === '/api/tools' && req.method === 'GET') {
        const items = registeredTools().map(tool => ({ ...tool.contract, executableInTurn: false, source: 'registry' }));
        const pluginItems = this.plugins?.toolDefinitions ? await this.plugins.toolDefinitions().catch(() => []) : [];
        for (const item of pluginItems) {
          const definition = item?.definition;
          const name = definition?.function?.name;
          if (typeof name === 'string') items.push({ name, description: definition.function.description ?? '', risk: 'plugin', approval: 'policy', executableInTurn: true, source: 'plugin' });
        }
        return json(res, 200, { items });
      }
      if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, await this.tasks.list());
      if (url.pathname === '/api/tasks/diagnostics' && req.method === 'GET') return json(res, 200, await this.tasks.diagnostics());
      if (url.pathname === '/api/tasks' && req.method === 'POST') return json(res, 200, await this.approved('task.create', input, () => this.tasks.create(input)));
      if (url.pathname === '/api/gateway/autostart' && req.method === 'POST') {
        if (!this.autostart) throw Object.assign(new Error('Gateway autostart service unavailable'), { code: 'AUTOSTART_UNAVAILABLE' });
        return json(res, 200, await this.approved('gateway.autostart', input, () => this.autostart.set(input)));
      }
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(run|pause|resume|cancel|recover|history)$/);
      if (taskMatch && req.method === 'POST') {
        if (taskMatch[2] === 'run') return json(res, 200, await this.approved('task.run', { id: taskMatch[1] }, () => this.tasks.run(taskMatch[1])));
        if (taskMatch[2] === 'cancel') return json(res, 200, await this.approved('task.cancel', { id: taskMatch[1] }, () => this.tasks.cancel(taskMatch[1])));
        if (taskMatch[2] === 'recover') return json(res, 200, await this.approved('task.recover', { id: taskMatch[1], runNow: input.runNow !== false }, () => this.tasks.recover(taskMatch[1], { runNow: input.runNow !== false })));
        if (taskMatch[2] === 'history') return json(res, 200, await this.tasks.history(taskMatch[1]));
        const enabled = taskMatch[2] === 'resume';
        return json(res, 200, await this.approved(`task.${taskMatch[2]}`, { id: taskMatch[1], enabled, approvalId: input.approvalId }, () => this.tasks.setEnabled(taskMatch[1], enabled)));
      }
      if (url.pathname === '/api/messages/channels' && req.method === 'GET') return json(res, 200, await this.messages.listChannels());
      if (url.pathname === '/api/messages/send' && req.method === 'POST') return json(res, 200, await this.approved('message.send', input, () => this.messages.send(input)));
      if (url.pathname === '/api/mcp' && req.method === 'GET') return json(res, 200, { items: this.mcp?.list ? await this.mcp.list() : [] });
      if (url.pathname === '/api/mcp' && req.method === 'POST') {
        const resource = { id: input.id, command: input.command, args: input.args, cwd: input.cwd, enabled: input.enabled === true, approvalId: input.approvalId };
        return json(res, 200, await this.approved('mcp.add', resource, () => this.mcp.addStdio(input)));
      }
      const mcpMatch = url.pathname.match(/^\/api\/mcp\/([^/]+)\/(inspect|enable|disable|tools|call)$/);
      if (mcpMatch && req.method === 'POST') {
        if (mcpMatch[2] === 'inspect') return json(res, 200, await this.mcp.inspect(mcpMatch[1]));
        if (mcpMatch[2] === 'enable' || mcpMatch[2] === 'disable') {
          const enabled = mcpMatch[2] === 'enable';
          return json(res, 200, await this.approved(`mcp.${mcpMatch[2]}`, { id: mcpMatch[1], enabled, approvalId: input.approvalId }, () => this.mcp.setEnabled(mcpMatch[1], enabled)));
        }
        if (mcpMatch[2] === 'tools') return json(res, 200, await this.mcp.tools(mcpMatch[1]));
        return json(res, 200, await this.approved('mcp.call', { server: mcpMatch[1], tool: input.tool, arguments: input.arguments ?? {}, approvalId: input.approvalId },
          () => this.mcp.call(mcpMatch[1], input.tool, input.arguments ?? {}, { approve: async () => true })));
      }
      if (url.pathname === '/api/plugins' && req.method === 'GET') return json(res, 200, { items: this.plugins?.list ? await this.plugins.list() : [] });
      if (url.pathname === '/api/plugins/registrations' && req.method === 'GET') return json(res, 200, { items: this.plugins?.registrations ? await this.plugins.registrations() : [], dynamic: this.plugins?.dynamicRegistrations ? await this.plugins.dynamicRegistrations() : [] });
      if (url.pathname === '/api/plugins/validate' && req.method === 'POST') return json(res, 200, await this.plugins.validate(input.directory));
      if (url.pathname === '/api/plugins/register' && req.method === 'POST') {
        return json(res, 200, await this.approved('plugin.register', { pluginId: input.pluginId, declaration: input.declaration }, () => this.plugins.register(input.pluginId, input.declaration, { approve: true })));
      }
      const dynamicPluginMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/dynamic\/([^/]+)\/([^/]+)$/);
      if (dynamicPluginMatch && req.method === 'POST') {
        return json(res, 200, await this.approved('plugin.invoke', { pluginId: dynamicPluginMatch[1], type: dynamicPluginMatch[2], registrationId: dynamicPluginMatch[3], request: input.request ?? {} }, () => this.plugins.invokeRegistration(dynamicPluginMatch[1], dynamicPluginMatch[2], dynamicPluginMatch[3], input.request ?? {})));
      }
      const pluginMatch = url.pathname.match(/^\/api\/plugins\/([^/]+)\/(enable|disable)$/);
      if (pluginMatch && req.method === 'POST') {
        if (pluginMatch[2] === 'disable') return json(res, 200, await this.approved('plugin.disable', { id: pluginMatch[1], approvalId: input.approvalId }, () => this.plugins.disable(pluginMatch[1])));
        return json(res, 200, await this.approved('plugin.enable', { id: pluginMatch[1], approvalId: input.approvalId }, () => this.plugins.enable(pluginMatch[1], { approve: async details => details.id === pluginMatch[1] })));
      }
      if (url.pathname === '/api/approvals' && req.method === 'GET') return json(res, 200, this.approvals.list().filter(item => !item.metadata?.clientIdentity || item.metadata.clientIdentity === this.clientIdentity(req)));
      const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
      if (approvalMatch && req.method === 'POST') {
        const pending = this.approvals.get?.(approvalMatch[1]);
        const owner = pending?.metadata?.clientIdentity;
        if (owner && owner !== this.clientIdentity(req)) throw Object.assign(new Error('Approval belongs to a different client'), { code: 'APPROVAL_CLIENT_MISMATCH' });
        const sessionDirectoryRead = pending?.type === 'turn.external_read' &&
          ['external_list_files', 'external_find_files', 'external_search_text'].includes(pending.operation) &&
          pending.metadata?.summary?.mode === 'read-only' && typeof pending.metadata?.summary?.path === 'string';
        const metadata = input.scope === 'session' && sessionDirectoryRead ? { readScope: 'session' } : undefined;
        return json(res, 200, await this.approvals.resolve(approvalMatch[1], input.decision, input.resource, metadata));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) { return json(res, ['PERMISSION_DENIED', 'INBOUND_SIGNATURE_INVALID', 'INBOUND_TIMESTAMP_EXPIRED', 'INBOUND_SOURCE_DENIED', 'INBOUND_CHANNEL_UNAVAILABLE'].includes(error.code) ? 403 : ['APPROVAL_REQUIRED', 'USER_CLARIFICATION_REQUIRED'].includes(error.code) ? 202 : error.code === 'SESSION_TURN_ACTIVE' ? 409 : 422, { error: error.message, code: error.code ?? 'REQUEST_FAILED', ...(error.approvalId ? { approvalId: error.approvalId } : {}), ...(error.turnId ? { turnId: error.turnId } : {}), ...(error.sessionId ? { sessionId: error.sessionId } : {}) }); }
  }
  async getUploadedAttachment(id, clientIdentity) {
    if (!this.attachmentStore) throw Object.assign(new Error('Attachment service unavailable'), { code: 'ATTACHMENT_UNAVAILABLE' });
    return this.attachmentStore.get(id, clientIdentity);
  }
  authorized(req) {
    if (!this.token) return true;
    const header = req.headers.authorization;
    return header === `Bearer ${this.token}` || req.headers['x-agent-gateway-token'] === this.token;
  }
  clientIdentity(req) { const headers = req?.headers ?? {}; const authorization = headers.authorization ?? headers.Authorization ?? headers['x-agent-gateway-token'] ?? headers['X-Agent-Gateway-Token'] ?? 'local'; return createHash('sha256').update(String(authorization)).digest('hex').slice(0, 24); }
  async approved(type, resource, operation) {
    if (!this.approvals) return operation();
    const { approvalId, approve, ...cleanResource } = resource ?? {};
    if (approvalId) {
      try { if (this.approvals.consumeApproved(approvalId, cleanResource)) return operation(); }
      catch (error) { throw Object.assign(error, { code: error.code ?? 'APPROVAL_RESOURCE_CHANGED', approvalId }); }
      throw Object.assign(new Error('Approval is not approved'), { code: 'APPROVAL_REQUIRED', approvalId });
    }
    const metadata = { source: 'gateway', ...(typeof cleanResource.clientIdentity === 'string' ? { clientIdentity: cleanResource.clientIdentity } : {}) };
    const approval = await this.approvals.request({ type, operation: type, resource: cleanResource, metadata });
    throw Object.assign(new Error(`Approval required: ${approval.id}`), { code: 'APPROVAL_REQUIRED', approvalId: approval.id });
  }
  createServer() { const server = http.createServer((req, res) => this.handle(req, res)); server.on('upgrade', (req, socket) => this.handleUpgrade(req, socket)); return server; }
}

function publicAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object' || typeof attachment.id !== 'string' || typeof attachment.name !== 'string') return null;
  return { id: attachment.id, name: attachment.name.slice(0, 255), mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : 'application/octet-stream', pages: Number.isSafeInteger(attachment.pages) ? attachment.pages : null, partial: attachment.partial === true, sizeBytes: Number.isSafeInteger(attachment.sizeBytes) ? attachment.sizeBytes : null };
}

function writeWsFrame(socket, opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = data.length < 126 ? Buffer.from([0x80 | opcode, data.length]) : Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 0xff]);
  socket.write(Buffer.concat([header, data]));
}
function writeWsText(socket, text) { writeWsFrame(socket, 0x1, text); }
