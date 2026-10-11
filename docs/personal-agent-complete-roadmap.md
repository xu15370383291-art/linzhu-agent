# Personal Agent 个人完整版建设规划

## 1. 产品定位

本项目的目标不是复制 OpenClaw 的多渠道平台和插件生态，而是建设一个：

- 单用户使用
- 本地优先
- Windows 首要支持
- 终端和本地 App 优先
- 模型配置简单
- 工具、Skill、Memory、自动化、消息发送和多轮控制完整
- 高风险操作逐次确认
- 默认不向外暴露服务
- 可以接入少量稳定的外部服务
- 不需要维护大型社区生态

的个人 Agent。

目标用户只需要打开 App，输入 API Key、模型、Provider 和相关设置，就能完成配置并开始使用。复杂的 Gateway、几十种聊天渠道、移动端矩阵和大型插件市场不属于本项目第一目标。

## 2. 与 OpenClaw 的边界

### 2.1 本项目要吸收的能力

从 OpenClaw 中吸收适合个人 Agent 的核心能力：

- 多 Provider 模型配置
- 模型连接测试和能力探测
- 会话、分支和恢复
- Memory 和 Memory 搜索
- Skills 加载和管理
- 多轮工具调用
- Sub-agent
- 定时任务和后台任务
- 消息发送
- Browser/Computer-use 的可选基础能力
- MCP 客户端
- Secrets 管理
- 本地认证和敏感操作确认
- Hook 和生命周期事件
- 诊断、健康状态、导出和恢复
- 高风险工具的 sandbox 和审批

### 2.2 本项目明确不做

第一阶段不做以下 OpenClaw 平台能力：

- WhatsApp、Telegram、Discord、Slack、Signal 等几十种渠道
- 多租户 Gateway
- Team deployment
- 社区插件市场
- ClawHub 类公共 Skill 平台
- iOS、Android、macOS、Windows 原生 Companion App 矩阵
- 复杂 ACP/外部 Agent 生态
- 大规模 Agent swarm
- 云端托管服务
- 企业级账号、组织、计费和配额
- 面向恶意多租户的完整系统隔离

后续如果需要外部聊天渠道，先只实现 1 个通用 Webhook/HTTP Channel，不直接复制 OpenClaw 的所有 Channel。

## 3. 当前基线

当前已经具备：

- OpenAI-compatible Chat Completions
- 本地模型配置页面
- 流式输出和重试
- 工作区读、搜、写、编辑
- 外部单文件读写
- WSL2 + Bubblewrap 只读命令沙箱
- disposable writable sandbox 和差异提交
- Memory v1
- Skills Markdown 加载
- 单层只读 Sub-agent
- 会话分支、rewind
- Query Cache
- Usage 和基础成本记录
- 声明式 Hook
- Web fetch/search
- Windows broker、审计、权限和原生测试

最近一次真实 WSL/Windows 全量测试已经通过 194/194。

当前核心入口：

- Agent：`backend/agent.js`
- CLI：`backend/cli.js`
- 模型：`backend/models.js`、`backend/model-server.js`、`backend/query-engine.js`
- 工具：`backend/tools/registry.js`
- 权限：`backend/permissions/`
- 会话：`backend/sessions.js`、`backend/sessions/branches.js`
- Memory：`backend/memory/`
- Skills：`backend/skills/`
- Hooks：`backend/hooks/`
- Sub-agent：`backend/subagents/`
- Cache：`backend/cache/`
- 沙箱：`backend/sandbox/`

## 4. 目标产品形态

### 4.1 首次启动

用户打开 App 后看到 onboarding：

1. 选择语言。
2. 选择模型 Provider。
3. 输入 API Key 或选择本地模型。
4. 填写 API Base URL、模型 ID、流式开关和上下文窗口。
5. 点击连接测试。
6. 显示能力探测结果：
   - Chat Completions
   - Streaming
   - Tools
   - Vision
   - JSON output
   - Embedding
   - Model usage
7. 设置工作区目录。
8. 选择安全模式：
   - Safe：所有高风险操作确认
   - Personal：允许已确认的低风险操作
   - Advanced：显式开启更多能力
9. 完成后进入聊天界面。

API Key 不通过模型请求发送以外的路径暴露，不显示在列表、日志、审计、缓存或错误信息中。

### 4.2 主界面

