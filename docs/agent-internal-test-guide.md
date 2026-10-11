# Agent 内部功能手工验收指南

本指南只测试 `npm start` 启动的 CLI Agent。测试过程只使用 Agent 内的自然语言、斜杠命令、终端审批和实际工作区变化，不需要启动 Gateway，也不使用 `Invoke-RestMethod`。

## 0. 启动

先配置模型：

```powershell
npm run models
```

在浏览器中填写 Provider、模型 ID、接口地址和 API Key，保存后关闭配置页。然后只启动：

```powershell
npm start
```

建议先准备测试目录：

```powershell
New-Item -ItemType Directory -Force manual-test | Out-Null
Set-Content -LiteralPath manual-test/readme.txt -Value "alpha`nbeta" -Encoding utf8
```

## 1. 普通对话和请求控制

### I-01 普通对话

输入：

```text
你好，请只回复：基础对话正常
```

预期：模型正常回答，回答保存到当前 Session。

### I-02 流式回答

输入：

```text
请写一篇至少五段的中文说明，不要调用工具。
```

预期：回答逐步显示，而不是等全部内容完成后一次显示。

### I-03 取消请求

输入一个要求长回答的问题，在模型输出过程中按 `Ctrl+C`。

预期：当前请求取消，CLI 回到下一次输入，半截回答不能作为完整回答保存。

## 2. Session、Branch、Rewind

### I-04 新建、重命名、列出和恢复

依次输入：

```text
/rename 内部测试会话
/sessions
/new
/sessions
/resume
```

在恢复菜单中选择“内部测试会话”。预期：旧会话仍存在，标题和历史可以恢复。

### I-05 按 ID 恢复

先执行 `/sessions`，复制一个 Session ID，然后输入：

```text
/use <session-id>
```

预期：切换到指定会话。

### I-06 Branch

```text
/branch create experiment
/branches
```

复制新分支 ID，输入 `/branch use <branch-id>`，再输入一条消息，切回原分支。

预期：分支消息不污染原分支。

### I-07 Rewind

先进行几轮对话，执行 `/history`，找到消息 ID 后输入：

```text
/rewind <message-id>
```

预期：模型上下文回退。注意 Rewind 不撤销已经发生的文件、命令或网络副作用。

## 3. Context、Compact、Reset、Cache

### I-08 Context

```text
/context
```

预期：显示上下文估算、输入上限、输出预留、摘要和截断状态。

### I-09 Compact

先进行多轮对话，再输入：

```text
/compact
/context
```

预期：早期完整轮次被摘要，Session 原文仍保留。

### I-10 Reset

```text
/reset
/context
/history
```

预期：旧历史不再发送给模型，但 `/history` 仍能看到本地原文。

### I-11 Cache

```text
/cache
/cache disable
/cache
/cache enable
/cache clear
/cache
```

预期：启用状态、条目、命中和清理结果正确变化。工具调用、流式请求和副作用操作不应命中 Cache。

## 4. Workspace 文件工具

### I-12 file_info

输入：`查看 manual-test/readme.txt 的类型、大小和行数。`

预期：Agent 使用 `file_info`，返回文件信息。

### I-13 read_file

输入：`读取 manual-test/readme.txt 的内容。`

预期：返回 alpha 和 beta。

### I-14 list_files

输入：`列出 manual-test 目录中的所有文件。`

预期：返回 readme.txt。

### I-15 find_files

输入：`查找文件名中包含 read 的文件。`

预期：返回 manual-test/readme.txt。

### I-16 search_text

输入：`搜索当前工作区中内容为 alpha 的文件。`

预期：返回 manual-test/readme.txt。

### I-17 分页

如果测试目录中文件足够多，输入：`列出当前工作区所有文件，一个都不要漏。`

预期：Agent 继续使用 nextCursor；达到限制时必须明确说明结果不完整。

### I-18 越界和私有路径

依次输入：

```text
读取当前工作区上一级目录的文件。
读取 .env 文件。
```

预期：越界、私有路径和环境文件被拒绝，Agent 不能声称读取成功。

## 5. Workspace 和 External 写入

### I-19 写入并批准

输入：`创建 manual-test/approved.txt，内容为 approved-by-agent。`

预览出现后输入 `y`，再在 PowerShell 检查：

```powershell
Get-Content manual-test/approved.txt
```

### I-20 写入并拒绝

输入：`创建 manual-test/denied.txt，内容为 should-not-exist。`

预览出现后输入 `n`。预期：文件不存在。

### I-21 编辑文件

输入：`把 manual-test/readme.txt 中唯一的 alpha 替换成 edited-alpha。`

输入 `y` 后检查文件。旧文本出现多次时必须拒绝 ambiguous edit。

### I-22 外部读取

先在 PowerShell 创建外部文件：

```powershell
$external = Join-Path $env:TEMP 'personal-agent-external-test.txt'
Set-Content -LiteralPath $external -Value 'external-alpha' -Encoding utf8
$external
```

在 Agent 中输入：`读取外部文件 <上面输出的绝对路径>。` 看到逐次审批后输入 `y`。输入 `n` 时不能返回文件内容。

### I-23 外部写入

输入：`把外部文件 <绝对路径> 替换为 external-edited。`

输入 `y` 后检查文件内容；输入 `n` 后文件必须保持原样。

### I-24 并发变化保护

让 Agent 停留在外部写入审批处，在另一个 PowerShell 窗口修改目标文件，再回 Agent 输入 `y`。

预期：身份或内容复核失败，不能覆盖并发修改。

## 6. 沙箱和 Web

### I-25 只读离线命令

输入：`在只读离线沙箱中执行 pwd，然后列出 /workspace 顶层内容。`

批准命令。预期：每次命令都要审批，工作区挂载只读。

### I-26 沙箱网络隔离
ℹ tests 225
ℹ suites 0
ℹ pass 225
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 24478.4583
输入：`在只读离线沙箱中执行 curl https://example.com。`

