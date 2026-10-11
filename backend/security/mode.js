export const SECURITY_MODES = new Set(['safe', 'personal', 'advanced']);

export function securityModeStatus(requested = 'safe', readiness = {}) {
  const mode = String(requested).toLowerCase();
  if (!SECURITY_MODES.has(mode)) throw Object.assign(new Error('Invalid security mode'), { code: 'SECURITY_MODE_INVALID' });
  if (mode === 'advanced' && readiness.windowsIsolation?.available !== true) return { requested: mode, active: 'safe', available: false, code: 'SECURITY_MODE_UNAVAILABLE', reason: 'Advanced mode requires a verified Windows isolation worker' };
  // Personal mode intentionally relaxes file-tool isolation. It still keeps
  // protected-path checks, audit and high-risk tool approvals; it does not
  // claim OS-level isolation for host-side file operations.
  return { requested: mode, active: mode, available: true, code: null, reason: null };
}
