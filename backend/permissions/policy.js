export class PermissionPolicy {
  constructor({ approveWrite = async () => false, approveWritableDiff = async () => false, approveCommand = async () => false, sandboxReady = false, writableSandboxReady = false,
    requireSandbox = false, personalMode = false, autoApproveFileOperations = false, audit, requireAudit = false, networkReady = false, skillScriptReady = false, processReady = false, messageReady = false, taskReady = false,
    approveMessage = async () => false, approveTask = async () => false, approveMcp = async () => false, requestApproval = null, mcpReady = false, browserReady = false, taskPermissions = null, trashReady = false, changePlanReady = false, clarificationReady = false } = {}) {
    this.approveWrite = approveWrite;
    this.approveWritableDiff = approveWritableDiff;
    this.approveCommand = approveCommand;
    this.sandboxReady = sandboxReady;
    this.writableSandboxReady = writableSandboxReady;
    this.requireSandbox = requireSandbox;
    this.personalMode = personalMode;
    this.autoApproveFileOperations = autoApproveFileOperations;
    this.fileReadsInSandbox = !personalMode;
    this.audit = audit;
    this.requireAudit = requireAudit;
    this.auditReady = false;
    this.networkReady = networkReady;
    this.skillScriptReady = skillScriptReady;
    this.processReady = processReady;
    this.messageReady = messageReady;
    this.taskReady = taskReady;
    this.approveMessage = approveMessage;
    this.approveTask = approveTask;
    this.approveMcp = approveMcp;
    this.requestApproval = requestApproval;
    this.mcpReady = mcpReady;
    this.browserReady = browserReady;
    this.taskPermissions = taskPermissions;
    this.trashReady = trashReady;
    this.changePlanReady = changePlanReady;
    this.clarificationReady = clarificationReady;
  }

  visible(name) {
    if (name === 'ask_user') return this.clarificationReady === true;
    if (this.taskPermissions && !this.taskPermissions.allowsTool(name)) return false;
    if (this.requireSandbox && this.sandboxReady !== true) return false;
    if (this.requireAudit && this.auditReady !== true) return false;
    if (name === 'sandbox_command') return this.sandboxReady === true;
    if (name === 'run_skill_script') return this.sandboxReady === true && this.skillScriptReady === true;
    if (name === 'sandbox_command_write') return this.writableSandboxReady === true;
    if (name === 'web_fetch' || name === 'web_search') return this.networkReady === true;
    if (name === 'browser_open') return this.networkReady === true && this.browserReady === true;
    if (name.startsWith('process_')) return this.processReady === true;
    if (['send_message', 'edit_message', 'delete_message', 'react_message', 'send_file'].includes(name)) return this.messageReady === true;
    if (name.startsWith('task_')) return this.taskReady === true;
    if (name.startsWith('mcp_')) return this.mcpReady === true;
    if (name === 'external_write_file' || name === 'external_edit_file') return true;
    if (name === 'delete_file' || name === 'restore_file' || name === 'list_trash') return this.trashReady === true;
    if (name === 'apply_change_plan') return this.changePlanReady === true;
    if (name === 'get_skills' || name === 'load_skill' || name === 'load_skill_resource') return true;
    if (name === 'delegate_task') return true;
    if (name.startsWith('external_')) return ['external_file_info', 'external_read_file', 'external_list_files',
      'external_find_files', 'external_search_text'].includes(name);
    return ['file_info', 'read_file', 'list_files', 'find_files', 'search_text', 'write_file', 'edit_file'].includes(name);
  }

  async authorize(name, details) {
    if (!this.visible(name)) return false;
    if (this.taskPermissions && !this.taskPermissions.allowsPath(name, details)) return false;
    if (this.taskPermissions && ['write_file', 'edit_file', 'external_write_file', 'external_edit_file', 'delete_file', 'restore_file', 'send_file'].includes(name)) {
      const bytes = typeof details?.after === 'string' ? Buffer.byteLength(details.after) : typeof details?.content === 'string' ? Buffer.byteLength(details.content) : 0;
      if (!this.taskPermissions.reserve(bytes)) throw Object.assign(new Error('Task resource limit exceeded'), { code: 'RESOURCE_LIMIT' });
    }
    if (name === 'sandbox_command') return this.approveSideEffect(name, details, this.approveCommand);
    if (name === 'run_skill_script') return this.approveSideEffect(name, details, this.approveCommand);
    if (name === 'sandbox_command_write') return this.approveSideEffect(name, details, this.approveCommand);
    if (name.startsWith('process_')) return this.approveSideEffect(name, details, this.approveCommand);
    if (name === 'browser_open' && this.requestApproval) return this.approveSideEffect(name, details, async () => false);
    if (['send_message', 'edit_message', 'delete_message', 'react_message', 'send_file'].includes(name)) return this.approveSideEffect(name, details, this.approveMessage);
    if (name.startsWith('task_')) return this.approveSideEffect(name, details, this.approveTask);
    if (name === 'mcp_list_tools') return true;
    if (name === 'mcp_call_tool') return this.approveSideEffect(name, details, this.approveMcp);
    if (!['write_file', 'edit_file', 'external_write_file', 'external_edit_file', 'delete_file', 'restore_file'].includes(name)) return true;
    if (this.personalMode && this.autoApproveFileOperations && ['write_file', 'edit_file', 'external_write_file', 'external_edit_file'].includes(name)) return true;
    return this.approveSideEffect(name, details, this.approveWrite);
  }

  async approveSideEffect(name, details, fallback) {
    if (this.requestApproval) {
      const result = await this.requestApproval({ tool: name, details });
      if (result === true) return true;
      if (result?.status === 'pending') throw Object.assign(new Error('Approval required'), { code: 'APPROVAL_REQUIRED', approvalId: result.approvalId, turnId: result.turnId, sessionId: result.sessionId });
      return false;
    }
    return (await fallback(details)) === true;
  }
}
