import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../backend/cli.js', import.meta.url));

test('a second CLI launch creates a fresh session and can resume the previous one', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-sessions-'));
  const run = input => spawnSync(process.execPath, [cli], { cwd: root, input, encoding: 'utf8', timeout: 10000 });
  const first = run('/rename 我的测试会话\nexit\n');
  assert.equal(first.status, 0, first.stderr);
  const firstId = first.stdout.match(/Session: .*\(([0-9a-f-]{36})\)/)?.[1];
  assert.ok(firstId);
  const second = run(`/sessions\n/use ${firstId}\n/history\nexit\n`);
  assert.equal(second.status, 0, second.stderr);
  const newId = second.stdout.match(/Session: .*\(([0-9a-f-]{36})\)/)?.[1];
  assert.ok(newId);
  assert.notEqual(newId, firstId);
  assert.match(second.stdout, /我的测试会话/);
  assert.match(second.stdout, /\(empty conversation\)/);
});

test('bare /rename prompts for a title and returns to the normal command loop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-rename-prompt-'));
  const result = spawnSync(process.execPath, [cli], { cwd: root, input: '/rename\n通过提示修改的标题\n/sessions\nexit\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /请输入要更改的对话名称：/);
  assert.match(result.stdout, /通过提示修改的标题/);
  assert.doesNotMatch(result.stderr, /Unknown command|Startup error/);
});

test('branch commands execute from the CLI command loop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-branches-'));
  const result = spawnSync(process.execPath, [cli], { cwd: root, input: '/branch create experiment\n/branches\nexit\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已创建分支：experiment/);
  assert.match(result.stdout, /experiment/);
  assert.doesNotMatch(result.stdout, /Unknown command/);
});

test('bare /branch shows branch usage instead of being treated as unknown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-branch-help-'));
  const result = spawnSync(process.execPath, [cli], { cwd: root, input: '/branch\nexit\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /分支用法/);
  assert.doesNotMatch(result.stdout, /Unknown command/);
});

test('CLI exposes local message, MCP and plugin management commands', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-service-commands-'));
  const result = spawnSync(process.execPath, [cli], { cwd: root, input: '/messages\n/mcp\n/plugins\nexit\n', encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /暂无消息频道/);
  assert.match(result.stdout, /暂无 MCP Server/);
  assert.match(result.stdout, /暂无本地插件/);
  assert.doesNotMatch(result.stdout, /Unknown command/);
});
