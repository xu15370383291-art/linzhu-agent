function matches(name, entry) {
  const tool = name.toLowerCase();
  const pattern = String(entry).trim().toLowerCase();
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return tool.startsWith(pattern.slice(0, -1));
  return tool === pattern;
}

export function resolveVisibleTools(registry, policy, {
  disableTools = false,
  modelSupportsTools = true,
  categories,
  groups,
  allowlist,
} = {}) {
  if (disableTools || !modelSupportsTools) return [];
  return registry.filter(tool => policy.visible(tool.name))
    .filter(tool => !categories?.length || categories.includes(tool.category))
    .filter(tool => inGroups(tool, groups))
    .filter(tool => allowlist === undefined || allowlist.some(entry => matches(tool.name, entry)))
    .map(tool => tool.definition);
}
import { inGroups } from './groups.js';
