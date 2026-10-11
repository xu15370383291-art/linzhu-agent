import { startGateway } from './host.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The supervisor is intentionally bounded: an unhealthy gateway must not create
// an unbounded restart loop or hide a persistent configuration failure.
export async function runGatewaySupervisor({ root = process.cwd(), host = '127.0.0.1', port = 0, token = process.env.AGENT_GATEWAY_TOKEN || null, maxRestarts = 3, restartDelayMs = 2_000, start = startGateway, signal = null, onRestart = () => {} } = {}) {
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 10) throw new Error('Invalid gateway restart limit');
  if (!Number.isInteger(restartDelayMs) || restartDelayMs < 100 || restartDelayMs > 60_000) throw new Error('Invalid gateway restart delay');
  let restarts = 0; let instance = null; let stopping = false;
  const stop = async () => { stopping = true; await instance?.close?.(); };
  const abort = () => { void stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!stopping) {
      try {
        instance = await start({ root, host, port, token });
        await new Promise((resolve, reject) => {
          instance.server.once('close', resolve);
          instance.server.once('error', reject);
          if (signal?.aborted) void stop();
        });
        if (stopping) break;
        throw Object.assign(new Error('Gateway server closed unexpectedly'), { code: 'GATEWAY_UNEXPECTED_CLOSE' });
      } catch (error) {
        await instance?.close?.().catch(() => {}); instance = null;
        if (stopping) break;
        if (restarts >= maxRestarts) throw Object.assign(new Error(`Gateway restart limit reached: ${error.message}`), { code: 'GATEWAY_RESTART_LIMIT', cause: error });
        restarts++; await onRestart({ restart: restarts, error: error.message }); await sleep(restartDelayMs);
      }
    }
  } finally { signal?.removeEventListener('abort', abort); await instance?.close?.().catch(() => {}); }
  return { restarts };
}
