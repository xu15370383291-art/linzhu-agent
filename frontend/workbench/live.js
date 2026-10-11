const $ = id => document.getElementById(id);
const slashMenu = document.createElement('div');
slashMenu.id = 'slash-menu'; slashMenu.className = 'slash-menu'; slashMenu.setAttribute('role', 'listbox'); slashMenu.setAttribute('aria-label', '命令与技能'); slashMenu.hidden = true;
document.querySelector('.composer').before(slashMenu);
document.querySelector('.composer-tools').prepend($('permission-template').content.cloneNode(true));
function closePermissions() { $('permission-menu').hidden = true; $('permission-toggle').setAttribute('aria-expanded', 'false'); }
function renderSecurityMode() {
  const personal = state.securityMode === 'personal';
  const current = $('permission-current');
  const personalOption = $('permission-personal');
  $('permission-mode-label').textContent = personal ? '个人文件模式' : '安全模式';
  current?.setAttribute('aria-pressed', String(!personal));
  personalOption?.setAttribute('aria-pressed', String(personal));
  current?.querySelector('.permission-check')?.toggleAttribute('hidden', personal);
  personalOption?.querySelector('.permission-check')?.toggleAttribute('hidden', !personal);
}
$('permission-toggle').onclick = () => { const open = $('permission-menu').hidden; $('permission-menu').hidden = !open; $('permission-toggle').setAttribute('aria-expanded', String(open)); };
async function setSecurityMode(mode, label) {
  closePermissions();
  try {
    await api('/api/security-mode', 'POST', { mode });
    await refreshLists();
    renderSecurityMode();
    notify(`已切换到${label}，当前回合不变，新回合立即生效`);
    return true;
  } catch (e) { error(e.message); return false; }
}
$('permission-current').onclick = () => void setSecurityMode('safe', '安全模式');
$('permission-personal').onclick = () => void setSecurityMode('personal', '个人文件模式');
$('permission-info').onclick = () => { $('permission-description').hidden = !$('permission-description').hidden; };
document.addEventListener('click', event => { if (!event.target.closest('.permission-control')) closePermissions(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('permission-menu').hidden) { closePermissions(); $('permission-toggle').focus(); } });
const state = { sessions: [], projects: [], currentProject: null, models: [], messages: [], current: null, currentArchived: false, turn: null, input: '', busy: false, diagnostics: null, securityMode: 'safe', archivedView: false, poll: null, streamText: '', streamAbort: null, lastEventId: '', reconnectTimer: null, clarificationIndex: 0, expandedPlanKeys: new Set(), skills: [], skillsError: '', selectedSkillId: null, slashIndex: -1, slashSubmenu: null, slashError: '' };
const skillChanges = 'personal-agent-skill-changes';
const skillChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(skillChanges) : null;
let attachment = null;
const terminal = new Set(['completed', 'failed', 'cancelled', 'denied', 'expired', 'interrupted']);
let pins = [];
try { const saved = JSON.parse(localStorage.getItem('lingzhu-live-pins') || '[]'); if (Array.isArray(saved)) pins = saved.filter(id => typeof id === 'string'); } catch {}
const collapsedGroups = new Set();
let reviewDismissed = null;
let tools = [];
let noticeTimer;
let modelCatalog = { selectedId: null, items: [] };
let editingModel = null;
let modelTesting = false;
let pendingSkillPrompt = null;
let savedPromptRange = null;
const PROMPT_SKILL_TOKEN = 'prompt-skill-token';

