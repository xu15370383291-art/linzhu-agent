import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredCheckpoint, createStructuredPlanRuntime, normalizeStructuredPlan, readyStructuredSteps, recoverStructuredPlan } from '../backend/gateway/structured-plan.js';

const planInput = () => ({ goal: '创建一个小型项目', phases: [
  { id: 'inspect', title: '检查项目', acceptance: { type: 'all_steps' }, steps: [{ id: 'read', title: '读取结构', kind: 'read', tools: ['list_files'], acceptance: { type: 'tool_success', tool: 'list_files' } }] },
  { id: 'build', title: '实现功能', dependsOn: ['inspect'], acceptance: { type: 'all_steps' }, steps: [{ id: 'write', title: '写入入口', kind: 'write', dependsOn: ['read'], tools: ['write_file'], sideEffect: true, acceptance: { type: 'file_exists', path: 'entry.txt' } }] },
] });

test('structured plans normalize phases, dependencies and retry metadata', () => {
  const plan = normalizeStructuredPlan(planInput(), { availableTools: new Set(['list_files', 'write_file']) });
  assert.equal(plan.version, 1); assert.equal(plan.status, 'draft'); assert.equal(plan.steps[1].retryPolicy.maxAttempts, 2);
  assert.deepEqual(readyStructuredSteps(plan).map(step => step.id), ['read']);
  plan.steps[0].status = 'completed'; plan.phases[0].status = 'completed';
  assert.deepEqual(readyStructuredSteps(plan).map(step => step.id), ['write']);
  const checkpoint = createStructuredCheckpoint(plan, { workspaceFingerprint: 'abc', reason: 'phase' });
  assert.deepEqual(checkpoint.completedSteps, ['read']); assert.equal(checkpoint.workspaceFingerprint, 'abc');
});

test('structured plans reject unknown references and dependency cycles', () => {
  assert.throws(() => normalizeStructuredPlan({ ...planInput(), phases: [{ ...planInput().phases[0], dependsOn: ['missing'] }] }), /unknown phase/);
  const cyclic = { goal: '循环', phases: [{ id: 'a', title: 'A', dependsOn: ['b'], acceptance: { type: 'all_steps' }, steps: [{ id: 'a1', title: 'A1', tools: ['read_file'], acceptance: { type: 'tool_success' }, dependsOn: ['b1'] }] }, { id: 'b', title: 'B', dependsOn: ['a'], acceptance: { type: 'all_steps' }, steps: [{ id: 'b1', title: 'B1', tools: ['read_file'], acceptance: { type: 'tool_success' }, dependsOn: ['a1'] }] }] };
  assert.throws(() => normalizeStructuredPlan(cyclic), /dependency cycle/);
});

test('structured plans reject tools outside the current visible surface', () => {
  assert.throws(() => normalizeStructuredPlan(planInput(), { availableTools: new Set(['list_files']) }), /not available/);
});

test('structured acceptance criteria require executable supported fields', () => {
  const valid = planInput();
  valid.phases[0].acceptance = { type: 'file_exists', path: 'README.md' };
  valid.phases[0].steps[0].acceptance = { type: 'result_contains', text: 'src' };
  const normalized = normalizeStructuredPlan(valid);
  assert.deepEqual(normalized.phases[0].acceptance, { type: 'file_exists', path: 'README.md' });
  assert.deepEqual(normalized.steps[0].acceptance, { type: 'result_contains', text: 'src' });

  for (const acceptance of [
    { type: 'mystery' },
    { type: 'file_exists' },
    { type: 'file_contains', path: 'README.md' },
    { type: 'result_contains' },
    { type: 'command_exit_code', exitCode: 999 },
  ]) {
    const invalid = planInput(); invalid.phases[0].acceptance = acceptance;
    assert.throws(() => normalizeStructuredPlan(invalid));
  }
});

test('plan tool contracts force side-effect marking even if the planner says false', () => {
  const input = planInput();
  input.phases[1].steps[0].sideEffect = false;
  const plan = normalizeStructuredPlan(input);
  assert.equal(plan.steps.find(step => step.id === 'write').sideEffect, true);
});

test('structured runtime gates tools by dependencies and records checkpoints', async () => {
  const plan = normalizeStructuredPlan(planInput(), { availableTools: new Set(['list_files', 'write_file']) });
  const updates = []; const runtime = createStructuredPlanRuntime(plan, { onUpdate: value => updates.push(structuredClone(value)) });
  const blocked = await runtime.beforeTool('write_file');
  assert.equal(blocked.ok, false); assert.equal(blocked.errorCode, 'STEP_DEPENDENCY_BLOCKED');
  const first = await runtime.beforeTool('list_files'); assert.equal(first.ok, true); await runtime.afterTool(first.step, { ok: true, tool: 'list_files' }); await runtime.acceptReadyPhases();
  const second = await runtime.beforeTool('write_file'); assert.equal(second.ok, true); await runtime.afterTool(second.step, { ok: true, tool: 'write_file', result: { content: 'Wrote entry.txt' } }); await runtime.acceptReadyPhases();
  assert.equal(plan.status, 'completed'); assert.ok(plan.checkpoints.length >= 4); assert.ok(updates.some(value => value.steps.find(step => step.id === 'write')?.status === 'completed'));
});