预期：网络被拒绝，不能访问公网。

### I-27 Disposable writable sandbox

输入：`在可写临时沙箱中创建 sandbox-created.txt，完成后展示差异。`

先批准命令，再批准差异提交。拒绝差异时，宿主工作区不应出现改动。

### I-28 Web Fetch

输入：`读取 https://example.com 并总结，同时给出来源 URL。`

批准联网一次。预期：显示站点审批、返回来源；拒绝时不能声称读取成功。

### I-29 Web Search

如果要测试搜索，先设置 Brave Key 后重新启动 CLI：

```powershell
$env:BRAVE_SEARCH_API_KEY = '你的测试Key'
npm start
```

输入：`搜索 Node.js 官方文档，并访问原始页面核实。`

未配置 Key 时预期是清晰配置错误，不能伪造结果。

## 7. Memory

### I-30 明确保存

```text
/remember 我偏好简体中文和简洁回答
/memory search 简体中文
```

保存提示处输入 `y`。预期可以搜索到该记忆。

### I-31 Candidate 确认

```text
/memory suggest 项目默认使用 SQLite
/memory list
/memory review <candidate-id> active
/memory search SQLite
```

预期：确认前不作为 active 返回，确认后可以搜索到。

### I-32 Memory 注入新会话

保存一条明确偏好后执行 `/new`，再问：`我之前告诉你的回答语言偏好吗？`

预期：Agent 可以使用长期 Memory，但 Memory 不能代替当前文件或网络证据。

### I-33 Memory 导入导出

```text
/memory export
/memory import D:\path\to\memory.md
```

预期：重复导入不重复创建；包含 API Key、密码、Token 的块被过滤。

## 8. Skill、Sub-agent、Hook、Usage

### I-34 Skill 查看和校验

```text
/skills
/skills validate
/skills show <skill-id>
```

预期：非法 Skill 不显示，内容只作为 untrusted text，不执行代码。

### I-35 Skill 启停

```text
/skills disable <skill-id>
/skills
/skills enable <skill-id>
```

预期：禁用后不能加载，启用后恢复。

### I-36 Skill Creator

```text
/skills create manual-skill
```

输入 `n` 时不生成文件；再次执行输入 `y` 时生成 `skills/manual-skill/SKILL.md`。

### I-37 Sub-agent

输入：`委派一个只读子任务，查找 manual-test 中有哪些文件并返回证据。`

预期：子代理只能读取和研究，不能写文件、执行命令或递归创建子代理。

### I-38 Hooks

```text
/hooks
/hooks validate
/hooks reload
```

准备一个 before deny Hook 后，让 Agent 调用对应工具。预期：工具真正执行前被阻止。

### I-39 Usage

完成至少一轮请求后输入：

```text
/usage
/usage session
/usage daily
/usage monthly
/usage pricing
/usage export
```

预期：显示请求、Token、成本；导出不包含消息正文、API Key 或 Authorization。

## 9. 当前 CLI 不能直接验收的功能

以下功能当前有模块级自动化测试，但还没有接入 `npm start` 的完整 Agent 主循环：

- `process_start/process_poll/process_kill`
- `send_message/edit_message/delete_message/react_message/send_file`
- `mcp_list_tools/mcp_call_tool`
- MCP Server 添加和连接
- Plugin 启用、禁用和动态注册
- CLI 创建新任务
- CLI 自动调度 Cron/Heartbeat

在 CLI 中输入：

```text
/messages
/mcp
/plugins
```

当前 CLI 已将消息、任务、MCP、Trash 和受控进程服务接入 Agent 工具回合。手工验收时仍需确认：普通闲聊不会暴露这些工具；明确提出消息、任务或 MCP 请求时才出现对应工具，并且每个副作用都必须经过本地确认或 fail-closed。

它们只能先运行模块级测试：

```powershell
node --test test/platform-services.test.js test/stage7.test.js test/gateway-admin.test.js
```

如果你的目标是“所有新增功能都必须通过 `npm start` 内部测试”，应继续用模型模拟服务验证消息、任务、MCP 和拒绝路径；这些 Store、ProcessManager 和消息/MCP 工具已经接入 `backend/cli.js` 的 `PermissionPolicy` 与 `runTurn`。

## 10. 最终回归

完成 CLI 可测项目后，退出 Agent，执行：

```powershell
npm test
$env:AGENT_TEST_WSL = '1'
npm test
```

最终要求：普通全量和 WSL/Windows 全量均为 0 failed；拒绝操作没有副作用；Agent 不声称执行未成功的工具；Memory candidate 未确认前不进入 active；禁用 Skill 后不可加载；Rewind 不虚假声称撤销外部副作用；Secret 不出现在 CLI 输出、Session、日志、Usage 和 Cache 中。