第一屏不是营销页，而是实际工作区：

- 当前会话
- 当前分支
- 当前模型
- 当前工作区
- Memory 状态
- Sandbox 状态
- 当前任务/后台任务
- 消息输入框
- 工具调用进度
- 审批卡片
- 取消按钮
- 新建/恢复/分支操作

### 4.3 本地服务形态

初期保持单机进程，但引入一个内部 Gateway 层，负责：

- UI 与 Agent 解耦
- Session API
- Tool API
- Approval API
- Task API
- Memory API
- Skill API
- Secret API
- Health/diagnostics API

默认只绑定 localhost，不提供默认公网暴露。

## 5. 总体架构

```text
App / CLI / Local Web UI
          |
     Local Gateway
          |
  Session + Agent Runtime
          |
  Context / Memory / Skills
          |
 Provider Adapter / Query Engine
          |
 Tools / MCP / Automation / Message
          |
 Permission / Approval / Secrets / Audit
          |
 Sandbox / Host Broker / External Services
```

### 5.1 进程边界

建议拆成以下逻辑组件：

- `app-host`：本地 UI、CLI、配置和用户输入。
- `agent-runtime`：模型调用、多轮循环和上下文。
- `local-gateway`：统一 API、事件、任务和审批。
- `tool-runtime`：工具发现、权限校验和执行。
- `sandbox-runtime`：WSL/Bubblewrap/临时写树。
- `secret-store`：API Key、OAuth、MCP Secret 引用。
- `task-service`：Cron、后台任务、任务状态。

第一阶段可以仍然部署为一个 Node 进程，但模块和 API 边界必须按上述结构设计，避免未来把 CLI 重新改写成 Gateway。

## 6. 功能模块规划

---

# 模块 A：模型 Provider 和登录配置

## A.1 目标

用户不需要编辑 JSON 或环境变量，打开 App 后即可完成模型登录和配置。

## A.2 首批 Provider 适配

不追求 OpenClaw 的数量，首批支持：

1. OpenAI-compatible
2. Anthropic Messages
3. Google Gemini
4. Ollama
5. OpenAI 本地/代理兼容地址
6. 用户自定义 Provider

Provider 通过 adapter 接口统一：

```text
validateConfig()
testConnection()
createRequest()
streamResponse()
normalizeUsage()
listModels()
capabilities()
```

## A.3 登录方式

- API Key
- OAuth（只为明确支持的 Provider 实现）
- 本地无 Key Provider
- 自定义 Endpoint + API Key
- Secret Store 引用

配置页面必须显示：

- Provider 名称
- API URL
- 模型 ID
- Key 状态
- 是否支持流式
- 是否支持工具
- 是否支持图片
- 是否支持 JSON
- 上下文窗口
- 输入/输出价格
- 最近测试时间

## A.4 验收

- 新用户只通过 UI 完成配置。
- Key 不进入日志、session、cache、usage export。
- Provider 错误分类清晰。
- Provider 不可用时不影响已配置的其他 Provider。
- 每个 adapter 有 JSON、stream、tool、usage 测试。

---

# 模块 B：工具系统

## B.1 工具分类

### 工作区工具

- `file_info`
- `read_file`
- `list_files`
- `find_files`
- `search_text`
- `write_file`
- `edit_file`

### 外部文件工具

- `external_file_info`
- `external_read_file`
- `external_write_file`
- `external_edit_file`

### 命令工具

- `sandbox_command`
- `sandbox_command_write`
- `process_start`
- `process_poll`
- `process_kill`

### Web 工具

- `web_fetch`
- `web_search`

### 用户交互工具

- `ask_user`
- `show_progress`
- `notify_user`

### 消息工具

- `send_message`
- `edit_message`
- `delete_message`
- `react_message`
- `send_file`

### Agent 工具

- `delegate_task`
- `list_subagents`
- `wait_subagent`
- `kill_subagent`

### 外部协议工具

- `mcp_list_tools`
- `mcp_call_tool`

## B.2 工具契约

所有工具都必须声明：

- name
- description
- input schema
- output schema
- risk
- required capability
- approval policy
- timeout
- output limit
- cancellation behavior
- audit behavior
- sandbox mode
- whether it may run in background

模型提供的工具名永远不能直接授予权限。

## B.3 缺口

当前最需要补的是：

