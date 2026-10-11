import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redact, redactText } from '../secrets/redact.js';
import { recoverStructuredPlan } from './structured-plan.js';

const MAX_TURNS = 256;
const MAX_EVENTS = 2048;
const MAX_DELTA_CHARS = 4096;

function fingerprint(value) { return createHash('sha256').update(value).digest('hex'); }

export class GatewayTurnStore {
  constructor(root, { emit = () => {}, approvals = null, now = () => Date.now() } = {}) {
    this.file = root ? path.join(path.resolve(root), '.agent-data', 'gateway-turns.json') : null;
    this.emit = emit;
    this.approvals = approvals;
    this.now = now;
    this.items = new Map();
    this.events = [];
    this.controllers = new Map();
    this.activeSessions = new Map();
    this.loaded = false;
    this.saveQueue = Promise.resolve();
    this.persistTimer = null;
  }

  async load() {
    if (this.loaded) return;
    try {
      if (!this.file) { this.loaded = true; return; }
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      for (const item of data.items ?? []) this.items.set(item.id, item);
      this.events = Array.isArray(data.events) ? data.events.slice(-MAX_EVENTS) : [];
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let recovered = false;
    for (const item of this.items.values()) {
      if (item.status !== 'running') continue;
      item.status = 'interrupted';
      item.errorCode = 'GATEWAY_RESTARTED';
      interruptPlan(item);
      interruptStructuredPlan(item);
      item.updatedAt = this.now();
      recovered = true;
    }
    for (const item of this.items.values()) this.refreshSessionReservation(item);
    this.loaded = true;
    if (recovered) await this.persist();
  }

  async persist() {
    if (!this.file) return;
    const operation = this.saveQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const durableEvents = this.events.filter(event => event?.type !== 'turn.delta').slice(-MAX_EVENTS);
        await writeFile(temp, JSON.stringify({ version: 1, items: [...this.items.values()].slice(-MAX_TURNS), events: durableEvents }, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temp, this.file);
      } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
    this.saveQueue = operation.catch(() => {});
    return operation;
  }

  async start(input, runner, clientIdentity) {
    await this.load();
    if (typeof input?.input !== 'string' || !input.input.trim() || input.input.length > 32_000)
      throw Object.assign(new Error('Turn input is required and must be at most 32,000 characters'), { code: 'INPUT_INVALID' });
    const turnId = input.turnId ?? randomUUID();
    if (typeof turnId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(turnId)) throw Object.assign(new Error('Invalid turn ID'), { code: 'TURN_ID_INVALID' });
    const existing = this.items.get(turnId);
    if (existing?.skillId && input.skillId && existing.skillId !== input.skillId || existing && !existing.skillId && input.skillId)
      throw Object.assign(new Error('Turn skill selection does not match the original request'), { code: 'TURN_RESOURCE_CHANGED' });
    const skillId = input.skillId ?? existing?.skillId ?? null;
    const skillReference = input.skillReference ?? existing?.skillReference ?? null;
    if (skillReference !== null && (!skillId || skillReference.skillId !== skillId || typeof skillReference.displayName !== 'string' || !skillReference.displayName.trim() || skillReference.displayName.length > 120 || !Number.isSafeInteger(skillReference.offset) || skillReference.offset < 0 || skillReference.offset > input.input.length))
      throw Object.assign(new Error('Invalid skill reference metadata'), { code: 'SKILL_REFERENCE_INVALID' });
    const inputHash = fingerprint(`${input.input}\u0000${input.attachmentId ?? ''}${skillId ? `\u0000${skillId}` : ''}`);
    let item = existing;
    if (existing) {
      if (existing.clientIdentity !== clientIdentity || existing.sessionId !== (input.sessionId ?? existing.sessionId) || existing.inputHash !== inputHash)
        throw Object.assign(new Error('Turn belongs to a different request'), { code: 'TURN_RESOURCE_CHANGED' });
      if (existing.status === 'awaiting_approval') {
        if (!input.approvalId) throw Object.assign(new Error('Turn is not resumable; query its current state'), { code: 'TURN_NOT_RESUMABLE', turnId });
        const approval = this.approvals?.get(input.approvalId);
        if (input.approvalId !== existing.approvalId || approval?.status !== 'approved' || approval.metadata?.turnId !== turnId || approval.metadata?.clientIdentity && approval.metadata.clientIdentity !== clientIdentity)
          throw Object.assign(new Error('Turn approval is not approved or does not match'), { code: 'TURN_APPROVAL_NOT_READY', turnId });
      } else if (existing.status !== 'awaiting_clarification' || !input.clarificationContext) {
        throw Object.assign(new Error('Turn is not resumable; query its current state'), { code: existing.status === 'running' ? 'TURN_ALREADY_RUNNING' : 'TURN_NOT_RESUMABLE', turnId });
      }
      this.assertSessionAvailable(existing);
      existing.status = 'running'; existing.updatedAt = this.now(); existing.errorCode = null; existing.errorMessage = null; existing.approvalId = input.approvalId ?? null; existing.clarification = null;
    } else {
      this.prune();
      if (this.controllers.size >= 16 || this.items.size >= MAX_TURNS)
        throw Object.assign(new Error('Gateway turn capacity reached'), { code: 'TURN_CAPACITY_REACHED' });
      item = { id: turnId, sessionId: input.sessionId ?? null, clientIdentity, inputHash, input: input.input, attachmentId: input.attachmentId ?? null, retryOf: input.retryOf ?? null, status: 'running', tool: null,
        ...(skillId ? { skillId } : {}), ...(skillReference ? { skillReference: { skillId, displayName: skillReference.displayName.trim(), offset: skillReference.offset } } : {}), plan: createInitialPlan(input.input), structuredPlan: null, activeStepId: null, activeStepIds: {}, stepSequence: 0,
        createdAt: this.now(), updatedAt: this.now(), errorCode: null, errorMessage: null, approvalId: null };
      this.assertSessionAvailable(item);
      this.items.set(turnId, item);
    }
    this.reserveSession(item);
    const controller = new AbortController();
    this.controllers.set(turnId, controller);
    await this.persist();
    this.publish('turn.started', { turnId, sessionId: item.sessionId, status: 'running' });
    this.publish('task.plan.updated', { turnId, sessionId: item.sessionId, plan: item.plan });
    const report = async (type, payload) => this.publish(type, { turnId, sessionId: item.sessionId, ...payload });
    try {
      const result = await runner({ ...input, ...(item.skillId ? { skillId: item.skillId } : {}), structuredPlan: item.structuredPlan, turnId, sessionId: item.sessionId ?? input.sessionId ?? null, approvalId: item.approvalId ?? input.approvalId ?? null, clientIdentity, signal: controller.signal,
        onPlan: async structuredPlan => {
          if (Array.isArray(structuredPlan?.steps) && Array.isArray(structuredPlan?.phases)) item.structuredPlan = structuredPlan;
          else item.structuredPlanError = structuredPlan?.errorMessage || '规划失败';
          item.updatedAt = this.now();
          await this.persist();
          await report('task.structured_plan.updated', { plan: structuredPlan });
        },
        onSession: sessionId => {
          if (item.sessionId !== sessionId) {
            const previousSessionId = item.sessionId;
            item.sessionId = sessionId;
            try { this.reserveSession(item); }
            catch (error) { item.sessionId = previousSessionId; throw error; }
            if (previousSessionId && previousSessionId !== sessionId && this.activeSessions.get(previousSessionId) === item.id)
              this.activeSessions.delete(previousSessionId);
          }
          item.updatedAt = this.now(); void this.persist().catch(() => {});
        },
        onDelta: text => {
          if (typeof text !== 'string' || !text) return;
          const safeText = redactText(text);
          this.publish('turn.delta', { turnId, sessionId: item.sessionId, text: safeText.slice(0, MAX_DELTA_CHARS) });
        },
        onStatus: async status => {
          if (status?.phase === 'tool') {
            item.tool = status.name;
            const step = startToolStep(item, status.name, this.now(), status.callId);
            await this.persist();
            await report('tool.started', { name: status.name });
            await report('task.step.updated', { step });
          } else if (status?.phase === 'tool_finished') {
            item.tool = null;
            const step = finishToolStep(item, status, this.now(), status.callId);
            await this.persist();
            await report('tool.finished', { name: status.name, ok: status.ok, ...(status.errorCode ? { errorCode: status.errorCode } : {}), ...(status.errorMessage ? { errorMessage: status.errorMessage } : {}) });
            if (step) await report('task.step.updated', { step });
          }
        },
      });
      item.sessionId = result?.sessionId ?? item.sessionId;
      completePlan(item, this.now());
      item.status = 'completed'; item.updatedAt = this.now(); item.errorCode = null; item.errorMessage = null; item.approvalId = null;
      await this.persist();
      await report('task.plan.updated', { plan: item.plan });
      await report('turn.completed', { status: item.status });
      return { ...result, turnId, sessionId: item.sessionId };
    } catch (error) {
      item.sessionId = error.sessionId ?? item.sessionId;
      item.updatedAt = this.now();
      if (error.code === 'APPROVAL_REQUIRED') {
        pausePlan(item, this.now());
        item.status = 'awaiting_approval'; item.approvalId = error.approvalId ?? null; item.errorCode = null; item.errorMessage = null;
        await this.persist();
        await report('task.plan.updated', { plan: item.plan });
        const approval = this.approvals?.get(item.approvalId);
        await report('turn.awaiting_approval', { status: item.status, approval: approval ? redact({ id: approval.id, type: approval.type, operation: approval.operation, resourceHash: approval.resourceHash, expiresAt: approval.expiresAt, metadata: approval.metadata }) : { id: item.approvalId } });
      } else if (error.code === 'USER_CLARIFICATION_REQUIRED' && error.clarification) {
        pausePlan(item, this.now());
        item.status = 'awaiting_clarification'; item.approvalId = null; item.clarification = structuredClone(error.clarification); item.errorCode = null; item.errorMessage = null; item.tool = null;
        await this.persist();
        await report('task.plan.updated', { plan: item.plan });
        await report('turn.awaiting_clarification', { status: item.status, clarification: item.clarification });
      } else if (error.code === 'CANCELLED' || controller.signal.aborted) {
        failPlan(item, 'cancelled', '操作已取消', this.now());
        item.status = 'cancelled'; item.approvalId = null; item.errorCode = 'CANCELLED'; item.errorMessage = null;
        item.tool = null;
        await this.persist();
        await report('task.plan.updated', { plan: item.plan });
        await report('turn.failed', { status: item.status, errorCode: item.errorCode });
      } else {
        failPlan(item, 'failed', error.message, this.now());
        item.status = 'failed'; item.approvalId = null; item.errorCode = typeof error.code === 'string' ? error.code.slice(0, 80) : 'TURN_FAILED';
        item.errorMessage = typeof error.message === 'string' ? redactText(error.message).slice(0, 500) : '回合执行失败';
        item.tool = null;
        await this.persist();
        await report('task.plan.updated', { plan: item.plan });
        await report('turn.failed', { status: item.status, errorCode: item.errorCode, errorMessage: item.errorMessage });
      }
      throw error;
    } finally {
      this.controllers.delete(turnId);
      this.refreshSessionReservation(item);
    }
  }

  refreshSessionReservation(item) {
    if (!item?.sessionId) return;
    const current = this.activeSessions.get(item.sessionId);
    if (['running', 'cancelling', 'awaiting_approval', 'awaiting_clarification'].includes(item.status)) this.activeSessions.set(item.sessionId, item.id);
    else if (current === item.id) this.activeSessions.delete(item.sessionId);
  }

  reserveSession(item) {
    if (!item?.sessionId) return;
    this.assertSessionAvailable(item);
    this.activeSessions.set(item.sessionId, item.id);
  }

  assertSessionAvailable(item) {
    if (!item?.sessionId) return;
    const activeId = this.activeSessions.get(item.sessionId);
    const active = activeId ? this.items.get(activeId) : null;
    if (active && active.id !== item.id && ['running', 'cancelling', 'awaiting_approval', 'awaiting_clarification'].includes(active.status)) {
      throw Object.assign(new Error('Another turn is already active for this session'), { code: 'SESSION_TURN_CONFLICT', sessionId: item.sessionId, turnId: active.id });
    }
  }

  async cancel(turnId, clientIdentity) {
    await this.load();
    const item = this.items.get(turnId);
    if (!item || item.clientIdentity !== clientIdentity) throw Object.assign(new Error('Turn not found'), { code: 'TURN_NOT_FOUND' });
    if (item.status === 'awaiting_clarification') {
      failPlan(item, 'cancelled', '用户取消了选择', this.now());
      item.status = 'cancelled'; item.errorCode = 'CANCELLED'; item.errorMessage = '用户取消了选择'; item.clarification = null; item.updatedAt = this.now();
      this.refreshSessionReservation(item); await this.persist();
      this.publish('task.plan.updated', { turnId, sessionId: item.sessionId, plan: item.plan });
      this.publish('turn.failed', { turnId, sessionId: item.sessionId, status: item.status, errorCode: item.errorCode, errorMessage: item.errorMessage });
      return this.public(item);
    }
    if (item.status === 'awaiting_approval' && item.approvalId) {
      if (this.approvals) await this.approvals.resolve(item.approvalId, 'cancelled');
      else { item.status = 'cancelled'; item.errorCode = 'CANCELLED'; item.errorMessage = null; item.approvalId = null; item.updatedAt = this.now(); await this.persist(); this.publish('turn.failed', { turnId, sessionId: item.sessionId, status: item.status, errorCode: item.errorCode }); }
      return this.public(item);
    }
    const controller = this.controllers.get(turnId);
    if (!controller || item.status !== 'running') throw Object.assign(new Error('Turn is not running'), { code: 'TURN_NOT_RUNNING' });
    controller.abort(Object.assign(new Error('Turn cancelled by client'), { code: 'CANCELLED' }));
    item.status = 'cancelling'; item.updatedAt = this.now();
    await this.persist();
    return this.public(item);
  }

  async approvalEvent(event) {
    const approval = event?.approval;
    if (event?.type !== 'approval.resolved' || !approval?.metadata?.turnId) return;
    await this.load();
    const item = this.items.get(approval.metadata.turnId);
    if (!item || item.approvalId !== approval.id || item.status !== 'awaiting_approval') return;
    if (approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired') {
      failPlan(item, approval.status === 'denied' ? 'denied' : approval.status, approval.status === 'denied' ? '用户拒绝了这项操作' : `审批状态：${approval.status}`, this.now());
      item.status = approval.status === 'denied' ? 'denied' : approval.status;
      item.errorCode = approval.status === 'denied' ? 'USER_DENIED' : approval.status.toUpperCase();
      item.errorMessage = approval.status === 'denied' ? '用户拒绝了这项操作' : `审批状态：${approval.status}`;
      item.approvalId = null; item.updatedAt = this.now();
      this.refreshSessionReservation(item);
      await this.persist();
      this.publish('task.plan.updated', { turnId: item.id, sessionId: item.sessionId, plan: item.plan });
      this.publish('turn.failed', { turnId: item.id, sessionId: item.sessionId, status: item.status, errorCode: item.errorCode, errorMessage: item.errorMessage });
    }
  }

  async get(turnId, clientIdentity) {
    await this.load();
    const item = this.items.get(turnId);
    if (!item || item.clientIdentity !== clientIdentity) return null;
    const approval = item.status === 'awaiting_approval' ? this.approvals?.get(item.approvalId) : null;
    return { ...this.public(item), ...(approval ? { approval } : {}) };
  }

  async getInputHash(turnId, clientIdentity) {
    await this.load();
    const item = this.items.get(turnId);
    if (!item || item.clientIdentity !== clientIdentity) return null;
    return item.inputHash ?? null;
  }

  async getInputResource(turnId, clientIdentity) {
    await this.load();
    const item = this.items.get(turnId);
    if (!item || item.clientIdentity !== clientIdentity) return null;
    return { inputHash: item.inputHash ?? null, attachmentId: item.attachmentId ?? null, ...(item.skillId ? { skillId: item.skillId } : {}), ...(item.skillReference ? { skillReference: item.skillReference } : {}) };
  }

  async getRecoveryRequest(turnId, clientIdentity) {
    await this.load();
    const item = this.items.get(turnId);
    if (!item || item.clientIdentity !== clientIdentity) return null;
    return { input: item.input ?? null, attachmentId: item.attachmentId ?? null, inputHash: item.inputHash ?? null, ...(item.skillId ? { skillId: item.skillId } : {}), ...(item.skillReference ? { skillReference: item.skillReference } : {}) };
  }

  async recover(turnId, clientIdentity, runner, { input, attachmentId = null, uploadedAttachment = null, skillId = null } = {}) {
    await this.load();
    const item = this.items.get(turnId);
    if (!item || item.clientIdentity !== clientIdentity) throw Object.assign(new Error('Turn not found'), { code: 'TURN_NOT_FOUND' });
    if (item.status !== 'interrupted' || !item.structuredPlan) throw Object.assign(new Error('Only an interrupted structured plan can be recovered'), { code: 'PLAN_NOT_RECOVERABLE' });
    if (typeof input !== 'string' || !input.trim() || fingerprint(`${input}\u0000${attachmentId ?? ''}${skillId ? `\u0000${skillId}` : ''}`) !== item.inputHash)
      throw Object.assign(new Error('The original user request could not be verified'), { code: 'TURN_RESOURCE_CHANGED' });
    const plan = recoverStructuredPlan(item.structuredPlan);
    item.structuredPlan = plan; item.status = 'running'; item.errorCode = null; item.errorMessage = null; item.updatedAt = this.now();
    this.assertSessionAvailable(item); this.reserveSession(item);
    await this.persist();
    this.publish('task.structured_plan.updated', { turnId, sessionId: item.sessionId, plan });
    const controller = new AbortController(); this.controllers.set(turnId, controller);
    const report = async (type, payload) => this.publish(type, { turnId, sessionId: item.sessionId, ...payload });
    try {
      const result = await runner({ input, attachmentId, uploadedAttachment, ...(skillId ? { skillId } : {}), structuredPlan: plan, turnId, sessionId: item.sessionId, clientIdentity, signal: controller.signal,
        onSession: sessionId => { item.sessionId = sessionId; item.updatedAt = this.now(); void this.persist().catch(() => {}); },
        onDelta: text => { if (typeof text === 'string' && text) this.publish('turn.delta', { turnId, sessionId: item.sessionId, text: redactText(text).slice(0, MAX_DELTA_CHARS) }); },
        onStatus: async status => {
          if (status?.phase === 'tool') {
            item.tool = status.name; const step = startToolStep(item, status.name, this.now(), status.callId);
            await this.persist(); await report('tool.started', { name: status.name }); await report('task.step.updated', { step });
          } else if (status?.phase === 'tool_finished') {
            item.tool = null; const step = finishToolStep(item, status, this.now(), status.callId);
            await this.persist(); await report('tool.finished', { name: status.name, ok: status.ok, ...(status.errorCode ? { errorCode: status.errorCode } : {}) });
            if (step) await report('task.step.updated', { step });
          }
        },
        onPlan: async updated => { item.structuredPlan = updated; item.updatedAt = this.now(); await this.persist(); this.publish('task.structured_plan.updated', { turnId, sessionId: item.sessionId, plan: updated }); } });
      item.status = 'completed'; item.errorCode = null; item.errorMessage = null; item.updatedAt = this.now();
      await this.persist(); this.refreshSessionReservation(item);
      this.publish('turn.completed', { turnId, sessionId: item.sessionId, status: item.status });
      return { ...result, turnId, sessionId: item.sessionId };
    } catch (error) {
      item.status = 'failed'; item.errorCode = error.code ?? 'TURN_FAILED'; item.errorMessage = redactText(error.message || '恢复失败').slice(0, 500); item.updatedAt = this.now();
      await this.persist(); this.refreshSessionReservation(item); this.publish('turn.failed', { turnId, sessionId: item.sessionId, status: item.status, errorCode: item.errorCode, errorMessage: item.errorMessage });
      throw error;
    } finally { this.controllers.delete(turnId); }
  }

  async retryStep(turnId, stepId, clientIdentity, runner, { input, attachmentId = null, uploadedAttachment = null, skillId = null, confirmUncertain = false } = {}) {
    await this.load();
    const item = this.items.get(turnId);
    if (!item || item.clientIdentity !== clientIdentity) throw Object.assign(new Error('Turn not found'), { code: 'TURN_NOT_FOUND' });
    if (!item.structuredPlan || !['failed', 'interrupted', 'completed'].includes(item.status)) throw Object.assign(new Error('Turn has no retryable structured plan'), { code: 'PLAN_STEP_NOT_RETRYABLE' });
    if (typeof input !== 'string' || !input.trim() || fingerprint(`${input}\u0000${attachmentId ?? ''}${skillId ? `\u0000${skillId}` : ''}`) !== item.inputHash)
      throw Object.assign(new Error('The original user request could not be verified'), { code: 'TURN_RESOURCE_CHANGED' });
    if (this.controllers.size >= 16) throw Object.assign(new Error('Gateway turn capacity reached'), { code: 'TURN_CAPACITY_REACHED' });
    const plan = item.structuredPlan;
    const step = plan.steps.find(value => value.id === stepId);
    if (!step) throw Object.assign(new Error('Plan step not found'), { code: 'PLAN_STEP_NOT_FOUND' });
    if (step.status === 'uncertain' && confirmUncertain !== true) throw Object.assign(new Error('该步骤结果不确定。先核实外部效果，再明确确认重试'), { code: 'PLAN_STEP_OUTCOME_UNCERTAIN' });
    if (!['failed', 'uncertain'].includes(step.status) || step.attempts >= step.retryPolicy.maxAttempts)
      throw Object.assign(new Error('该步骤当前状态或重试次数不允许重试'), { code: 'PLAN_STEP_NOT_RETRYABLE' });
    const completed = new Set(plan.steps.filter(value => ['completed', 'skipped'].includes(value.status)).map(value => value.id));
    if (!step.dependsOn.every(id => completed.has(id)) || !(plan.phases.find(value => value.id === step.phaseId)?.dependsOn ?? []).every(id => plan.phases.find(value => value.id === id)?.status === 'completed'))
      throw Object.assign(new Error('步骤依赖尚未完成，不能单独重试'), { code: 'STEP_DEPENDENCY_BLOCKED' });
    if (typeof input !== 'string' || !input.trim()) throw Object.assign(new Error('Original request is unavailable'), { code: 'TURN_RESOURCE_CHANGED' });
    this.assertSessionAvailable(item);
    step.status = 'ready'; step.acceptanceStatus = 'pending'; delete step.lastErrorCode; delete step.lastErrorMessage;
    const phase = plan.phases.find(value => value.id === step.phaseId);
    if (phase?.status === 'failed') { phase.status = 'running'; phase.acceptanceStatus = 'pending'; delete phase.lastErrorCode; delete phase.lastErrorMessage; }
    plan.status = 'ready'; plan.updatedAt = this.now();
    item.status = 'running'; item.errorCode = null; item.errorMessage = null; item.updatedAt = this.now();
    this.reserveSession(item); await this.persist();
    this.publish('task.structured_plan.updated', { turnId, sessionId: item.sessionId, plan });
    const controller = new AbortController(); this.controllers.set(turnId, controller);
    try {
      const result = await runner({ input, attachmentId, uploadedAttachment, ...(skillId ? { skillId } : {}), structuredPlan: plan, retryStepId: step.id, turnId, sessionId: item.sessionId, clientIdentity, signal: controller.signal,
        onSession: sessionId => { item.sessionId = sessionId; item.updatedAt = this.now(); void this.persist().catch(() => {}); },
        onDelta: text => { if (typeof text === 'string' && text) this.publish('turn.delta', { turnId, sessionId: item.sessionId, text: redactText(text).slice(0, MAX_DELTA_CHARS) }); },
        onStatus: async status => {
          if (status?.phase === 'tool') { item.tool = status.name; const timeline = startToolStep(item, status.name, this.now(), status.callId); await this.persist(); this.publish('tool.started', { turnId, sessionId: item.sessionId, name: status.name }); this.publish('task.step.updated', { turnId, sessionId: item.sessionId, step: timeline }); }
          else if (status?.phase === 'tool_finished') { item.tool = null; const timeline = finishToolStep(item, status, this.now(), status.callId); await this.persist(); this.publish('tool.finished', { turnId, sessionId: item.sessionId, name: status.name, ok: status.ok, ...(status.errorCode ? { errorCode: status.errorCode } : {}) }); if (timeline) this.publish('task.step.updated', { turnId, sessionId: item.sessionId, step: timeline }); }
        },
        onPlan: async updated => { item.structuredPlan = updated; item.updatedAt = this.now(); await this.persist(); this.publish('task.structured_plan.updated', { turnId, sessionId: item.sessionId, plan: updated }); } });
      const retried = item.structuredPlan.steps.find(value => value.id === stepId);
      item.status = retried?.status === 'completed' ? 'completed' : 'failed';
      item.errorCode = item.status === 'completed' ? null : retried?.lastErrorCode || 'PLAN_STEP_RETRY_FAILED';
      item.errorMessage = item.status === 'completed' ? null : retried?.lastErrorMessage || '步骤重试未通过验收'; item.updatedAt = this.now();
      await this.persist(); this.refreshSessionReservation(item);
      this.publish(item.status === 'completed' ? 'turn.completed' : 'turn.failed', { turnId, sessionId: item.sessionId, status: item.status, ...(item.errorCode ? { errorCode: item.errorCode, errorMessage: item.errorMessage } : {}) });
      return { ...result, turnId, sessionId: item.sessionId, status: item.status };
    } catch (error) {
      item.status = 'failed'; item.errorCode = error.code ?? 'PLAN_STEP_RETRY_FAILED'; item.errorMessage = redactText(error.message || '步骤重试失败').slice(0, 500); item.updatedAt = this.now();
      await this.persist(); this.refreshSessionReservation(item); this.publish('turn.failed', { turnId, sessionId: item.sessionId, status: item.status, errorCode: item.errorCode, errorMessage: item.errorMessage }); throw error;
    } finally { this.controllers.delete(turnId); }
  }

  canAccess(turnId, clientIdentity) { const item = this.items.get(turnId); return Boolean(item && item.clientIdentity === clientIdentity); }
  public(item) { const { clientIdentity, inputHash, input: privateInput, ...safe } = item; return { ...safe }; }

  publish(type, payload) {
    const event = this.emit(type, payload, { correlationId: payload.turnId, source: 'gateway' });
    if (type === 'turn.delta') return event;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.schedulePersist();
    return event;
  }

  schedulePersist() {
    if (!this.file || this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; void this.persist().catch(() => {}); }, 100);
    this.persistTimer.unref?.();
  }

