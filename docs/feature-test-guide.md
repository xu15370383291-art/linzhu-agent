# Personal Agent 新增功能验收测试手册

本文用于逐项验收最近实现的阶段 1 到阶段 7 功能。每一项都给出对应的自动化测试文件/测试名称，以及可手工执行的入口或验证方法。

## 0. 测试前准备

建议在独立的测试工作区执行手工测试，避免 `/skills create`、Memory 导入、任务和模型配置修改当前项目数据。自动化测试本身会使用临时目录，不会依赖当前项目的业务数据。

在项目目录执行：

```powershell
node --version
npm test
```

Windows/WSL 原生安全测试执行：

```powershell
$env:AGENT_TEST_WSL = '1'
npm test
```

预期：普通环境 0 failures；开启 `AGENT_TEST_WSL=1` 后，所有测试都应通过且没有 skipped。

## 1. 核心契约

### 1.1 Tool Schema

自动化测试：

```powershell
node --test test/contracts.test.js test/platform-services.test.js
```

对应测试：

- `tool contract normalizes safety defaults and rejects invalid risk`
- `registered tools expose complete safety contracts`

手工验收：启动 Gateway 后查看工具契约：

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/api/tools
```

每个工具都应包含名称、风险、审批策略、超时、输出限制、取消和审计相关字段。`write_file`、`send_message`、`mcp_call_tool` 等副作用工具不能显示为无审批。

### 1.2 Skill Manifest

自动化测试：

```powershell
node --test test/contracts.test.js test/skills.test.js
```

对应测试：

- `skill manifest has lifecycle, permissions and stable fingerprint`
- `skills discover validated markdown and load as untrusted text only`
- `invalid skills, linked roots and malformed IDs are omitted`

手工验收：在项目的 `skills/<id>/SKILL.md` 放入合法 frontmatter，然后在 CLI 输入：

```text
/skills
/skills validate
/skills show <id>
/skills disable <id>
/skills enable <id>
```

预期：禁用后 `/skills show` 不能加载；修改 `SKILL.md` 后列表显示 changed/updated，旧的授权工具不应自动继承。

### 1.3 Memory 数据模型

自动化测试：

```powershell
node --test test/contracts.test.js test/memory.test.js
```

对应测试：

- `memory contract keeps candidates separate and ranks fresh important entries`
- `memory suggestions require review, deduplicate and preserve project scope`
- `memory markdown export/import is bounded and filters secret content`

手工验收：

```text
/memory
/remember 偏好使用简体中文回答
/memory search 中文
/memory show <id>
/memory forget <id>
/memory clear project
/memory export
/memory suggest 用户喜欢简洁回答
/memory review <candidate-id> active
```

预期：`/memory suggest` 产生的 candidate 默认不会进入正常 Memory 上下文；只有 review 为 active 后才能被检索。输入 `api_key=...`、`password=...` 等敏感内容必须拒绝。

### 1.4 Approval 模型

自动化测试：

```powershell
node --test test/contracts.test.js test/gateway-auth.test.js test/write-ticket.test.js
```

对应测试：

- `approval is single-use, expires and binds the resource`
- `Gateway token protects HTTP and high-risk actions create approval requests`
- `Gateway approved task can be retried once with the same resource`
- `write tickets are single-use and bound to workspace and immutable preview`

预期：审批过期、资源变更、重复使用审批票据都必须失败。

### 1.5 Event 模型

自动化测试：

```powershell
node --test test/contracts.test.js test/gateway.test.js
```

对应测试：

- `events are bounded, secret-free and delivered through EventBus`
- `Local Gateway SSE emits bounded JSON events`
- `Local Gateway WebSocket completes a localhost handshake and ignores client data`

预期：事件不能包含 API Key、Authorization、Secret 等字段；事件过大或未知事件类型必须拒绝。

## 2. Secrets 和 Provider

### 2.1 Windows DPAPI Secret Store

自动化测试：

```powershell
node --test test/secrets.test.js
```

对应测试：

- `Windows SecretStore protects, resolves, lists metadata and survives a new instance`
- `redactor strips credential fields and known credential values`

手工验收：

1. 运行 `npm run models`。
2. 在页面添加一个模型连接并填写 API Key。
3. 保存后关闭页面，再重新打开。
4. 确认连接仍显示“已配置”，但列表接口和页面列表不显示 Key。

检查落盘文件时只检查是否包含 Key，不要把文件内容复制到聊天：

```powershell
Select-String -LiteralPath .agent-data/models.json -Pattern '你的测试Key'
Select-String -LiteralPath .agent-data/secrets.json -Pattern '你的测试Key'
```

预期：两条命令都没有匹配结果。`models.json` 应该只包含 `secret://...` 引用或 `hasKey` 相关状态。