- 进程后台管理
- 用户问答工具
- 进度卡片
- 消息发送工具
- MCP 工具桥接
- Tool output schema 更严格的统一验证

---

# 模块 C：Skill 系统

## C.1 个人版目标

Skill 不做公共市场，但要支持本地个人扩展：

- 内置 Skill
- 用户目录 Skill
- 项目目录 Skill
- 启用/禁用
- 校验
- 版本摘要
- 资源白名单
- Skill Creator
- Skill 安全预览

## C.2 Skill Creator

新增 `/skills create <id>`：

1. 创建 manifest 模板。
2. 填写名称和描述。
3. 选择允许的工具上限。
4. 选择资源目录。
5. 生成 `SKILL.md`。
6. 显示 diff。
7. 用户确认后写入。

禁止 Skill Creator 自动安装依赖或执行脚本。

## C.3 Skill 生命周期

```text
discovered
  -> validated
  -> disabled
  -> enabled
  -> loaded
  -> updated
  -> revalidated
  -> disabled
```

Skill 更新后：

- 重新校验 manifest
- 重新计算摘要
- 失效相关 Cache
- 不自动继承旧授权

---

# 模块 D：Memory 长期记忆

## D.1 个人版记忆类型

- 用户偏好
- 用户身份/画像
- 项目事实
- 项目决策
- 当前任务状态
- 重要历史结论

## D.2 存储

首选 SQLite；同时保留 Markdown 导入导出：

- `MEMORY.md`
- `memory/*.md`
- `.agent-data/memory.sqlite`

SQLite 是检索数据库，Markdown 是用户可读、可备份、可迁移的来源格式。

## D.3 记忆生命周期

```text
candidate
  -> user review
  -> active
  -> updated/superseded
  -> expired
  -> deleted
```

自动记忆只能生成 candidate，不能直接 active。

## D.4 记忆检索

检索结果必须：

- 有作用域
- 有来源
- 有更新时间
- 有过期状态
- 有置信度
- 有字符预算
- 明确不是实时证据

Memory 不能替代读取当前文件、运行命令或联网获取事实。

---

# 模块 E：自动化与后台任务

这是当前项目相对 OpenClaw 最大的功能缺口之一。

## E.1 任务类型

- 一次性延迟任务
- Cron 定时任务
- 固定间隔任务
- 每日任务
- Heartbeat
- 文件变化触发
- Webhook 触发
- 邮件/IMAP 触发（后续）

## E.2 任务模型

```text
id
name
enabled
schedule
timezone
payload
targetSession
targetAgent
delivery
retryPolicy
timeout
lastRun
nextRun
failureCount
status
```

## E.3 任务执行

任务必须经过：

1. 配置校验。
2. 权限确认。
3. 创建独立 task session 或指定 session。
4. 执行 Agent turn。
5. 记录运行日志。
6. 可选发送消息。
7. 失败重试或通知。

## E.4 CLI

```text
/tasks
/task create
/task list
/task show <id>
/task pause <id>
/task resume <id>
/task run <id>
/task delete <id>
/task history <id>
```

## E.5 安全

- 默认任务不能写外部路径。
- 自动任务不能默认执行高风险命令。
- 任务使用独立 session。
- 任务消息必须标记为自动生成。
- 失败不无限重试。
- 任务日志不得保存密钥和正文敏感信息。

---

# 模块 F：消息发送和多轮控制

## F.1 个人版范围

不做几十种渠道，先实现三种消息面：

1. 当前 App/CLI 会话
2. 通用 Webhook/HTTP Channel
3. 一个用户实际需要的聊天平台适配器

后续再扩展 Telegram/Discord/企业微信等。

## F.2 消息工具

- `send_message`
- `edit_message`
- `delete_message`
- `react_message`
- `send_file`
- `send_image`
- `send_audio`

消息对象包括：

- channel
- account
- conversation
- thread
- sender
- recipient
- message ID
- idempotency key
- delivery status
- retry status
- attachments

## F.3 多轮控制

当前 Agent loop 还应补充：

- `/stop`
- `/steer <instruction>`
- `/pause`
- `/resume-task`
- `/yield`
- `process poll`
- `process kill`
- 运行中追加用户输入
- 排队多条用户消息
- 当前 turn 状态显示
- 模型正在工具调用时的控制

消息发送必须支持：

