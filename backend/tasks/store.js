import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

function nextAt(schedule, now = Date.now()) {
  if (schedule.type === 'once') return schedule.at > now ? schedule.at : null;
  if (schedule.type === 'interval') return now + schedule.ms;
  if (schedule.type === 'daily') { const next = new Date(now); next.setHours(schedule.hour, schedule.minute, 0, 0); if (next.getTime() <= now) next.setDate(next.getDate() + 1); return next.getTime(); }
  if (schedule.type === 'heartbeat') return now + schedule.ms;
  if (schedule.type === 'cron') return nextCron(schedule.expression, now);
  throw new Error('Unsupported schedule');
}

async function unlinkIfPresent(file) {
  try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function cronField(value, min, max) {
  const values = new Set();
  for (const part of String(value).split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error('Invalid cron step');
    const [startText, endText] = range.includes('-') ? range.split('-') : [range, range];
    const start = startText === '*' ? min : Number(startText);
    const end = endText === '*' ? max : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new Error('Invalid cron range');
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function cronParts(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Cron requires five fields: minute hour day month weekday');
  return [cronField(fields[0], 0, 59), cronField(fields[1], 0, 23), cronField(fields[2], 1, 31), cronField(fields[3], 1, 12), cronField(fields[4], 0, 6)];
}

function nextCron(expression, now = Date.now()) {
  const [minutes, hours, days, months, weekdays] = cronParts(expression);
  const cursor = new Date(now - (now % 60_000) + 60_000);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (minutes.has(cursor.getMinutes()) && hours.has(cursor.getHours()) && days.has(cursor.getDate()) && months.has(cursor.getMonth() + 1) && weekdays.has(cursor.getDay())) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error('Cron has no occurrence within one year');
}

export class TaskStore {
  constructor(root, { run = async () => ({ ok: false, code: 'TASK_RUNNER_UNAVAILABLE' }), onEvent = async () => {}, maxConcurrent = 2, now = () => Date.now() } = {}) {
    this.file = path.join(path.resolve(root), '.agent-data', 'tasks.json');
    this.runTask = run; this.onEvent = onEvent; this.maxConcurrent = Math.max(1, Math.min(16, maxConcurrent)); this.now = now;
    this.data = null; this.timer = null; this.active = new Map(); this.loadedRecovery = false; this.saveQueue = Promise.resolve();
  }
  async load() {
    if (this.data) return this.data;
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { version: 2, tasks: {}, history: [] }; }
    this.data.version = Math.max(2, this.data.version ?? 1); this.data.tasks ??= {}; this.data.history ??= [];
    if (!this.loadedRecovery) {
      this.loadedRecovery = true;
      let changed = false;
      for (const task of Object.values(this.data.tasks)) {
        if (task.status !== 'running') continue;
        task.status = 'interrupted'; task.enabled = false; task.nextRun = null; task.recoveredAt = this.now(); task.recoveryRequired = true; changed = true;
      }
      if (changed) await this.save();
    }
    return this.data;
  }
  async save() {
    const operation = this.saveQueue.then(async () => {
      const data = await this.load(); await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temp, this.file); }
      finally { await unlinkIfPresent(temp); }
    });
    this.saveQueue = operation.catch(() => {});
    return operation;
  }
  validateSchedule(schedule) { if (!schedule || !['once', 'interval', 'daily', 'heartbeat', 'cron'].includes(schedule.type)) throw new Error('Unsupported task schedule'); if (schedule.type === 'once' && !Number.isSafeInteger(schedule.at)) throw new Error('Invalid once schedule'); if ((schedule.type === 'interval' || schedule.type === 'heartbeat') && (!Number.isSafeInteger(schedule.ms) || schedule.ms < 10_000 || schedule.ms > 31 * 86400_000)) throw new Error('Invalid interval schedule'); if (schedule.type === 'daily' && (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23 || !Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59)) throw new Error('Invalid daily schedule'); if (schedule.type === 'cron') cronParts(schedule.expression); }
  async create({ name, schedule, payload, enabled = true, retry = { max: 2 }, permissions = {}, timeoutMs = 10 * 60_000 }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('Invalid task name'); this.validateSchedule(schedule);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) throw Object.assign(new Error('Invalid task timeout'), { code: 'TASK_TIMEOUT_INVALID' });
    const data = await this.load(); const id = randomUUID(); const snapshot = this.validatePermissions(permissions);
    data.tasks[id] = { id, name: name.trim(), schedule, payload: structuredClone(payload ?? {}), permissions: snapshot, timeoutMs, enabled: enabled !== false, retry: { max: Math.min(5, Math.max(0, retry.max ?? 2)) }, failureCount: 0, nextRun: nextAt(schedule, this.now()), status: 'scheduled', createdAt: this.now() };
    await this.save(); await this.onEvent({ type: 'task.updated', task: this.public(data.tasks[id]) }); return this.public(data.tasks[id]);
  }
  validatePermissions(input = {}) {
    const tools = input.tools === undefined ? [] : input.tools;
    const roots = input.roots === undefined ? [] : input.roots;
    if (!Array.isArray(tools) || tools.length > 32 || tools.some(value => typeof value !== 'string' || value.length > 128)) throw Object.assign(new Error('Invalid task tool permissions'), { code: 'TASK_PERMISSION_INVALID' });
    if (!Array.isArray(roots) || roots.length > 16 || roots.some(value => typeof value !== 'string' || value.length > 2048 || !path.isAbsolute(value) && !path.win32.isAbsolute(value))) throw Object.assign(new Error('Invalid task path permissions'), { code: 'TASK_PERMISSION_INVALID' });
    return { tools: [...new Set(tools)], roots: [...new Set(roots)], network: input.network === true, messages: input.messages === true, maxFiles: Number.isSafeInteger(input.maxFiles) ? Math.min(1000, Math.max(1, input.maxFiles)) : 100, maxBytes: Number.isSafeInteger(input.maxBytes) ? Math.min(50 * 1024 * 1024, Math.max(1, input.maxBytes)) : 2 * 1024 * 1024 };
  }
  async run(id) {
    const data = await this.load(); const task = data.tasks[id]; if (!task) throw new Error('Task not found');
    if (this.active.has(id) || task.status === 'running') throw Object.assign(new Error('Task is already running'), { code: 'TASK_ALREADY_RUNNING' });
    if (this.active.size >= this.maxConcurrent) throw Object.assign(new Error('Task concurrency limit reached'), { code: 'TASK_CONCURRENCY_LIMIT' });
    if (!task.enabled) throw Object.assign(new Error('Task is not enabled'), { code: 'TASK_NOT_ENABLED' });
    if (task.schedule.type === 'once' && task.status === 'completed') throw Object.assign(new Error('Task is already completed'), { code: 'TASK_ALREADY_COMPLETED' });
    if (['paused', 'cancelled', 'interrupted', 'dead_letter'].includes(task.status) && !task.enabled) throw Object.assign(new Error('Task is not enabled'), { code: 'TASK_NOT_ENABLED' });
    const runId = randomUUID(); const controller = new AbortController(); const startedAt = this.now();
    this.active.set(id, { runId, controller, startedAt }); task.status = 'running'; task.runId = runId; task.startedAt = startedAt; task.recoveryRequired = false; await this.save(); await this.onEvent({ type: 'task.updated', task: this.public(task) });
    const permissions = Object.freeze(structuredClone(task.permissions ?? this.validatePermissions())); let result; let timedOut = false; let timer;
    try {
      const operation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason ?? Object.assign(new Error('Task cancelled'), { code: 'TASK_CANCELLED' });
        return this.runTask(Object.freeze(structuredClone(task)), permissions, { signal: controller.signal, runId });
      });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(Object.assign(new Error('Task timed out'), { code: 'TASK_TIMEOUT' })); reject(Object.assign(new Error('Task timed out'), { code: 'TASK_TIMEOUT' })); }, task.timeoutMs ?? 10 * 60_000); timer.unref?.(); });
      result = await Promise.race([operation, timeout]);
      if (controller.signal.aborted) throw controller.signal.reason ?? Object.assign(new Error('Task cancelled'), { code: 'TASK_CANCELLED' });
    } catch (error) {
      const cancelled = task.cancelRequested === true || controller.signal.reason?.code === 'TASK_CANCELLED' || error?.code === 'TASK_CANCELLED' || error?.name === 'AbortError';
      result = { ok: false, code: timedOut ? 'TASK_TIMEOUT' : cancelled ? 'TASK_CANCELLED' : error.code ?? 'TASK_RUN_FAILED', error: error.message };
    } finally { clearTimeout(timer); this.active.delete(id); }
    const finishedAt = this.now(); task.lastRun = finishedAt; task.finishedAt = finishedAt; delete task.runId; delete task.startedAt;
    if (task.cancelRequested || result?.code === 'TASK_CANCELLED') { task.status = 'cancelled'; task.enabled = false; task.nextRun = null; delete task.cancelRequested; }
    else {
      const failed = result?.ok === false; task.failureCount = failed ? task.failureCount + 1 : 0;
      task.status = failed ? (task.failureCount > task.retry.max ? 'dead_letter' : 'scheduled') : task.schedule.type === 'once' ? 'completed' : 'scheduled';
      task.deadLetter = task.status === 'dead_letter'; if (task.deadLetter) task.deadLetterAt = finishedAt;
      task.nextRun = task.schedule.type === 'once'
        ? (failed && task.failureCount <= task.retry.max ? finishedAt + Math.min(60_000, 1_000 * 2 ** Math.max(0, task.failureCount - 1)) : null)
        : nextAt(task.schedule, finishedAt);
    }
    data.history.push({ taskId: id, runId, startedAt, time: finishedAt, status: task.status, result: { ok: result?.ok !== false, code: result?.code ?? null } }); data.history = data.history.slice(-1000); await this.save(); await this.onEvent({ type: 'task.updated', task: this.public(task) }); return { task: this.public(task), result };
  }
  async cancel(id) {
    const data = await this.load(); const task = data.tasks[id]; if (!task) throw new Error('Task not found');
    const active = this.active.get(id); if (!active) { task.status = 'cancelled'; task.enabled = false; task.nextRun = null; await this.save(); await this.onEvent({ type: 'task.updated', task: this.public(task) }); return this.public(task); }
    task.cancelRequested = true; active.controller.abort(Object.assign(new Error('Task cancelled'), { code: 'TASK_CANCELLED' })); await this.save(); return this.public(task);
  }
  async recover(id, { runNow = true } = {}) {
    const data = await this.load(); const task = data.tasks[id]; if (!task) throw new Error('Task not found');
    if (!['interrupted', 'cancelled', 'dead_letter', 'failed'].includes(task.status)) throw Object.assign(new Error('Task does not require recovery'), { code: 'TASK_RECOVERY_NOT_REQUIRED' });
    task.enabled = true; task.status = 'scheduled'; task.deadLetter = false; task.failureCount = 0; task.recoveryRequired = false; task.nextRun = runNow ? this.now() : nextAt(task.schedule, this.now()); await this.save(); await this.onEvent({ type: 'task.updated', task: this.public(task) }); return this.public(task);
  }
  async setEnabled(id, enabled) { const data = await this.load(); if (!data.tasks[id]) throw new Error('Task not found'); data.tasks[id].enabled = enabled === true; data.tasks[id].status = enabled ? 'scheduled' : 'paused'; if (!enabled) data.tasks[id].nextRun = null; else data.tasks[id].nextRun = nextAt(data.tasks[id].schedule, this.now()); await this.save(); return this.public(data.tasks[id]); }
  async remove(id) { const data = await this.load(); if (!data.tasks[id]) throw new Error('Task not found'); delete data.tasks[id]; await this.save(); return { id, deleted: true }; }
  async startScheduler({ pollMs = 1000 } = {}) { if (this.timer) return; await this.load(); this.timer = setInterval(() => this.tick().catch(() => {}), Math.max(250, pollMs)); this.timer.unref?.(); }
  stopScheduler() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick(now = this.now()) { const tasks = await this.list(); for (const task of tasks) { if (this.active.size >= this.maxConcurrent) break; if (task.enabled && task.status === 'scheduled' && task.nextRun !== null && task.nextRun <= now) await this.run(task.id).catch(error => { if (!['TASK_ALREADY_RUNNING', 'TASK_CONCURRENCY_LIMIT'].includes(error.code)) void this.onEvent({ type: 'task.updated', task: { id: task.id, error: error.code ?? error.message } }); }); } }
  async list() { return Object.values((await this.load()).tasks).map(task => this.public(task)); }
  async history(id) { return (await this.load()).history.filter(item => !id || item.taskId === id); }
  async diagnostics() { const data = await this.load(); return { active: [...this.active].map(([id, run]) => ({ id, runId: run.runId, startedAt: run.startedAt })), maxConcurrent: this.maxConcurrent, scheduled: Object.values(data.tasks).filter(task => task.status === 'scheduled' && task.enabled).length, interrupted: Object.values(data.tasks).filter(task => task.status === 'interrupted').length, deadLetter: Object.values(data.tasks).filter(task => task.status === 'dead_letter').length, historyEntries: data.history.length }; }
  public(task) { return { ...task, payload: undefined, permissions: structuredClone(task.permissions ?? { tools: [], roots: [], network: false, messages: false, maxFiles: 100, maxBytes: 2 * 1024 * 1024 }), ...(task.payload === undefined ? {} : { hasPayload: true }) }; }
}
