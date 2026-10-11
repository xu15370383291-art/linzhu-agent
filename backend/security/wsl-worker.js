import { WslSandbox } from '../sandbox/wsl.js';

export class WslWorkerRunner {
  constructor(root, { sandbox = new WslSandbox(root) } = {}) {
    this.root = root;
    this.sandbox = sandbox;
    this.isolated = false;
    this.mode = 'wsl-bwrap';
    this.lastError = null;
  }

  async verify() {
    this.isolated = false;
    try {
      this.isolated = await this.sandbox.verify() === true;
      this.lastError = this.isolated ? null : 'Sandbox verification returned false';
    } catch (error) {
      this.lastError = error.message;
      throw error;
    }
    return this.isolated;
  }

  async run(request, { signal } = {}) {
    if (!this.isolated) throw Object.assign(new Error('WSL worker is not verified'), { code: 'WORKER_UNAVAILABLE' });
    if (!request || request.operation !== 'readonly-command' || typeof request.command !== 'string') throw Object.assign(new Error('Worker accepts only readonly-command requests'), { code: 'WORKER_REQUEST_DENIED' });
    if (request.command.length > 200 || /[\x00-\x1f\x7f]/.test(request.command)) throw Object.assign(new Error('Worker command is invalid'), { code: 'WORKER_REQUEST_DENIED' });
    return this.sandbox.execute(request.command, { signal });
  }
}