- 幂等
- 重试
- 失败队列
- 取消
- 部分成功说明
- 目标 channel 校验

---

# 模块 G：轻量插件能力

## G.1 不做大型生态

不实现 OpenClaw 的完整社区市场，只实现本地插件包：

- `plugins/<id>/plugin.json`
- 可注册工具
- 可注册 Provider
- 可注册 Skill bundle
- 可注册 Hook
- 可注册消息 Channel
- 可注册定时任务类型
- 可注册 CLI 命令

## G.2 插件 manifest

```json
{
  "id": "example",
  "version": "1.0.0",
  "entry": "index.js",
  "capabilities": ["tool", "provider"],
  "permissions": ["network.read"],
  "configSchema": {}
}
```

## G.3 插件安全

插件是本地受信代码，必须明确告知用户：

- 安装/启用插件等于执行本地代码。
- 插件不应默认获得所有权限。
- 插件能力必须声明。
- 启用前显示来源、版本和权限。
- 插件更新后重新确认。
- 插件错误不能破坏主 Agent。

## G.4 插件管理

```text
/plugins
/plugins list
/plugins inspect <id>
/plugins enable <id>
/plugins disable <id>
/plugins validate <path>
/plugins reload
```

不做远程插件市场，初期只支持本地目录或 npm 包路径。

---

# 模块 H：MCP

## H.1 目标

让个人 Agent 能连接少量 MCP Server，发现其工具和资源，但仍服从本项目自己的权限、审批、审计和沙箱边界。

## H.2 MCP 支持范围

第一阶段：

- MCP stdio server
- MCP HTTP/SSE server
- tool discovery
- resource discovery
- call tool
- timeout/cancel
- output limit
- server enable/disable

后续：

- OAuth MCP
- MCP prompts
- MCP sampling
- remote server health check

## H.3 MCP 权限

MCP 工具默认不自动暴露给模型。用户需要：

1. 添加 Server。
2. 查看启动命令/URL。
3. 查看声明权限。
4. 测试连接。
5. 选择允许的工具。
6. 选择是否需要每次确认。

MCP Server 不能绕过：

- tool allowlist
- external path check
- network policy
- sandbox policy
- audit
- user confirmation

## H.4 配置

```text
/mcp
/mcp list
/mcp add
/mcp inspect <id>
/mcp tools <id>
/mcp enable <id>
/mcp disable <id>
/mcp remove <id>
```

---

# 模块 I：Secrets 和认证

## I.1 Secrets 目标

API Key 不再明文保存在普通 `models.json` 中，改为 Secret Store：

- Windows Credential Manager 优先
- DPAPI 加密文件作为 fallback
- 本地临时内存 token
- Provider secret reference
- MCP server secret reference
- Webhook secret reference

## I.2 Secret API

内部接口：

- `secret.set(id, value)`
- `secret.get(id)`
- `secret.delete(id)`
- `secret.listMetadata()`
- `secret.rotate(id)`
- `secret.resolve(reference)`

任何普通日志、错误、session、cache、usage、audit 都不能获得 secret 明文。

## I.3 认证方式

个人 App 初期支持：

- 本地设备锁
- App PIN（可选）
- Windows 当前用户身份
- 本地 Gateway token
- localhost origin 校验
- 配置页面 CSRF 防护
- 可选 Tailscale/trusted proxy

不做多租户，但要区分：

- 本地 App 操作者
- 自动化任务
- MCP Server
- 外部 Webhook
- 消息 Channel sender

## I.4 高风险认证

以下操作要求额外确认：

- 读取 Secret
- 外部文件写入
- 沙箱差异提交
- 安装/启用插件
- 添加 MCP Server
- 添加自动化任务
- 绑定消息 Channel
- 导出 session/usage/memory

---

# 模块 J：App 与本地 Gateway

## J.1 App 形态

保留：

- CLI
- 本地 Web UI

新增：

- 本地 Gateway HTTP/WebSocket API
- 聊天页面
- Settings 页面
- Memory 页面
- Skills 页面
- Tasks 页面
- Hooks 页面
- MCP 页面
- Plugins 页面
- Usage 页面
- Approvals 页面
- Diagnostics 页面

## J.2 Gateway API

```text
/api/health
/api/models
/api/sessions
/api/branches
/api/memory
/api/skills
/api/hooks
/api/tasks
/api/mcp
/api/plugins
/api/usage
/api/cache
/api/approvals
/api/events
/api/chat
```

