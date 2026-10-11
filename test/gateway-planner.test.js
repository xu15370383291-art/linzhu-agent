import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGatewayTurnRunner } from '../backend/gateway/turn-runner.js';
import { classifyPlanningNeed, explicitPlanningChoice, generateStructuredPlan, planningSignals, preserveCompletedPlanSteps } from '../backend/gateway/planner.js';
import { readFile } from 'node:fs/promises';
import { PermissionPolicy } from '../backend/permissions/policy.js';

const model = response => ({ async get() { return { model: 'mock', apiKey: 'test', streaming: false, url: 'http://localhost/v1' }; } });
const plan = JSON.stringify({ goal: '创建一个小型项目', phases: [{ id: 'build', title: '实现项目', acceptance: { type: 'all_steps', description: '计划步骤全部通过' }, steps: [{ id: 'write', title: '创建入口文件', kind: 'write', tools: ['write_file'], sideEffect: true, acceptance: { type: 'file_exists', path: 'index.js', description: '入口文件存在' } }] }] });

test('planner only runs for substantial project requests and emits a validated plan', async () => {
  assert.deepEqual(planningSignals('你好').complexity, []);
  assert.ok(planningSignals('请创建一个完整的小型记账项目').complexity.includes('multi_scope'));
  let calls = 0; let plannerTools; let executionTools;
  const request = async (_messages, tools, options) => {
    calls++;
    if (calls === 1) { plannerTools = tools; assert.equal(options.toolChoice, 'none'); return { choices: [{ message: { role: 'assistant', content: plan } }] }; }
    executionTools = tools;
    return { choices: [{ message: { role: 'assistant', content: '已完成' } }] };
  };
  const generated = await generateStructuredPlan({ input: '请创建一个完整的小型记账项目', request, tools: [{ function: { name: 'write_file' } }] });
  assert.equal(generated.status, 'ready'); assert.equal(generated.steps[0].tools[0], 'write_file'); assert.deepEqual(plannerTools, []);
  assert.equal(executionTools, undefined);
});

test('planning choice honors explicit instructions before semantic classification', async () => {
  let calls = 0;
  const request = async () => { calls++; throw new Error('must not call classifier'); };
  assert.deepEqual(await classifyPlanningNeed({ input: '先给我制定一个实施计划', request }), { decision: 'plan', reason: 'explicit-user-instruction' });
  assert.equal(explicitPlanningChoice('可以，你按照规划进行操作') , 'plan');
  assert.equal(explicitPlanningChoice('规划创建 skill 难道不行吗'), null);
  assert.deepEqual(await classifyPlanningNeed({ input: '直接回答，不要制定计划，什么是 Skill？', request }), { decision: 'direct', reason: 'explicit-user-instruction' });
  assert.equal(explicitPlanningChoice('创建一个技能'), null);
  assert.equal(calls, 0);
});

test('semantic classifier distinguishes single-item creation from multi-stage project work', async () => {
  const answers = ['DIRECT', 'DIRECT', 'PLAN'];
  const request = async messages => {
    assert.match(messages[0].content, /语义和实际步骤范围优先/);
    assert.ok(JSON.parse(messages[1].content).keywordSignals);
    return { choices: [{ message: { content: answers.shift() } }] };
  };
  const skill = await classifyPlanningNeed({ input: '帮我创建一个面试 Skill，整理用户给出的面试题并生成自然口述回答模板', request });
  const longSingle = await classifyPlanningNeed({ input: `请帮我整理这段内容并生成一份口述面试回答模板。${'只针对这一段材料输出，不创建文件，不涉及其他模块。'.repeat(8)}`, request });
  const project = await classifyPlanningNeed({ input: '实现一个完整的前后端系统，集成数据库，最后部署并运行测试验证', request });
  assert.equal(skill.decision, 'direct');
  assert.equal(longSingle.decision, 'direct');
  assert.equal(project.decision, 'plan');
});

test('invalid semantic classifier output safely routes to direct execution', async () => {
  const result = await classifyPlanningNeed({ input: '创建一份报告', request: async () => ({ choices: [{ message: { content: '也许需要计划' } }] }) });
  assert.equal(result.decision, 'direct');
  assert.equal(result.reason, 'invalid-classifier-output');
});

test('Gateway runner fails closed when execution planning fails', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-planner-fallback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0; let planUpdates = [];
  const runner = createGatewayTurnRunner({
    root, models: model(), structuredPlanning: true,
    audit: { auditReady: true, async record() {} }, sandbox: { async verify() { return false; } },
    request: undefined,
  });
  // A semantic PLAN decision followed by invalid plan JSON must stop before execution.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    const content = body.messages[0].content.includes('任务路由分类器') ? 'PLAN' : 'not-json';
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await assert.rejects(runner({ input: '创建一个完整的小型项目', turnId: 'planner-fail-closed', onPlan: value => planUpdates.push(value) }), { code: 'PLAN_GENERATION_FAILED' });
    assert.equal(calls, 2); assert.equal(planUpdates[0].status, 'failed');
    assert.match(planUpdates[0].errorMessage, /计划生成或校验失败/);
  } finally { globalThis.fetch = originalFetch; }
});