### 2.2 旧明文配置迁移

自动化测试：

```powershell
node --test test/models.test.js --test-name-pattern "legacy plaintext model keys migrate"
```

预期：旧 `models.json` 第一次被读取后，Key 被迁移到 DPAPI，模型文件中不再存在原始 Key；迁移失败时不能静默继续保存明文。

### 2.3 Provider 列表和 Ollama 无 Key

自动化测试：

```powershell
node --test test/secrets.test.js test/models.test.js --test-name-pattern "provider|Ollama"
```

手工查看 Provider：启动模型配置服务后：

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/api/providers
```

预期至少看到：

- `openai-compatible`
- `ollama`

Ollama 测试应确认请求不带 `Authorization` Header。自动化对应：`Ollama provider stores and requests without an API key`。

### 2.4 连接测试错误分类

自动化测试：

```powershell
node --test test/models.test.js
```

覆盖：成功、鉴权失败、404、限流、服务端错误、网络失败、超时、无效响应、未保存草稿测试。

## 3. Skill 系统

### 3.1 Skill 发现和安全加载

```powershell
node --test test/skills.test.js
```

必须确认：

- 软链接 Skill 被忽略；
- 非法 ID 被忽略；
- 缺失 frontmatter 被忽略；
- Skill 内容只作为 untrusted text；
- Skill 本身不能授予工具权限。

### 3.2 Skill 生命周期

CLI 手测：

```text
/skills validate
/skills enable <id>
/skills disable <id>
/skills show <id>
```

自动化覆盖：`skills discover validated markdown and load as untrusted text only`。启停和指纹变化也可通过 Gateway：

```text
GET  /api/skills
POST /api/skills/<id>/enable
POST /api/skills/<id>/disable
POST /api/skills/<id>/inspect
```

### 3.3 Skill Creator

在交互式 CLI 输入：

```text
/skills create demo-skill
```

确认模板内容后输入 `y`。预期生成 `skills/demo-skill/SKILL.md`；输入其他内容应不写入。生成过程不能安装依赖，不能执行脚本。

## 4. Memory

### 4.1 生命周期和确认

```powershell
node --test test/memory.test.js --test-name-pattern "suggestions require review"
```

手测：

```text
/memory suggest 项目使用 SQLite
/memory list
/memory review <candidate-id> active
/memory search SQLite
```

预期：确认前 `list/search` 不应把 candidate 当 active 返回；确认后才返回。

### 4.2 去重、冲突、作用域和排序

自动化测试：

```powershell
node --test test/memory.test.js
```

覆盖：重复内容去重、project scope 隔离、active 检索、敏感内容过滤、更新时间排序。

### 4.3 Markdown 导入导出

CLI：

```text
/memory export
/memory import D:\path\to\memory.md
```

预期：重复导入不会重复创建；包含 `api_key`、`password`、`token` 等内容的块会被跳过。

## 5. 工具平台

### 5.1 工具 Contract 和权限

```powershell
node --test test/platform-services.test.js test/tool-routing.test.js test/sandbox-boundary.test.js
```

对应测试：

- `registered tools expose complete safety contracts`
- `new side-effect tools require readiness, service and explicit approval`
- `all message actions share message readiness and approval`
- `execution rejects tools not exposed in this turn, including writes`

预期：模型不能只靠伪造工具名、参数或隐藏工具名绕过 allowlist。

### 5.2 受控后台进程

```powershell
node --test test/platform-services.test.js --test-name-pattern "process manager"
```

预期：没有受控 runner 时返回 `PROCESS_UNAVAILABLE`；有 runner 时可以 start/poll/kill，输出有上限。

当前 CLI 默认没有开放宿主机任意后台命令，这是预期的 fail-closed 行为。

### 5.3 跨区域写入和沙箱

普通测试：

```powershell
node --test test/write-ticket.test.js test/external-write.test.js test/writable-sandbox.test.js
```

原生测试：

```powershell
$env:AGENT_TEST_WSL = '1'
node --test test/sandbox.test.js test/writable-sandbox.test.js test/snapshot.test.js
```

覆盖：工作区写入、外部文件写入、临时可写沙箱、差异审批、stale file 检测、硬链接/Junction/ADS 防护。

## 6. Local Gateway

### 6.1 启动和认证

终端 A：

```powershell
npm run gateway
```

如果需要 Token，重新启动前设置：

```powershell
$env:AGENT_GATEWAY_TOKEN = 'local-test-token'
npm run gateway
```

终端 B：

```powershell
Invoke-WebRequest http://127.0.0.1:<port>/api/health
Invoke-WebRequest http://127.0.0.1:<port>/api/models
Invoke-WebRequest http://127.0.0.1:<port>/api/models -Headers @{ Authorization = 'Bearer local-test-token' }
```

有 Token 时，未认证请求应为 401，带正确 Token 才能访问。

自动化测试：

```powershell
node --test test/gateway.test.js test/gateway-auth.test.js test/gateway-admin.test.js
```

### 6.2 Gateway API 一览

只读接口：

```text
GET /api/health
GET /api/providers
GET /api/models
GET /api/sessions
GET /api/memory
GET /api/skills
GET /api/tools
GET /api/tasks
GET /api/messages/channels
GET /api/mcp
GET /api/plugins
GET /api/approvals
```

事件接口：

```text
GET /api/events                 SSE
WebSocket /api/events           WebSocket
```

### 6.3 高风险审批完整手测

以创建任务为例，第一次请求只创建审批，不执行任务：

```powershell
$headers = @{ Authorization = 'Bearer local-test-token'; 'Content-Type' = 'application/json' }
$task = @{ name = 'manual-once'; schedule = @{ type = 'once'; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() + 60000 } }
$taskJson = $task | ConvertTo-Json -Depth 8 -Compress
$pending = Invoke-WebRequest http://127.0.0.1:<port>/api/tasks -Method Post -Headers $headers -Body $taskJson
$pending.Content | ConvertFrom-Json
```

记录返回的 `approvalId`，然后批准同一个资源：

```powershell
$approvalId = (($pending.Content | ConvertFrom-Json).approvalId)
$approvalBody = @{ decision = 'approved'; resource = $task } | ConvertTo-Json -Depth 8 -Compress
Invoke-RestMethod "http://127.0.0.1:<port>/api/approvals/$approvalId" -Method Post -Headers $headers -Body $approvalBody
```

带 `approvalId` 重试原请求：

```powershell
$retry = @{ name = $task.name; schedule = $task.schedule; approvalId = $approvalId } | ConvertTo-Json -Depth 8 -Compress
Invoke-RestMethod http://127.0.0.1:<port>/api/tasks -Method Post -Headers $headers -Body $retry
```

预期：第一次返回 `APPROVAL_REQUIRED`；批准后重试成功；修改 name/schedule 或再次使用同一 approvalId 必须失败。

## 7. 自动化、消息、MCP、插件

### 7.1 Cron、Heartbeat、调度器

```powershell
node --test test/stage7.test.js test/platform-services.test.js --test-name-pattern "heartbeat|cron|task store"
```

手工查看任务：

```text
/tasks
/tasks list
/tasks run <id>
/tasks pause <id>
/tasks resume <id>
/tasks history <id>
```

Gateway host 启动时会自动启动任务轮询器；任务失败按 retry.max 有限重试，不会无限执行。

常驻 Gateway 的新增验收：

```powershell
npm run gateway:background
```

```text
GET  /api/tasks/diagnostics
POST /api/tasks/<id>/cancel
POST /api/tasks/<id>/recover
GET  /api/gateway/autostart
POST /api/gateway/autostart
```

预期：同一工作区第二个 Gateway 被 `GATEWAY_ALREADY_RUNNING` 拒绝；运行中的任务不能重复启动；取消和超时分别记录结构化状态；超过 retry.max 后进入 `dead_letter`；重启后遗留的 `running` 任务变为 `interrupted`，必须显式 recover；高风险 API 第一次请求返回 `APPROVAL_REQUIRED`。后台监督器最多按配置次数重启，不能无限拉起故障进程。

### 7.2 Webhook 消息

自动化测试：

```powershell
node --test test/platform-services.test.js --test-name-pattern "webhook message store"
```

验证内容：

- HTTP 公网 URL 被拒绝，必须 HTTPS；
- localhost HTTP 可用于本地测试；
- Secret 只通过 `secret://` 解析；
- 相同 idempotency key 只发送一次；
- delivery status 会保存；
- message action 需要 message readiness 和审批。

