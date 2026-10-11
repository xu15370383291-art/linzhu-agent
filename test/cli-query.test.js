import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../backend/cli.js', import.meta.url));

test('CLI recovers from rate limit and request failure, then accepts another question', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-query-'));
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume request body */ }
    requests++;
    if (requests === 1) {
      res.writeHead(429, { 'Retry-After': '0' });
      res.end('temporarily limited');
      return;
    }
    if (requests === 3) {
      res.writeHead(400);
      res.end('invalid request');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `answer ${requests}` } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, [cli], { cwd: root, env: {
    ...process.env, AGENT_API_KEY: 'test-only', AGENT_MODEL: 'mock',
    AGENT_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.end('first\nsecond\nthird\nexit\n');
  const code = await new Promise((resolve, reject) => {
    // This path includes WSL verification plus a rate-limit retry before the
    // first answer; allow the real isolated startup cost on slower machines.
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI did not finish')); }, 20000);
    child.on('error', reject);
    child.on('close', value => { clearTimeout(timeout); resolve(value); });
  });
  assert.equal(code, 0, errors);
  assert.equal(requests, 4);
  assert.match(output, /Agent> answer 2/);
  assert.match(errors, /模型接口返回 HTTP 400|Model API returned 400/);
  assert.match(output, /Agent> answer 4/);
});

test('CLI retains approved writes or fail-closed tool denials after a later model failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-write-'));
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume request body */ }
    requests++;
    if (requests === 2) {
      res.writeHead(400);
      res.end('provider failed');
      return;
    }
    const message = requests === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'write-1', type: 'function', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'saved' }),
      } }] }
      : { role: 'assistant', content: 'still working' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, [cli], { cwd: root, env: {
    ...process.env, AGENT_API_KEY: 'test-only', AGENT_MODEL: 'mock',
    AGENT_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.end('create note\ny\nnext question\nexit\n');
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI did not finish')); }, 10000);
    child.on('error', reject);
    child.on('close', value => { clearTimeout(timeout); resolve(value); });
  });
  assert.equal(code, 0, errors);
  const isolated = !/all tools disabled/.test(errors);
  if (process.env.AGENT_TEST_WSL === '1') assert.equal(isolated, true, errors);
  if (isolated) assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'saved');
  else await assert.rejects(readFile(path.join(root, 'note.txt')), { code: 'ENOENT' });
  assert.match(errors, /provider failed/);
  assert.match(output, /Agent> still working/);
  const files = await readdir(path.join(root, '.agent-data', 'sessions'));
  const sessions = await Promise.all(files.filter(name => name.endsWith('.json')).map(name =>
    readFile(path.join(root, '.agent-data', 'sessions', name), 'utf8').then(JSON.parse)));
  const session = sessions.find(value => value.messages.some(message => message.role === 'tool'));
  assert.ok(session);
  assert.deepEqual(session.messages.slice(0, 4).map(message => message.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.match(session.messages[2].content, isolated ? /Wrote note.txt/ : /TOOL_NOT_AVAILABLE/);
});

test('CLI accepts another question after private file_info is denied', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-denial-'));
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests++;
    let message;
    if (requests === 1) message = { role: 'assistant', content: null, tool_calls: [{ id: 'info-1', type: 'function', function: {
      name: 'file_info', arguments: JSON.stringify({ path: '.agent-data/models.json' }),
    } }] };
    else if (requests === 2) {
      assert.match(body.messages.at(-1).content, /WORKSPACE_ACCESS_DENIED|TOOL_NOT_AVAILABLE/);
      message = { role: 'assistant', content: 'Private file denied' };
    } else message = { role: 'assistant', content: 'Still responding' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const child = spawn(process.execPath, [cli], { cwd: root, env: {
    ...process.env, AGENT_API_KEY: 'test-only', AGENT_MODEL: 'mock',
    AGENT_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  } });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.end('查看 .agent-data/models.json 的文件信息\n你好\nexit\n');
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI did not accept input after denial')); }, 10000);
    child.on('error', reject);
    child.on('close', value => { clearTimeout(timer); resolve(value); });
  });
  assert.equal(code, 0, errors);
  assert.equal(requests, 3);
  assert.match(output, /Agent> (Private file denied|当前没有可用)/);
  assert.match(output, /Agent> Still responding/);
});