function isPromptSkillToken(node) { return node?.nodeType === Node.ELEMENT_NODE && node.classList.contains(PROMPT_SKILL_TOKEN); }
function makeSkillToken(skill) {
  const token = document.createElement('span');
  token.className = `${PROMPT_SKILL_TOKEN} skill-inline-token`;
  token.contentEditable = 'false';
  token.dataset.skillId = skill.id;
  token.dataset.skillName = skill.name || skill.id;
  token.setAttribute('role', 'img');
  token.setAttribute('aria-label', `技能：${skill.name || skill.id}`);
  token.title = skill.description || skill.name || skill.id;
  const icon = document.createElement('span'); icon.className = 'skill-token-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = skill.icon || '◇';
  const name = document.createElement('span'); name.className = 'skill-token-name'; name.textContent = skill.name || skill.id;
  token.append(icon, name);
  return token;
}
function serializePrompt() {
  const editor = $('prompt'); let text = ''; let skillReference = null; let pendingSkillSpacer = false;
  const walk = node => {
    if (isPromptSkillToken(node)) {
      if (!skillReference) skillReference = { skillId: node.dataset.skillId, displayName: node.dataset.skillName || node.dataset.skillId, offset: text.length };
      pendingSkillSpacer = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      let value = node.nodeValue || '';
      if (pendingSkillSpacer) { value = value.replace(/^ /, ''); pendingSkillSpacer = false; }
      text += value; return;
    }
    if (node.nodeName === 'BR') { text += '\n'; return; }
    const block = node !== editor && node.nodeType === Node.ELEMENT_NODE && ['DIV', 'P'].includes(node.tagName);
    if (block && text && !text.endsWith('\n')) text += '\n';
    for (const child of node.childNodes) walk(child);
    if (block && node.nextSibling && !text.endsWith('\n')) text += '\n';
  };
  walk(editor);
  text = text.replace(/\u00a0/g, ' ');
  if (skillReference) skillReference.offset = Math.min(skillReference.offset, text.length);
  return { text, skillReference };
}
function setPromptText(value) {
  const editor = $('prompt'); editor.replaceChildren(document.createTextNode(String(value ?? ''))); savedPromptRange = null;
}
function restorePromptDraft(text, skillReference = null) {
  const editor = $('prompt'); editor.replaceChildren(); savedPromptRange = null;
  const value = String(text ?? '');
  if (!skillReference?.skillId || !Number.isSafeInteger(skillReference.offset) || skillReference.offset < 0 || skillReference.offset > value.length) {
    editor.append(document.createTextNode(value)); return;
  }
  editor.append(document.createTextNode(value.slice(0, skillReference.offset)));
  const token = makeSkillToken({ id: skillReference.skillId, name: skillReference.displayName || skillReference.skillId, icon: skillReference.icon || '◇' });
  editor.append(token, document.createTextNode(' '), document.createTextNode(value.slice(skillReference.offset)));
  state.selectedSkillId = skillReference.skillId;
}
function selectionInsidePrompt(selection = getSelection()) {
  return Boolean(selection?.rangeCount && $('prompt').contains(selection.anchorNode));
}
function rememberPromptRange() {
  const selection = getSelection();
  if (selectionInsidePrompt(selection)) savedPromptRange = selection.getRangeAt(0).cloneRange();
}
function insertSkillToken(skill, { replaceSlash = false } = {}) {
  const editor = $('prompt');
  if (replaceSlash) {
    const range = document.createRange(); range.selectNodeContents(editor); range.deleteContents(); savedPromptRange = null;
  }
  editor.focus();
  const selection = getSelection();
  let range = selectionInsidePrompt(selection) ? selection.getRangeAt(0).cloneRange() : savedPromptRange?.cloneRange();
  if (!range || !editor.contains(range.startContainer)) {
    range = document.createRange(); range.selectNodeContents(editor); range.collapse(false);
  }
  const existing = editor.querySelector(`.${PROMPT_SKILL_TOKEN}`);
  if (existing) {
    const tokenRange = document.createRange(); tokenRange.selectNode(existing);
    if (range.compareBoundaryPoints(Range.START_TO_START, tokenRange) >= 0 && range.compareBoundaryPoints(Range.START_TO_END, tokenRange) <= 0) {
      range.setStartAfter(existing); range.collapse(true);
    }
    existing.remove();
  }
  range.deleteContents();
  const token = makeSkillToken(skill);
  const before = document.createTextNode(' '); const after = document.createTextNode(' ');
  const previousCharacter = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.nodeValue?.[range.startOffset - 1] : range.startContainer.childNodes[range.startOffset - 1]?.textContent?.slice(-1);
  if (!previousCharacter || /\s/.test(previousCharacter)) before.textContent = '';
  const fragment = document.createDocumentFragment();
  fragment.append(before, token, after);
  range.insertNode(fragment);
  range.setStartAfter(after); range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range); savedPromptRange = range.cloneRange();
  state.selectedSkillId = skill.id;
  $('skill-picker').value = '';
  updateInput();
  return token;
}
function adjacentSkillToken(range, direction) {
  const container = range.startContainer; const offset = range.startOffset;
  if (container.nodeType === Node.TEXT_NODE) {
    if (direction < 0 && offset === 0) {
      if (isPromptSkillToken(container.previousSibling)) return { token: container.previousSibling, spacer: container };
      if (/^\s*$/.test(container.nodeValue) && isPromptSkillToken(container.previousSibling?.previousSibling)) return { token: container.previousSibling.previousSibling, spacer: container };
    }
    if (direction > 0 && offset === container.nodeValue.length) {
      if (isPromptSkillToken(container.nextSibling)) return { token: container.nextSibling, spacer: container };
      if (/^\s*$/.test(container.nodeValue) && isPromptSkillToken(container.nextSibling?.nextSibling)) return { token: container.nextSibling.nextSibling, spacer: container };
    }
    return null;
  }
  if (container.nodeType === Node.ELEMENT_NODE) {
    const adjacent = container.childNodes[direction < 0 ? offset - 1 : offset];
    if (isPromptSkillToken(adjacent)) return { token: adjacent, spacer: null };
    if (adjacent?.nodeType === Node.TEXT_NODE && /^\s*$/.test(adjacent.textContent)) {
      const token = adjacent[direction < 0 ? 'previousSibling' : 'nextSibling'];
      if (isPromptSkillToken(token)) return { token, spacer: adjacent };
    }
  }
  return null;
}
function removeSkillTokenAtCaret(direction) {
  const selection = getSelection(); if (!selection?.isCollapsed || !selectionInsidePrompt(selection)) return false;
  const range = selection.getRangeAt(0); const adjacent = adjacentSkillToken(range, direction);
  if (!adjacent) return false;
  const { token, spacer } = adjacent; const parent = token.parentNode; const marker = document.createTextNode('');
  parent.insertBefore(marker, direction < 0 ? token : token.nextSibling);
  token.remove();
  if (spacer?.isConnected && spacer !== marker && /^\s*$/.test(spacer.textContent)) spacer.remove();
  if (direction < 0 && marker.nextSibling?.nodeType === Node.TEXT_NODE && /^\s*$/.test(marker.nextSibling.textContent)) marker.nextSibling.remove();
  if (direction > 0 && marker.previousSibling?.nodeType === Node.TEXT_NODE && /^\s*$/.test(marker.previousSibling.textContent)) marker.previousSibling.remove();
  const next = document.createRange(); next.setStart(marker, 0); next.collapse(true);
  selection.removeAllRanges(); selection.addRange(next); savedPromptRange = next.cloneRange();
  state.selectedSkillId = null; $('skill-picker').value = ''; updateInput();
  return true;
}
function removeSelectedSkillToken() {
  const selection = getSelection(); if (!selection || selection.isCollapsed || !selectionInsidePrompt(selection)) return false;
  const range = selection.getRangeAt(0); const tokens = [...$('prompt').querySelectorAll(`.${PROMPT_SKILL_TOKEN}`)];
  const token = tokens.find(item => { try { return range.intersectsNode(item); } catch { return false; } });
  if (!token) return false;
  range.deleteContents();
  if (token.isConnected) token.remove();
  state.selectedSkillId = $('prompt').querySelector(`.${PROMPT_SKILL_TOKEN}`)?.dataset.skillId || null;
  updateInput(); return true;
}
const slashCommands = [
  { id: 'tools', name: '工具目录', description: '查看 Agent 当前提供的工具及权限说明', icon: '⚒', aliases: ['tool', '工具'], run: () => $('tools-toggle').click() },
  { id: 'model-settings', name: '模型连接', description: '管理模型连接与当前模型设置', icon: '◈', aliases: ['model', '模型'], run: () => $('model-settings').click() },
  { id: 'security', name: '操作审批模式', description: '查看或切换安全模式与个人文件模式', icon: '♧', aliases: ['mode', '安全模式'], submenu: 'security' },
  { id: 'details', name: '运行详情', description: '查看当前会话和 Gateway 运行状态', icon: '◷', aliases: ['status', '状态'], run: () => $('details-toggle').click() },
  { id: 'attach', name: '添加附件', description: '选择并上传一份本机文本或 PDF 文件', icon: '▣', aliases: ['attachment', '附件'], run: () => $('attachment-toggle').click() },
  { id: 'export', name: '导出当前会话', description: '将当前会话导出为 Markdown 文件', icon: '↓', aliases: ['export', '导出'], enabled: () => Boolean(state.current), disabledReason: '当前还没有可导出的会话', run: () => $('export-session').click() },
  { id: 'memory', name: '记忆与任务', description: '管理 Agent 记忆和定时任务', icon: '◇', aliases: ['memory', '记忆'], run: () => $('admin-toggle').click() },
];
function notify(text) { $('notice').textContent = text; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 2400); }
function action(parent, symbol, label, handler) {
  const button = addText(parent, 'button', symbol, 'component-action'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.onclick = () => Promise.resolve().then(handler).catch(e => error(e.message)); return button;
}
function setHistory(open) { document.body.classList.toggle('history-open', open); $('history-backdrop').hidden = !open; $('history-toggle').setAttribute('aria-expanded', String(open)); }
async function exportSession(id) {
  const session = await api(`/api/sessions/${id}`);
  const text = `# ${session.title}\n\n` + session.messages.map(message => `## ${message.role === 'user' ? '你' : '灵珠'}\n\n${message.content}`).join('\n\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${session.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '会话'}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || `请求失败 (${response.status})`), { status: response.status, ...result });
  return result;
}
function error(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
function turnError(turn) {
  if (turn.errorCode === 'MODEL_SECRET_UNAVAILABLE') return '已保存的模型密钥无法读取或解密。请在模型配置页重新保存 API Key，并在输入框留空时测试已保存连接。';
  return `回合${statusText(turn.status)}${turn.errorCode ? `：${turn.errorCode}` : ''}${turn.errorMessage ? `\n${turn.errorMessage}` : ''}`;
}
function formatTime(value) { return value ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : ''; }
function addText(parent, tag, text, className) { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; parent.append(node); return node; }
function addOrb(parent, className) { const orb = addText(parent, 'span', '', className); orb.setAttribute('aria-hidden', 'true'); orb.append(document.createElement('span'), document.createElement('i')); return orb; }
function renderAttachmentCard(parent, attachment) {
  if (!attachment?.id || !attachment.name) return;
  const card = addText(parent, 'a', '', 'message-attachment');
  card.href = `/api/attachments/${encodeURIComponent(attachment.id)}/open`;
  card.target = '_blank'; card.rel = 'noreferrer'; card.title = '打开附件';
  addText(card, 'span', attachmentIcon(attachment.name), 'attachment-file-icon');
  const copy = addText(card, 'span', '', 'attachment-card-copy');
  addText(copy, 'strong', attachment.name);
  addText(copy, 'small', `${attachment.sizeBytes ? formatBytes(attachment.sizeBytes) : '附件'} · 点击打开文件`);
}
function statusText(status) { return ({ starting: '正在创建', running: '正在执行', cancelling: '正在停止', awaiting_approval: '等待确认', awaiting_clarification: '等待选择', completed: '已完成', failed: '执行失败', cancelled: '已取消', denied: '已拒绝', expired: '已过期', interrupted: '运行中断' })[status] || '就绪'; }
function stepStatusText(status) { return ({ pending: '等待中', ready: '可执行', running: '执行中', waiting: '等待确认', waiting_approval: '等待确认', waiting_acceptance: '等待验收', completed: '已完成', failed: '失败', blocked: '被阻塞', skipped: '已跳过', uncertain: '结果不确定', cancelled: '已取消', interrupted: '已中断' })[status] || status || '等待中'; }
function structuredPlanProgress(plan) {
  const steps = plan?.steps || [];
  const completed = steps.filter(step => ['completed', 'skipped'].includes(step.status)).length;
  const phases = plan?.phases || [];
  const completedPhases = phases.filter(phase => phase.status === 'completed').length;
  return { steps, completed, phases, completedPhases };
}
async function recoverTurn(turn) {
  if (!turn?.id || state.busy || turn.status !== 'interrupted' || !turn.structuredPlan) return;
  state.busy = true; renderTurn();
  try {
    const result = await api(`/api/turns/${encodeURIComponent(turn.id)}/recover`, 'POST', {});
    state.turn = { id: result.turnId || turn.id, sessionId: result.sessionId || turn.sessionId, status: result.status || 'running', structuredPlan: result.structuredPlan || turn.structuredPlan };
    sessionStorage.setItem('lingzhu-live-turn', state.turn.id); watchTurn(state.turn.id);
  } catch (e) { error(e.message); }
  finally { state.busy = false; renderTurn(); renderMessages(state.messages); }
}
function renderPlanCard(parent, plan, turn) {
  if (!plan?.steps?.length) return;
  const card = addText(parent, 'section', '', 'task-plan');
  const head = addText(card, 'div', '', 'task-plan-head');
  const planKey = turn?.id || plan.id || 'current';
  const expanded = state.expandedPlanKeys.has(planKey);
  const toggle = addText(head, 'button', '', 'task-plan-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', `${expanded ? '收起' : '展开'}执行计划`);
  toggle.title = `${expanded ? '收起' : '展开'}执行计划`;
  const title = addText(toggle, 'span', '', 'task-plan-title');
  addText(title, 'strong', '执行计划');
  addText(title, 'small', plan.goal || '处理当前请求');
  const progress = structuredPlanProgress(plan);
  const completed = progress.completed;
  addText(title, 'small', plan.phases ? `${progress.completedPhases}/${progress.phases.length} 个阶段 · ${completed}/${progress.steps.length} 个步骤已完成` : `${completed}/${plan.steps.length} 个步骤已完成`, 'task-plan-progress');
  addText(head, 'span', stepStatusText(plan.status === 'running' ? 'running' : plan.status), `task-plan-status ${plan.status || ''}`);
  const details = addText(card, 'div', '', 'task-plan-details');
  details.id = `task-plan-details-${String(planKey).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  details.hidden = !expanded;
  toggle.setAttribute('aria-controls', details.id);
  toggle.onclick = () => {
    if (state.expandedPlanKeys.has(planKey)) state.expandedPlanKeys.delete(planKey); else state.expandedPlanKeys.add(planKey);
    renderMessages(state.messages);
  };
  const list = addText(details, 'ol', '', 'task-plan-list');
  if (plan.phases) {
    for (const phase of progress.phases) {
      const phaseRow = addText(list, 'li', '', `task-plan-phase ${phase.status || 'pending'}`);
      const phaseCopy = addText(phaseRow, 'span', '', 'task-step-copy');
      addText(phaseCopy, 'strong', `阶段：${phase.title}`);
      addText(phaseCopy, 'small', `${stepStatusText(phase.status)} · 验收：${phase.acceptanceStatus === 'passed' ? '通过' : phase.acceptanceStatus === 'failed' ? '未通过' : '待检查'}${phase.dependsOn?.length ? ` · 依赖：${phase.dependsOn.join('、')}` : ''}`);
      if (phase.lastErrorMessage) addText(phaseCopy, 'small', `验收原因：${phase.lastErrorMessage}`, 'task-step-error');
      const phaseSteps = progress.steps.filter(step => step.phaseId === phase.id);
      for (const step of phaseSteps) {
        const row = addText(list, 'li', '', `task-plan-step ${step.status || 'pending'}`);
        addText(row, 'span', step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'cancelled' ? '×' : step.status === 'waiting_approval' ? '…' : step.status === 'blocked' ? '!' : '·', 'task-step-mark');
        const copy = addText(row, 'span', '', 'task-step-copy');
        addText(copy, 'strong', step.title || step.label || step.tool || '执行步骤');
        addText(copy, 'small', `${stepStatusText(step.status)}${step.dependsOn?.length ? ` · 依赖：${step.dependsOn.join('、')}` : ''}${step.errorCode || step.lastErrorCode ? ` · ${step.errorCode || step.lastErrorCode}` : ''}${step.attempts !== undefined ? ` · 尝试 ${step.attempts}/${step.retryPolicy?.maxAttempts ?? 2}` : ''}${step.acceptanceStatus ? ` · 验收${step.acceptanceStatus === 'passed' ? '通过' : step.acceptanceStatus === 'failed' ? '未通过' : '待检查'}` : ''}`);
        if (step.errorMessage || step.lastErrorMessage) addText(copy, 'small', `原因：${step.errorMessage || step.lastErrorMessage}`, 'task-step-error');
        if (turn && ['failed', 'uncertain'].includes(step.status) && step.attempts < (step.retryPolicy?.maxAttempts ?? 2)) {
          const retryStep = action(copy, '↻', step.status === 'uncertain' ? '核实后重试此步骤' : '仅重试此步骤', () => retryPlanStep(turn, step));
          retryStep.classList.add('retry-turn', 'retry-plan-step');
        }
      }
    }
  } else for (const step of plan.steps) {
    const row = addText(list, 'li', '', `task-plan-step ${step.status || 'pending'}`);
    addText(row, 'span', step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.status === 'cancelled' ? '×' : step.status === 'waiting' ? '…' : '·', 'task-step-mark');
    const copy = addText(row, 'span', '', 'task-step-copy');
    addText(copy, 'strong', step.label || step.tool || '执行步骤');
    addText(copy, 'small', stepStatusText(step.status) + (step.errorCode ? ` · ${step.errorCode}` : ''));
    if (step.errorMessage && step.status === 'failed') addText(copy, 'small', `原因：${step.errorMessage}`, 'task-step-error');
  }
  if (turn && ['failed', 'cancelled', 'interrupted', 'denied', 'expired'].includes(turn.status)) {
    const actions = addText(card, 'div', '', 'task-plan-actions');
    const recover = turn.status === 'interrupted' && turn.structuredPlan;
    const retry = action(actions, '↻', recover ? '从检查点恢复' : '重试当前任务', () => recover ? recoverTurn(turn) : retryTurn(turn));
    retry.classList.add('retry-turn'); retry.textContent = recover ? '从检查点恢复' : '重试当前任务';
    retry.disabled = state.busy;
  }
}
function updateConnection(connected) { $('connection-label').textContent = connected ? 'Gateway 已连接' : '正在重连 Gateway'; $('connection-dot').classList.toggle('warning', !connected); }
async function retryPlanStep(turn, step) {
  if (!turn?.id || state.busy) return;
  const confirmUncertain = step.status === 'uncertain';
  if (confirmUncertain && !window.confirm(`步骤“${step.title}”执行时中断，实际副作用可能已经发生。请先检查文件或外部状态；确认已核实并仍要重新执行后，才继续。\n\n确认重新执行此步骤？`)) return;
  state.busy = true; renderTurn(); error('');
  try {
    const result = await api(`/api/turns/${encodeURIComponent(turn.id)}/retry-step`, 'POST', { stepId: step.id, confirmUncertain });
    state.turn = { ...state.turn, id: result.turnId || turn.id, sessionId: result.sessionId || turn.sessionId, status: result.status || 'running', structuredPlan: result.structuredPlan || state.turn?.structuredPlan };
    sessionStorage.setItem('lingzhu-live-turn', state.turn.id); await checkTurn();
  } catch (e) { error(e.message); }
  finally { state.busy = false; renderTurn(); renderMessages(state.messages); }
}
function renderReasoningOptions(select, profile, value = 'default') {
  select.replaceChildren();
  for (const option of profile?.options || [{ value: 'default', label: '模型默认' }]) addText(select, 'option', option.label).value = option.value;
  select.value = [...select.options].some(option => option.value === value) ? value : 'default';
  select.title = profile?.label || '思考设置';
}
function nearBottom() { const view = $('conversation'); return view.scrollHeight - view.scrollTop - view.clientHeight < 80; }

function safeUrl(value) {
  try { const url = new URL(value, window.location.href); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
function renderInline(parent, source) {
  const pattern = /(`[^`\n]+`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
  let cursor = 0; let match;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
    if (match[1].startsWith('`')) addText(parent, 'code', match[1].slice(1, -1), 'inline-code');
    else if (match[2]) { const href = safeUrl(match[3]); if (href) { const link = addText(parent, 'a', match[2], 'message-link'); link.href = href; link.target = '_blank'; link.rel = 'noreferrer'; } else parent.append(document.createTextNode(match[2])); }
    else if (match[4] || match[5]) addText(parent, 'strong', match[4] || match[5]);
    else addText(parent, 'em', match[6] || match[7]);
    cursor = pattern.lastIndex;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}
function renderUserMessage(parent, message) {
  const reference = message.skillReference;
  if (!reference?.skillId || typeof reference.offset !== 'number') { renderMarkdown(parent, message.content || ''); return; }
  const content = String(message.content || ''); const offset = Math.max(0, Math.min(content.length, reference.offset));
  parent.classList.add('message-text-with-skill');
  if (offset) parent.append(document.createTextNode(content.slice(0, offset)));
  parent.append(makeSkillToken({ id: reference.skillId, name: reference.displayName || reference.skillId, icon: reference.icon || '◇' }));
  parent.append(document.createTextNode(content.slice(offset)));
}
function renderMarkdown(parent, source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  const paragraph = content => { const node = addText(parent, 'p', '', 'markdown-paragraph'); renderInline(node, content); };
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      index++; const code = [];
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      const block = addText(parent, 'div', '', 'code-block');
      if (fence[1]) block.dataset.language = fence[1];
      const pre = block.appendChild(document.createElement('pre')); const codeNode = addText(pre, 'code', code.join('\n'));
      action(block, '⧉', '复制代码', async () => { await navigator.clipboard.writeText(codeNode.textContent); notify('代码已复制'); });
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { const node = addText(parent, `h${heading[1].length}`, '', 'markdown-heading'); renderInline(node, heading[2]); index++; continue; }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { addText(parent, 'hr', '', 'markdown-rule'); index++; continue; }
    const table = index + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1]);
    if (table) {
      const tableNode = addText(parent, 'table', '', 'markdown-table');
      const cells = row => row.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell => cell.trim());
      const header = addText(tableNode, 'thead', ''); const headerRow = addText(header, 'tr', '');
      for (const cell of cells(line)) { const th = addText(headerRow, 'th', ''); renderInline(th, cell); }
      index += 2; const body = addText(tableNode, 'tbody', '');
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) { const tr = addText(body, 'tr', ''); for (const cell of cells(lines[index++])) { const td = addText(tr, 'td', ''); renderInline(td, cell); } }
      continue;
    }
    const list = line.match(/^\s*([-*+] |\d+\. )(.+)$/);
    if (list) {
      const ordered = /^\d/.test(list[1]); const listNode = addText(parent, ordered ? 'ol' : 'ul', '', 'markdown-list');
      while (index < lines.length) { const item = lines[index].match(ordered ? /^\s*\d+\. (.+)$/ : /^\s*[-*+] (.+)$/); if (!item) break; const li = addText(listNode, 'li', ''); renderInline(li, item[1]); index++; }
      continue;
    }
    if (/^\s*> ?/.test(line)) { const quote = addText(parent, 'blockquote', '', 'markdown-quote'); renderInline(quote, line.replace(/^\s*> ?/, '')); index++; continue; }
    const prose = [line]; index++;
    while (index < lines.length && lines[index].trim() && !/^\s*(#{1,6})\s|^\s*```|^\s*[-*+] |^\s*\d+\. |^\s*> /.test(lines[index])) prose.push(lines[index++]);
    paragraph(prose.join('\n'));
  }
}

function renderSessions() {
  $('sessions').replaceChildren();
  $('session-count').textContent = state.sessions.length;
  const query = $('session-query').value.trim().toLowerCase();
  const matches = state.sessions.filter(item => item.title.toLowerCase().includes(query));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ordinary = new Map([['置顶', []], ['今天', []], ['最近 7 天', []], ['更早', []]]);
  const projects = new Map();
  for (const session of matches) {
    if (session.project?.id) {
      if (!projects.has(session.project.id)) projects.set(session.project.id, { project: session.project, sessions: [] });
      projects.get(session.project.id).sessions.push(session);
      continue;
    }
    const date = new Date(session.updatedAt).getTime();
    ordinary.get(pins.includes(session.id) ? '置顶' : date >= today.getTime() ? '今天' : date >= today.getTime() - 6 * 86400000 ? '最近 7 天' : '更早').push(session);
  }
  for (const { project, sessions } of projects.values()) renderSessionGroup(project.name, sessions, `project:${project.id}`);
  const hasOrdinary = [...ordinary.values()].some(items => items.length);
  if (hasOrdinary) addText($('sessions'), 'div', '普通对话', 'session-category-heading');
  for (const [name, sessions] of ordinary) renderSessionGroup(name, sessions, name);
  if (!matches.length) addText($('sessions'), 'p', query ? '没有匹配的会话' : state.archivedView ? '还没有归档的会话。' : '还没有会话，开始一个新任务。', 'empty-list');
}
function renderSessionGroup(name, sessions, key, collapseKey = key) {
  if (!sessions.length) return;
  const group = addText($('sessions'), 'section', '', 'session-group');
  const heading = addText(group, 'button', `⌄ ${name} · ${sessions.length}`, 'group-heading');
  heading.type = 'button'; heading.setAttribute('aria-expanded', 'true');
  heading.onclick = () => { if (collapsedGroups.has(collapseKey)) collapsedGroups.delete(collapseKey); else collapsedGroups.add(collapseKey); renderSessions(); };
  heading.textContent = `${collapsedGroups.has(collapseKey) ? '›' : '⌄'} ${name} · ${sessions.length}`;
  heading.setAttribute('aria-expanded', String(!collapsedGroups.has(collapseKey)));
  if (collapsedGroups.has(collapseKey)) return;
  for (const session of sessions) {
    const row = addText(group, 'div', '', 'session-row');
    row.dataset.sessionId = session.id;
    const button = document.createElement('button'); button.className = `session-item${session.id === state.current ? ' active' : ''}`;
    button.type = 'button'; button.onclick = () => selectSession(session.id).catch(e => error(e.message));
    button.title = `${session.title}\n${new Date(session.updatedAt).toLocaleString('zh-CN')}`;
    button.setAttribute('aria-current', session.id === state.current ? 'true' : 'false');
    addText(button, 'span', '', 'session-mark'); addText(button, 'span', session.title, 'session-name');
    addText(button, 'time', formatTime(session.updatedAt)); row.append(button);
    const menu = addText(row, 'details', '', 'session-menu');
    const trigger = addText(menu, 'summary', '···'); trigger.title = '会话操作'; trigger.setAttribute('aria-label', `会话操作：${session.title}`);
    menu.ontoggle = () => { if (menu.open) document.querySelectorAll('.session-menu[open]').forEach(other => { if (other !== menu) other.open = false; }); };
    const options = addText(menu, 'div', '', 'session-options');
    action(options, pins.includes(session.id) ? '取消置顶' : '置顶', '在此浏览器置顶会话', () => {
      const next = pins.includes(session.id) ? pins.filter(id => id !== session.id) : [...pins, session.id];
      localStorage.setItem('lingzhu-live-pins', JSON.stringify(next)); pins = next; renderSessions();
    });
    action(options, '导出会话', '导出会话', async () => { menu.open = false; await exportSession(session.id); });
    action(options, '改名', '重命名会话', async () => { menu.open = false; await renameSession(session); });
    action(options, '分支', '管理会话分支', async () => { menu.open = false; await manageBranches(session); });
    action(options, state.archivedView ? '恢复' : '归档', state.archivedView ? '恢复到最近会话' : '归档会话', async () => { menu.open = false; await setSessionArchived(session); });
  }
}
async function setSessionArchived(session) {
  const actionName = state.archivedView ? 'restore' : 'archive';
  await api(`/api/sessions/${session.id}/${actionName}`, 'POST', {});
  if (state.current === session.id && actionName === 'archive') await newSession();
  await refreshLists();
  notify(actionName === 'archive' ? '会话已归档，内容仍保留' : '会话已恢复');
}
async function renameSession(session) {
  const title = window.prompt('会话标题', session.title);
  if (title === null || title.trim() === session.title) return;
  await api(`/api/sessions/${session.id}/rename`, 'POST', { title });
  await refreshLists();
  if (state.current === session.id) $('session-title').textContent = title.trim();
  notify('会话已重命名');
}
async function manageBranches(session) {
  const result = await api(`/api/sessions/${session.id}/branches`);
  $('session-dialog-title').textContent = '上下文分支'; $('session-dialog-body').replaceChildren();
  for (const branch of result.items) {
    const row = addText($('session-dialog-body'), 'div', '', 'branch-row');
    addText(row, 'strong', branch.name); addText(row, 'small', branch.id === result.activeBranchId ? '当前分支' : '');
    if (branch.id !== result.activeBranchId) action(row, '切换', `切换到 ${branch.name}`, async () => { await api(`/api/sessions/${session.id}/branch`, 'POST', { branchId: branch.id }); $('session-dialog').close(); await selectSession(session.id); notify(`已切换到 ${branch.name}`); });
  }
  action($('session-dialog-body'), '＋', '创建分支', async () => { const name = window.prompt('分支名称', '新分支'); if (!name) return; await api(`/api/sessions/${session.id}/fork`, 'POST', { name }); $('session-dialog').close(); await selectSession(session.id); notify('已创建并切换到新分支'); });
  $('session-dialog').showModal();
}
function renderMessages(messages = []) {
  const list = $('messages'); const stick = nearBottom(); list.replaceChildren();
  if (!messages.length && !state.turn) {
    const empty = addText(list, 'section', '', 'empty-state');
    addOrb(empty, 'empty-orbit'); addText(empty, 'h1', '从一个任务开始');
    addText(empty, 'p', '描述你希望灵珠处理的事情。');
    for (const prompt of ['分析当前项目结构，并指出最值得优先处理的问题。', '检查项目中的测试，并总结失败原因。']) {
      const button = addText(empty, 'button', prompt + ' ↗'); button.type = 'button'; button.onclick = () => { setPromptText(prompt); updateInput(); $('prompt').focus(); };
    }
  }
  for (const message of messages) {
    const failed = message.role === 'assistant' && String(message.content || '').startsWith('本次请求执行失败');
    const item = addText(list, 'article', '', `message ${message.role}${failed ? ' failed-message' : ''}`);
    const avatar = addText(item, 'div', message.role === 'user' ? '你' : '', 'avatar');
    if (message.role !== 'user') addOrb(avatar, 'mini-orb');
    const content = addText(item, 'div', '', 'message-body');
    const author = addText(content, 'div', '', 'message-author');
    addText(author, 'span', message.role === 'user' ? '你' : failed ? '灵珠 · 执行失败' : '灵珠');
    if (message.createdAt) addText(author, 'time', formatTime(message.createdAt));
    const text = addText(content, 'div', '', 'message-text');
    if (message.role === 'user') renderUserMessage(text, message); else renderMarkdown(text, message.content || '');
    renderAttachmentCard(content, message.attachment);
    const actions = addText(content, 'div', '', 'message-actions');
    action(actions, '⧉', '复制消息', async () => { await navigator.clipboard.writeText(message.content || ''); notify('消息已复制'); });
    if ((message.content || '').length > 1200 || (message.content || '').split('\n').length > 16) {
      text.classList.add('collapsed-message');
      const expand = action(actions, '展开全文', '展开全文', () => {
        const collapsed = text.classList.toggle('collapsed-message'); expand.textContent = collapsed ? '展开全文' : '收起'; expand.setAttribute('aria-expanded', String(!collapsed)); expand.title = collapsed ? '展开全文' : '收起'; expand.setAttribute('aria-label', expand.title);
      }); expand.setAttribute('aria-expanded', 'false');
    }
  }
  if (state.turn?.plan || state.turn?.structuredPlan) {
    const planItem = addText(list, 'article', '', 'message assistant plan-message');
    addOrb(addText(planItem, 'div', '', 'avatar'), 'mini-orb');
    const planBody = addText(planItem, 'div', '', 'message-body');
    addText(planBody, 'div', '灵珠 · 任务进度', 'message-author');
    renderPlanCard(planBody, state.turn.structuredPlan || state.turn.plan, state.turn);
  }
  if (state.turn && !terminal.has(state.turn.status)) {
    const item = addText(list, 'article', '', 'message assistant live-message');
    addOrb(addText(item, 'div', '', 'avatar'), 'mini-orb');
    const content = addText(item, 'div', '', 'message-body');
    addText(content, 'div', '灵珠 · ' + statusText(state.turn.status), 'message-author');
    const liveText = addText(content, 'div', '', 'message-text live-text');
    if (state.streamText) renderMarkdown(liveText, state.streamText);
    addText(content, 'p', state.turn.tool ? `正在使用 ${state.turn.tool}` : state.turn.status === 'awaiting_approval' ? '操作需要你的确认，请查看右侧审批详情。' : state.streamText ? '正在生成…' : '正在处理你的请求…', 'live-status');
  }
  if (stick) $('conversation').scrollTop = $('conversation').scrollHeight;
}
function renderTurn() {
  const turn = state.turn;
  $('turn-status').textContent = turn ? statusText(turn.status) : '就绪';
  const live = document.querySelector('.live-message');
  if (live && turn) {
    live.querySelector('.message-author').textContent = '灵珠 · ' + statusText(turn.status);
    live.querySelector('.live-status').textContent = turn.tool ? `正在使用 ${turn.tool}` : turn.status === 'awaiting_approval' ? '操作需要你的确认，请查看右侧审批详情。' : state.streamText ? '正在生成…' : '正在处理你的请求…';
    const liveText = live.querySelector('.live-text'); liveText.replaceChildren(); if (state.streamText) renderMarkdown(liveText, state.streamText);
  }
  const canStop = turn && ['running', 'awaiting_approval', 'awaiting_clarification'].includes(turn.status);
  $('send').textContent = canStop ? '■' : '↑';
  $('send').title = canStop ? '停止任务' : '发送消息'; $('send').setAttribute('aria-label', $('send').title);
  $('send').disabled = !canStop && (state.currentArchived || state.busy || Boolean(turn && !terminal.has(turn.status)) || !serializePrompt().text.trim());
  $('prompt').setAttribute('contenteditable', String(!state.currentArchived && !state.busy && !(turn && !terminal.has(turn.status))));
  $('prompt').setAttribute('aria-disabled', String(state.currentArchived || state.busy || Boolean(turn && !terminal.has(turn.status))));
  $('model-select').disabled = !state.models.length || state.busy || Boolean(turn && !terminal.has(turn.status));
  $('export-session').disabled = !state.current;
  $('composer-state').textContent = state.currentArchived ? '归档会话为只读，请先恢复会话再继续' : turn?.status === 'awaiting_approval' ? '请先处理待确认的操作' : '工作区工具由权限策略控制';
  const approval = turn?.approval;
  const pending = turn?.status === 'awaiting_approval' && approval;
  $('review').hidden = !pending || reviewDismissed === approval.id;
  $('review-open').hidden = !pending;
  $('approve').disabled = state.busy; $('deny').disabled = state.busy;
  renderClarification(turn);
  if ($('details').open) renderTurnDetails();
  if (approval) {
    $('approval-operation').textContent = approval.operation || approval.type || '操作审批';
    const summary = approval.metadata?.summary || {};
    const scopedRead = approval.type === 'turn.external_read' && ['external_list_files', 'external_find_files', 'external_search_text'].includes(approval.operation);
    $('read-scope-option').hidden = !scopedRead;
    $('read-scope').checked = false;
    $('approval-summary').textContent = summary.path ? `${summary.mode === 'read-only' ? '只读目标：' : '目标文件：'}${summary.path}` : summary.tool ? `工具：${summary.tool}` : '请确认是否允许此操作继续。';
    const preview = summary.diffPreview || summary.commandPreview || (summary.beforePreview !== undefined || summary.afterPreview !== undefined ? `--- 当前内容\n${summary.beforePreview || ''}\n+++ 执行后\n${summary.afterPreview || ''}` : '');
    $('approval-preview').hidden = !preview;
    if (preview) { $('approval-preview-title').textContent = summary.diffPreview ? '文件差异' : summary.commandPreview ? '待执行命令' : '文件内容预览'; $('approval-preview-content').textContent = preview; }
    $('approval-details').replaceChildren();
    for (const [key, value] of Object.entries(summary)) {
      if (value == null || typeof value === 'object') continue;
      const row = addText($('approval-details'), 'div', '', 'detail-row');
      addText(row, 'span', key); addText(row, 'strong', String(value));
    }
  }
  document.body.classList.toggle('has-review', !$('review').hidden);
}
async function refreshSession() {
  if (!state.current) { state.messages = []; renderMessages(); return; }
  const session = await api(`/api/sessions/${state.current}`);
  state.currentProject = session.project || null; state.currentArchived = Boolean(session.archivedAt); renderProjectSelector();
  $('session-title').textContent = session.title;
  state.messages = session.messages; state.streamText = ''; renderMessages(state.messages);
}
async function refreshLists() {
  const [sessions, models, diagnostics] = await Promise.all([api(`/api/sessions${state.archivedView ? '?archived=true' : ''}`), api('/api/models'), api('/api/diagnostics')]);
  const projects = await api('/api/projects').catch(() => ({ items: [] }));
  state.sessions = sessions.filter(item => item.messageCount !== 0 || item.id === state.current); state.models = models.items; state.diagnostics = diagnostics;
  await refreshSkillPicker();
  state.projects = projects.items || [];
  state.securityMode = diagnostics.securityMode?.active || diagnostics.securityMode?.requested || 'safe';
  $('archive-toggle').setAttribute('aria-pressed', String(state.archivedView));
  $('archive-toggle').classList.toggle('active', state.archivedView);
  $('list-heading').querySelector('span').textContent = state.archivedView ? '已归档会话' : '最近会话 · 搜索全部';
  $('sandbox-label').textContent = diagnostics.worker?.available ? '已验证' : '不可用';
  $('runtime-label').textContent = diagnostics.failClosed ? '受限运行' : '本地运行中';
  $('runtime-dot').classList.toggle('warning', diagnostics.failClosed);
  $('connection-label').textContent = 'Gateway 已连接'; $('connection-dot').classList.remove('warning');
  const select = $('model-select'); select.replaceChildren();
  if (!state.models.length) addText(select, 'option', '未配置模型');
  for (const model of state.models) { const option = addText(select, 'option', `${model.name} · ${model.model}`); option.value = model.id; }
  select.value = models.selectedId || '';
  select.disabled = !state.models.length;
  const selected = state.models.find(model => model.id === select.value);
  const reasoning = $('reasoning-select');
  renderReasoningOptions(reasoning, selected?.reasoningProfile, selected?.reasoningEffort || 'default');
  reasoning.disabled = !selected || state.busy || Boolean(state.turn && !terminal.has(state.turn.status));
  renderSecurityMode();
  renderProjectSelector();
  renderSessions();
}
async function refreshSkillPicker() {
  const picker = $('skill-picker'); if (!picker) return;
  try {
    const result = await api('/api/skills?includeInvalid=true');
  const items = Array.isArray(result) ? result : result.items || [];
    state.skills = items; state.skillsError = '';
    picker.replaceChildren(new Option('插入 Skill 引用', ''));
    for (const item of items.filter(skill => !skill.invalid && skill.enabled === true && skill.installed !== false)) picker.add(new Option(item.name || item.id, item.id));
    picker.value = '';
    picker.title = items.length ? '指定一个已安装的 Skill；停用技能不可用于对话' : '暂无已安装技能';
    renderSlashMenu(); return true;
  } catch (e) { state.skillsError = e.message; picker.title = e.message; renderSlashMenu(); return false; }
}
function slashMatches(item, query, skill = false) {
  const words = [item.name, item.description, ...(skill ? [item.id] : item.aliases || [])].filter(Boolean).join(' ').toLocaleLowerCase();
  return words.includes(query.toLocaleLowerCase());
}
function availableSlashRows() { return [...slashMenu.querySelectorAll('[role="option"]:not(:disabled)')]; }
function setSlashIndex(index) {
  const rows = availableSlashRows();
  if (!rows.length) { state.slashIndex = -1; return; }
  state.slashIndex = (index + rows.length) % rows.length;
  rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === state.slashIndex)));
  rows[state.slashIndex]?.scrollIntoView({ block: 'nearest' });
}
function renderSlashMenu() {
  const prompt = $('prompt');
  const text = serializePrompt().text;
  const open = text.startsWith('/');
  slashMenu.hidden = !open;
  if (open) positionSlashMenu();
  prompt?.setAttribute('aria-expanded', String(open));
  if (!open) { state.slashIndex = -1; state.slashSubmenu = null; return; }
  slashMenu.replaceChildren();
  const query = text.slice(1);
  if (state.slashSubmenu === 'security') {
    const heading = addText(slashMenu, 'div', '', 'slash-section-title');
    const back = addText(heading, 'button', '‹ 返回', 'slash-back'); back.type = 'button'; back.onclick = () => { state.slashSubmenu = null; state.slashIndex = -1; renderSlashMenu(); $('prompt').focus(); };
    addText(heading, 'span', '操作审批模式');
    let visibleModes = 0;
    for (const [mode, title, description, icon] of [['safe', '安全模式', '外部读取、写入和命令按策略请求确认', '♧'], ['personal', '个人文件模式', '普通文件读写可直接执行；其他风险操作仍受保护', '◇']]) {
      if (!`${title} ${description} ${mode}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      visibleModes++;
      const selected = state.securityMode === mode;
      const row = addText(slashMenu, 'button', '', 'slash-option'); row.type = 'button'; row.setAttribute('role', 'option'); row.dataset.slashOption = mode; row.disabled = selected;
      addText(row, 'span', icon, 'slash-icon'); const copy = addText(row, 'span', '', 'slash-copy'); addText(copy, 'strong', title); addText(copy, 'small', description);
      row.title = `${title}：${description}`; row.onclick = () => void chooseSecurityMode(mode, title);
    }
    if (!visibleModes) addText(slashMenu, 'p', '没有匹配的选项', 'slash-empty');
  } else {
    const matchingCommands = slashCommands.filter(item => slashMatches(item, query));
    const installed = state.skills.filter(item => item.installed !== false);
    const matchingSkills = installed.filter(item => slashMatches(item, query, true));
    if (matchingCommands.length) {
      addText(slashMenu, 'div', '功能', 'slash-section-title');
      for (const item of matchingCommands) {
        const enabled = item.enabled ? item.enabled() : true;
        const row = addText(slashMenu, 'button', '', 'slash-option'); row.type = 'button'; row.setAttribute('role', 'option'); row.dataset.slashOption = item.id; row.disabled = !enabled;
        addText(row, 'span', item.icon, 'slash-icon'); const copy = addText(row, 'span', '', 'slash-copy'); addText(copy, 'strong', item.name); addText(copy, 'small', item.description);
        if (item.submenu) addText(row, 'span', '›', 'slash-arrow');
        row.title = `${item.name}：${enabled ? item.description : item.disabledReason || '当前不可用'}`;
        row.onclick = () => item.submenu ? (state.slashSubmenu = item.submenu, state.slashIndex = -1, renderSlashMenu(), $('prompt').focus()) : void chooseSlashCommand(item);
      }
    }
    if (matchingSkills.length) {
      addText(slashMenu, 'div', '技能', 'slash-section-title');
      for (const item of matchingSkills) {
        const usable = !state.skillsError && !item.invalid && item.enabled === true;
        const reason = state.skillsError ? '技能列表暂不可用' : item.invalid ? item.error || '技能校验失败' : !item.enabled ? '技能已停用' : '';
        const row = addText(slashMenu, 'button', '', 'slash-option slash-skill-option'); row.type = 'button'; row.setAttribute('role', 'option'); row.dataset.slashOption = `skill:${item.id}`; row.disabled = !usable;
        addText(row, 'span', item.icon || '◇', 'slash-icon'); const copy = addText(row, 'span', '', 'slash-copy'); addText(copy, 'strong', item.name || item.id); addText(copy, 'small', item.description?.trim() || '未提供技能简介');
        if (!usable) addText(row, 'span', reason, 'slash-disabled-reason');
        row.title = `${item.name || item.id}（${item.id}）${item.description ? `：${item.description}` : '：未提供技能简介'}${reason ? `；${reason}` : ''}`;
        row.onclick = () => void chooseSlashSkill(item);
      }
    }
    if (!matchingCommands.length && !matchingSkills.length) addText(slashMenu, 'p', state.skillsError ? `技能列表不可用：${state.skillsError}` : state.skills.length ? '没有匹配的功能或技能' : '没有匹配的功能', 'slash-empty');
  }
  state.slashIndex = -1;
  const first = availableSlashRows()[0];
  if (first) setSlashIndex(0);
}
function positionSlashMenu() {
  const composer = document.querySelector('.composer-area');
  const rect = composer?.getBoundingClientRect();
  const inputRect = $('prompt')?.getBoundingClientRect();
  if (!rect || !inputRect) return;
  const bottom = Math.max(0, rect.bottom - inputRect.top + 8);
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const available = Math.max(96, Math.min(matchMedia('(max-width:680px)').matches ? 330 : 410, inputRect.top - 12, viewportHeight - 100));
  slashMenu.style.bottom = `${bottom}px`;
  slashMenu.style.maxHeight = `${available}px`;
}
function clearSlashText({ focus = true } = {}) {
  const input = $('prompt');
  const serialized = serializePrompt();
  if (!serialized.text.startsWith('/')) return;
  setPromptText('');
  state.selectedSkillId = null;
  updateInput();
  if (focus) input.focus();
}
async function chooseSecurityMode(mode, title) {
  if (await setSecurityMode(mode, title)) clearSlashText();
}
async function chooseSlashCommand(item) {
  try { await item.run(); state.slashError = ''; clearSlashText({ focus: false }); }
  catch (e) { state.slashError = e.message; error(e.message); }
}
function chooseSlashSkill(item) {
  if (item.invalid || item.enabled !== true || item.installed === false) return;
  insertSkillToken(item, { replaceSlash: serializePrompt().text.startsWith('/') });
  notify(`已为下一条消息选择技能：${item.name || item.id}`);
}
function renderProjectSelector() {
  const label = $('project-current-label'); if (!label) return;
  label.textContent = state.currentProject?.name || '选择项目';
  $('project-toggle').title = state.currentProject?.path || '选择项目';
  renderProjectOptions();
}
function renderProjectOptions() {
  const list = $('project-list'); if (!list) return;
  list.replaceChildren();
  const query = $('project-query').value.trim().toLocaleLowerCase();
  const matches = state.projects.filter(project => `${project.name} ${project.path}`.toLocaleLowerCase().includes(query));
  const ordinary = addText(list, 'button', '', 'project-option');
  ordinary.type = 'button'; ordinary.setAttribute('role', 'option'); ordinary.setAttribute('aria-selected', String(!state.currentProject));
  addText(ordinary, 'span', '▱', 'project-option-icon'); addText(ordinary, 'span', '普通对话', 'project-option-name');
  ordinary.onclick = () => void selectRecentProject('').catch(e => error(e.message));
  for (const project of matches) {
    const option = addText(list, 'button', '', 'project-option');
    option.type = 'button'; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(project.id === state.currentProject?.id));
    addText(option, 'span', '▱', 'project-option-icon');
    const copy = addText(option, 'span', '', 'project-option-copy');
    addText(copy, 'span', project.name, 'project-option-name');
    addText(copy, 'small', project.path);
    option.title = project.path;
    option.onclick = () => void selectRecentProject(project.id).catch(e => error(e.message));
  }
  if (!matches.length && query) addText(list, 'p', '没有匹配的项目', 'project-empty');
}
function openProjectMenu() {
  const menu = $('project-menu'); const open = menu.hidden;
  menu.hidden = !open;
  $('project-toggle').setAttribute('aria-expanded', String(open));
  if (open) { $('project-query').value = ''; renderProjectOptions(); $('project-query').focus(); }
}
function closeProjectMenu({ focus = false } = {}) {
  $('project-menu').hidden = true;
  $('project-toggle').setAttribute('aria-expanded', 'false');
  if (focus) $('project-toggle').focus();
}
async function chooseProject() {
  if (state.turn && !terminal.has(state.turn.status)) return error('当前回合尚未结束，无法切换项目。');
  try {
    const result = await api('/api/projects/pick', 'POST', {});
    if (result.cancelled || !result.project) return;
    await refreshLists();
    state.currentProject = result.project;
    await newSession();
    state.currentProject = result.project;
    renderProjectSelector();
    $('prompt').focus();
    notify(`已选择项目：${result.project.name}。发送消息后会创建独立项目对话。`);
  } catch (e) { error(e.message); }
}
async function selectRecentProject(id) {
  if (!id) {
    closeProjectMenu();
    state.currentProject = null;
    await newSession();
    renderProjectSelector();
    return;
  }
  const project = state.projects.find(item => item.id === id);
  if (!project) return;
  if (state.turn && !terminal.has(state.turn.status)) return error('当前回合尚未结束，无法切换项目。');
  closeProjectMenu();
  await newSession();
  state.currentProject = project;
  renderProjectSelector();
  $('prompt').focus();
  notify(`已选择项目：${project.name}。发送消息后会创建独立项目对话。`);
}
async function selectSession(id) {
  if (state.turn && !terminal.has(state.turn.status) && state.turn.sessionId !== id) return error('当前回合尚未结束，请先完成或停止它。');
  if (state.current !== id) clearAttachment();
  const session = await api(`/api/sessions/${id}`);
  state.currentProject = session.project || null; state.currentArchived = Boolean(session.archivedAt);
  if (state.turn?.sessionId !== id) { state.turn = null; state.streamText = ''; }
  state.current = id; sessionStorage.setItem('lingzhu-live-session', id); error('');
  $('session-title').textContent = session.title; state.messages = session.messages;
  renderProjectSelector(); renderSessions(); renderMessages(state.messages); renderTurn(); setHistory(false);
}
async function newSession() {
  if (state.turn && !terminal.has(state.turn.status)) return error('当前回合尚未结束，请先完成或停止它。');
  clearAttachment();
  state.current = null;
  state.currentArchived = false;
  state.messages = [];
  state.turn = null;
  state.streamText = '';
  state.input = '';
  state.selectedSkillId = null; state.slashSubmenu = null; setPromptText('');
  reviewDismissed = null;
  sessionStorage.removeItem('lingzhu-live-session');
  sessionStorage.removeItem('lingzhu-live-turn');
  sessionStorage.removeItem('lingzhu-live-input');
  $('session-title').textContent = '新会话';
  error('');
  renderMessages();
  renderTurn();
  setHistory(false);
  $('prompt').focus();
}
async function checkTurn() {
  if (!state.turn) return;
  try {
    const turn = await api(`/api/turns/${state.turn.id}`);
    state.turn = turn; renderTurn(); renderMessages(state.messages);
    if (terminal.has(turn.status)) {
      clearInterval(state.poll); state.poll = null;
      sessionStorage.removeItem('lingzhu-live-turn');
      if (turn.status === 'completed') {
        sessionStorage.removeItem('lingzhu-live-input');
        sessionStorage.removeItem('lingzhu-live-skill'); sessionStorage.removeItem('lingzhu-live-skill-reference');
      } else {
        const failedInput = sessionStorage.getItem('lingzhu-live-input');
        const failedSkill = sessionStorage.getItem('lingzhu-live-skill');
        const failedReference = JSON.parse(sessionStorage.getItem('lingzhu-live-skill-reference') || 'null');
        if (failedInput) { restorePromptDraft(failedInput, failedReference); state.input = failedInput; updateInput(); }
        if (failedSkill) {
          await refreshSkillPicker();
          if (!state.skills.some(item => item.id === failedSkill && item.enabled === true && item.installed !== false && !item.invalid)) error(`原技能“${failedSkill}”已不可用，请检查技能状态后重试。`);
        }
      }
      // Failed turns are persisted as an assistant message in the conversation.
      // Keep the global error area for transport/UI errors only.
      clearAttachment();
      await refreshLists(); await refreshSession();
    }
    return true;
  } catch (e) {
    // The client starts polling just before POST /api/turns to survive a
    // refresh during creation. A 404 in that narrow window is expected.
    if (e.code === 'TURN_NOT_FOUND' && state.turn?.creating) return false;
    error(e.message);
    return false;
  }
}
function renderClarification(turn) {
  const dialog = $('clarification-dialog');
  if (!dialog) return;
  const pending = turn?.status === 'awaiting_clarification' && turn.clarification;
  if (!pending) { if (dialog.open) dialog.close(); return; }
  $('clarification-question').textContent = pending.question;
  const list = $('clarification-options'); list.replaceChildren();
  const selectedIndex = Math.min(Math.max(0, state.clarificationIndex), pending.options.length - 1); state.clarificationIndex = selectedIndex;
  pending.options.forEach((option, index) => {
    const button = addText(list, 'button', '', 'clarification-option'); button.type = 'button'; button.dataset.optionId = option.id;
    button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === selectedIndex));
    addText(button, 'span', String(index + 1), 'clarification-index');
    const copy = addText(button, 'span', '', 'clarification-option-copy'); addText(copy, 'strong', option.label); if (option.description) addText(copy, 'small', option.description);
    button.onclick = () => chooseClarification(option.id);
  });
  if (!dialog.open) dialog.showModal();
  $('clarification-options').querySelectorAll('button')[selectedIndex]?.focus();
}
async function chooseClarification(optionId) {
  if (!state.turn?.id || state.busy) return;
  state.busy = true; renderTurn(); error('');
  try {
    await api(`/api/turns/${encodeURIComponent(state.turn.id)}/clarify`, 'POST', { optionId });
    if ($('clarification-dialog').open) $('clarification-dialog').close();
    await checkTurn();
  } catch (e) { error(e.message); }
  finally { state.busy = false; renderTurn(); }
}
function cancelClarification() {
  if (!state.turn || state.turn.status !== 'awaiting_clarification' || state.busy) return;
  void api(`/api/turns/${encodeURIComponent(state.turn.id)}/cancel`, 'POST', {}).then(checkTurn).catch(e => error(e.message));
}
function watchTurn(turnId) {
  sessionStorage.setItem('lingzhu-live-turn', turnId);
  clearInterval(state.poll); state.poll = setInterval(checkTurn, 1200);
  void checkTurn();
}
function processEvent(event) {
  const payload = event.payload || {}; const turnId = payload.turnId;
  if (turnId && state.turn?.id !== turnId) return;
  if (event.type === 'turn.started') { if (state.turn) state.turn.status = 'running'; renderTurn(); return; }
  if (!state.turn || state.turn.id !== turnId) return;
  if (event.type === 'turn.delta') { state.streamText += typeof payload.text === 'string' ? payload.text : ''; renderMessages(state.messages); return; }
  if (event.type === 'tool.started') { state.turn.tool = payload.name || null; renderTurn(); return; }
  if (event.type === 'tool.finished') { state.turn.tool = null; renderTurn(); return; }
  if (event.type === 'task.plan.updated') { state.turn.plan = payload.plan; renderTurn(); renderMessages(state.messages); return; }
  if (event.type === 'task.structured_plan.updated') { state.turn.structuredPlan = payload.plan; renderTurn(); renderMessages(state.messages); return; }
  if (event.type === 'task.step.updated') {
    state.turn.plan ??= { version: 1, status: 'running', goal: state.input, steps: [] };
    const index = state.turn.plan.steps.findIndex(step => step.id === payload.step?.id);
    if (index >= 0) state.turn.plan.steps[index] = payload.step; else if (payload.step) state.turn.plan.steps.push(payload.step);
    renderTurn(); renderMessages(state.messages); return;
  }
  if (event.type === 'turn.awaiting_approval') { state.turn.status = 'awaiting_approval'; state.turn.approval = payload.approval; renderTurn(); return; }
  if (event.type === 'turn.awaiting_clarification') { state.turn.status = 'awaiting_clarification'; state.turn.clarification = payload.clarification; renderTurn(); renderMessages(state.messages); return; }
  if (event.type === 'turn.completed' || event.type === 'turn.failed') { state.turn.status = payload.status || (event.type === 'turn.completed' ? 'completed' : 'failed'); state.turn.errorCode = payload.errorCode || null; state.turn.errorMessage = payload.errorMessage || null; renderTurn(); void checkTurn(); }
}
function parseSseBlock(block) {
  let id = ''; let data = '';
  for (const line of block.split('\n')) { if (line.startsWith('id:')) id = line.slice(3).trim(); else if (line.startsWith('data:')) data += line.slice(5).trimStart(); }
  if (!data) return;
  try { const event = JSON.parse(data); if (id && id === state.lastEventId) return; if (id) state.lastEventId = id; processEvent(event); } catch { /* Ignore malformed event frames. */ }
}
async function connectEvents() {
  if (state.streamAbort) return;
  const controller = new AbortController(); state.streamAbort = controller;
  try {
    const headers = state.lastEventId ? { 'Last-Event-ID': state.lastEventId } : {};
    const response = await fetch('/api/events', { headers, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`事件连接失败 (${response.status})`);
    updateConnection(true); let buffer = ''; const reader = response.body.getReader(); const decoder = new TextDecoder();
    while (true) { const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }).replace(/\r/g, ''); const blocks = buffer.split('\n\n'); buffer = blocks.pop() || ''; for (const block of blocks) parseSseBlock(block); }
  } catch (e) { if (e.name !== 'AbortError') updateConnection(false); }
  finally { state.streamAbort = null; if (!controller.signal.aborted) { clearTimeout(state.reconnectTimer); state.reconnectTimer = setTimeout(() => void connectEvents(), 900); } }
}
async function send() {
  if (state.turn && ['running', 'awaiting_approval'].includes(state.turn.status)) {
    try { await api(`/api/turns/${state.turn.id}/cancel`, 'POST', {}); await checkTurn(); } catch (e) { error(e.message); }
    return;
  }
  const serialized = serializePrompt(); const input = serialized.text.trim();
  const leadingTrim = serialized.text.length - serialized.text.trimStart().length;
  const skillReference = serialized.skillReference ? { ...serialized.skillReference, offset: Math.max(0, serialized.skillReference.offset - leadingTrim) } : null;
  if (!input || state.busy) return;
  if (input.startsWith('/')) return;
  if (state.currentArchived) return error('归档会话为只读，请先恢复会话再继续。');
  if (state.turn && !terminal.has(state.turn.status)) return;
  if (!state.models.length) return error('请先在模型连接页配置并选用模型。');
  const requestedSkillId = skillReference?.skillId || null;
  if (requestedSkillId) {
    try {
      if (!await refreshSkillPicker()) throw new Error(state.skillsError || '技能列表暂时不可用');
      const selected = state.skills.find(item => item.id === requestedSkillId);
      if (!selected || selected.invalid || selected.enabled !== true || selected.installed === false) throw new Error(`技能“${selected?.name || requestedSkillId}”已不可用，请重新选择技能。`);
      await api(`/api/skills/${encodeURIComponent(requestedSkillId)}/inspect`, 'POST', {});
    } catch (e) { state.selectedSkillId = requestedSkillId; error(`发送前无法验证所选技能：${e.message}`); return; }
  }
  state.busy = true; state.input = input; error(''); renderTurn();
  let turnId;
  try {
    if (!state.current) {
      const session = await api('/api/sessions', 'POST', state.currentProject ? { projectId: state.currentProject.id } : {});
      state.current = session.id;
      state.currentProject = session.project || null;
      renderProjectSelector();
      sessionStorage.setItem('lingzhu-live-session', session.id);
      await refreshLists();
      $('session-title').textContent = session.title || '新会话';
    }
    if (requestedSkillId && !state.skills.some(item => item.id === requestedSkillId && item.enabled === true && item.installed !== false && !item.invalid))
      throw new Error(`技能“${skillReference?.displayName || requestedSkillId}”在发送前已不可用，请重新选择。`);
    turnId = crypto.randomUUID(); sessionStorage.setItem('lingzhu-live-input', input);
    if (requestedSkillId) {
      sessionStorage.setItem('lingzhu-live-skill', requestedSkillId);
      sessionStorage.setItem('lingzhu-live-skill-reference', JSON.stringify(skillReference));
    } else { sessionStorage.removeItem('lingzhu-live-skill'); sessionStorage.removeItem('lingzhu-live-skill-reference'); }
    const sentAttachment = attachment ? { id: attachment.id, name: attachment.name || attachment.localName, mediaType: attachment.mediaType, pages: attachment.pages, partial: attachment.partial, sizeBytes: attachment.sizeBytes || attachment.localSize } : null;
    state.turn = { id: turnId, sessionId: state.current, status: 'starting', creating: true }; state.streamText = ''; setPromptText(''); updateInput(); renderTurn(); renderMessages([...state.messages, { role: 'user', content: input, ...(skillReference ? { skillReference } : {}), ...(sentAttachment ? { attachment: sentAttachment } : {}) }]);
    watchTurn(turnId);
    await api('/api/turns', 'POST', { input, skillId: requestedSkillId, skillReference, attachmentId: attachment?.id, sessionId: state.current, turnId });
    if (state.selectedSkillId === requestedSkillId) state.selectedSkillId = null;
    state.turn.creating = false;
    await checkTurn();
  } catch (e) {
    if (state.turn?.id === turnId) state.turn.creating = false;
    const found = await checkTurn();
    const failedTurn = found && state.turn && terminal.has(state.turn.status) && state.turn.status !== 'completed';
    if ((!found || failedTurn) && e.message) { restorePromptDraft(input, skillReference); updateInput(); error(e.message); }
  } finally { state.busy = false; renderTurn(); }
}
async function retryTurn(turn) {
  if (!turn?.id || state.busy || !['failed', 'cancelled', 'interrupted', 'denied', 'expired'].includes(turn.status)) return;
  state.busy = true; error(''); state.streamText = '';
  try {
    const result = await api(`/api/turns/${encodeURIComponent(turn.id)}/retry`, 'POST', {});
    const nextId = result.turnId;
    if (!nextId) throw new Error('重试未返回新的回合 ID');
    state.input = sessionStorage.getItem('lingzhu-live-input') || state.input;
    state.turn = { id: nextId, sessionId: state.current, status: 'starting', creating: true };
    sessionStorage.setItem('lingzhu-live-turn', nextId);
    watchTurn(nextId); await checkTurn();
  } catch (e) { error(e.message); }
  finally { if (state.turn) state.turn.creating = false; state.busy = false; renderTurn(); renderMessages(state.messages); }
}
async function decide(decision) {
  const approval = state.turn?.approval; if (!approval) return;
  state.busy = true; renderTurn(); error('');
  try {
    const scope = decision === 'approved' && !$('read-scope-option').hidden && $('read-scope').checked ? 'session' : undefined;
    await api(`/api/approvals/${approval.id}`, 'POST', { decision, ...(scope ? { scope } : {}) });
    if (decision === 'approved') {
      await api('/api/turns', 'POST', { input: state.input, attachmentId: attachment?.id, sessionId: state.current, turnId: state.turn.id, approvalId: approval.id });
    }
  } catch (e) { if (e.code !== 'APPROVAL_REQUIRED') error(e.message); }
  finally { state.busy = false; await checkTurn(); }
}

$('new-session').onclick = newSession;
$('project-browse').onclick = () => void chooseProject();
$('project-toggle').onclick = openProjectMenu;
$('project-create').onclick = () => { closeProjectMenu(); void chooseProject(); };
$('project-query').oninput = renderProjectOptions;
document.addEventListener('click', event => { if (!event.target.closest('#project-workspace')) closeProjectMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('project-menu').hidden) { event.preventDefault(); closeProjectMenu({ focus: true }); }
  if ($('project-menu').hidden || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const options = [...$('project-list').querySelectorAll('.project-option')]; if (!options.length) return;
  event.preventDefault(); const current = options.indexOf(document.activeElement);
  const next = event.key === 'ArrowDown' ? Math.min(current + 1, options.length - 1) : Math.max(current < 0 ? options.length - 1 : current - 1, 0);
  options[next]?.focus();
});
function updateInput() { const value = serializePrompt().text; $('message-limit').textContent = `${value.length.toLocaleString('zh-CN')} / 32,000`; renderSlashMenu(); renderTurn(); }
const promptObserver = new MutationObserver(() => { if ($('prompt').querySelectorAll(`.${PROMPT_SKILL_TOKEN}`).length > 1) $('prompt').querySelectorAll(`.${PROMPT_SKILL_TOKEN}`).forEach((token, index) => { if (index) token.remove(); }); });
promptObserver.observe($('prompt'), { childList: true, subtree: true, characterData: true });
for (const type of ['keyup', 'mouseup', 'touchend', 'focus', 'blur']) $('prompt').addEventListener(type, rememberPromptRange);
document.addEventListener('selectionchange', () => { if (selectionInsidePrompt()) rememberPromptRange(); });
$('prompt').addEventListener('paste', event => {
  event.preventDefault();
  const text = event.clipboardData?.getData('text/plain') || '';
  const selection = getSelection();
  if (!selectionInsidePrompt(selection)) return;
  const range = selection.getRangeAt(0); range.deleteContents();
  const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range); rememberPromptRange(); updateInput();
});
for (const type of ['compositionstart', 'compositionend']) $('prompt').addEventListener(type, event => { if (type === 'compositionend') { rememberPromptRange(); updateInput(); } });
function renderTurnDetails() {
  $('turn-details').replaceChildren();
  const turn = state.turn;
  if (!turn) { addText($('turn-details'), 'dt', '状态'); addText($('turn-details'), 'dd', '尚无回合'); return; }
  for (const [key, value] of [['状态', statusText(turn.status)], ['回合 ID', turn.id], ['当前工具', turn.tool || '无'], ['开始时间', turn.createdAt ? new Date(turn.createdAt).toLocaleString('zh-CN') : '正在登记'], ['更新时间', turn.updatedAt ? new Date(turn.updatedAt).toLocaleString('zh-CN') : '正在登记'], ['错误代码', turn.errorCode || '无']]) { addText($('turn-details'), 'dt', key); addText($('turn-details'), 'dd', value); }
}
function renderTools() {
  const query = $('tool-query').value.trim().toLowerCase(); $('tool-list').replaceChildren();
  for (const tool of tools.filter(item => `${item.name} ${item.description || ''}`.toLowerCase().includes(query))) {
    const row = addText($('tool-list'), 'div', '', 'tool-row'); addText(row, 'strong', tool.name); addText(row, 'p', tool.description || '');
    addText(row, 'small', `${tool.executableInTurn ? '当前回合可用' : '目录工具'} · ${({ read: '读取', network: '网络', write: '写入', execute: '执行', message: '消息', admin: '管理', plugin: '插件' })[tool.risk] || tool.risk || '未知'} · ${tool.approval === 'none' ? '无需审批' : '按策略审批'}`);
  }
  if (!$('tool-list').children.length) addText($('tool-list'), 'p', '没有匹配的工具', 'empty-list');
}
$('history-toggle').onclick = () => setHistory(!document.body.classList.contains('history-open'));
$('history-backdrop').onclick = () => setHistory(false);
$('archive-toggle').onclick = async () => {
  if (state.turn && !terminal.has(state.turn.status)) return error('当前回合尚未结束，暂时无法切换归档视图。');
  state.archivedView = !state.archivedView;
  if (state.current) {
    state.current = null; state.currentArchived = false; state.currentProject = null; state.messages = []; state.turn = null;
    sessionStorage.removeItem('lingzhu-live-session'); sessionStorage.removeItem('lingzhu-live-turn'); sessionStorage.removeItem('lingzhu-live-input');
    renderProjectSelector(); renderMessages(); renderTurn();
  }
  try { await refreshLists(); } catch (e) { state.archivedView = !state.archivedView; error(e.message); }
};
document.addEventListener('keydown', event => { if (event.key === 'Escape') { setHistory(false); document.querySelectorAll('.session-menu[open]').forEach(menu => { menu.open = false; }); } });
document.addEventListener('click', event => { document.querySelectorAll('.session-menu[open]').forEach(menu => { if (!menu.contains(event.target)) menu.open = false; }); });
$('search-toggle').onclick = () => { $('session-query').hidden = !$('session-query').hidden; if (!$('session-query').hidden) { if (matchMedia('(max-width:680px)').matches) setHistory(true); $('session-query').focus(); } };
$('session-query').oninput = renderSessions;
$('refresh').onclick = () => refreshLists().then(refreshSession).catch(e => error(e.message));
$('send').onclick = send;
$('skill-picker').onchange = event => {
  const item = state.skills.find(skill => skill.id === event.target.value && !skill.invalid && skill.enabled === true && skill.installed !== false);
  if (item) {
    const editor = $('prompt'); editor.focus();
    if (savedPromptRange) { const selection = getSelection(); selection.removeAllRanges(); selection.addRange(savedPromptRange); }
    insertSkillToken(item);
  }
  event.target.value = '';
};
$('prompt').oninput = () => {
  const wasOpen = !slashMenu.hidden;
  const tokens = $('prompt').querySelectorAll(`.${PROMPT_SKILL_TOKEN}`);
  if (tokens.length > 1) [...tokens].slice(1).forEach(token => token.remove());
  state.selectedSkillId = $('prompt').querySelector(`.${PROMPT_SKILL_TOKEN}`)?.dataset.skillId || null;
  rememberPromptRange();
  updateInput();
  if (!wasOpen && serializePrompt().text.startsWith('/')) void refreshSkillPicker();
};
$('prompt').onkeydown = event => {
  if (event.isComposing || event.keyCode === 229) return;
  const promptText = serializePrompt().text;
  if (!promptText.startsWith('/')) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
    else if (['Backspace', 'Delete'].includes(event.key) && removeSelectedSkillToken()) event.preventDefault();
    else if (event.key === 'Backspace' && removeSkillTokenAtCaret(-1)) event.preventDefault();
    else if (event.key === 'Delete' && removeSkillTokenAtCaret(1)) event.preventDefault();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const rows = availableSlashRows(); if (!rows.length) return;
    const next = state.slashIndex + (event.key === 'ArrowDown' ? 1 : -1);
    setSlashIndex(next < 0 ? rows.length - 1 : next);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const row = availableSlashRows()[state.slashIndex];
    if (row) row.click();
  } else if (event.key === 'Escape' && state.slashSubmenu) {
    event.preventDefault(); state.slashSubmenu = null; state.slashIndex = -1; renderSlashMenu();
  }
};
slashMenu.addEventListener('mousemove', event => { const row = event.target.closest('[role="option"]:not(:disabled)'); if (!row) return; const index = availableSlashRows().indexOf(row); if (index >= 0) setSlashIndex(index); });
slashMenu.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape' && state.slashSubmenu) { event.preventDefault(); state.slashSubmenu = null; state.slashIndex = -1; renderSlashMenu(); $('prompt').focus(); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const rows = availableSlashRows(); if (rows.length) setSlashIndex(state.slashIndex + (event.key === 'ArrowDown' ? 1 : -1)); }
  else if (event.key === 'Enter') { event.preventDefault(); availableSlashRows()[state.slashIndex]?.click(); }
});
window.addEventListener('focus', () => { if (slashMenu.hidden) return; void refreshSkillPicker(); });
window.visualViewport?.addEventListener('resize', positionSlashMenu);
window.addEventListener('resize', positionSlashMenu);
$('approve').onclick = () => decide('approved'); $('deny').onclick = () => decide('denied');
$('clarification-dialog').addEventListener('keydown', event => {
  const options = [...$('clarification-options').querySelectorAll('button')]; if (!options.length) return;
  const current = Math.min(Math.max(0, state.clarificationIndex), options.length - 1);
  if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    event.preventDefault(); const delta = event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1; const next = (current + delta + options.length) % options.length;
    state.clarificationIndex = next; renderClarification(state.turn); options[next]?.focus();
  } else if (event.key === 'Enter') { event.preventDefault(); void chooseClarification(options[current].dataset.optionId); }
  else if (event.key === 'Escape') { event.preventDefault(); cancelClarification(); }
});
$('clarification-close').onclick = cancelClarification;
$('review-close').onclick = () => { reviewDismissed = state.turn?.approval?.id; renderTurn(); };
$('review-open').onclick = () => { reviewDismissed = null; renderTurn(); };
$('export-session').onclick = () => { if (state.current) exportSession(state.current).catch(e => error(e.message)); };
$('tools-toggle').onclick = async () => {
  $('tools-dialog').showModal(); $('tool-list').textContent = '正在加载…';
  try { const result = await api('/api/tools'); tools = result.items; renderTools(); } catch (e) { $('tool-list').textContent = e.message; }
};
$('tool-query').oninput = renderTools;
$('tools-close').onclick = () => $('tools-dialog').close();
$('session-dialog-close').onclick = () => $('session-dialog').close();
$('admin-toggle').onclick = async () => { $('admin-dialog').showModal(); await loadMemory(); };
$('admin-dialog-close').onclick = () => $('admin-dialog').close();
$('memory-tab').onclick = () => { $('memory-tab').classList.add('active'); $('tasks-tab').classList.remove('active'); $('memory-panel').hidden = false; $('tasks-panel').hidden = true; void loadMemory(); };
$('tasks-tab').onclick = () => { $('tasks-tab').classList.add('active'); $('memory-tab').classList.remove('active'); $('memory-panel').hidden = true; $('tasks-panel').hidden = false; void loadTasks(); };
$('memory-query').oninput = () => void loadMemory(); $('memory-candidates').onchange = () => void loadMemory(); $('memory-refresh').onclick = () => void loadMemory(); $('task-refresh').onclick = () => void loadTasks();
async function loadMemory() {
  $('memory-list').textContent = '正在加载…';
  try {
    const query = $('memory-query').value.trim(); const candidates = $('memory-candidates').checked;
    const params = new URLSearchParams(); if (query) params.set('query', query); if (candidates) params.set('includeCandidates', 'true');
    const result = await api(`/api/memory${params.size ? `?${params}` : ''}`); const items = result.items || result; $('memory-list').replaceChildren();
    for (const item of items) {
      const row = addText($('memory-list'), 'div', '', 'admin-row'); addText(row, 'strong', item.content || item.id);
      addText(row, 'small', `${item.scope || '项目'} · ${item.status || 'active'}${item.match?.method ? ` · 命中：${item.match.method}${item.match.score === undefined ? '' : ` ${item.match.score}`}` : ''}${item.provenance?.sourceType ? ` · 来源：${item.provenance.sourceType}` : ''}${item.provenance?.reason ? ` · ${item.provenance.reason}` : ''}${item.updatedAt ? ` · ${formatTime(item.updatedAt)}` : ''}${item.conflictGroup ? ' · 存在同类记录' : ''}`);
      if (item.provenance?.sourceText) addText(row, 'small', `原始表达：${item.provenance.sourceText}`);
      if (item.status === 'candidate') {
        action(row, '通过', '确认记忆', async () => { await api(`/api/memory/${item.id}/review`, 'POST', { decision: 'active' }); await loadMemory(); });
        action(row, '替代旧项', '确认并取代旧记忆', async () => {
          const previousId = prompt('输入要被这条记忆取代的旧记忆 ID'); if (!previousId) return;
          await api(`/api/memory/${item.id}/review`, 'POST', { decision: { status: 'active', supersedesId: previousId } }); await loadMemory();
        });
        action(row, '忽略', '忽略候选记忆', async () => { await api(`/api/memory/${item.id}/review`, 'POST', { decision: 'deleted' }); await loadMemory(); });
      } else if (item.status === 'active') {
        action(row, '历史', '查看记忆历史', async () => {
          const history = await api(`/api/memory/${item.id}/history`); const choices = history.map(version => `${version.versionNo}: ${version.action} · ${version.content}`).join('\n');
          const selected = prompt(`记忆历史\n${choices}\n\n输入要恢复的版本号，取消则不恢复`); if (!selected) return;
          const versionNo = Number(selected); if (!Number.isSafeInteger(versionNo) || versionNo < 1) throw new Error('版本号无效');
          await api(`/api/memory/${item.id}/restore`, 'POST', { versionNo }); await loadMemory();
        });
        action(row, '编辑', '更新记忆', async () => { const content = prompt('编辑记忆内容', item.content); if (content === null || !content.trim()) return; await api(`/api/memory/${item.id}`, 'PATCH', { content }); await loadMemory(); });
        action(row, '删除', '删除记忆', async () => { if (!confirm('删除这条记忆？')) return; await api(`/api/memory/${item.id}/delete`, 'POST', {}); await loadMemory(); });
      }
    }
    if (!items.length) addText($('memory-list'), 'p', candidates ? '暂无待审核记忆' : '暂无记忆', 'empty-list');
  } catch (e) { $('memory-list').textContent = e.message; }
}
async function loadTasks() {
  $('task-list').textContent = '正在加载…';
  try { const result = await api('/api/tasks'); $('task-list').replaceChildren(); for (const task of result) { const row = addText($('task-list'), 'div', '', 'admin-row'); addText(row, 'strong', task.name); addText(row, 'small', `${task.status} · ${task.enabled ? '已启用' : '已停用'}`); if (task.enabled && task.status === 'scheduled') action(row, '运行', '运行任务', async () => { try { await api(`/api/tasks/${task.id}/run`, 'POST', {}); notify('任务已开始运行'); } catch (e) { error(e.message); } await loadTasks(); }); } if (!result.length) addText($('task-list'), 'p', '暂无任务', 'empty-list'); } catch (e) { $('task-list').textContent = e.message; }
}
function modelFormData() {
  const form = $('model-form');
  const data = { name: form.elements.name.value, model: form.elements.model.value, url: form.elements.url.value, fullUrl: form.elements.fullUrl.checked, reasoningEffort: form.elements.reasoningEffort.value, streaming: form.elements.streaming.checked };
  if (form.elements.apiKey.value) data.apiKey = form.elements.apiKey.value;
  return data;
}
function modelFeedback(message, failed = false) { $('model-feedback').textContent = message; $('model-feedback').classList.toggle('model-feedback-error', failed); }
function renderModelCatalog() {
  const list = $('model-list'); list.replaceChildren();
  for (const item of modelCatalog.items) {
    const row = addText(list, 'button', '', `model-dialog-item${item.id === editingModel ? ' active' : ''}`); row.type = 'button'; row.setAttribute('aria-label', `编辑模型 ${item.name}`);
    addText(row, 'strong', item.name); addText(row, 'small', `${item.model}${item.reasoningEffort && !['auto', 'default'].includes(item.reasoningEffort) ? ` · ${item.reasoningProfile?.options.find(option => option.value === item.reasoningEffort)?.label || item.reasoningEffort}` : ''}${item.id === modelCatalog.selectedId ? ' · 当前使用' : ''}`);
    row.onclick = () => openModelEditor(item.id);
  }
  if (!list.children.length) addText(list, 'p', '暂无模型连接', 'empty-list');
  $('model-delete').disabled = !editingModel || modelTesting;
  $('model-test').disabled = modelTesting;
}
function openModelEditor(id) {
  editingModel = id;
  const form = $('model-form'); form.reset(); form.elements.streaming.checked = true;
  const item = modelCatalog.items.find(value => value.id === id);
  if (item) { form.elements.name.value = item.name; form.elements.model.value = item.model; form.elements.url.value = item.url; form.elements.fullUrl.checked = item.fullUrl === true; renderReasoningOptions(form.elements.reasoningEffort, item.reasoningProfile, item.reasoningEffort || 'default'); form.elements.streaming.checked = item.streaming !== false; }
  else renderReasoningOptions(form.elements.reasoningEffort, null);
  $('model-form-title').textContent = item ? '编辑模型连接' : '新增模型连接'; $('model-key-state').textContent = item?.hasKey ? '已配置，留空表示保留' : '';
  modelFeedback(''); renderModelCatalog();
}
async function refreshModelCatalog() { modelCatalog = await api('/api/models'); if (!editingModel) editingModel = modelCatalog.selectedId || modelCatalog.items[0]?.id || null; openModelEditor(editingModel); }
async function openModelSettings() { $('model-dialog').showModal(); try { await refreshModelCatalog(); } catch (e) { modelFeedback(e.message, true); } }
$('model-settings').onclick = openModelSettings;
$('model-dialog-close').onclick = () => $('model-dialog').close();
$('model-new').onclick = () => openModelEditor(null);
$('model-form').onsubmit = async event => { event.preventDefault(); try { const result = await api(editingModel ? `/api/models/${editingModel}` : '/api/models', editingModel ? 'PUT' : 'POST', modelFormData()); modelCatalog = result; editingModel = editingModel || result.items.at(-1)?.id; $('model-form').elements.apiKey.value = ''; openModelEditor(editingModel); await refreshLists(); modelFeedback('模型连接已保存'); notify('模型连接已保存'); } catch (e) { modelFeedback(e.message, true); } };
$('model-test').onclick = async () => { if (modelTesting) return; modelTesting = true; renderModelCatalog(); modelFeedback('正在测试连接…'); try { const result = await api('/api/models/test', 'POST', { ...modelFormData(), ...(editingModel ? { id: editingModel } : {}) }); modelFeedback(result.ok ? `连接成功，耗时 ${result.elapsedMs} ms；未修改配置` : `${result.message}（${result.code}）`, !result.ok); } catch (e) { modelFeedback(e.message, true); } finally { modelTesting = false; renderModelCatalog(); } };
$('model-delete').onclick = async () => { if (!editingModel || !window.confirm('确定删除这个模型连接吗？')) return; try { modelCatalog = await api(`/api/models/${editingModel}`, 'DELETE', {}); editingModel = modelCatalog.selectedId || null; openModelEditor(editingModel); await refreshLists(); modelFeedback('模型连接已删除'); } catch (e) { modelFeedback(e.message, true); } };
function formatBytes(bytes) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`; return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`; }
function attachmentIcon(name) { const extension = String(name).split('.').pop()?.toLowerCase(); return extension === 'pdf' ? 'PDF' : ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cs', 'go', 'rs', 'sql'].includes(extension) ? 'CODE' : 'TXT'; }
function updateAttachmentCard(card, icon, name, meta, url) {
  card.hidden = !name;
  if (!name) return;
  card.href = url || '#';
  card.querySelector('.attachment-file-icon').textContent = icon;
  card.querySelector('.attachment-card-copy strong').textContent = name;
  card.querySelector('.attachment-card-copy small').textContent = meta;
}
function setLocalAttachmentFile(file) {
  if (attachment?.url) URL.revokeObjectURL(attachment.url);
  if (!file) { attachment = null; updateAttachmentCard($('attachment-selected-card'), '', '', '', ''); return; }
  const url = URL.createObjectURL(file);
  attachment = { file, url, localName: file.name, localSize: file.size, localType: file.type };
  $('attachment-file-name').textContent = `${file.name} · ${formatBytes(file.size)}`;
  updateAttachmentCard($('attachment-selected-card'), attachmentIcon(file.name), file.name, `${formatBytes(file.size)} · 点击打开原文件`, url);
  $('attachment-preview').disabled = false;
  $('attachment-upload-status').textContent = '准备上传到本地 Gateway，上传后会附加到下一条消息。';
}
function clearAttachment() {
  if (attachment?.url) URL.revokeObjectURL(attachment.url);
  attachment = null;
  $('attachment-bar').hidden = true;
  $('attachment-label').textContent = '';
  $('attachment-meta').textContent = '点击打开文件';
  $('attachment-card').removeAttribute('href');
  $('attachment-icon').textContent = 'FILE';
  $('attachment-file').value = '';
  $('attachment-file-name').textContent = '尚未选择文件';
  updateAttachmentCard($('attachment-selected-card'), '', '', '', '');
  $('attachment-preview').disabled = true;
  $('attachment-upload-status').textContent = '文件会在本地 Gateway 中校验和暂存，不会写入项目目录。';
}
function selectedAttachmentFile() { return $('attachment-file').files?.[0] || null; }
function showSelectedAttachment(file) {
  setLocalAttachmentFile(file);
}
async function uploadAttachment() {
  const file = selectedAttachmentFile(); if (!file) return;
  const button = $('attachment-preview'); button.disabled = true; button.textContent = '校验中…'; $('attachment-upload-status').textContent = '正在上传并提取文本，请稍候…';
  try {
    const response = await fetch('/api/attachments/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Agent-File-Name': encodeURIComponent(file.name) }, body: file });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || `上传失败 (${response.status})`), result);
    attachment = { ...attachment, id: result.id, name: result.name, sizeBytes: result.sizeBytes, mediaType: result.mediaType, pages: result.pages, partial: result.partial };
    $('attachment-label').textContent = `${result.name} · ${formatBytes(result.sizeBytes)}${result.pages ? ` · ${result.pages} 页` : ''}`;
    $('attachment-icon').textContent = attachmentIcon(result.name);
    $('attachment-card').href = attachment.url;
    $('attachment-meta').textContent = `${formatBytes(result.sizeBytes)} · 点击打开原文件`;
    $('attachment-bar').hidden = false;
    $('attachment-upload-status').textContent = result.partial ? '已添加，内容较长，仅提取了部分文本。' : '已添加到下一条消息。';
    $('attachment-dialog').close(); notify('附件已添加');
  } catch (e) { $('attachment-upload-status').textContent = e.message || '附件上传失败'; }
  finally { button.textContent = '上传并添加'; button.disabled = !attachment?.file; }
}
$('attachment-toggle').onclick = () => { $('attachment-dialog').showModal(); $('attachment-file').focus(); };
$('attachment-dialog-close').onclick = () => $('attachment-dialog').close();
$('attachment-cancel').onclick = () => $('attachment-dialog').close();
$('attachment-file').onchange = () => showSelectedAttachment(selectedAttachmentFile());
$('attachment-preview').onclick = () => void uploadAttachment();
$('attachment-clear').onclick = clearAttachment;
$('attachment-dropzone').ondragover = event => { event.preventDefault(); $('attachment-dropzone').classList.add('dragover'); };
$('attachment-dropzone').ondragleave = () => $('attachment-dropzone').classList.remove('dragover');
$('attachment-dropzone').ondrop = event => { event.preventDefault(); $('attachment-dropzone').classList.remove('dragover'); const file = event.dataTransfer.files?.[0]; if (!file) return; const transfer = new DataTransfer(); transfer.items.add(file); $('attachment-file').files = transfer.files; showSelectedAttachment(file); };
$('attachment-dropzone').onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('attachment-file').click(); } };
$('model-select').onchange = async event => { try { await api(`/api/models/${event.target.value}/select`, 'POST', {}); await refreshLists(); } catch (e) { error(e.message); } };
$('reasoning-select').onchange = async event => {
  const model = state.models.find(item => item.id === $('model-select').value);
  if (!model) return;
  try {
    await api(`/api/models/${model.id}`, 'PUT', { name: model.name, model: model.model, url: model.url, fullUrl: model.fullUrl === true, streaming: model.streaming !== false, reasoningEffort: event.target.value });
    await refreshLists(); notify(`思考强度已设为${({ auto: '自动', none: '关闭', low: '低', medium: '中', high: '高' })[event.target.value]}`);
  } catch (e) { event.target.value = model.reasoningEffort || 'default'; error(e.message); }
};
$('details-toggle').onclick = () => { const dl = $('diagnostics'); dl.replaceChildren(); for (const [key, value] of [['Node', state.diagnostics?.node], ['平台', state.diagnostics?.platform], ['安全模式', state.diagnostics?.securityMode?.effective ?? state.diagnostics?.securityMode?.requested], ['隔离进程', state.diagnostics?.worker?.available ? '可用' : '不可用'], ['审计', state.diagnostics?.audit?.available ? '可用' : '不可用']]) { addText(dl, 'dt', key); addText(dl, 'dd', value ?? '未知'); } renderTurnDetails(); $('details').showModal(); };
$('details-close').onclick = () => $('details').close();

(async () => {
  try {
    await refreshLists();
    const saved = sessionStorage.getItem('lingzhu-live-session');
    const turnId = sessionStorage.getItem('lingzhu-live-turn');
    let activeTurn = null;
    if (turnId && state.sessions.some(item => item.id === saved)) {
      try { activeTurn = await api(`/api/turns/${turnId}`); } catch { activeTurn = null; }
    }
    if (activeTurn) await selectSession(saved);
    else {
      state.current = null;
      state.messages = [];
      sessionStorage.removeItem('lingzhu-live-session');
      sessionStorage.removeItem('lingzhu-live-turn');
      sessionStorage.removeItem('lingzhu-live-input');
      renderMessages();
    }
    if (activeTurn && state.current) {
      state.input = sessionStorage.getItem('lingzhu-live-input') || '';
      state.turn = activeTurn;
      renderMessages(state.messages);
      if (!terminal.has(activeTurn.status)) watchTurn(turnId);
    }
    renderTurn(); void connectEvents();
    const params = new URLSearchParams(location.search);
    const requestedSkill = params.get('skill');
    const requestedPrompt = params.get('prompt');
    if (requestedPrompt) setPromptText(requestedPrompt);
    if (requestedSkill) {
      await refreshSkillPicker();
      const picker = $('skill-picker');
      if ([...picker.options].some(option => option.value === requestedSkill)) { const item = state.skills.find(skill => skill.id === requestedSkill); insertSkillToken(item); }
      else error(`技能“${requestedSkill}”不存在、未安装或已停用。`);
      if (requestedPrompt) { updateInput(); pendingSkillPrompt = requestedPrompt; history.replaceState(null, '', '/'); void send(); }
    } else if (requestedPrompt) { updateInput(); history.replaceState(null, '', '/'); void send(); }
  } catch (e) { $('connection-label').textContent = 'Gateway 不可用'; $('connection-dot').classList.add('warning'); error(e.message); renderMessages(); }
})();

const networkCanvas = $('network-canvas');
const networkContext = networkCanvas.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let networkNodes = [];
let networkFrame;
function resizeNetwork() {
  const { width, height } = networkCanvas.getBoundingClientRect();
  const scale = Math.min(devicePixelRatio || 1, 2);
  networkCanvas.width = Math.max(1, Math.round(width * scale));
  networkCanvas.height = Math.max(1, Math.round(height * scale));
  networkContext.setTransform(scale, 0, 0, scale, 0, 0);
  networkNodes = Array.from({ length: Math.min(46, Math.max(22, Math.round(width / 28))) }, (_, index) => ({
    x: (index * 83) % Math.max(width, 1),
    y: 90 + (index * 47) % Math.max(height - 110, 1),
    vx: (index % 2 ? 1 : -1) * (0.025 + index % 4 * 0.009),
    vy: (index % 3 ? -1 : 1) * (0.018 + index % 5 * 0.006),
    phase: index * 0.7,
  }));
  if (reducedMotion.matches) drawNetwork(0);
}
function drawNetwork(time) {
  const { width, height } = networkCanvas.getBoundingClientRect();
  networkContext.clearRect(0, 0, width, height);
  for (const node of networkNodes) {
    if (!reducedMotion.matches) {
      node.x += node.vx; node.y += node.vy;
      if (node.x < 0 || node.x > width) node.vx *= -1;
      if (node.y < 65 || node.y > height - 30) node.vy *= -1;
    }
  }
  for (let i = 0; i < networkNodes.length; i++) {
    for (let j = i + 1; j < networkNodes.length; j++) {
      const a = networkNodes[i], b = networkNodes[j];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance > 118) continue;
      networkContext.strokeStyle = `rgba(75, 194, 190, ${(1 - distance / 118) * 0.15})`;
      networkContext.beginPath(); networkContext.moveTo(a.x, a.y); networkContext.lineTo(b.x, b.y); networkContext.stroke();
    }
  }
  for (const node of networkNodes) {
    const pulse = 1 + Math.sin(time / 850 + node.phase) * 0.6;
    networkContext.fillStyle = `rgba(99, 224, 211, ${0.22 + pulse * 0.05})`;
    networkContext.beginPath(); networkContext.arc(node.x, node.y, 1.3 * pulse, 0, Math.PI * 2); networkContext.fill();
  }
  if (!reducedMotion.matches) networkFrame = requestAnimationFrame(drawNetwork);
}
function updateNetworkMotion() {
  cancelAnimationFrame(networkFrame);
  resizeNetwork();
  if (!reducedMotion.matches) networkFrame = requestAnimationFrame(drawNetwork);
}
new ResizeObserver(resizeNetwork).observe(document.querySelector('.main'));
reducedMotion.addEventListener('change', updateNetworkMotion);
updateNetworkMotion();
