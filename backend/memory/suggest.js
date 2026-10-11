const persistentPatterns = [
  /^(?:请)?记住(?:我)?[：:，,]?\s*(.+)$/i,
  /^(?:以后|今后)(?:都|请)\s*(.+)$/i,
  /^(?:我)?(?:偏好|喜欢|习惯)(?:是|：|:)?\s*(.+)$/i,
  /^(?:本项目|这个项目)(?:采用|使用|约定|决定)(?:了)?[：:，,]?\s*(.+)$/i,
];

export function extractMemorySuggestion(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/[。！!]+$/, '').trim();
  if (!text || text.length > 500 || /(?:密码|密钥|token|api[_ -]?key|secret|password|cookie|authorization)/i.test(text)) return null;
  for (const pattern of persistentPatterns) {
    const match = text.match(pattern);
    if (!match?.[1]?.trim()) continue;
    const content = match[1].trim();
    const project = /项目|project/i.test(text);
    return { content, scope: project ? 'project' : 'global', kind: project ? 'decision' : 'preference' };
  }
  return null;
}
