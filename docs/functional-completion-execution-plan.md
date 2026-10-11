# Agent 功能完整化执行计划

## 目标

在不破坏现有安全、权限、审批、审计和 fail-closed 边界的前提下，补齐以下七类功能：

1. 插件运行时真正接入 Agent 工具注册表和回合执行；
2. 入站消息、会话映射和频道能力；
3. Provider 认证扩展和真实连接验收；
4. Memory 可选语义向量检索；
5. Gateway 常驻自动化和后台服务；
6. 多模态文件、图片、音频和 PDF 能力；
7. 浏览器能力增强。

每个阶段都必须完成实现、单元测试、跨模块测试、拒绝路径测试、资源清理测试，并串行通过普通全量测试和原生 Windows/WSL 全量测试。

## 不变的安全原则

- 插件 entry 不自动执行；所有运行时 Adapter 必须由宿主显式注册、审批并绑定插件 hash。
- 动态插件 Tool 必须经过统一 Tool Schema、PermissionPolicy、Approval、Capability、Audit 和输出限制。
- 入站消息默认不触发高风险工具；消息来源、频道、会话和用户身份必须经过 allowlist 和映射校验。
- OAuth 只保存加密 token 引用，不保存密码；使用 state、PKCE、回环地址和 token 过期校验。
- Embedding 是可选能力；失败时保持 FTS5/关键词检索，不因为语义服务不可用而让 Memory 失效。
- 后台任务必须使用已有 TaskPermissionPolicy 和独立 Session，不能继承交互会话的无限权限。
- 文件、图片、音频和 PDF 都先经过大小、类型、路径、解析时间和内容安全限制。
- 浏览器访问继续执行 URL、DNS、重定向、私网、凭据和响应大小检查。

## 阶段 1：插件运行时接入 Agent

### 实现

- 将 `PluginRuntimeRegistry` 的动态 Tool 注册转换为统一 Tool definition。
- 给动态 Tool 分配稳定的命名空间、schema、risk、timeout、output limit 和 plugin metadata。
- `runTurn` 接收 PluginStore，动态 Tool 进入当前回合的 allowlist 和 visible surface。
- `routeTool` 能调用动态 Tool，并把调用交给 PluginStore 的 hash-bound Adapter。
- 插件注册的 Skill、Hook、Channel、Task、Provider 建立运行时注册表接口；只有对应宿主服务显式消费时才生效。
- 插件 hash 变化、禁用、超时、异常时撤销 Tool surface 和运行时句柄。

### 验收

- 模型能在明确暴露时调用插件 Tool；普通回合不会调用隐藏插件。
- 恶意插件不能增加内置工具、修改 PermissionPolicy、取得 SecretStore 或绕过 Approval。
- 插件工具错误、超时和超大输出不会破坏主回合。

### 阶段 1 当前状态

已完成。动态插件 Tool 已进入 Agent 当前回合的工具 surface，并通过统一 schema、当前回合 allowlist、PluginStore hash 校验、Capability、输出限制和现有权限边界执行。普通闲聊不会暴露插件 Tool。定向测试和普通/原生全量测试均通过。

## 阶段 2：入站消息与频道适配

### 实现

- 增加 webhook 入站 HTTP handler，校验签名、时间戳、重放 nonce、来源 allowlist 和 payload 限制。
- 建立 channel -> external conversation -> Agent session 的持久化映射。
- 入站消息进入独立 Session 或配置的会话，不直接复用 CLI 当前会话。
- 增加消息去重、顺序保护、失败重试、dead-letter 状态和 delivery history。
- 增加最小 Webhook Channel Adapter 契约，后续频道通过 Adapter 扩展。
- 入站消息默认只允许聊天和只读工具；写入、消息发送、MCP、任务和插件操作仍需要审批。

### 验收

- 合法签名消息可进入正确会话；无签名、过期签名、重放、超大 payload 被拒绝。
- 同一消息不会重复执行模型回合。
- 不同频道和不同外部会话不会串线。
- 入站消息不能伪造用户批准或扩大权限。

## 阶段 3：Provider 认证与真实连接能力

### 实现

- 保留 API Key 和 Ollama 无 Key，增加通用 OAuth Provider 契约。
- 使用 Authorization Code + PKCE、state、localhost callback、token refresh 和 revoke 状态。
- Access Token、Refresh Token、Client Secret 只进入 SecretStore。
- Provider registry 暴露 auth methods、capabilities、connection diagnostics 和 model discovery 状态。
- 增加真实连接测试矩阵：非流式、流式、Tool Calling、JSON、限流、认证失败、上下文超限和 usage。
- Provider 不支持 OAuth 时明确显示，不伪造通用登录。

### 验收

