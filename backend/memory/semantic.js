export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) return null;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index++) { if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) return null; dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  const divisor = Math.sqrt(leftNorm) * Math.sqrt(rightNorm); return divisor > 0 ? dot / divisor : 0;
}
export function vectorIdentity({ provider = 'none', model = 'default', dimensions = null } = {}) { return `${provider}:${model}:${dimensions ?? 'auto'}`; }

export function normalizeVector(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8192 || value.some(item => !Number.isFinite(item))) return null;
  const norm = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm === 0) return null;
  return value.map(item => item / norm);
}
