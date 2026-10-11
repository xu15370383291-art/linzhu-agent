function lines(text) {
  if (!text) return [];
  return text.match(/.*(?:\r?\n|$)/g).filter(Boolean);
}

function safeLine(line) {
  return line.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/\r?\n$/, '') + (/\n$/.test(line) ? '' : ' [no newline]');
}

export function previewDiff(before, after) {
  const oldLines = lines(before);
  const newLines = lines(after);
  let prefix = 0;
  while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < Math.min(oldLines.length, newLines.length) - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const changed = [...removed.map(line => `- ${safeLine(line)}`), ...added.map(line => `+ ${safeLine(line)}`)];
  const limit = 200;
  return {
    text: [`@@ after line ${prefix} @@`, ...changed.slice(0, limit),
      ...(changed.length > limit ? [`... ${changed.length - limit} more changed lines not shown`] : [])].join('\n'),
    removed: removed.length,
    added: added.length,
    truncated: changed.length > limit,
  };
}
