import { TOOL_GROUPS } from '../tools/groups.js';

const rules = [
  { kind: 'message', groups: [TOOL_GROUPS.MESSAGE], preferredTool: 'send_message', pattern: /(发送|发给|消息|短信|通知|回复|send|message|notify)/i },
  { kind: 'task', groups: [TOOL_GROUPS.TASK], preferredTool: 'task_create', pattern: /(定时|自动化|后台任务|计划任务|提醒我|task|schedule|cron|heartbeat)/i },
  { kind: 'mcp', groups: [TOOL_GROUPS.MCP], preferredTool: 'mcp_call_tool', pattern: /\b(?:mcp_call_tool|mcp_list_tools)\b|(?:请|帮我|现在|直接)?\s*(?:调用|列出|查看|获取|检查|连接|配置|启用|停用|测试|使用)\s*(?:(?:一下|当前|已经|已配置的|这个)\s*){0,2}(?:MCP(?:服务器|服务端|工具)?|模型上下文协议)|\b(?:call|list|inspect|connect|configure|enable|disable|use)\s+(?:(?:the\s+)?configured\s+|the\s+)?mcp(?:\s+(?:server|tool))?\b/i },
  { kind: 'process', groups: [TOOL_GROUPS.PROCESS], preferredTool: 'process_start', pattern: /(后台进程|启动进程|轮询进程|停止进程|process)/i },
  { kind: 'writable_sandbox_command', groups: ['sandbox.command.write'], preferredTool: 'sandbox_command_write', pattern: /(运行|执行|run|execute).*(修改|写入|生成|创建|格式化|修复|改动)|(modify|write|generate|format|fix).*(command|project|files?)/i },
  { kind: 'sandbox_command', groups: ['sandbox.command'], preferredTool: 'sandbox_command', pattern: /(运行|执行).*(命令|测试|git|npm)|(run|execute).*(command|tests?|git|npm)/i },
  { kind: 'workspace_info', groups: ['filesystem'], preferredTool: 'file_info', pattern: /(文件|目录|文件夹).*(大小|字节|行数|类型|修改时间|信息)|(size|lines|metadata|stat).*(file|directory)/i },
  { kind: 'workspace_list', groups: ['filesystem'], preferredTool: 'list_files', pattern: /(当前|这个|本)?\s*(空(?:的)?\s*)?(工作区|项目|文件夹|目录).*(里面|之中|中|里|下).*(有什么|有啥|包含什么|有哪些|内容|列出|列表)|(当前|这个|本)\s*(工作区|项目|文件夹|目录).*(有哪些|什么|列出|列表)|里面有什么|列出.*(文件|目录)|list.*files/i },
  { kind: 'workspace_find', groups: ['filesystem'], preferredTool: 'find_files', pattern: /(找|查找|搜索|定位).*(文件名|叫.*的文件|名字.*文件)|find.*files?|which.*file/i },
  { kind: 'workspace_search', groups: ['filesystem'], preferredTool: 'search_text', pattern: /(项目|工作区|代码|文件).*(搜索|查找|哪里|出现)|搜索.*(项目|代码|文件)|search.*text/i },
  { kind: 'workspace_read', groups: ['filesystem'], preferredTool: 'read_file', pattern: /(读取|查看|打开|看看).*(文件|README|package\.json|内容|\b[\w.-]+\.[A-Za-z0-9]{1,8}\b)|read.*file/i },
  { kind: 'workspace_edit', groups: ['filesystem'], preferredTool: 'edit_file', pattern: /(修改|编辑|替换|改一下|改成|更新).*(文件|README|代码)|edit.*file/i },
  { kind: 'workspace_write', groups: ['filesystem'], preferredTool: 'write_file', pattern: /(创建|新建|写入|覆盖).*(文件)|write.*file/i },
  { kind: 'workspace_trash', groups: ['workspace.trash'], preferredTool: 'delete_file', pattern: /(删除|移入.*回收|放入.*Trash|delete|trash).*(文件)|delete.*file/i },
  { kind: 'workspace_restore', groups: ['workspace.trash'], preferredTool: 'restore_file', pattern: /(恢复|还原).*(文件|Trash|回收)|restore.*file/i },
  { kind: 'workspace_trash_list', groups: ['workspace.trash'], preferredTool: 'list_trash', pattern: /(回收站|Trash).*(列表|文件|有哪些)|list.*trash/i },
];

