export class WorkerBoundary {
  constructor({ runner = null } = {}) { this.runner = runner; }
  readiness() {
    return { available: Boolean(this.runner && this.runner.isolated === true && typeof this.runner.run === 'function'), mode: this.runner?.mode ?? 'unavailable', reason: this.runner?.isolated === true ? null : this.runner?.lastError || 'No verified low-privilege isolated worker is configured' };
  }
  async run(request, options = {}) {
    const status = this.readiness();
    if (!status.available) throw Object.assign(new Error(status.reason), { code: 'WORKER_UNAVAILABLE' });
    return this.runner.run(structuredClone(request), options);
  }
}
