import process from 'node:process';

export async function collectReadiness({ root, secrets = null, audit = null, worker = null, sandbox = null, windowsIsolation = null, browser = null, securityMode = 'safe' } = {}) {
  const secretStatus = secrets?.available ? await secrets.available().catch(error => ({ available: false, code: 'SECRET_STORE_ERROR', message: error.message })) : { available: false, code: 'SECRET_STORE_NOT_CONFIGURED' };
  const workerStatus = worker?.readiness ? worker.readiness() : { available: false, mode: 'unavailable', reason: 'No verified low-privilege isolated worker is configured' };
  let sandboxStatus = { available: false, reason: 'Sandbox not configured' };
  if (sandbox) sandboxStatus = { available: sandbox.sandboxReady === true, reason: sandbox.sandboxReady === true ? null : 'Sandbox readiness has not been verified' };
  const windowsStatus = windowsIsolation ?? { supported: process.platform === 'win32', available: false, mode: 'unconfigured', reason: 'No verified Windows isolation probe is configured' };
  const { securityModeStatus } = await import('./mode.js');
  const mode = securityModeStatus(securityMode, { worker: workerStatus, windowsIsolation: windowsStatus });
  const auditStatus = { available: Boolean(audit?.auditReady ?? audit?.ready) };
  return { node: process.version, platform: process.platform, root: root ?? null, securityMode: mode, secrets: secretStatus, audit: auditStatus, sandbox: sandboxStatus, worker: workerStatus, windowsIsolation: windowsStatus, browser: browser ?? { available: false, code: 'BROWSER_NOT_CONFIGURED' }, attachments: { text: { available: true, mode: 'workspace-relative-utf8-bounded' }, pdf: { available: true, mode: 'local-pdfjs-bounded-text-extraction' }, image: { available: false, code: 'VISION_INPUT_UNAVAILABLE' }, audio: { available: false, code: 'AUDIO_TRANSCRIPTION_UNAVAILABLE' } }, operationBroker: { available: auditStatus.available, mode: 'shared-capability-broker' }, changePlan: { available: true, mode: 'bounded-plan-and-single-use-capability' }, trash: { available: true, mode: 'recoverable-no-permanent-delete' }, taskPermissions: { available: true, mode: 'snapshot-and-enforced' }, failClosed: !workerStatus.available || !secretStatus.available || !auditStatus.available };
}