  async replay(afterId, { clientIdentity, turnId } = {}) {
    await this.load();
    if (turnId && !this.canAccess(turnId, clientIdentity)) throw Object.assign(new Error('Turn not found'), { code: 'TURN_NOT_FOUND' });
    let start = 0;
    if (afterId) { const index = this.events.findIndex(event => event.id === afterId); if (index >= 0) start = index + 1; }
    return this.events.slice(start).filter(event => {
      const eventTurn = event.payload?.turnId;
      if (turnId && eventTurn !== turnId) return false;
      return !eventTurn || this.canAccess(eventTurn, clientIdentity);
    });
  }

  abortActive(reason = 'Gateway is shutting down') {
    for (const controller of this.controllers.values()) controller.abort(Object.assign(new Error(reason), { code: 'CANCELLED' }));
  }

  prune() {
    const terminal = [...this.items.values()].filter(item => !['running', 'cancelling', 'awaiting_approval'].includes(item.status));
    while (this.items.size >= MAX_TURNS && terminal.length) {
      const item = terminal.shift();
      this.items.delete(item.id);
    }
  }
}

function createInitialPlan(input) {
  const goal = String(input || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || '执行用户请求';
  return { version: 1, status: 'running', goal, steps: [{ id: 'understand', label: '理解用户需求', status: 'completed', kind: 'system' }] };
}

function startToolStep(item, name, now, callId = null) {
  item.plan ??= createInitialPlan('执行用户请求');
  item.stepSequence = Number.isSafeInteger(item.stepSequence) ? item.stepSequence + 1 : item.plan.steps.length;
  const step = { id: `${item.id}:step:${item.stepSequence}`, label: toolLabel(name), tool: name, status: 'running', startedAt: now };
  item.plan.steps.push(step);
  item.activeStepId = step.id;
  item.activeStepIds ??= {};
  if (typeof callId === 'string' && callId) item.activeStepIds[callId] = step.id;
  item.updatedAt = now;
  return step;
}

function finishToolStep(item, status, now, callId = null) {
  const stepId = typeof callId === 'string' && callId ? item.activeStepIds?.[callId] : item.activeStepId;
  const step = item.plan?.steps?.find(value => value.id === stepId);
  if (!step) return null;
  step.status = status?.errorCode === 'APPROVAL_REQUIRED' ? 'waiting' : status?.ok ? 'completed' : 'failed';
  step.finishedAt = now;
  if (status?.errorCode) step.errorCode = String(status.errorCode).slice(0, 80);
  if (!status?.ok && status?.errorCode !== 'APPROVAL_REQUIRED') step.errorMessage = String(status?.errorMessage || '工具执行失败').slice(0, 500);
  if (typeof callId === 'string' && callId) delete item.activeStepIds?.[callId];
  item.activeStepId = Object.values(item.activeStepIds ?? {})[0] ?? null;
  item.updatedAt = now;
  return step;
}

function completePlan(item, now) {
  item.plan ??= createInitialPlan('执行用户请求');
  for (const step of item.plan.steps) {
    if (step.status === 'running' || step.status === 'waiting') {
      step.status = 'completed';
      step.finishedAt = now;
    }
  }
  if (!item.plan.steps.some(step => step.id === `${item.id}:result`))
    item.plan.steps.push({ id: `${item.id}:result`, label: '整理并返回结果', status: 'completed', kind: 'system', finishedAt: now });
  item.plan.status = 'completed';
  item.activeStepId = null;
}

function pausePlan(item, now) {
  const step = item.plan?.steps?.find(value => value.id === item.activeStepId);
  if (step) step.status = 'waiting';
  if (item.plan) item.plan.status = 'waiting';
  item.updatedAt = now;
}

function failPlan(item, status, message, now) {
  const step = item.plan?.steps?.find(value => value.id === item.activeStepId);
  if (step) {
    step.status = status === 'cancelled' ? 'cancelled' : 'failed';
    step.errorMessage = String(message || '回合执行失败').slice(0, 400);
    step.finishedAt = now;
  }
  item.plan ??= createInitialPlan('执行用户请求');
  item.plan.status = status;
  item.activeStepId = null;
  item.activeStepIds = {};
  item.updatedAt = now;
}

function interruptPlan(item) {
  if (!item.plan) return;
  for (const step of item.plan.steps ?? []) if (step.status === 'running' || step.status === 'waiting') {
    step.status = 'interrupted';
    step.errorMessage = 'Gateway 重启，任务在此处中断';
  }
  item.plan.status = 'interrupted';
  item.activeStepId = null;
  item.activeStepIds = {};
}

function interruptStructuredPlan(item) {
  const plan = item.structuredPlan;
  if (!plan) return;
  for (const step of plan.steps ?? []) if (step.status === 'running' || step.status === 'waiting_approval') {
    step.status = step.sideEffect ? 'uncertain' : 'interrupted';
    step.lastErrorCode = step.sideEffect ? 'SIDE_EFFECT_OUTCOME_UNKNOWN' : 'GATEWAY_RESTARTED';
    step.lastErrorMessage = step.sideEffect ? 'Gateway 重启时此副作用步骤正在执行；请先核实实际结果，再决定是否重试' : 'Gateway 重启，任务在此处中断';
  }
  plan.status = 'interrupted'; plan.updatedAt = Date.now();
  plan.checkpoints = [...(plan.checkpoints ?? []), { planId: plan.id, revision: plan.revision, reason: 'gateway-restarted', completedSteps: plan.steps.filter(step => ['completed', 'skipped'].includes(step.status)).map(step => step.id), failedSteps: plan.steps.filter(step => ['failed', 'uncertain'].includes(step.status)).map(step => step.id), runningSteps: [], createdAt: new Date().toISOString() }].slice(-32);
}

function toolLabel(name) {
  return ({
    read_file: '读取文件', file_info: '检查文件信息', list_files: '列出目录', find_files: '查找文件', search_text: '搜索文件内容',
    write_file: '写入文件', edit_file: '编辑文件', external_read_file: '读取外部文件', external_file_info: '检查外部文件',
    external_list_files: '列出外部目录', external_find_files: '查找外部文件', external_search_text: '搜索外部内容',
    external_write_file: '写入外部文件', external_edit_file: '编辑外部文件', sandbox_command: '执行受控命令',
  })[name] || `调用工具：${name}`;
}
