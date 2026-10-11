import path from 'node:path';
import { Models } from '../models.js';
import { Sessions } from '../sessions.js';
import { MemoryStore } from '../memory/store.js';
import { SkillStore } from '../skills/store.js';
import { TaskStore } from '../tasks/store.js';
import { MessageStore } from '../messages/webhook.js';
import { McpStore } from '../mcp/store.js';
import { PluginStore } from '../plugins/store.js';
import { SecretStore } from '../secrets/store.js';
import { ApprovalManager } from './approval-manager.js';
import { LocalGateway } from './server.js';
import { Workspace } from '../workspace.js';
import { runTurn, createConfiguredRequest } from '../agent.js';
import { SecurityAudit } from '../permissions/audit.js';
import { WorkerBoundary } from '../security/worker-boundary.js';
import { collectReadiness } from '../security/readiness.js';
import { probeWindowsIsolation } from '../security/windows-isolation-probe.js';
import { SecurityModeStore } from '../security/mode-store.js';
import { CapabilityBroker } from '../security/capability.js';
import { OperationBroker } from '../security/broker.js';
import { EventBus } from '../contracts/events.js';
import { createTaskRunner as createBoundedTaskRunner } from '../tasks/runner.js';
import { createGatewayTurnRunner } from './turn-runner.js';
import { TransactionJournal } from '../security/transaction-journal.js';
import { GatewayAutostart } from './autostart.js';
import { InboundMessageStore } from '../messages/inbound.js';
import { createInboundMessageRunner } from '../messages/inbound-runner.js';
import { EmbeddingConfigStore } from '../memory/embedding-config.js';
import { createEmbeddingProvider } from '../memory/embedding-provider.js';
import { AccessGrantStore } from '../security/access-grants.js';
import { AttachmentStore } from '../attachments/store.js';
import { ProjectStore } from './projects.js';
import { createControlledBrowser } from '../browser/session.js';
import { WebTools } from '../tools/web.js';

export function createLocalGateway(root = process.cwd(), options = {}) {
  const workspace = path.resolve(root); const secrets = new SecretStore(workspace); const events = options.eventBus;
  const accessGrants = new AccessGrantStore(workspace);
  const attachmentStore = new AttachmentStore(workspace);
  const models = new Models(workspace, { secrets });
  const sessions = new Sessions(workspace);
  const projects = new ProjectStore(workspace, { picker: options.projectPicker });
  const memoryEmbedding = new EmbeddingConfigStore(workspace);
  let embeddingConfigError = null;
  const memory = new MemoryStore(workspace);
  let browserStatus = { available: false, code: 'BROWSER_NOT_INITIALIZED' };
  let controlledBrowser = null;
  const web = new WebTools({ approve: options.approveNetwork ?? (async () => false), searchKey: options.searchKey });
  let browserInitialization;
  const initializeBrowser = async () => {
    browserInitialization ??= options.browser === false
      ? Promise.resolve({ browser: null, status: { available: false, code: 'BROWSER_DISABLED' } })
      : options.browser
        ? Promise.resolve({ browser: options.browser, status: { available: true, mode: 'injected-controlled-browser' } })
        : createControlledBrowser(options.browserOptions);
    const result = await browserInitialization;
    controlledBrowser = result.browser;
    browserStatus = result.status;
    web.browser = controlledBrowser;
    if (controlledBrowser) controlledBrowser.web = web;
    gateway.browserStatus = browserStatus;
    return browserStatus;
  };
  let memoryInitialization;
  const initializeMemory = () => {
    if (!memoryInitialization) memoryInitialization = memoryEmbedding.get().then(settings => {
      if (settings.configured) memory.configureEmbedding(createEmbeddingProvider(settings), 'hybrid');
    }).catch(error => { embeddingConfigError = error.code ?? 'EMBEDDING_CONFIG_INVALID'; });
    return memoryInitialization;
  };
  const skills = options.skills ?? new SkillStore(workspace);
  const worker = new WorkerBoundary({ runner: options.workerRunner });
  const modeStore = new SecurityModeStore(workspace);
  const eventBus = events ?? new EventBus();
  const operationBroker = new OperationBroker({ capabilities: new CapabilityBroker(), root: workspace, audit: options.audit ?? null, onEvent: event => eventBus.emit(event) });
  const transactionJournal = new TransactionJournal(workspace);
  const autostart = new GatewayAutostart(workspace);
  const messages = new MessageStore(workspace, { secrets, operationBroker });
  const mcp = new McpStore(workspace, { secrets, operationBroker });
  const taskRunner = options.runTask ?? createBoundedTaskRunner({ workspaceRoot: workspace, models, sessions, memory, skills, messages, mcp });
  const tasks = new TaskStore(workspace, { run: taskRunner });
  const approvals = new ApprovalManager({ root: workspace });
  const plugins = new PluginStore(workspace, { operationBroker });
  const inbound = options.inbound ?? new InboundMessageStore(workspace, { secrets, autoProcess: false, createSession: () => sessions.create(), onMessage: createInboundMessageRunner({ workspaceRoot: workspace, models, sessions, audit: options.audit, sandbox: options.sandbox }) });
  const gateway = new LocalGateway({ root: workspace, models, sessions, projects, memory, memoryEmbedding, initializeMemory, getEmbeddingConfigError: () => embeddingConfigError, browserStatus, skills, tasks, messages, inbound, mcp, plugins, approvals, securityModeStore: modeStore, accessGrants, attachmentStore, autostart, eventBus, runTurn: options.runTurn ?? createGatewayTurnRunner({ root: workspace, models, sessions, memory, skills, plugins, audit: options.audit, sandbox: options.sandbox, sandboxReady: options.sandboxReady, approvals, accessGrants, attachmentStore, getSecurityMode: () => modeStore.getRequested(), structuredPlanning: options.structuredPlanning ?? true, web, browserReady: () => browserStatus.available === true }), diagnostics: async () => { await initializeMemory(); const windowsIsolation = await probeWindowsIsolation(options.windowsIsolationProbe ? { probe: options.windowsIsolationProbe } : {}); const readiness = await collectReadiness({ root: workspace, secrets, worker, audit: options.audit, sandbox: { sandboxReady: Boolean(options.sandbox && options.sandboxReady === true) }, windowsIsolation, browser: browserStatus, securityMode: await modeStore.getRequested() }); return { ...readiness, memory: { ...(await memory.status()), embeddingConfigError }, tasks: await tasks.diagnostics(), inbound: await inbound.diagnostics(), autostart: await autostart.get() }; }, health: options.health });
  if (!options.runTurn) {
    const runTurn = gateway.runTurn;
    gateway.runTurn = async turn => { await initializeBrowser(); return runTurn(turn); };
  }
  inbound.onEvent = async event => gateway.emit(event.type, { delivery: event.delivery }, { source: 'inbound' });
  return { gateway, secrets, transactionJournal, accessGrants, projects, autostart, tasks: gateway.tasks, messages: gateway.messages, inbound: gateway.inbound, memory, initialize: initializeMemory, initializeBrowser, getBrowserStatus: () => browserStatus, mcp: gateway.mcp, plugins: gateway.plugins, close: async () => { try { gateway.tasks.stopScheduler(); gateway.inbound.stopScheduler(); gateway.mcp.close(); await controlledBrowser?.close(); } finally { await memory.close(); } } };
}
