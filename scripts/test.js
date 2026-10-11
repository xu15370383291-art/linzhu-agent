import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const scope = ['all', 'backend', 'frontend'].includes(args[0]) ? args.shift() : 'all';
const options = args;

const files = [];
async function discover(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'fixtures') {
      if (scope !== 'backend' || entry.name !== 'frontend') await discover(file);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(file);
  }
}
await discover(path.join(root, 'test', ...(scope === 'frontend' ? ['frontend'] : [])));
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...options, ...files.sort()], {
  cwd: root, stdio: 'inherit', windowsHide: true,
});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
