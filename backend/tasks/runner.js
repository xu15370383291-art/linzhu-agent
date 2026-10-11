import { createConfiguredRequest, runTurn } from '../agent.js';
import { Workspace } from '../workspace.js';
import { Sessions } from '../sessions.js';
import { TaskPermissionPolicy } from '../security/task-permissions.js';
import { PermissionPolicy } from '../permissions/policy.js';
import { SecurityAudit } from '../permissions/audit.js';
import { WslSandbox } from '../sandbox/wsl.js';
import { commitWindowsChange } from '../sandbox/snapshot.js';

// Scheduled turns get a new session and a frozen permission snapshot. They do
// not inherit the interactive CLI's approvals or capabilities.
export function createTaskRunner({ workspaceRoot, models, sessions = new Sessions(workspaceRoot), memory = null, skills = null, trash = null, messages = null, mcp = null } = {}) {
  const root = new Workspace(workspaceRoot, { commitBroker: process.platform === 'win32' ? commitWindowsChange : undefined });
  return async (task, permissions, { signal } = {}) => {
    const input = typeof task.payload?.input === 'string' ? task.payload.input.trim() : '';
    if (!input) return { ok: false, code: 'TASK_INPUT_REQUIRED' };
    const item = await models.get();
    if (!item) return { ok: false, code: 'MODEL_NOT_CONFIGURED' };
    if (process.platform !== 'win32') return { ok: false, code: 'SANDBOX_UNAVAILABLE' };

    const sandbox = new WslSandbox(root.root);
    const audit = new SecurityAudit(root.root);
    try { await audit.initialize(); } catch { return { ok: false, code: 'AUDIT_UNAVAILABLE' }; }
    let sandboxReady = false;
    try { sandboxReady = await sandbox.verify(); } catch { sandboxReady = false; }
    if (!sandboxReady) return { ok: false, code: 'SANDBOX_UNAVAILABLE' };

    const taskPermissions = new TaskPermissionPolicy(permissions, { workspaceRoot: root.root });
    const approvedBySnapshot = name => async () => taskPermissions.allowsTool(name);
    const policy = new PermissionPolicy({
      requireSandbox: true,
      sandboxReady: true,
      requireAudit: true,
      audit,
      auditReady: true,
      taskPermissions,
      trashReady: Boolean(trash),
      messageReady: Boolean(messages),
      mcpReady: Boolean(mcp),
      approveCommand: approvedBySnapshot('sandbox_command'),
      approveMessage: approvedBySnapshot('send_message'),
      approveTask: approvedBySnapshot('task_run'),
      approveMcp: approvedBySnapshot('mcp_call_tool'),
      approveWrite: async details => taskPermissions.allowsTool(details?.path ? 'write_file' : 'write_file'),
    });
    const session = await sessions.create();
    const request = createConfiguredRequest(item, { cache: null });
    try {
      const answer = await runTurn({
        session,
        input,
        workspace: root,
        sandbox,
        skills,
        memory,
        userMessageMetadata: { taskId: task.id },
        trash,
        messages,
        mcp,
        request,
        policy,
        contextSettings: { contextWindow: item.contextWindow, outputReserve: item.outputReserve },
        modelName: item.model,
        signal,
      });
      await sessions.save(session);
      return { ok: true, answer, sessionId: session.id };
    } catch (error) {
      if (session.messages.length) await sessions.save(session).catch(() => {});
      return { ok: false, code: error.code ?? 'TASK_TURN_FAILED', error: error.message, sessionId: session.id };
    }
  };
}