消息动作工具对应：`send_message`、`edit_message`、`delete_message`、`react_message`、`send_file`。

### 7.3 MCP stdio

自动化测试：

```powershell
node --test test/stage7.test.js test/gateway-admin.test.js
```

对应测试：

- `MCP stdio client initializes, discovers, calls and closes with bounded messages`
- `Gateway exposes MCP and plugin administration endpoints`

Gateway 手测：

```text
POST /api/mcp
POST /api/mcp/<id>/enable
POST /api/mcp/<id>/tools
POST /api/mcp/<id>/call
POST /api/mcp/<id>/disable
```

预期：未启用 Server 不能连接；未发现或不在 allowlist 的工具不能调用；超时、Server 退出和客户端关闭都能结束 pending request。

### 7.4 本地插件

创建最小插件目录：

```text
plugins/demo/plugin.json
plugins/demo/index.js
```

manifest 示例：

```json
{
  "id": "demo",
  "version": "1.0.0",
  "entry": "index.js",
  "capabilities": ["tool"],
  "permissions": []
}
```

自动化测试：

```powershell
node --test test/stage7.test.js test/gateway-admin.test.js
```

Gateway 手测：

```text
GET  /api/plugins
POST /api/plugins/validate     { directory: "..." }
POST /api/plugins/demo/enable  { approve: true }
POST /api/plugins/demo/disable
```

预期：manifest 非法、软链接目录、绝对 entry 路径、`..` 路径都被拒绝；启用前需要明确审批；重启 Gateway 后启用状态仍可恢复。

## 8. 最终回归

逐项测试完成后执行：

```powershell
npm test
$env:AGENT_TEST_WSL = '1'
npm test
```

最终验收标准：

- 普通全量测试 0 failed；
- WSL/Windows 原生全量测试 0 failed、0 skipped；
- `.agent-data/models.json` 不包含 API Key；
- Gateway 默认只监听 `127.0.0.1`；
- 高风险 Gateway 请求必须经过 Approval；
- Memory candidate 不会直接进入 active 上下文；
- 禁用 Skill/MCP/Plugin 后不能继续暴露对应能力；
- 工具、消息、任务、MCP 的副作用不能命中 Query Cache；
- 所有任务、MCP 子进程、WebSocket 和测试临时资源都能清理。