WebSocket 事件：

- `turn.started`
- `assistant.delta`
- `tool.started`
- `tool.finished`
- `approval.required`
- `approval.resolved`
- `task.updated`
- `subagent.updated`
- `turn.completed`
- `turn.failed`

## J.3 远程能力

第一阶段只支持 localhost。远程访问需要明确开启：

- token
- trusted proxy
- Tailscale
- HTTPS

默认禁止公网监听。

---

# 模块 K：多模态能力

当前项目只处理文本。个人完整版建议按需增加：

## K.1 图片

- 图片上传
- 图片预览
- Vision model 输入
- 图片压缩/大小限制
- 图片脱敏提示
- 图片作为工具结果和 session 附件

## K.2 PDF/文档

- PDF 文本提取
- 文档摘要
- 文档写入
- 页面范围选择
- OCR 作为可选 Provider

## K.3 音频/语音

- 音频上传
- 语音转写
- TTS 输出
- 语音消息发送
- Realtime voice 作为可选能力

所有媒体能力必须加入 Context token/size budget，不能无限把二进制内容塞进会话。

---

# 模块 L：诊断、恢复和运维

新增：

- `/doctor`
- `/health`
- `/diagnostics`
- `/repair`
- 配置迁移
- Session 恢复
- Task 恢复
- Cache/Memory 数据库检查
- orphan temporary directory 清理
- broker journal 恢复
- 失败任务重试
- 模型 Provider probe
- Sandbox readiness probe
- MCP Server health
- Plugin health

启动时检查：

- Node 版本
- SQLite capability
- WSL 状态
- Bubblewrap
- systemd user service
- cgroup v2
- libseccomp
- Windows broker 编译能力
- 审计目录
- Secret Store
- 端口占用

## 7. 实施优先级

### P0：个人使用必需闭环

1. Local Gateway API
2. Secret Store
3. Provider adapter 机制
4. Automation/Cron/Heartbeat
5. Message send Webhook
6. 多轮控制 stop/steer/pause/resume
7. MCP stdio client
8. CLI command registry 完整同步
9. `/doctor` 和 health checks

### P1：显著提升使用体验

1. Web Control UI
2. Browser automation
3. PDF/图片输入
4. Plugin SDK v1
5. Skill Creator
6. Memory Markdown import/export
7. Message attachments
8. Sub-agent status/wait/kill/persistence

### P2：高级个人能力

1. Telegram 或 Discord 单渠道
2. OAuth Provider
3. MCP HTTP/OAuth
4. Voice/TTS
5. Desktop computer-use
6. 多 Agent swarm
7. Remote node

## 8. 推荐实施顺序

```text
M11 Secret Store + Node20 SQLite strategy
  ↓
M12 Local Gateway + WebSocket event bus
  ↓
M13 Provider adapters + capability probing
  ↓
M14 Cron/Heartbeat/background tasks
  ↓
M15 Webhook message send + multi-turn controls
  ↓
M16 MCP stdio client
  ↓
M17 Plugin SDK v1
  ↓
M18 Browser + PDF/image
  ↓
M19 Web Control UI
  ↓
M20 optional channel/node integrations
```

## 9. 明确不追求的功能

为了保持个人项目可维护，暂时不做：

- 数十种消息渠道
- 社区插件市场
- 云端托管
- 多租户组织系统
- 企业 RBAC
- 复杂 billing
- 完整 iOS/Android/macOS/Windows companion matrix
- 面向恶意管理员的绝对系统安全
- 自动无确认安装远程 Skill/Plugin/MCP

## 10. 每个模块的完成标准

每个模块必须具备：

1. 明确的配置 schema。
2. capability/readiness 检查。
3. 默认关闭高风险能力。
4. 失败时不影响普通聊天。
5. 逐次审批或显式启用。
6. 结构化错误码。
7. 取消和超时处理。
8. 审计记录。
9. 单元测试。
10. 跨模块测试。
11. Windows/WSL 原生测试（涉及沙箱时）。
12. README 和 architecture 文档同步。

最终验收命令：

```powershell
npm test
$env:AGENT_TEST_WSL = '1'
npm test
```

只有普通全量和真实原生全量都通过，模块才可以标记为完成。
