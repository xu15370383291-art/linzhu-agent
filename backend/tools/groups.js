export const TOOL_GROUPS = Object.freeze({
  WORKSPACE_READ: 'workspace.read',
  WORKSPACE_WRITE: 'workspace.write',
  WORKSPACE_TRASH: 'workspace.trash',
  EXTERNAL_READ: 'external.read',
  EXTERNAL_WRITE: 'external.write',
  SANDBOX_COMMAND: 'sandbox.command',
  WRITABLE_SANDBOX: 'sandbox.command.write',
  NETWORK_READ: 'network.read',
  PROCESS: 'process.control',
  MESSAGE: 'message.send',
  TASK: 'task.control',
  MCP: 'mcp.control',
  CLARIFICATION: 'interaction.clarification',
});

export function inGroups(tool, groups) {
  return !groups?.length || tool.groups.some(group => groups.includes(group));
}
