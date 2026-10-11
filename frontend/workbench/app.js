const panel = document.getElementById('review-panel');
const toast = document.getElementById('toast');
const conversation = document.getElementById('conversation-column');
const conversationScroll = document.getElementById('conversation-scroll');
const reviewEmpty = document.getElementById('review-empty');
const searchDialog = document.getElementById('search-dialog');
const searchInput = document.getElementById('session-search');
const searchResults = document.getElementById('search-results');
const appShell = document.querySelector('.app-shell');
const sidebarToggle = document.getElementById('sidebar-toggle');
const workspaceSwitcher = document.getElementById('workspace-switcher');
const workspaceMenu = document.getElementById('workspace-menu');
const modelPicker = document.getElementById('model-picker');
const modelMenu = document.getElementById('model-menu');
const actionsButton = document.getElementById('more-actions');
const actionsMenu = document.getElementById('actions-menu');
const settingsButton = document.getElementById('settings-button');
const settingsDialog = document.getElementById('settings-dialog');
const detailsDialog = document.getElementById('details-dialog');
const attachmentInput = document.getElementById('attachment-input');
const settingMotion = document.getElementById('setting-motion');
const settingCompact = document.getElementById('setting-compact');
const settingAutoReview = document.getElementById('setting-auto-review');
const storageKey = 'lingzhu-prototype-sessions-v1';
const activeSessionKey = 'lingzhu-prototype-active-session-v1';
const shellStateKey = 'lingzhu-prototype-shell-v1';
const scenarioParam = new URLSearchParams(window.location.search).get('scenario');
const testScenario = ['failure', 'success', 'approval', 'empty'].includes(scenarioParam) ? scenarioParam : null;
const isDemoScenario = testScenario !== null;
let toastTimer;
const transitionTimers = new Map();
let activeSessionId;
let selectedModel = { name: 'GPT-4.1', provider: 'OpenAI' };

function loadShellState() {
  try {
    return JSON.parse(localStorage.getItem(shellStateKey)) || {};
  } catch {
    return {};
  }
}

function saveShellState() {
  try {
    localStorage.setItem(shellStateKey, JSON.stringify({
      sidebarCollapsed: appShell.classList.contains('sidebar-collapsed'),
      motion: settingMotion.checked,
      compact: settingCompact.checked,
      autoReview: settingAutoReview.checked,
      model: selectedModel,
    }));
  } catch {
    notify('界面偏好无法保存，本次预览仍可继续使用');
  }
}

function applyShellState() {
  const state = loadShellState();
  const shellState = isDemoScenario ? {} : state;
  const sidebarCollapsed = shellState.sidebarCollapsed === true;
  appShell.classList.toggle('sidebar-collapsed', sidebarCollapsed);
  sidebarToggle.textContent = sidebarCollapsed ? '›' : '‹';
  sidebarToggle.setAttribute('aria-label', sidebarCollapsed ? '展开侧边栏' : '收起侧边栏');
  sidebarToggle.title = sidebarCollapsed ? '展开侧边栏' : '收起侧边栏';
  settingMotion.checked = shellState.motion !== false;
  settingCompact.checked = shellState.compact === true;
  settingAutoReview.checked = isDemoScenario ? true : shellState.autoReview !== false;
  selectedModel = shellState.model?.name ? shellState.model : selectedModel;
  appShell.classList.toggle('no-motion', !settingMotion.checked);
  appShell.classList.toggle('compact-trace', settingCompact.checked);
  updateModelLabel();
}

function updateModelLabel() {
  document.querySelector('.model-name-label').textContent = selectedModel.name;
  document.querySelector('.model-provider').textContent = selectedModel.provider;
  document.getElementById('telemetry-model').textContent = selectedModel.name;
}

function closeFloatingMenus() {
  [workspaceMenu, modelMenu, actionsMenu].forEach(menu => {
    menu.hidden = true;
  });
  [workspaceSwitcher, modelPicker, actionsButton].forEach(button => button?.setAttribute('aria-expanded', 'false'));
}

