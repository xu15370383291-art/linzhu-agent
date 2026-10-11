import process from 'node:process';
import { GatewayAutostart } from './autostart.js';
import { runGatewaySupervisor } from './supervisor.js';

const root = process.env.AGENT_WORKSPACE || process.cwd();
const config = await new GatewayAutostart(root).get();
const controller = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
await runGatewaySupervisor({ root, host: config.host, port: Number(process.env.AGENT_GATEWAY_PORT || config.port), token: process.env.AGENT_GATEWAY_TOKEN || null, maxRestarts: config.maxRestarts, restartDelayMs: config.restartDelayMs, signal: controller.signal, onRestart: info => console.error(`Gateway restart ${info.restart}: ${info.error}`) });
