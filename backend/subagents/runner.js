import { availableTools, routeTool } from '../tools/registry.js';
import { resolveVisibleTools } from '../tools/surface.js';

export class SubagentRunner {
  constructor({ request, workspace, policy, externalReads, sandbox, web, skills, maxRounds = 4, maxTools = 8 } = {}) {
    this.request = request; this.workspace = workspace; this.policy = policy; this.externalReads = externalReads; this.sandbox = sandbox; this.web = web; this.skills = skills; this.maxRounds = maxRounds; this.maxTools = maxTools;
  }
  async run({ task, signal }) {
    if (typeof task !== 'string' || !task.trim() || task.length > 4000) throw new Error('Invalid sub-agent task');
    const tools = availableTools(this.policy, { surface: (registry, current) => resolveVisibleTools(registry, current, { groups: ['workspace.read'] }) });
    const allowedTools = new Set(tools.map(tool => tool.function.name)); const messages = [{ role: 'user', content: task }]; let calls = 0;
    for (let round = 0; round < this.maxRounds; round++) {
      signal?.throwIfAborted(); const response = await this.request(messages, tools, { toolChoice: tools.length ? 'auto' : 'none', signal }); const message = response?.choices?.[0]?.message;
      if (!message) throw new Error('Invalid sub-agent response'); messages.push(message);
      if (!message.tool_calls?.length) return { content: message.content ?? '', rounds: round + 1, toolCalls: calls };
      for (const call of message.tool_calls) {
        if (++calls > this.maxTools) throw new Error('Sub-agent tool limit reached');
        const result = await routeTool(call, { workspace: this.workspace, externalReads: this.externalReads, sandbox: this.sandbox, web: this.web, skills: this.skills, policy: this.policy, allowedTools, signal });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        if (result.isError && result.errorCode === 'TOOL_NOT_AVAILABLE') return { content: '子代理请求了未开放的工具，操作已拒绝。', rounds: round + 1, toolCalls: calls, denied: true };
      }
    }
    throw new Error('Sub-agent round limit reached');
  }
}
