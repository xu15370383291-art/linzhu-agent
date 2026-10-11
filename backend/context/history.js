export function completedTurns(messages) {
  const turns = [];
  let current = null;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'user') {
      if (current) turns.push(current);
      current = { start: index, end: index + 1, messages: [] };
    }
    if (!current) throw new Error('Conversation history starts without a user message');
    current.messages.push(message);
    current.end = index + 1;
  }
  if (current) turns.push(current);
  return turns;
}

export function assertToolPairs(messages, { allowOpen = false } = {}) {
  const pending = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call.id !== 'string' || !call.id || pending.has(call.id)) throw new Error('Invalid tool call ID in context');
        pending.add(call.id);
      }
    } else if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) throw new Error('Unpaired tool result in context');
    }
  }
  if (pending.size && !allowOpen) throw new Error('Unpaired tool call in context');
}

export function projectToolResults(messages, { maxChars = 12000, aggregateChars = 40000, protectedFrom = messages.length } = {}) {
  let remaining = aggregateChars;
  let truncated = 0;
  const view = messages.map((message, index) => {
    if (message.role !== 'tool' || index >= protectedFrom) return message;
    const original = String(message.content ?? '');
    const limit = Math.min(maxChars, Math.max(0, remaining));
    if (original.length <= limit) { remaining -= original.length; return message; }
    const marker = `[Historical tool result truncated: ${original.length} chars; rerun the tool for details]`;
    let content = limit <= marker.length ? marker.slice(0, limit) : original.slice(0, limit - marker.length - 1) + '\n' + marker;
    try {
      const parsed = JSON.parse(original);
      if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
        const envelope = { ...parsed, content: '', truncated: true };
        const available = Math.max(0, limit - JSON.stringify(envelope).length - marker.length - 1);
        content = JSON.stringify({ ...envelope, content: parsed.content.slice(0, available) + '\n' + marker });
      }
    } catch { /* Plain-text tool results remain plain text. */ }
    remaining = Math.max(0, remaining - content.length);
    truncated++;
    return { ...message, content };
  });
  return { messages: view, truncated };
}
