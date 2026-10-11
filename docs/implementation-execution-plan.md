# Personal Agent 分阶段实施计划

本文是 `personal-agent-complete-roadmap.md` 的执行版计划。目标是把个人 Agent 的核心能力做成可被 CLI、Local Gateway 和后续 App 共同使用的服务，而不是在不同入口重复实现业务逻辑。

## 执行规则

每个阶段都必须同时完成：

1. 配置或数据契约。
2. 正常路径、拒绝路径、错误路径、取消/超时路径。
3. CLI 或内部服务入口。
4. 单元测试和跨模块测试。
5. 文档与旧接口兼容检查。
6. 阶段全量回归：`npm test`；涉及 WSL/Windows 时额外运行 `$env:AGENT_TEST_WSL='1'; npm test`。

阶段只有在测试全通过后才标记完成。高风险能力默认关闭，所有 Secret、工具审批和外部写入继续遵循现有 fail-closed 边界。

## 阶段 1：核心契约整理

### 目标

建立所有运行时共享的结构化契约，避免 CLI、Gateway、App、插件和任务系统各自定义数据格式。

### 实现

- `backend/contracts/tool.js`：工具定义、风险、能力、审批、超时、输出限制、取消和审计声明；输入/输出基础 schema 校验。
- `backend/contracts/skill.js`：Skill manifest、来源、版本、摘要、工具/资源权限和生命周期状态。
- `backend/contracts/memory.js`：candidate/active/superseded/deleted 生命周期、作用域、来源、置信度、过期和检索结果。
- `backend/contracts/approval.js`：一次性审批请求、资源指纹、过期、决策和拒绝原因。
- `backend/contracts/events.js`：turn、tool、approval、task、message、provider 和 diagnostics 事件。
- 为现有工具、Skill、Memory 和审批对象增加兼容适配，而不改变现有调用方的公开字段。

### 验收

- 非法契约在边界被拒绝。
- 契约不能携带 API Key 等敏感字段。
- 事件可序列化、有限大小且不包含 Secret。
- 旧测试全部通过。

## 阶段 2：Secrets 和 Provider

### 目标

让用户可以在本机配置 Provider，而 API Key 不再依赖明文 `models.json`。

### 实现

- `backend/secrets/store.js`：Windows DPAPI 加密存储；非 Windows 使用受限权限的加密 fallback，并明确报告能力状态。
- `backend/secrets/redact.js`：日志、错误、Session、Cache、Usage、审计统一脱敏。
- `backend/providers/registry.js`：OpenAI-compatible、Ollama 和自定义 Endpoint 的统一适配层；保留现有 Chat Completions 行为。
- `backend/models.js`：旧明文 API Key 一次性迁移为 Secret reference；兼容读取旧数据并在成功保存后删除明文。
- capability probe：chat、streaming、tools、vision、json、usage。
- 完善 `/models` 相关 CLI 状态和错误分类。

### 验收

- 重启后可使用 Secret reference 请求模型。
- 列表、日志、session、cache、usage export 不出现 Key。
- 迁移中断不损坏旧配置。
- Secret Store 不可用时普通聊天仍可运行，但依赖 Secret 的请求 fail closed。

## 阶段 3：Skill 完整生命周期

### 实现

- manifest 校验、版本/hash、来源和 enabled 状态持久化。
- enable/disable/reload/delete/inspect/validate。
- 工具和资源 allowlist；Skill 只能声明权限，不能自行授予权限。
- `/skills create` 生成模板，写入前显示 diff 并逐次审批，不执行脚本、不自动安装依赖。
- Skill 更新使相关 Query Cache 失效。
- CLI 与后续 Gateway 使用同一个 SkillStore。

### 验收

- 禁用 Skill 不再进入模型工具上下文。
- manifest 变更重新校验且不继承旧授权。
- 非法路径、软链接、超大文件和未知权限被拒绝。

## 阶段 4：Memory 完整生命周期

### 实现

- candidate -> review -> active -> updated/superseded -> expired/deleted。
- global/project/session/task 分层作用域。
- 来源、置信度、重要性、更新时间、访问时间和过期时间。
- 相似内容去重、冲突标记和检索排序。
- Markdown `MEMORY.md` 与 `memory/*.md` 导入/导出。
- `/memory list|search|show|delete|clear|export|import`。
- 只有 active 记忆进入提示词；记忆不能替代当前文件/网络证据。

### 验收

- 自动提取只能生成 candidate。
- 删除、过期和项目隔离有效。
- 导入导出不泄漏敏感值，数据库损坏能给出可诊断错误。

## 阶段 5：工具平台

### 实现

- 统一工具注册、schema、能力、权限、审批、取消、超时、输出限制、审计。
- 进程 start/poll/kill 的安全后台任务接口。
- `ask_user`、进度事件、消息和任务工具。
- 跨区域写入：workspace、external single-file、disposable sandbox、remote/MCP resource 分开授权。
- 写工具必须 preview -> approval ticket -> revalidate -> commit。
- 副作用工具禁止 Query Cache；所有调用产生结构化审计和事件。

### 验收

- 模型不能通过工具名或参数绕过 allowlist。
- 取消能中止实际执行并留下结构化结果。
- 工具输出和错误不会破坏多轮会话。

## 阶段 6：Local Gateway

### 实现

- localhost-only HTTP API：health、models、sessions、turns、approvals、tasks、memory、skills、tools、usage、diagnostics。
- WebSocket/SSE 事件总线，统一流式文本、工具、审批、任务和错误事件。
- Gateway token、Origin 校验、请求体/连接/事件大小限制。
- CLI 先作为 Gateway 的控制面兼容客户端；App 后续只使用 Gateway。

### 验收

- HTTP 和 WebSocket 默认不能远程访问。
- 事件顺序、断线重连和未完成审批可恢复。
- 未认证或跨 Origin 写请求被拒绝。

## 阶段 7：自动化、消息、MCP、插件

### 实现顺序

1. Cron、一次性延迟、Interval、Heartbeat、独立 task session、重试和历史。
2. Webhook/HTTP message channel：send/edit/delete/react/file、幂等、重试、取消、delivery status。
3. `/stop`、`/steer`、`/pause`、`/resume-task`、`/yield` 和排队输入。
4. MCP stdio：server 管理、初始化、工具发现、allowlist、审批、超时、取消、输出限制、Secret reference。
5. 本地插件 SDK：manifest、validate、enable/disable/reload，注册 tools/providers/skills/hooks/channels/tasks；启用前展示权限，插件错误隔离。

### 验收

- 任务重启恢复、失败有限重试，不能无限执行高风险操作。
- 消息副作用不可缓存且具备幂等键。
- MCP/插件不能绕过本项目的权限、审批和审计。

## 最终全量测试

完成七阶段后执行：

```powershell
npm test
$env:AGENT_TEST_WSL = '1'
npm test
```

并补做：

- 新用户从零配置 Provider -> 对话 -> 工具审批 -> Memory -> Skill -> 任务 -> 消息的串联测试。
- Secret 泄漏扫描。
- Gateway HTTP/WebSocket 安全测试。
- 进程、任务、MCP、插件清理测试。
- Node 20 兼容性结论和启动诊断。

## 当前执行批次

本轮先完成阶段 1，并在阶段 1 测试通过后进入阶段 2。若某项底层能力需要操作系统或外部服务，先实现可检测、可拒绝、可测试的边界，再接入真实服务，避免用不可验证的占位逻辑标记完成。
