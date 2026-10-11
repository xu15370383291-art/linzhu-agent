import process from 'node:process';

export async function probeWindowsIsolation({ probe = null } = {}) {
  if (process.platform !== 'win32') return { supported: false, available: false, mode: 'unsupported', reason: 'Windows isolation probe requires Windows' };
  if (typeof probe !== 'function') return { supported: true, available: false, mode: 'unconfigured', reason: 'No verified Restricted Token/AppContainer worker probe is configured' };
  try {
    const result = await probe();
    if (!result || result.available !== true || typeof result.mode !== 'string') return { supported: true, available: false, mode: 'rejected', reason: 'Isolation probe did not verify a restricted worker' };
    return { supported: true, available: true, mode: result.mode, reason: null };
  } catch (error) {
    return { supported: true, available: false, mode: 'error', reason: error.message };
  }
}
