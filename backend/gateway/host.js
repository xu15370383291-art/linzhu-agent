import { createLocalGateway } from './factory.js';
import { WslWorkerRunner } from '../security/wsl-worker.js';
import { SecurityAudit } from '../permissions/audit.js';
import { WindowsWorkerRunner } from '../security/windows-worker.js';
import { acquireGatewayLock } from './runtime.js';

export async function startGateway({ root = process.cwd(), host = '127.0.0.1', port = 0, token = process.env.AGENT_GATEWAY_TOKEN || null, skills = null } = {}) {
  const lock = await acquireGatewayLock(root);
  let closed = false;
  const worker = new WslWorkerRunner(root);
  await worker.verify().catch(() => false);
  const windowsWorker = process.platform === 'win32' ? new WindowsWorkerRunner(root) : null;
  const windowsIsolation = windowsWorker ? await windowsWorker.verify().catch(() => false) : false;
  const audit = new SecurityAudit(root);
  try { await audit.initialize(); audit.auditReady = true; } catch { audit.auditReady = false; }
  try {
    const services = createLocalGateway(root, { skills: skills ?? undefined, workerRunner: worker, sandbox: worker.sandbox, sandboxReady: worker.isolated === true, audit, windowsIsolationProbe: async () => ({ available: windowsIsolation, mode: windowsWorker?.mode ?? 'unsupported' }), health: async () => ({ ok: true, host, gateway: 'local', pid: process.pid }) });
    await services.gateway.approvals.load();
    await services.transactionJournal.recover();
    await services.initialize();
    await services.initializeBrowser();
    services.gateway.token = token;
    const server = services.gateway.createServer();
    await services.inbound.startScheduler();
    await services.tasks.startScheduler();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    const address = server.address();
    return { ...services, server, address, lock, close: async () => {
      if (closed) return;
      closed = true;
      services.gateway.turns.abortActive();
      services.gateway.closeClients?.();
      services.close();
      await windowsWorker?.close();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      await lock.release();
    } };
  } catch (error) { await windowsWorker?.close(); await lock.release().catch(() => {}); throw error; }
}

if (process.argv[1] && process.argv[1].endsWith('gateway/host.js')) {
  const instance = await startGateway({ port: Number(process.env.AGENT_GATEWAY_PORT || 0) });
  console.log(`Local Gateway: http://${instance.address.address}:${instance.address.port}/`);
  process.once('SIGINT', () => instance.close().then(() => process.exit(0)));
  process.once('SIGTERM', () => instance.close().then(() => process.exit(0)));
}