test('single Skill creation does not invoke structured planner after semantic DIRECT', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-planner-direct-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0; const planUpdates = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    const isClassifier = body.messages[0].content.includes('任务路由分类器');
    const content = isClassifier ? 'DIRECT' : '我会先整理技能说明。';
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const runner = createGatewayTurnRunner({ root, models: model(), structuredPlanning: true,
      audit: { auditReady: true, async record() {} }, sandbox: { async verify() { return false; } } });
    const result = await runner({ input: '帮我创建一个面试 Skill，名称为 mianshi', turnId: 'planner-direct-skill', onPlan: value => planUpdates.push(value) });
    assert.equal(result.answer, '我会先整理技能说明。');
    assert.equal(calls, 2);
    assert.equal(planUpdates.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('semantic classifier request failure fails open to normal Agent execution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-planner-classifier-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (body.messages[0].content.includes('任务路由分类器'))
      return new Response(JSON.stringify({ error: { message: 'classifier unavailable' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已直接处理。' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const runner = createGatewayTurnRunner({ root, models: model(), structuredPlanning: true,
      audit: { auditReady: true, async record() {} }, sandbox: { async verify() { return false; } } });
    const result = await runner({ input: '请创建一个面试回答模板', turnId: 'planner-classifier-error' });
    assert.equal(result.answer, '已直接处理。');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('replanning preserves completed work and rejects changed or omitted side effects', () => {
  const previous = { id: 'old', revision: 1, replanCount: 0, createdAt: 1, checkpoints: [{ id: 'cp' }], steps: [
    { id: 'write', phaseId: 'build', status: 'completed', sideEffect: true, tools: ['write_file'], attempts: 1 },
    { id: 'verify', phaseId: 'build', status: 'failed', sideEffect: false, tools: ['read_file'], attempts: 1 },
  ] };
  const next = { id: 'new', revision: 1, createdAt: 2, checkpoints: [], steps: [
    { id: 'write', phaseId: 'build', status: 'pending', sideEffect: true, tools: ['write_file'], attempts: 0 },
    { id: 'verify', phaseId: 'build', status: 'pending', sideEffect: false, tools: ['read_file'], attempts: 0 },
  ] };
  const merged = preserveCompletedPlanSteps(previous, next);
  assert.equal(merged.steps[0].status, 'completed'); assert.equal(merged.steps[0].attempts, 1);
  assert.equal(merged.revision, 2); assert.equal(merged.replannedFrom, 'old'); assert.equal(merged.replanCount, 1);
  assert.deepEqual(merged.checkpoints, [{ id: 'cp' }]); assert.equal(merged.createdAt, 1);
  assert.throws(() => preserveCompletedPlanSteps(previous, { ...structuredClone(next), steps: next.steps.slice(1) }), { code: 'PLAN_REPLAN_UNSAFE' });
  const changed = structuredClone(next); changed.steps[0].tools = ['external_write_file'];
  assert.throws(() => preserveCompletedPlanSteps(previous, changed), { code: 'PLAN_REPLAN_UNSAFE' });
});

test('Gateway replans a failed phase, preserves completed writes and executes only a new repair step', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gateway-plan-replan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let planCount = 0; let executionCount = 0; let firstWrites = 0; let repairWrites = 0;
  const firstPlan = { goal: '创建并验证文件', phases: [{ id: 'build', title: '写入并验收', acceptance: { type: 'file_contains', path: 'result.txt', text: 'READY' }, steps: [
    { id: 'write', title: '创建文件', tools: ['write_file'], sideEffect: true, acceptance: { type: 'tool_success' } },
  ] }] };
  const repairedPlan = { goal: '创建并验证文件', phases: [{ id: 'build', title: '修复并验收', acceptance: { type: 'file_contains', path: 'result.txt', text: 'READY' }, steps: [
    { id: 'write', title: '创建文件', tools: ['write_file'], sideEffect: true, acceptance: { type: 'tool_success' } },
    { id: 'repair', title: '修复文件内容', dependsOn: ['write'], tools: ['write_file'], sideEffect: true, acceptance: { type: 'tool_success' } },
  ] }] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    let message;
    if (body.messages[0].content.includes('任务路由分类器')) {
      message = { role: 'assistant', content: 'PLAN' };
    } else if (body.tool_choice === 'none' || !body.tools?.length) {
      planCount++;
      if (planCount === 2) assert.ok(JSON.parse(body.messages.at(-1).content).replanContext);
      message = { role: 'assistant', content: JSON.stringify(planCount === 1 ? firstPlan : repairedPlan) };
    } else {
      executionCount++;
      if (executionCount === 1) message = { role: 'assistant', content: null, tool_calls: [{ id: 'write-first', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'PENDING' }) } }] };
      else if (executionCount === 2) message = { role: 'assistant', content: null, tool_calls: [{ id: 'write-repair', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'READY' }) } }] };
      else message = { role: 'assistant', content: '文件已修复并通过验收。' };
    }
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const runner = createGatewayTurnRunner({ root, models: model(), structuredPlanning: true, getSecurityMode: async () => 'personal',
      audit: { auditReady: true, async record() {} }, sandbox: { async verify() { return false; } } });
    const updates = [];
    const result = await runner({ input: '请创建并验证一个小项目文件', turnId: 'replan-integration', policy: new PermissionPolicy(), onPlan: value => { if (Array.isArray(value.steps)) updates.push(structuredClone(value)); } });
    assert.equal(result.answer, '文件已修复并通过验收。');
    assert.equal(planCount, 2); assert.equal(executionCount, 3);
    assert.equal(await readFile(path.join(root, 'result.txt'), 'utf8'), 'READY');
    assert.equal(updates.at(-1).revision, 2); assert.equal(updates.at(-1).replanCount, 1);
    assert.equal(updates.at(-1).steps.find(step => step.id === 'write').status, 'completed');
    assert.equal(updates.at(-1).steps.find(step => step.id === 'repair').status, 'completed');
  } finally { globalThis.fetch = originalFetch; }
});
