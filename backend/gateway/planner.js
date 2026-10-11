import { normalizeStructuredPlan } from './structured-plan.js';

const PLANNER_SYSTEM = `你是一个本地项目 Agent 的任务规划器。只负责把用户需求转换成结构化 JSON 计划，不执行任何工具，不声称已经修改文件。计划必须可验证、分阶段、步骤之间有明确依赖。只引用提供的工具名称。每个阶段和步骤都必须包含可执行验收条件。输出只能是 JSON，不要 Markdown，不要解释文字。
JSON 结构：{"goal":"...","phases":[{"id":"...","title":"...","dependsOn":[],"acceptance":{"type":"all_steps","description":"..."},"steps":[{"id":"...","title":"...","kind":"read|write|test|verify|operation","dependsOn":[],"tools":[],"sideEffect":false,"acceptance":{"type":"tool_success|result_contains|file_exists|file_contains|command_exit_code","tool":"工具名","path":"相对工作区路径","text":"期望文本","exitCode":0,"description":"..."},"retryPolicy":{"maxAttempts":2,"mode":"safe|repair-arguments"}}]}]}
验收类型字段要求：tool_success 可选 tool；result_contains 必须提供 text；file_exists 必须提供 path；file_contains 必须提供 path 和 text；command_exit_code 可选 exitCode（默认 0）。阶段验收使用 all_steps，表示该阶段所有步骤分别验收成功。路径必须相对于当前工作区。计划应该足够具体但不要拆成无意义的小步骤。文件写入、命令和其他副作用步骤必须标记 sideEffect=true。不要编造工具名称。`;

const EXPLICIT_PLAN = /^(?:(?:请|麻烦|我想)?(?:你)?(?:先)?(?:帮我|给我)?\s*)(?:制定|生成|列出|给出|规划|做)\s*(?:(?:一个|整体|详细|执行|实施|项目|一下|下)\s*){0,2}(?:计划|规划|方案|一下|下)|(?:按照|按)(?:上述|这个|该)?(?:规划|计划)|\bplan\s+(?:this|the task|the project)\b/i;
const EXPLICIT_DIRECT = /^(?:(?:请|麻烦|我想)?(?:你)?(?:直接|就直接)|直接)(?:回答|处理|做|执行)|^(?:(?:请|麻烦)?(?:你)?(?:先)?)(?:不要|不需要|无需|不用)(?:再|去)?(?:制定|生成|做)?(?:任何)?(?:计划|规划)|\bno\s+plan\b/i;
const COMPLEXITY_SIGNALS = [
  ['multi_scope', /(?:完整.{0,12}(?:项目|应用|系统)|跨(?:多个)?(?:模块|服务|目录)|多个文件|前后端|端到端|end[- ]to[- ]end|full[- ]stack|multiple files)/i],
  ['integration', /(?:集成|打通|对接).{0,20}(?:系统|服务|模块|接口|数据库|api)|(?:integration|integrate|wire up)/i],
  ['delivery_chain', /(?:部署|上线|迁移|发布|构建并测试|实现并验证|开发并测试|实现.{0,20}测试|验收)/i],
  ['multi_part', /(?:并且|同时|然后|最后|以及).{0,30}(?:并且|同时|然后|最后|以及)|\b(?:and then|as well as)\b/i],
];
const ACTION_SIGNAL = /(?:创建|新建|开发|实现|搭建|构建|制作|设计|重构|修改|修复|测试|整理|部署|迁移|build|create|develop|implement|refactor|fix|test|deploy|migrate|make|write)/i;

export function planningSignals(input) {
  const text = String(input ?? '').trim();
  return {
    hasAction: ACTION_SIGNAL.test(text),
    longRequest: text.length >= 160,
    complexity: COMPLEXITY_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name),
  };
}

export function explicitPlanningChoice(input) {
  const text = String(input ?? '').trim();
  if (EXPLICIT_DIRECT.test(text)) return 'direct';
  if (EXPLICIT_PLAN.test(text)) return 'plan';
  return null;
}