test('structured runtime also gates steps on phase dependencies', async () => {
  const input = { goal: '分阶段任务', phases: [
    { id: 'first', title: '第一阶段', acceptance: { type: 'all_steps' }, steps: [{ id: 'first-step', title: '检查', tools: ['list_files'], acceptance: { type: 'tool_success' } }] },
    { id: 'second', title: '第二阶段', dependsOn: ['first'], acceptance: { type: 'all_steps' }, steps: [{ id: 'second-step', title: '测试', tools: ['sandbox_command'], acceptance: { type: 'command_exit_code' } }] },
  ] };
  const plan = normalizeStructuredPlan(input, { availableTools: new Set(['list_files', 'sandbox_command']) });
  const runtime = createStructuredPlanRuntime(plan);
  assert.equal(plan.steps[1].status, 'pending');
  assert.equal((await runtime.beforeTool('sandbox_command')).errorCode, 'STEP_DEPENDENCY_BLOCKED');
  const first = await runtime.beforeTool('list_files'); await runtime.afterTool(first.step, { ok: true, tool: 'list_files' }); await runtime.acceptReadyPhases();
  assert.equal(plan.phases[0].status, 'completed'); assert.equal((await runtime.beforeTool('sandbox_command')).ok, true);
});

test('step and phase acceptance failures block dependent work', async () => {
  const input = { goal: '需核对产物', phases: [
    { id: 'build', title: '生成文件', acceptance: { type: 'file_contains', path: 'result.txt', text: 'EXPECTED' }, steps: [
      { id: 'write', title: '写文件', tools: ['write_file'], acceptance: { type: 'result_contains', text: 'committed' } },
    ] },
    { id: 'verify', title: '校验结果', dependsOn: ['build'], acceptance: { type: 'all_steps' }, steps: [
      { id: 'check', title: '检查', tools: ['read_file'], acceptance: { type: 'tool_success' } },
    ] },
  ] };
  const plan = normalizeStructuredPlan(input);
  const runtime = createStructuredPlanRuntime(plan, { verifyStep: async () => ({ ok: false, message: '结果缺少 committed' }), verifyPhase: async () => ({ ok: false, message: '文件内容不匹配' }) });
  const write = await runtime.beforeTool('write_file');
  const stepResult = await runtime.afterTool(write.step, { ok: true, tool: 'write_file', result: { content: 'Wrote result.txt' } });
  assert.equal(stepResult.errorCode, 'PLAN_ACCEPTANCE_FAILED');
  assert.equal((await runtime.beforeTool('read_file')).errorCode, 'STEP_DEPENDENCY_BLOCKED');

  const secondPlan = normalizeStructuredPlan(input);
  const phaseRuntime = createStructuredPlanRuntime(secondPlan, { verifyPhase: async () => ({ ok: false, message: '文件内容不匹配' }) });
  const successful = await phaseRuntime.beforeTool('write_file');
  await phaseRuntime.afterTool(successful.step, { ok: true, tool: 'write_file', result: { content: 'committed' } });
  const phaseResult = await phaseRuntime.acceptReadyPhases();
  assert.equal(phaseResult.errorCode, 'PHASE_ACCEPTANCE_FAILED');
  assert.equal((await phaseRuntime.beforeTool('read_file')).errorCode, 'STEP_DEPENDENCY_BLOCKED');
});

test('structured recovery keeps completed steps and reopens interrupted steps', () => {
  const plan = normalizeStructuredPlan(planInput());
  plan.steps[0].status = 'completed'; plan.steps[1].status = 'interrupted'; plan.status = 'interrupted';
  const recovered = recoverStructuredPlan(plan);
  assert.equal(recovered.steps[0].status, 'completed'); assert.equal(recovered.steps[1].status, 'ready'); assert.equal(recovered.status, 'ready');
  assert.throws(() => recoverStructuredPlan(recovered, { revision: 2 }), { code: 'PLAN_REVISION_CHANGED' });
});

test('recovery never automatically replays an uncertain side-effect step', () => {
  const plan = normalizeStructuredPlan(planInput());
  plan.steps[0].status = 'completed';
  plan.steps[1].status = 'running'; plan.steps[1].sideEffect = true;
  const recovered = recoverStructuredPlan(plan);
  assert.equal(recovered.steps[0].status, 'completed');
  assert.equal(recovered.steps[1].status, 'uncertain');
  assert.equal(readyStructuredSteps(recovered).some(step => step.id === 'write'), false);
});