export function classifyIntent(input) {
  const text = String(input ?? '').trim();
  // Detect absolute Windows, UNC and POSIX paths even when the path is quoted
  // or contains spaces. The actual tool still validates the complete path.
  const externalPath = /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n"' )]+/.test(text);
  const accessAlias = /(?:^|[\s"'(])@[a-z][a-z0-9_-]{0,31}(?:[\\/]|$)/i.test(text);
  const driveMention = text.match(/([A-Za-z])\s*盘(?:中|里)?/i)?.[1]?.toUpperCase() ?? null;
  const externalWrite = /(创建|新建|写入|覆盖|保存|修改|编辑|替换|更新|write|edit|save)/i.test(text);
  if (/https?:\/\/\S+/i.test(text) || /(联网|上网|网上|网页|网站|web search|search the web)/i.test(text)) {
    const fetch = /https?:\/\/\S+/i.test(text);
    const mixed = /(项目|工作区|文件|保存|写入|file|workspace)/i.test(text);
    const groups = mixed ? [TOOL_GROUPS.NETWORK_READ, TOOL_GROUPS.WORKSPACE_READ, TOOL_GROUPS.WORKSPACE_WRITE]
      : [TOOL_GROUPS.NETWORK_READ];
    if (externalPath && externalWrite) groups.push(TOOL_GROUPS.EXTERNAL_WRITE);
    return { kind: fetch ? 'web_fetch' : 'web_search', preferredTool: fetch ? 'web_fetch' : 'web_search',
      groups,
      mustUseTool: true, requiresEvidence: true, confidence: 0.95 };
  }
  if ((externalPath || accessAlias || driveMention) && externalWrite) {
    const edit = /(修改|编辑|替换|更新|edit)/i.test(text);
    return { kind: edit ? 'external_edit' : 'external_write',
      groups: /(读取|查看|打开|读取内容|read)/i.test(text)
        ? [TOOL_GROUPS.EXTERNAL_READ, TOOL_GROUPS.EXTERNAL_WRITE] : [TOOL_GROUPS.EXTERNAL_WRITE],
      preferredTool: edit ? 'external_edit_file' : 'external_write_file',
      mustUseTool: true, requiresEvidence: false, confidence: 0.95 };
  }
  const externalReadRequest = externalPath || accessAlias || driveMention || /(?:外部文件|外部目录)/i.test(text);
  if (externalReadRequest && /(读取|查看|打开|看看|列出|查找|搜索|内容|文件夹|目录|read|list|find|search)/i.test(text)) {
    const preferredTool = /(列出|文件夹|目录|list)/i.test(text) ? 'external_list_files'
      : /(查找|找|文件名|find)/i.test(text) ? 'external_find_files'
        : /(搜索|search)/i.test(text) ? 'external_search_text' : 'external_read_file';
    return { kind: 'external_read', groups: [TOOL_GROUPS.EXTERNAL_READ], preferredTool,
      mustUseTool: true, requiresEvidence: true, confidence: 0.98 };
  }
  const explicitFileTool = /\b(write_file|edit_file)\b/i.exec(text);
  const rule = explicitFileTool
    ? rules.find(candidate => candidate.kind === (explicitFileTool[1].toLowerCase() === 'write_file' ? 'workspace_write' : 'workspace_edit'))
    : rules.find(candidate => candidate.pattern.test(text));
  if (!rule) return { kind: 'general', groups: undefined, mustUseTool: false, requiresEvidence: false, confidence: 0.5 };
  return {
    ...rule,
    groups: ['message', 'task', 'mcp', 'process'].includes(rule.kind) ? rule.groups
      : rule.kind === 'sandbox_command' ? [TOOL_GROUPS.SANDBOX_COMMAND]
      : rule.kind === 'writable_sandbox_command' ? [TOOL_GROUPS.WRITABLE_SANDBOX]
      : ['workspace_edit', 'workspace_write'].includes(rule.kind)
        ? [TOOL_GROUPS.WORKSPACE_READ, TOOL_GROUPS.WORKSPACE_WRITE]
        : ['workspace_trash', 'workspace_restore', 'workspace_trash_list'].includes(rule.kind)
          ? [TOOL_GROUPS.WORKSPACE_TRASH]
        : [TOOL_GROUPS.WORKSPACE_READ],
    mustUseTool: true,
    requiresEvidence: ['workspace_info', 'workspace_list', 'workspace_find', 'workspace_search', 'workspace_read'].includes(rule.kind),
    wantsAll: ['workspace_list', 'workspace_find', 'workspace_search'].includes(rule.kind) && /(全部|所有|有哪些|列出|每个|一共|all|every|list all)/i.test(text),
    confidence: 0.95,
  };
}