- API Key、Ollama 和至少一个 OAuth 流程分别可配置、测试、保存和恢复。
- Token 过期能刷新；state/PKCE 错误拒绝回调。
- 日志、Session、事件、错误和 UI 不泄露 token。

## 阶段 4：Memory 可选语义检索

### 实现

- 保留当前 SQLite FTS5 作为默认和降级路径。
- 增加 EmbeddingProvider 契约和可配置 `keyword`、`semantic`、`hybrid` 三种模式。
- 支持本地 Ollama Embedding 和 OpenAI-compatible Embedding Adapter；不把正文写入日志。
- 增加向量表/索引、模型和维度 identity、embedding cache、失效和重建。
- Hybrid 检索融合 FTS5 BM25、向量相似度、scope、confidence、importance、recency 和 conflict 状态。
- Embedding 不可用、超时或维度变化时自动降级 FTS5，并在 diagnostics 中报告原因。

### 验收

- 关键词、语义和混合模式分别可测试。
- 无 Embedding 配置时现有 Memory 行为不回归。
- 模型/维度变化不会混用旧向量。
- 敏感记忆默认不发送到外部 Embedding Provider，除非用户显式开启。

## 阶段 5：Gateway 常驻自动化

### 实现

- 增加 Gateway 单实例锁、PID/health 状态和优雅关闭。
- 增加 Windows 后台运行入口、开机自启配置和崩溃后有限重启策略。
- Scheduler 使用已有 TaskStore、权限快照、独立 Session、重试、历史和资源配额。
- 增加任务并发上限、运行锁、取消、超时和 dead-letter 状态。
- Gateway API 增加任务诊断、运行状态、取消和恢复接口。

### 阶段 5 当前状态

已完成。`TaskStore` 现在提供任务权限快照、并发上限、单任务运行锁、超时和 `AbortSignal` 取消、有限重试、`dead_letter`、历史记录以及 Gateway 重启后的 `interrupted` 恢复状态；任务状态文件使用串行原子保存，避免 Windows 并发 `rename` 竞态。Gateway 增加 PID/令牌单实例锁、优雅关闭、任务诊断/取消/恢复 API 和审批保护的自启配置 API。`gateway:background` 提供回环地址绑定和有限次数崩溃重启监督器，不执行无限重启，也不自动修改系统注册表或安装 Windows Service。普通全量测试与 `AGENT_TEST_WSL=1` 原生 Windows/WSL 全量测试均通过。

### 验收

- Gateway 常驻时定时任务稳定执行且不会重复并发。
- Gateway 重启后任务状态和审批状态可恢复。
- 任务取消、超时、失败重试和权限拒绝都有结构化历史。
- 没有 Gateway 时，CLI 不声称后台任务仍在运行。

## 阶段 6：多模态能力

### 实现

- 扩展 Tool/Provider 消息契约支持有限图片、音频和文件附件。
- 增加文件类型、大小、数量、分辨率、时长、解析时间和临时目录限制。
- 增加 PDF 文本提取和页数/大小限制；解析失败返回结构化错误。
- 文件内容默认作为不可信数据，不能通过提示注入获得工具权限。
- Provider capability 不支持多模态时明确拒绝或转为用户可见的文本摘要路径。

### 验收

- 支持的图片、音频、PDF 能正确进入模型；不支持类型和超限文件被拒绝。
- 临时文件始终清理；Secret 和本地私密路径不会被意外上传。
- 多模态失败不破坏普通文本回合。

## 阶段 7：浏览器能力增强

### 实现

- 在现有安全 Web Fetch/Search 基础上增加受控浏览器会话抽象。
- 保留 URL/DNS/私网/重定向/凭据/响应大小/取消/审计边界。
- 增加页面分页、可访问文本提取、有限表单预览和用户审批；不自动提交高风险表单。
- 浏览器 Cookie、登录态和下载目录隔离，不进入普通工具上下文。
- 下载文件复用多模态文件安全管线。

### 验收

- 静态页面、分页、搜索和受控浏览器结果可组合使用。
- 私网、文件 URL、凭据 URL、恶意重定向和超限响应继续被拒绝。
- 表单提交、文件下载和外部副作用需要单独审批。

## 每阶段测试命令

```powershell
npm test
$env:AGENT_TEST_WSL='1'
npm test
```

测试脚本固定使用串行文件执行，避免真实 WSL 测试和 CLI 子进程争抢资源导致假失败。

## 最终目标

完成后，除 App UI 外，Agent 应具备：可扩展插件运行时、入站消息、可选 OAuth、可选语义 Memory、可靠常驻自动化、多模态文件处理和受控浏览器能力；所有新增能力仍必须经过统一工具、权限、审批、审计和安全边界。
