import { createHash, randomUUID } from 'node:crypto';

export const PLAN_VERSION = 1;
export const PLAN_STATUSES = new Set(['draft', 'pending', 'ready', 'running', 'waiting', 'waiting_acceptance', 'completed', 'failed', 'blocked', 'cancelled', 'interrupted']);
export const STEP_STATUSES = new Set(['pending', 'ready', 'running', 'waiting_approval', 'completed', 'failed', 'blocked', 'skipped', 'uncertain', 'cancelled', 'interrupted']);

const MAX_GOAL = 240;
const MAX_PHASES = 16;
const MAX_STEPS = 128;
const MAX_ID = 80;
const ACCEPTANCE_TYPES = new Set(['tool_success', 'result_contains', 'file_exists', 'file_contains', 'command_exit_code', 'all_steps']);
const SIDE_EFFECT_TOOLS = new Set(['write_file', 'edit_file', 'external_write_file', 'external_edit_file', 'delete_file', 'restore_file', 'apply_change_plan', 'sandbox_command', 'sandbox_command_write', 'task_create', 'task_run', 'send_message', 'edit_message', 'delete_message', 'react_message', 'send_file', 'mcp_call_tool', 'process_start', 'process_kill']);

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}

function id(value, label) { return text(value, label, MAX_ID).replace(/[^A-Za-z0-9._:-]/g, '') || (() => { throw new Error(`${label} contains invalid characters`); })(); }

function unique(values, label) {
  const result = [...new Set(values)];
  if (result.length !== values.length) throw new Error(`${label} contains duplicate IDs`);
  return result;
}

function assertAcyclic(nodes, dependencies, label) {
  const visiting = new Set(); const visited = new Set();
  const visit = node => {
    if (visiting.has(node)) throw new Error(`${label} contains a dependency cycle`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of dependencies.get(node) ?? []) visit(dependency);
    visiting.delete(node); visited.add(node);
  };
  for (const node of nodes) visit(node);
}