export async function classifyPlanningNeed({ input, request, signal }) {
  const explicit = explicitPlanningChoice(input);
  if (explicit) return { decision: explicit, reason: 'explicit-user-instruction' };

  const signals = planningSignals(input);
  if (!signals.hasAction && !signals.longRequest && !signals.complexity.length)
    return { decision: 'direct', reason: 'no-task-complexity-signals', signals };
  if (typeof request !== 'function') return { decision: 'direct', reason: 'classifier-unavailable', signals };

  const response = await request([
    { role: 'system', content: '你是任务路由分类器，不执行任务，不制定计划。判断用户请求是否需要在执行前生成多阶段、带依赖和验收条件的结构化计划。完整项目、跨多个模块/文件的实现、集成、部署迁移并验证等通常需要计划；单个内容或文件、回答问题、解释、总结、单个 Skill 创建等通常直接处理。只根据用户真正要求的交付范围判断，不要因“创建/实现/修改”等单个动词或请求很长就判为计划。关键词信号只是辅助，语义和实际步骤范围优先。明确要求制定计划则 PLAN，明确要求直接处理或不要计划则 DIRECT。信息不足、任务简单或不确定时输出 DIRECT。仅输出一个标签：PLAN 或 DIRECT。' },
    { role: 'user', content: JSON.stringify({ request: String(input ?? ''), keywordSignals: signals }) },
  ], [], { toolChoice: 'none', maxTokens: 64, stream: false, signal });
  const content = response?.choices?.[0]?.message?.content;
  const label = String(content ?? '').trim().replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/, '').trim().toUpperCase();
  if (label === 'PLAN') return { decision: 'plan', reason: 'semantic-classifier', signals };
  if (label === 'DIRECT') return { decision: 'direct', reason: 'semantic-classifier', signals };
  return { decision: 'direct', reason: 'invalid-classifier-output', signals };
}

function extractJson(content) {
  const text = String(content ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{'); const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('规划器没有返回有效 JSON');
  return JSON.parse(text.slice(start, end + 1));
}

export async function generateStructuredPlan({ input, request, tools, signal, now = () => Date.now(), replanContext = null }) {
  if (typeof request !== 'function') throw new Error('Planner request is unavailable');
  const toolNames = (tools ?? []).map(tool => tool?.function?.name).filter(Boolean);
  const response = await request([
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: JSON.stringify({ request: String(input ?? ''), availableTools: toolNames, ...(replanContext ? { replanContext } : {}) }) },
  ], [], { toolChoice: 'none', maxTokens: 3000, stream: false, signal });
  const content = response?.choices?.[0]?.message?.content;
  const plan = normalizeStructuredPlan(extractJson(content), { availableTools: new Set(toolNames), now });
  plan.status = 'ready';
  return plan;
}

export function preserveCompletedPlanSteps(previous, next) {
  const nextSteps = new Map(next.steps.map(step => [step.id, step]));
  const completed = (previous?.steps ?? []).filter(step => step.status === 'completed' || step.status === 'skipped');
  const missingCompleted = completed.filter(step => !nextSteps.has(step.id));
  if (missingCompleted.length) throw Object.assign(new Error(`新计划未保留已完成步骤：${missingCompleted.map(step => step.id).join(', ')}`), { code: 'PLAN_REPLAN_UNSAFE' });
  for (const oldStep of completed) {
    const replacement = nextSteps.get(oldStep.id);
    if (!replacement) continue;
    if (replacement.phaseId !== oldStep.phaseId || JSON.stringify(replacement.tools) !== JSON.stringify(oldStep.tools) ||
        replacement.sideEffect !== oldStep.sideEffect || JSON.stringify(replacement.acceptance) !== JSON.stringify(oldStep.acceptance))
      throw Object.assign(new Error(`新计划改变了已完成步骤 ${oldStep.id} 的作用范围`), { code: 'PLAN_REPLAN_UNSAFE' });
    replacement.status = oldStep.status;
    replacement.attempts = oldStep.attempts;
    replacement.acceptanceStatus = 'passed';
  }
  next.revision = (previous.revision ?? 1) + 1;
  next.replannedFrom = previous.id;
  next.replanCount = (previous.replanCount ?? 0) + 1;
  next.checkpoints = [...(previous.checkpoints ?? []), ...(next.checkpoints ?? [])].slice(-32);
  next.createdAt = previous.createdAt ?? next.createdAt;
  return next;
}