function openFloatingMenu(menu, anchor) {
  const isOpen = !menu.hidden;
  closeFloatingMenus();
  if (isOpen) return;
  const bounds = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${Math.round(bounds.bottom + 7)}px`;
  menu.style.left = `${Math.round(Math.min(bounds.left, window.innerWidth - menu.offsetWidth - 14))}px`;
  anchor.setAttribute('aria-expanded', 'true');
}

const networkCanvas = document.getElementById('network-canvas');
const networkContext = networkCanvas.getContext('2d');
const neuralReadout = document.getElementById('neural-readout');
const latencyReadout = document.getElementById('latency-readout');
let nodes = [];

function resizeNetwork() {
  const bounds = networkCanvas.getBoundingClientRect();
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  networkCanvas.width = Math.max(1, Math.round(bounds.width * scale));
  networkCanvas.height = Math.max(1, Math.round(bounds.height * scale));
  networkContext.setTransform(scale, 0, 0, scale, 0, 0);
  const count = Math.min(46, Math.max(22, Math.round(bounds.width / 28)));
  nodes = Array.from({ length: count }, (_, index) => ({
    x: (index * 83) % Math.max(bounds.width, 1),
    y: 90 + ((index * 47) % Math.max(bounds.height - 110, 1)),
    vx: (index % 2 ? 1 : -1) * (0.025 + (index % 4) * 0.009),
    vy: (index % 3 ? -1 : 1) * (0.018 + (index % 5) * 0.006),
    phase: index * 0.7,
  }));
}

function drawNetwork(time) {
  const bounds = networkCanvas.getBoundingClientRect();
  networkContext.clearRect(0, 0, bounds.width, bounds.height);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const node of nodes) {
    if (!reduced) {
      node.x += node.vx;
      node.y += node.vy;
      if (node.x < 0 || node.x > bounds.width) node.vx *= -1;
      if (node.y < 65 || node.y > bounds.height - 30) node.vy *= -1;
    }
  }
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]; const b = nodes[j];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance > 118) continue;
      networkContext.strokeStyle = `rgba(75, 194, 190, ${(1 - distance / 118) * 0.15})`;
      networkContext.lineWidth = 1;
      networkContext.beginPath(); networkContext.moveTo(a.x, a.y); networkContext.lineTo(b.x, b.y); networkContext.stroke();
    }
  }
  for (const node of nodes) {
    const pulse = 1 + Math.sin(time / 850 + node.phase) * 0.6;
    networkContext.fillStyle = `rgba(99, 224, 211, ${0.22 + pulse * 0.05})`;
    networkContext.beginPath(); networkContext.arc(node.x, node.y, 1.3 * pulse, 0, Math.PI * 2); networkContext.fill();
  }
  if (!reduced) requestAnimationFrame(drawNetwork);
}

resizeNetwork();
requestAnimationFrame(drawNetwork);
window.addEventListener('resize', resizeNetwork);
setInterval(() => {
  neuralReadout.textContent = `${(97.8 + Math.random() * 1.9).toFixed(1)}%`;
  latencyReadout.textContent = `${String(Math.round(38 + Math.random() * 15)).padStart(3, '0')} ms`;
}, 1600);

function notify(message) {
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2400);
}

function createSession() {
  return {
    id: crypto.randomUUID(),
    title: '新建会话',
    status: 'idle',
    messages: [],
    createdAt: Date.now(),
  };
}

function seedSession() {
  return {
    id: crypto.randomUUID(),
    title: '检查会话保存逻辑',
    status: 'approval',
    createdAt: Date.now() - 60_000,
    messages: [
      { role: 'user', text: '检查项目中的会话保存逻辑，并给出改进方案。', time: '12:18' },
      {
        role: 'assistant',
        text: '我会先追踪会话的读取与写入路径，再检查并发保存时是否存在覆盖风险。',
        steps: [
          { title: '读取会话模块', detail: 'backend/sessions.js', tool: '文件读取', duration: '0.3 秒', status: 'done' },
          { title: '检查保存与分支逻辑', detail: '3 个相关模块', tool: '代码分析', duration: '1.2 秒', status: 'done' },
          { title: '准备修改保存逻辑', detail: 'backend/sessions.js', tool: '写入文件', duration: '等待确认', status: 'waiting' },
        ],
        approval: true,
      },
    ],
  };
}

function loadSessions() {
  // Demo URLs are deterministic visual fixtures; never mix them with saved sessions.
  if (testScenario === 'empty') return [createSession()];
  if (testScenario === 'success') {
    return [{ ...createSession(), title: '成功流程测试', status: 'done', messages: [{ role: 'user', text: '请汇总本周的项目进展。', time: '12:18' }, { role: 'assistant', text: '本周项目进展已整理完成，所有步骤均已成功。', state: 'done' }] }];
  }
  if (testScenario === 'failure') {
    return [{ ...createSession(), title: '失败与重试测试', status: 'failed', messages: [{ role: 'user', text: '尝试读取一个暂时不可用的文件。', time: '12:18' }, { role: 'assistant', text: '读取 workspace/temporarily-missing.md 失败：模拟的文件读取错误。', state: 'failed', retry: true }] }];
  }
  if (testScenario === 'approval') return [seedSession()];
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    try { localStorage.removeItem(storageKey); } catch {}
  }
  return [seedSession()];
}

let sessions = loadSessions();
activeSessionId = sessions[0].id;
if (!testScenario) {
  try {
    const savedActiveId = localStorage.getItem(activeSessionKey);
    if (sessions.some(session => session.id === savedActiveId)) activeSessionId = savedActiveId;
  } catch {}
}

function activeSession() {
  return sessions.find(session => session.id === activeSessionId);
}

function saveSessions() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(sessions.slice(0, 30)));
    localStorage.setItem(activeSessionKey, activeSessionId);
  } catch {
    notify('浏览器存储不可用，会话仅保留到本次预览结束');
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function currentTime() {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

function statusLabel(status) {
  return ({ idle: '空闲', running: '正在执行', approval: '等待确认', done: '已完成', failed: '执行失败', cancelled: '已取消' })[status] || '空闲';
}

function renderSidebar() {
  const list = document.querySelector('.session-section');
  const label = list.querySelector('.section-label');
  list.replaceChildren(label);
  for (const session of sessions.slice(0, 12)) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `session-item${session.id === activeSessionId ? ' active' : ''}`;
    item.dataset.sessionId = session.id;
    const mark = document.createElement('span');
    mark.className = `session-mark${['running', 'approval'].includes(session.status) ? ' running' : ''}${session.status === 'failed' ? ' failed' : ''}`;
    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = session.title;
    const time = document.createElement('span');
    time.className = 'session-time';
    time.textContent = session.id === activeSessionId ? statusLabel(session.status) : '';
    item.append(mark, title, time);
    item.addEventListener('click', () => selectSession(session.id));
    list.append(item);
  }
}

function renderStep(step, index) {
  const waiting = step.status === 'waiting';
  const failed = step.status === 'failed';
  const done = step.status === 'done';
  return `<div class="trace-step ${waiting ? 'waiting' : ''} ${failed ? 'failed' : ''} ${done ? 'done' : ''}">
    <span class="trace-node">${done ? '<span>✓</span>' : failed ? '<span>!</span>' : '<span class="node-core"></span>'}</span>
    <div class="trace-copy"><div class="trace-heading"><strong>${escapeHTML(step.title)}</strong><span class="trace-duration">${escapeHTML(step.duration || (waiting ? '进行中' : ''))}</span></div>
    <div class="trace-subline"><span class="tool-token ${waiting ? 'warning-token' : ''}">${escapeHTML(step.tool || '任务执行')}</span><code>${escapeHTML(step.detail || '')}</code>${index < 2 ? `<button class="trace-expand" type="button" aria-label="${escapeHTML(step.title)}">⌄</button>` : ''}</div></div>
  </div>`;
}

function renderMessage(message) {
  if (message.role === 'user') {
    return `<article class="message user-message"><div class="message-avatar user-avatar">林</div><div class="message-content"><div class="message-meta"><strong>你</strong><span>${escapeHTML(message.time || '')}</span></div><p>${escapeHTML(message.text)}</p></div></article>`;
  }
  const running = message.state === 'running';
  const waiting = message.approval;
  const steps = message.steps?.length
    ? `<div class="execution-trace"><div class="trace-line"></div>${message.steps.map(renderStep).join('')}</div>`
    : '';
  const approval = waiting
    ? '<div class="approval-inline"><div class="approval-inline-icon">!</div><div class="approval-inline-copy"><strong>需要你的确认</strong><span>灵珠准备修改示例文件；此原型不会写入真实文件。</span></div><button class="review-button" id="focus-review" type="button">检查变更 <span>↗</span></button></div>'
    : '';
  const actions = running
    ? '<button class="state-action cancel-action" type="button" data-action="cancel">停止任务</button>'
    : message.retry
      ? '<button class="state-action retry-action" type="button" data-action="retry">重试</button>'
      : '';
  const dotClass = waiting ? 'waiting' : message.state || '';
  return `<article class="message assistant-message"><div class="message-avatar assistant-avatar"><span class="mini-orb"></span></div><div class="message-content">
    <div class="message-meta"><strong>灵珠</strong>${running ? '<span class="live-label"><span></span>正在执行</span>' : ''}</div>
    <p>${escapeHTML(message.text)}</p>${steps}${approval}
    <div class="assistant-foot"><span class="response-state ${dotClass}"><span></span>${escapeHTML(message.statusText || statusLabel(running ? 'running' : waiting ? 'approval' : message.state || 'done'))}</span>${actions}<button class="subtle-action copy-action" type="button" aria-label="复制回答" title="复制回答">▢</button></div>
  </div></article>`;
}

function renderReview(session) {
  const pending = session.status === 'approval';
  document.querySelector('.app-shell').classList.toggle('review-hidden', !pending || !settingAutoReview.checked);
  const reviewContent = document.querySelectorAll('.review-summary, .file-heading, .diff-toolbar, .diff-code, .review-explanation, .review-actions');
  reviewContent.forEach(element => { element.hidden = !pending; });
  reviewEmpty.hidden = pending;
  panel.classList.toggle('collapsed', !pending);
  if (!pending) return;
  const approve = document.getElementById('approve-change');
  approve.innerHTML = '<span>✓</span>批准并继续';
}

function render() {
  const session = activeSession();
  if (!session) return;
  document.querySelector('.breadcrumb strong').textContent = session.title;
  document.querySelector('.breadcrumb .unsaved-dot').hidden = session.messages.length === 0;
  document.querySelector('.turn-id code').textContent = session.messages.at(-1)?.time || '—';
  renderSidebar();
  if (!session.messages.length) {
    conversation.innerHTML = `<div class="date-rule"><span>新会话</span></div><section class="empty-state"><div class="empty-orbit"><span></span><i></i></div><h1>从一个任务开始</h1><p>描述你希望灵珠处理的事情。</p><div class="suggestion-list"><button type="button" data-prompt="分析当前项目结构，并指出最值得优先处理的问题。">分析当前项目结构 <span>↗</span></button><button type="button" data-prompt="帮我整理本周的项目进展。">整理项目进展 <span>↗</span></button><button type="button" data-prompt="检查项目中的测试，并总结失败原因。">检查测试结果 <span>↗</span></button></div></section>${renderComposer(session)}`;
  } else {
    conversation.innerHTML = `<div class="date-rule"><span>今天 · ${escapeHTML(session.messages[0].time || currentTime())}</span></div>${session.messages.map(renderMessage).join('')}${renderComposer(session)}`;
  }
  renderReview(session);
  bindConversationActions();
}

function renderComposer(session) {
  const running = session.status === 'running';
  const locked = running || session.status === 'approval';
  return `<div class="composer-wrap"><div class="composer-toolbar"><span class="context-chip"><span class="context-dot"></span>工作区工具已启用</span><span class="composer-spacer"></span><span class="context-meter">上下文 <strong>${Math.min(18 + session.messages.length * 3, 92)}%</strong></span><button class="icon-button tiny" type="button" aria-label="输入选项">⌄</button></div>
    <div class="composer"><button class="attach-button" type="button" aria-label="添加附件" title="添加附件" ${locked ? 'disabled' : ''}>＋</button><textarea rows="1" aria-label="发送给灵珠的消息" placeholder="${session.status === 'approval' ? '请先处理待确认的操作…' : '给灵珠发送消息…'}" ${locked ? 'disabled' : ''}></textarea><div class="composer-end"><span class="enter-hint">Enter 发送 · Shift Enter 换行</span><button class="send-button" type="button" aria-label="${running ? '停止任务' : '发送消息'}" title="${running ? '停止任务' : '发送消息'}" ${session.status === 'approval' ? 'disabled' : ''}>${running ? '■' : '<span>↑</span>'}</button></div></div><div class="composer-note">${session.status === 'approval' ? '先检查待确认的操作，再决定是否继续。' : '此界面为交互原型；任务与审批均为模拟操作。'}</div></div>`;
}

function clearTransition() {
  clearTimeout(transitionTimers.get(activeSessionId));
  transitionTimers.delete(activeSessionId);
}

function scheduleTransition(sessionId, callback, delay) {
  clearTimeout(transitionTimers.get(sessionId));
  const timer = setTimeout(() => {
    transitionTimers.delete(sessionId);
    callback();
  }, delay);
  transitionTimers.set(sessionId, timer);
}

function selectSession(id) {
  activeSessionId = id;
  saveSessions();
  render();
  conversationScroll.scrollTop = conversationScroll.scrollHeight;
}

function newSession() {
  const session = createSession();
  sessions.unshift(session);
  activeSessionId = session.id;
  saveSessions();
  render();
  conversation.querySelector('textarea')?.focus();
  notify('已创建新会话');
}

function submitMessage(text) {
  const content = text.trim();
  const session = activeSession();
  if (!content || !session || session.status === 'running' || session.status === 'approval') return;
  session.messages.push({ role: 'user', text: content, time: currentTime() });
  if (session.messages.length === 1 || session.title === '新建会话') session.title = content.slice(0, 24);
  session.status = 'running';
  session.messages.push({
    role: 'assistant',
    text: '收到。我会先梳理任务，再检查相关内容。',
    state: 'running',
    statusText: '正在读取工作区',
    steps: [
      { title: '梳理任务与范围', detail: '理解你的请求', tool: '任务分析', duration: '进行中', status: 'running' },
      { title: '检查相关内容', detail: '等待开始', tool: '工作区读取', duration: '排队中', status: 'queued' },
    ],
  });
  saveSessions();
  render();
  scheduleTransition(session.id, () => runAnalysis(session.id), 750);
}

function runAnalysis(sessionId) {
  const session = sessions.find(item => item.id === sessionId);
  if (!session || session.status !== 'running') return;
  const assistant = session.messages.at(-1);
  if (testScenario === 'failure' && !session.retrying) {
    session.status = 'failed';
    assistant.text = '读取 workspace/temporarily-missing.md 失败：模拟的文件读取错误。';
    assistant.state = 'failed';
    assistant.statusText = '执行失败';
    assistant.retry = true;
    saveSessions();
    render();
    return;
  }
  if (testScenario === 'success' || (testScenario === 'failure' && session.retrying) || session.messages.at(-2)?.text.includes('汇总')) {
    session.status = 'done';
    session.retrying = false;
    assistant.text = '任务已完成。我已整理出清晰的结果，并检查了输出内容。';
    assistant.state = 'done';
    assistant.statusText = '执行完成';
    assistant.steps = [
      { title: '梳理任务与范围', detail: '确认处理目标', tool: '任务分析', duration: '0.2 秒', status: 'done' },
      { title: '检查相关内容', detail: '完成信息整理', tool: '工作区读取', duration: '0.6 秒', status: 'done' },
      { title: '生成并检查结果', detail: '结果已就绪', tool: '内容生成', duration: '0.3 秒', status: 'done' },
    ];
    saveSessions();
    render();
    return;
  }
  session.status = 'approval';
  assistant.text = '我已完成初步检查。此任务包含文件修改操作，请先查看模拟差异并决定是否继续。';
  assistant.statusText = '等待你确认';
  assistant.steps = [
    { title: '梳理任务与范围', detail: '确认处理目标', tool: '任务分析', duration: '0.2 秒', status: 'done' },
    { title: '检查相关内容', detail: '已检查 3 个相关模块', tool: '工作区读取', duration: '0.6 秒', status: 'done' },
    { title: '申请变更审批', detail: 'backend/sessions.js', tool: '操作审批', duration: '等待确认', status: 'waiting' },
  ];
  session.retrying = false;
  assistant.approval = true;
  saveSessions();
  render();
  notify('任务需要你确认一项变更');
}

function resolveApproval(approved) {
  const session = activeSession();
  if (!session || session.status !== 'approval') return;
  session.status = approved ? 'done' : 'cancelled';
  const assistant = session.messages.at(-1);
  assistant.approval = false;
  assistant.retry = false;
  assistant.state = approved ? 'done' : 'cancelled';
  assistant.statusText = approved ? '已批准，任务完成' : '操作已拒绝';
  assistant.text = approved
    ? '审批已通过。原型演示流程已完成；没有文件被写入或修改。'
    : '你已拒绝这项变更。原型流程已停止，没有文件被写入或修改。';
  assistant.steps.at(-1).status = approved ? 'done' : 'failed';
  assistant.steps.at(-1).duration = approved ? '已批准' : '已拒绝';
  saveSessions();
  render();
  notify(approved ? '原型流程已完成，未修改真实文件' : '已拒绝本次变更，未修改真实文件');
}

function cancelTask() {
  const session = activeSession();
  if (!session || session.status !== 'running') return;
  clearTransition();
  session.status = 'cancelled';
  const assistant = session.messages.at(-1);
  assistant.state = 'cancelled';
  assistant.statusText = '已取消';
  assistant.retry = true;
  assistant.text = '任务已停止，没有进行其他操作。';
  saveSessions();
  render();
  notify('任务已取消');
}

function retryTask() {
  const session = activeSession();
  if (!session || !['failed', 'cancelled'].includes(session.status)) return;
  const lastAssistant = session.messages.at(-1);
  if (lastAssistant.role !== 'assistant') return;
  lastAssistant.state = 'running';
  lastAssistant.statusText = '正在重试';
  lastAssistant.retry = false;
  lastAssistant.text = '正在重新执行任务。';
  session.status = 'running';
  session.retrying = true;
  saveSessions();
  render();
  scheduleTransition(session.id, () => runAnalysis(session.id), 750);
}

function bindConversationActions() {
  document.getElementById('focus-review')?.addEventListener('click', () => {
    panel.classList.remove('collapsed');
    document.querySelector('.app-shell').classList.remove('review-hidden');
    document.getElementById('approve-change').focus();
  });
  conversation.querySelector('.send-button')?.addEventListener('click', () => {
    if (activeSession().status === 'running') return cancelTask();
    const input = conversation.querySelector('textarea');
    if (!input.value.trim()) return input.focus();
    const message = input.value;
    submitMessage(message);
  });
  conversation.querySelector('textarea')?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      conversation.querySelector('.send-button').click();
    }
  });
  conversation.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
    submitMessage(button.dataset.prompt);
  }));
  conversation.querySelector('[data-action="cancel"]')?.addEventListener('click', cancelTask);
  conversation.querySelector('[data-action="retry"]')?.addEventListener('click', retryTask);
  conversation.querySelector('.copy-action')?.addEventListener('click', async () => {
    const text = activeSession().messages.at(-1)?.text || '';
    try {
      await navigator.clipboard.writeText(text);
      notify('已复制回答');
    } catch {
      notify('当前浏览器未开放剪贴板权限');
    }
  });
  conversation.querySelector('.attach-button')?.addEventListener('click', () => attachmentInput.click());
  conversation.querySelector('.composer-toolbar .tiny')?.addEventListener('click', event => {
    event.currentTarget.classList.toggle('active');
    notify(event.currentTarget.classList.contains('active') ? '输入选项已展开' : '输入选项已收起');
  });
}

function updateSearch() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const matches = sessions.filter(session => !query || `${session.title} ${session.messages.map(message => message.text).join(' ')}`.toLocaleLowerCase().includes(query));
  searchResults.replaceChildren();
  if (!matches.length) {
    searchResults.innerHTML = '<p class="search-empty">没有找到匹配的会话</p>';
    return;
  }
  for (const session of matches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    const title = document.createElement('strong');
    title.textContent = session.title;
    const detail = document.createElement('span');
    detail.textContent = session.messages.at(-1)?.text || '空会话';
    button.append(title, detail);
    button.addEventListener('click', () => {
      selectSession(session.id);
      searchDialog.close();
    });
    searchResults.append(button);
  }
}

function recoverInterruptedSessions() {
  let changed = false;
  for (const session of sessions) {
    if (session.status !== 'running') continue;
    const assistant = session.messages.at(-1);
    if (!assistant || assistant.role !== 'assistant') continue;
    session.status = 'failed';
    assistant.state = 'failed';
    assistant.statusText = '任务中断，可重试';
    assistant.retry = true;
    assistant.text = '页面刷新时任务中断，没有继续执行其他操作。你可以重试。';
    changed = true;
  }
  if (changed) saveSessions();
}

document.querySelector('.new-chat').addEventListener('click', newSession);
document.querySelector('.search-chat').addEventListener('click', () => {
  searchInput.value = '';
  updateSearch();
  searchDialog.showModal();
  searchInput.focus();
});
searchInput.addEventListener('input', updateSearch);
document.querySelector('.panel-close').addEventListener('click', () => {
  panel.classList.add('collapsed');
  document.querySelector('.app-shell').classList.add('review-hidden');
  notify('已收起操作检查面板');
});
document.getElementById('approve-change').addEventListener('click', () => resolveApproval(true));
document.getElementById('reject-change').addEventListener('click', () => resolveApproval(false));
sidebarToggle.addEventListener('click', () => {
  const collapsed = appShell.classList.toggle('sidebar-collapsed');
  sidebarToggle.textContent = collapsed ? '›' : '‹';
  sidebarToggle.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
  sidebarToggle.title = collapsed ? '展开侧边栏' : '收起侧边栏';
  saveShellState();
  notify(collapsed ? '侧边栏已收起' : '侧边栏已展开');
});
workspaceSwitcher.addEventListener('click', () => openFloatingMenu(workspaceMenu, workspaceSwitcher));
modelPicker.addEventListener('click', () => openFloatingMenu(modelMenu, modelPicker));
actionsButton.addEventListener('click', () => openFloatingMenu(actionsMenu, actionsButton));
settingsButton.addEventListener('click', () => {
  closeFloatingMenus();
  settingsDialog.showModal();
});
document.getElementById('settings-close').addEventListener('click', () => settingsDialog.close());
document.getElementById('settings-done').addEventListener('click', () => {
  appShell.classList.toggle('no-motion', !settingMotion.checked);
  appShell.classList.toggle('compact-trace', settingCompact.checked);
  saveShellState();
  settingsDialog.close();
  notify('设置已应用');
});
document.getElementById('details-close').addEventListener('click', () => detailsDialog.close());
document.getElementById('execution-details').addEventListener('click', () => {
  closeFloatingMenus();
  document.getElementById('telemetry-context').textContent = `${Math.min(18 + (activeSession()?.messages.length || 0) * 3, 92)}%`;
  detailsDialog.showModal();
});
document.querySelector('.window-control[aria-label="最小化"]').addEventListener('click', () => notify('桌面窗口控制将在接入桌面壳后生效'));
document.querySelector('.window-control[aria-label="最大化"]').addEventListener('click', () => notify('当前已使用最大化工作区布局'));
document.querySelector('.window-control.close').addEventListener('click', () => notify('预览窗口不会被关闭；可直接关闭浏览器标签页'));
document.querySelectorAll('#workspace-menu [data-workspace]').forEach(button => button.addEventListener('click', () => {
  const workspace = button.dataset.workspace;
  document.querySelector('.workspace-copy strong').textContent = workspace;
  document.querySelector('.workspace-copy small').textContent = workspace === 'Personal Agent' ? 'D:\\personal agent' : 'D:\\personal agent\\frontend\\workbench';
  closeFloatingMenus();
  notify(`已切换到${workspace}`);
}));
document.querySelectorAll('#model-menu [data-model]').forEach(button => button.addEventListener('click', () => {
  selectedModel = { name: button.dataset.model, provider: button.dataset.provider };
  updateModelLabel();
  saveShellState();
  closeFloatingMenus();
  notify(`已切换到 ${selectedModel.name}`);
}));
document.querySelectorAll('[data-action="open-model-settings"], [data-action="workspace-settings"]').forEach(button => button.addEventListener('click', () => {
  closeFloatingMenus();
  notify('模型配置页将在桌面壳接入后打开');
}));
document.querySelector('[data-action="rename-session"]').addEventListener('click', () => {
  closeFloatingMenus();
  const session = activeSession();
  const title = window.prompt('输入新的会话名称', session.title);
  if (!title?.trim()) return;
  session.title = title.trim().slice(0, 80);
  saveSessions();
  render();
  notify('会话名称已更新');
});
document.querySelector('[data-action="export-session"]').addEventListener('click', () => {
  closeFloatingMenus();
  const session = activeSession();
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${session.title || 'session'}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  notify('当前会话已导出');
});
document.querySelector('[data-action="clear-session"]').addEventListener('click', () => {
  closeFloatingMenus();
  if (!window.confirm('清空当前会话内容吗？此操作只影响原型中的本地会话。')) return;
  const session = activeSession();
  clearTransition();
  session.messages = [];
  session.status = 'idle';
  session.title = '新建会话';
  saveSessions();
  render();
  notify('当前会话已清空');
});
attachmentInput.addEventListener('change', () => {
  const files = [...attachmentInput.files];
  if (!files.length) return;
  notify(`已选择 ${files.length} 个附件；原型不会上传文件`);
  attachmentInput.value = '';
});
settingMotion.addEventListener('change', () => {
  appShell.classList.toggle('no-motion', !settingMotion.checked);
  saveShellState();
});
settingCompact.addEventListener('change', () => {
  appShell.classList.toggle('compact-trace', settingCompact.checked);
  saveShellState();
});
settingAutoReview.addEventListener('change', () => {
  saveShellState();
  renderReview(activeSession());
});
document.addEventListener('click', event => {
  const anchor = event.target.closest?.('#workspace-switcher, #model-picker, #more-actions');
  if (![workspaceMenu, modelMenu, actionsMenu].some(menu => menu.contains(event.target)) && !anchor) closeFloatingMenus();
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    newSession();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
    event.preventDefault();
    document.querySelector('.search-chat').click();
  }
  if (event.key === 'Escape' && searchDialog.open) searchDialog.close();
  if ((event.ctrlKey || event.metaKey) && event.key === ',') {
    event.preventDefault();
    settingsDialog.showModal();
  }
});

applyShellState();
recoverInterruptedSessions();
render();
if (window.location.search.includes('testMode=1')) {
  window.__lingzhuTest = {
    getState: () => ({ status: activeSession()?.status, sessions: sessions.map(({ id, title, status, messages }) => ({ id, title, status, messages })), activeSessionId }),
    clearStorage: () => {
      localStorage.removeItem(storageKey);
      localStorage.removeItem(activeSessionKey);
      localStorage.removeItem(shellStateKey);
    },
  };
}