function normalizeAcceptance(value, label, { phase = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}.acceptance is required`);
  const type = text(value.type, `${label}.acceptance.type`, 40);
  if (!ACCEPTANCE_TYPES.has(type)) throw new Error(`${label}.acceptance.type is unsupported: ${type}`);
  if (phase && !['all_steps', 'file_exists', 'file_contains'].includes(type)) throw new Error(`${label}.acceptance.type is not supported for phase acceptance: ${type}`);
  const acceptance = { type, ...(value.description === undefined ? {} : { description: text(value.description, `${label}.acceptance.description`, 300) }) };
  if (type === 'tool_success' && value.tool !== undefined) acceptance.tool = text(value.tool, `${label}.acceptance.tool`, 120);
  if (type === 'result_contains') acceptance.text = text(value.text, `${label}.acceptance.text`, 500);
  if (type === 'file_exists' || type === 'file_contains') acceptance.path = text(value.path, `${label}.acceptance.path`, 1000);
  if (type === 'file_contains') acceptance.text = text(value.text, `${label}.acceptance.text`, 500);
  if (type === 'command_exit_code') {
    const exitCode = value.exitCode ?? 0;
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) throw new Error(`${label}.acceptance.exitCode must be an integer from 0 to 255`);
    acceptance.exitCode = exitCode;
  }
  return acceptance;
}

function normalizeStep(value, index, phaseId, availableTools) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`steps[${index}] must be an object`);
  const stepId = id(value.id, `steps[${index}].id`);
  const tools = value.tools === undefined ? [] : unique(value.tools.map((tool, toolIndex) => text(tool, `steps[${index}].tools[${toolIndex}]`, 120)), `steps[${index}].tools`);
  if (!tools.length) throw new Error(`steps[${index}] must reference at least one executable tool`);
  if (availableTools && tools.some(tool => !availableTools.has(tool))) throw new Error(`steps[${index}] references a tool that is not available: ${tools.find(tool => !availableTools.has(tool))}`);
  const dependsOn = value.dependsOn === undefined ? [] : unique(value.dependsOn.map((dependency, dependencyIndex) => id(dependency, `steps[${index}].dependsOn[${dependencyIndex}]`)), `steps[${index}].dependsOn`);
  const retryPolicy = value.retryPolicy && typeof value.retryPolicy === 'object' && !Array.isArray(value.retryPolicy)
    ? { maxAttempts: Number.isSafeInteger(value.retryPolicy.maxAttempts) && value.retryPolicy.maxAttempts > 0 && value.retryPolicy.maxAttempts <= 8 ? value.retryPolicy.maxAttempts : 2, mode: value.retryPolicy.mode === 'repair-arguments' ? 'repair-arguments' : 'safe' }
    : { maxAttempts: 2, mode: 'safe' };
  return {
    id: stepId, phaseId, title: text(value.title ?? value.label, `steps[${index}].title`, 160),
    kind: text(value.kind ?? 'operation', `steps[${index}].kind`, 40), dependsOn, tools,
    acceptance: normalizeAcceptance(value.acceptance, `steps[${index}]`), retryPolicy,
    sideEffect: value.sideEffect === true || tools.some(tool => SIDE_EFFECT_TOOLS.has(tool)), status: STEP_STATUSES.has(value.status) ? value.status : 'pending',
    attempts: Number.isSafeInteger(value.attempts) && value.attempts >= 0 ? value.attempts : 0,
    ...(value.lastErrorCode ? { lastErrorCode: text(value.lastErrorCode, `steps[${index}].lastErrorCode`, 80) } : {}),
    ...(value.lastErrorMessage ? { lastErrorMessage: text(value.lastErrorMessage, `steps[${index}].lastErrorMessage`, 500) } : {}),
  };
}

export function normalizeStructuredPlan(input, { availableTools = null, now = () => Date.now() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Execution plan must be an object');
  const goal = text(input.goal, 'plan.goal', MAX_GOAL);
  const rawPhases = Array.isArray(input.phases) ? input.phases : [];
  if (rawPhases.length > MAX_PHASES) throw new Error(`Execution plan has more than ${MAX_PHASES} phases`);
  const phaseIds = unique(rawPhases.map((phase, index) => id(phase?.id, `phases[${index}].id`)), 'phase IDs');
  const phaseSet = new Set(phaseIds);
  const phaseDependencies = new Map();
  const phases = rawPhases.map((phase, index) => {
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) throw new Error(`phases[${index}] must be an object`);
    const dependsOn = phase.dependsOn === undefined ? [] : unique(phase.dependsOn.map((dependency, dependencyIndex) => id(dependency, `phases[${index}].dependsOn[${dependencyIndex}]`)), `phases[${index}].dependsOn`);
    if (dependsOn.some(dependency => !phaseSet.has(dependency))) throw new Error(`phases[${index}] depends on an unknown phase`);
    phaseDependencies.set(phase.id, dependsOn);
    return { id: phase.id, title: text(phase.title, `phases[${index}].title`, 160), dependsOn, acceptance: normalizeAcceptance(phase.acceptance, `phases[${index}]`, { phase: true }), status: PLAN_STATUSES.has(phase.status) ? phase.status : 'pending', acceptanceStatus: ['pending', 'passed', 'failed'].includes(phase.acceptanceStatus) ? phase.acceptanceStatus : 'pending' };
  });
  assertAcyclic(phaseIds, phaseDependencies, 'Phase dependencies');
  const rawSteps = rawPhases.flatMap(phase => (Array.isArray(phase.steps) ? phase.steps.map(step => ({ ...step, phaseId: phase.id })) : []));
  if (rawPhases.some(phase => !Array.isArray(phase.steps) || phase.steps.length === 0)) throw new Error('Every phase must contain at least one step');
  if (!rawSteps.length) throw new Error('Execution plan must contain at least one step');
  if (rawSteps.length > MAX_STEPS) throw new Error(`Execution plan has more than ${MAX_STEPS} steps`);
  const steps = rawSteps.map((step, index) => normalizeStep(step, index, step.phaseId, availableTools));
  const stepIds = unique(steps.map(step => step.id), 'step IDs');
  const stepSet = new Set(stepIds); const stepDependencies = new Map();
  for (const step of steps) {
    if (step.dependsOn.some(dependency => !stepSet.has(dependency))) throw new Error(`Step ${step.id} depends on an unknown step`);
    if (step.dependsOn.includes(step.id)) throw new Error(`Step ${step.id} cannot depend on itself`);
    stepDependencies.set(step.id, step.dependsOn);
  }
  assertAcyclic(stepIds, stepDependencies, 'Step dependencies');
  const revision = Number.isSafeInteger(input.revision) && input.revision > 0 ? input.revision : 1;
  const replanCount = Number.isSafeInteger(input.replanCount) && input.replanCount >= 0 ? Math.min(2, input.replanCount) : 0;
  return {
    version: PLAN_VERSION, id: typeof input.id === 'string' ? id(input.id, 'plan.id') : randomUUID(), revision,
    goal, status: PLAN_STATUSES.has(input.status) ? input.status : 'draft', phases, steps, replanCount,
    ...(typeof input.replannedFrom === 'string' ? { replannedFrom: id(input.replannedFrom, 'plan.replannedFrom') } : {}),
    checkpoints: Array.isArray(input.checkpoints) ? input.checkpoints.slice(-32) : [],
    createdAt: input.createdAt ?? now(), updatedAt: now(),
  };
}

export function readyStructuredSteps(plan) {
  const complete = new Set(plan.steps.filter(step => step.status === 'completed' || step.status === 'skipped').map(step => step.id));
  const phases = new Map(plan.phases.map(phase => [phase.id, phase]));
  return plan.steps.filter(step => step.status === 'pending' && step.dependsOn.every(dependency => complete.has(dependency)) && (phases.get(step.phaseId)?.dependsOn ?? []).every(dependency => phases.get(dependency)?.status === 'completed'))
    .map(step => ({ ...step, status: 'ready' }));
}

export function createStructuredCheckpoint(plan, { workspaceFingerprint = null, reason = 'step' } = {}) {
  return { id: randomUUID(), planId: plan.id, revision: plan.revision, reason, completedSteps: plan.steps.filter(step => step.status === 'completed' || step.status === 'skipped').map(step => step.id), failedSteps: plan.steps.filter(step => step.status === 'failed' || step.status === 'uncertain').map(step => step.id), runningSteps: plan.steps.filter(step => step.status === 'running' || step.status === 'waiting_approval').map(step => step.id), workspaceFingerprint, createdAt: new Date().toISOString() };
}

export function checkpointFingerprint(value) { return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex'); }

export function createStructuredPlanRuntime(plan, { onUpdate = () => {}, verifyStep = async () => ({ ok: true }), verifyPhase = async () => ({ ok: true }), now = () => Date.now() } = {}) {
  const completed = () => new Set(plan.steps.filter(step => step.status === 'completed' || step.status === 'skipped').map(step => step.id));
  const update = async reason => {
    refresh();
    plan.updatedAt = now();
    plan.checkpoints = [...(plan.checkpoints ?? []), createStructuredCheckpoint(plan, { reason })].slice(-32);
    await onUpdate(plan);
  };
  function refresh() {
    const done = completed();
    const phaseById = new Map(plan.phases.map(phase => [phase.id, phase]));
    for (const step of plan.steps) {
      const phaseReady = (phaseById.get(step.phaseId)?.dependsOn ?? []).every(dependency => phaseById.get(dependency)?.status === 'completed');
      if (step.status === 'pending' && phaseReady && step.dependsOn.every(dependency => done.has(dependency))) step.status = 'ready';
      if (step.status === 'blocked' && phaseReady && step.dependsOn.every(dependency => done.has(dependency))) step.status = 'ready';
    }
    for (const phase of plan.phases) {
      const phaseSteps = plan.steps.filter(step => step.phaseId === phase.id);
      if (phaseSteps.length && phaseSteps.every(step => step.status === 'completed' || step.status === 'skipped')) {
        if (phase.acceptance.type === 'all_steps' && phase.acceptanceStatus === 'pending') phase.acceptanceStatus = 'passed';
        phase.status = phase.acceptanceStatus === 'passed' ? 'completed' : phase.acceptanceStatus === 'failed' ? 'failed' : 'waiting_acceptance';
      }
      else if (phaseSteps.some(step => step.status === 'failed' || step.status === 'uncertain')) phase.status = 'failed';
      else if (phaseSteps.some(step => step.status === 'running' || step.status === 'waiting_approval')) phase.status = 'running';
    }
    if (plan.phases.length && plan.phases.every(phase => phase.acceptanceStatus === 'passed')) plan.status = 'completed';
  }
  async function beforeTool(tool, requestedStepId = null) {
    refresh();
    const candidates = plan.steps.filter(step => step.tools.includes(tool) && (!requestedStepId || step.id === requestedStepId));
    const ready = candidates.find(step => step.status === 'ready' || step.status === 'failed' && (step.attempts ?? 0) < step.retryPolicy.maxAttempts || step.status === 'waiting_approval');
    if (ready) { ready.status = 'running'; plan.status = 'running'; await update('step-started'); return { ok: true, step: ready }; }
    const blocked = candidates.find(step => ['pending', 'blocked'].includes(step.status));
    if (blocked) return { ok: false, errorCode: 'STEP_DEPENDENCY_BLOCKED', message: `步骤“${blocked.title}”的前置步骤尚未完成` };
    const completedStep = candidates.find(step => ['completed', 'skipped'].includes(step.status));
    if (completedStep) return { ok: false, errorCode: 'STEP_ALREADY_COMPLETED', message: `步骤“${completedStep.title}”已经完成，不需要重复执行` };
    return { ok: false, errorCode: 'STEP_NOT_IN_PLAN', message: `工具“${tool}”不在当前结构化计划中` };
  }
  async function afterTool(step, { ok, errorCode = null, errorMessage = null, tool, args, result } = {}) {
    if (!step) return { ok: Boolean(ok) };
    step.attempts = (step.attempts ?? 0) + 1;
    if (ok) {
      const accepted = await verifyStep(step, { tool, args, result });
      if (!accepted?.ok) {
        step.status = 'failed'; step.lastErrorCode = 'PLAN_ACCEPTANCE_FAILED'; step.lastErrorMessage = String(accepted?.message || '步骤验收未通过').slice(0, 500);
        plan.status = 'failed'; await update('step-acceptance-failed');
        return { ok: false, errorCode: 'PLAN_ACCEPTANCE_FAILED', message: step.lastErrorMessage };
      }
      step.status = 'completed'; step.lastErrorCode = undefined; step.lastErrorMessage = undefined; step.acceptanceStatus = 'passed';
    }
    else if (errorCode === 'APPROVAL_REQUIRED') step.status = 'waiting_approval';
    else { step.status = 'failed'; step.lastErrorCode = errorCode ?? 'TOOL_EXECUTION_ERROR'; step.lastErrorMessage = String(errorMessage || '工具执行失败').slice(0, 500); }
    if (!ok && errorCode !== 'APPROVAL_REQUIRED') {
      const failed = new Set([step.id]);
      for (const candidate of plan.steps) if (candidate.dependsOn.some(dependency => failed.has(dependency)) && candidate.status === 'pending') { candidate.status = 'blocked'; failed.add(candidate.id); }
      plan.status = 'failed';
    }
    await update(ok ? 'step-completed' : 'step-failed');
    return { ok: Boolean(ok), ...(ok ? {} : { errorCode: errorCode ?? 'TOOL_EXECUTION_ERROR', message: step.lastErrorMessage }) };
  }
  async function acceptReadyPhases() {
    refresh();
    for (const phase of plan.phases) {
      if (phase.status !== 'waiting_acceptance' || phase.acceptanceStatus !== 'pending') continue;
      const checked = await verifyPhase(phase, plan);
      phase.acceptanceStatus = checked?.ok ? 'passed' : 'failed';
      if (!checked?.ok) {
        phase.lastErrorCode = 'PHASE_ACCEPTANCE_FAILED';
        phase.lastErrorMessage = String(checked?.message || '阶段验收未通过').slice(0, 500);
        phase.status = 'failed'; plan.status = 'failed';
      } else {
        delete phase.lastErrorCode; delete phase.lastErrorMessage; phase.status = 'completed';
      }
      await update(checked?.ok ? 'phase-accepted' : 'phase-acceptance-failed');
      if (!checked?.ok) return { ok: false, phase, errorCode: 'PHASE_ACCEPTANCE_FAILED', message: phase.lastErrorMessage };
      refresh();
    }
    return { ok: true };
  }
  refresh();
  return { beforeTool, afterTool, acceptReadyPhases, refresh: async () => { refresh(); await update('refresh'); }, readySteps: () => readyStructuredSteps(plan) };
}

export function recoverStructuredPlan(plan, { revision = plan?.revision, now = () => Date.now() } = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('Structured plan is unavailable');
  if (revision !== plan.revision) throw Object.assign(new Error('Structured plan revision changed; recovery requires a fresh plan'), { code: 'PLAN_REVISION_CHANGED' });
  for (const step of plan.steps ?? []) {
    if (step.status === 'running' || step.status === 'interrupted') step.status = step.status === 'running' && step.sideEffect ? 'uncertain' : 'ready';
    else if (step.status === 'waiting_approval') step.status = 'waiting_approval';
  }
  plan.status = 'ready'; plan.updatedAt = now();
  plan.checkpoints = [...(plan.checkpoints ?? []), createStructuredCheckpoint(plan, { reason: 'recovered' })].slice(-32);
  return plan;
}
