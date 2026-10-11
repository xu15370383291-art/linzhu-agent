export const slashCommands = [
  { name: '/models', description: '选择当前模型；/models use <名称> 直接切换' },
  { name: '/context', description: '查看上下文预算和摘要状态' },
  { name: '/compact', description: '压缩较早的完整对话轮次' },
  { name: '/reset', description: '重置发送给模型的历史视图' },
  { name: '/new', description: '创建新会话' },
  { name: '/sessions', description: '列出本地会话' },
  { name: '/resume', description: '搜索并恢复已保存的会话' },
  { name: '/history', description: '查看当前会话的完整对话记录' },
  { name: '/rename', description: '修改当前会话标题；可输入 /rename 后再输入标题' },
  { name: '/use', description: '恢复会话：/use <id>' },
  { name: '/help', description: '显示命令说明' },
  { name: '/providers', description: '查看可用 Provider 和能力' },
  { name: '/security-mode', description: '设置安全模式：safe|personal|advanced', lowFrequency: true },
  { name: '/skills', description: '查看、启停、校验和创建 Skill' },
  { name: '/memory', description: '查看、搜索、确认、导入导出长期记忆' },
  { name: '/memory-embedding', description: '配置本机 Ollama 向量记忆、查看状态或分批重建', lowFrequency: true },
  { name: '/messages', description: '管理 Webhook 消息频道', lowFrequency: true },
  { name: '/mcp', description: '管理 MCP Server 和工具', lowFrequency: true },
  { name: '/plugins', description: '管理本地插件', lowFrequency: true },
  { name: '/branches', description: '列出当前会话的所有对话分支', lowFrequency: true },
  { name: '/branch', description: '创建或切换分支：/branch create|use ...', lowFrequency: true },
  { name: '/exit', description: '退出 Agent' },
];

export function isExitCommand(input) {
  return ['exit', '/exit', 'exit/'].includes(input.trim().toLowerCase());
}

export function isUserInterrupt(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}
