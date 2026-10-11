import { WslSandbox } from '../sandbox/wsl.js';

process.env.PORT ??= '59160';
try {
  if (!await new WslSandbox(process.cwd()).verify()) throw new Error('Sandbox verification returned false');
} catch (error) {
  console.error(`Workbench sandbox startup check failed: ${error.message}`);
  console.error('Run npm run workbench from a normal user terminal. Do not launch it from a restricted agent process. Isolation checks remain enabled.');
  process.exitCode = 1;
}
if (!process.exitCode) await import('./server.js');
