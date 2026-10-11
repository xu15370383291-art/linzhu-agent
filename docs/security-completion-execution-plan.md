# 安全与审批能力收尾执行计划

## 目标

在不降低现有 Safe 模式安全边界的前提下，完成以下四个剩余阶段：

1. Windows 低权限 Worker；
2. 多文件事务日志与回滚；
3. 插件动态注册边界；
4. App/Gateway 审批续接。

每个阶段必须同时满足：实现、正向功能测试、拒绝路径测试、资源清理测试、普通全量测试和原生 Windows/WSL 全量测试。任何阶段测试失败，都停留在当前阶段修复，不进入下一阶段。

## 统一安全原则

- 模型只能提交结构化请求，不能提交“已批准”字段作为授权依据。
- 审批绑定完整资源指纹、目标路径、内容摘要、参数和有效期，并且只能消费一次。
- 高风险操作先准备和展示，再审批，再重新校验目标，最后由受控执行器提交。
- Windows 主 Node 进程不会因为开启某个模式而自动获得更高权限。
- 所有隔离能力必须有真实探测结果；探测失败就保持 Safe/fail-closed。
- 事件、日志、Session、错误、任务历史和审批元数据不得包含 Secret 或正文内容。
- 插件 entry 永远不会因为发现或启用而自动执行；动态运行时只能通过宿主注册的、哈希绑定的、能力受限的 Adapter。

## 阶段 1：Windows 低权限 Worker

### 目标

提供真实的 Windows 受限 Worker，用于执行明确允许的只读命令和探测；它必须与主 Node 进程分离，不能继承宿主机的写能力、网络能力和无限生命周期。

### 实现步骤

1. 新增 Windows helper 编译和生命周期管理模块。
2. 使用 Windows Restricted Token：删除不必要的 Privilege、禁用管理员 SID、设置低完整性等级，并用 Job Object 限制进程树。
3. Helper 只接受结构化 JSON：operation、command、cwd、timeoutMs、outputLimit；拒绝额外字段、控制字符、超长请求和写操作意图。
4. Worker 启动时创建一次性 Job；超时、取消、父进程退出和协议错误都终止整个 Job 并清理临时资源。
5. 实现探测：确认 Worker 身份与主进程不同、低完整性、不能写入受保护测试文件、不能访问 Secret 目录、不能建立网络连接，并确认失败时不会标记 available。
6. 接入 `WorkerBoundary`、`probeWindowsIsolation`、`collectReadiness` 和安全模式选择。

### 阶段 1 验收

- 真实 Windows 环境可启动并完成只读探测；
- 受限 Worker 不能写入 workspace、`.agent-data` 或临时保护文件；
- 取消和超时清理子进程；
- helper 不存在、编译失败、协议错误或探测不完整时全部 fail-closed；
- Windows/WSL 全量测试通过。

### 阶段 1 当前状态

已完成。`WindowsWorkerRunner` 使用独立 C# helper、Restricted Token、低完整性 SID、Job Object 和受限只读命令协议；Gateway host 会启动并验证它，diagnostics 会报告真实 mode/availability。定向测试和两套全量测试均通过。

## 阶段 2：多文件事务日志与回滚

### 目标

把 ChangePlan 和 WritableSandbox 的多文件提交从“顺序提交并报告部分成功”升级为带持久化事务日志的可恢复提交。不能承诺操作系统不支持的绝对原子性，但必须保证崩溃恢复可审计、可继续或可回滚。

### 实现步骤

1. 定义 transaction journal：事务 ID、阶段、目标、before hash、after hash、备份位置、提交顺序、状态和错误码。
2. prepare 阶段锁定并重新验证所有目标，写入 journal 和受保护备份；备份目录禁止符号链接、硬链接和路径逃逸。
3. commit 阶段逐文件提交，每一步先写 durable journal，再执行 Windows Broker/atomic write。
4. 任一步失败时进入 `rollback-pending`，按逆序使用 before 内容和目标指纹恢复；恢复目标发生外部变化时停止并报告人工复核，不覆盖未知内容。
5. 进程启动和每次新事务前扫描未完成 journal，执行安全恢复或标记为需要用户确认。
6. 事务结果只暴露摘要：committed、rolledBack、manualReview、failed；不写入文件正文。

### 阶段 2 验收

- 中途失败自动逆序恢复已提交文件；
- 恢复遇到外部修改时不覆盖并进入人工复核；
- Node 进程崩溃后可从 journal 恢复；
- journal 轮换、容量限制、权限和清理经过测试；
- 原有单文件写入和 Trash 行为不回归。

### 阶段 2 当前状态

已完成。事务 journal、受保护备份、提交状态、逆序回滚、外部修改人工复核和启动恢复扫描已接入 ChangePlan、WritableSandbox、CLI 与 Gateway host；定向测试和两套全量测试均通过。

## 阶段 3：插件动态注册边界

### 目标

允许受信任插件向 Agent 注册有限的 Tool、Provider、Skill、Hook、Channel 或 Task，但插件不能通过 manifest、模型参数或返回值扩大权限。

### 实现步骤

1. 定义注册契约：类型、ID、版本、插件哈希、schema、风险、权限声明、超时、输出上限和回调句柄。
2. 只允许启用且哈希匹配的插件，通过显式 Adapter 注册；entry 文件不自动 import。
3. 每个注册项进入独立 registry，和内置工具一样经过 schema、surface、PermissionPolicy、Approval、Capability、Audit。
4. 插件返回值必须是结构化 JSON，大小、深度、字符串长度和错误信息都要限制；禁止返回 Secret、函数、路径越界授权或新的工具定义。
5. Provider/Channel/Hook/Task 注册必须使用对应服务的受控接口，不能直接拿到 filesystem、process、SecretStore 或 ApprovalManager 内部对象。
6. hash 变化、插件禁用、注册冲突、超时和异常时立即撤销注册并清理资源。

### 阶段 3 验收

- 动态注册项可列出、验证、启用、撤销；
- 恶意插件不能自动执行、不能隐藏工具、不能扩大路径/网络/消息权限；
- hash 变化后旧 Adapter 不可调用；
- 插件异常不会破坏主 Agent 回合；
- 重启后不会恢复未重新验证的运行时 Adapter。

### 阶段 3 当前状态

已完成。独立 PluginRuntimeRegistry、显式注册审批、hash 绑定、类型/schema/risk 校验、Capability、输出限制、冲突检测、禁用和 hash 变化撤销均已完成；CLI 和 Gateway 提供注册信息查看与显式动态调用边界；定向测试和两套全量测试均通过。

## 阶段 4：App/Gateway 审批续接

### 目标

让 App 可以安全地执行“模型提出操作 -> Gateway 返回审批请求 -> 用户确认 -> 客户端带 approvalId 续接”的完整流程，同时防止票据重放、资源替换、跨 Session 使用和客户端伪造批准。

### 实现步骤

1. 为 turn 建立持久化 turn ID、Session ID、模型请求状态和待处理 tool call。
2. 高风险工具返回结构化 `approval.required`，包含 approvalId、turnId、工具名、脱敏摘要、资源指纹和过期时间，不包含 Secret 或正文。
3. Approval API 绑定 turn、Session、用户/客户端 token、工具、完整参数和资源摘要。
4. 用户批准后，客户端只能提交 approvalId 和原始结构化请求；Gateway 重新计算指纹并消费一次性票据，不能接受客户端 `approved: true`。
5. 支持取消、过期、断线恢复、并发续接和服务重启后的未完成审批恢复。
6. turn 完成、失败、取消和等待审批都发布事件，事件不得泄露模型消息正文或 Secret。

### 阶段 4 验收

- App 可以完成读、写、消息、MCP、Task 和插件操作的审批续接；
- 任何参数、路径、内容、Session、turn 或客户端 token 变化都会拒绝；
- approvalId 只能消费一次；
- 断线重连可查询未完成审批；
- 普通闲聊和只读操作不产生不必要审批。

### 阶段 4 当前状态

已完成。Gateway/App 审批续接支持 turn/session/clientIdentity 绑定、一次性 Approval、脱敏摘要、202 等待审批响应、原始资源指纹重算、重放/改参数/改输入/换客户端拒绝、审批本地持久化和断线恢复查询；定向测试和两套全量测试均通过。

## 每阶段测试命令

定向测试通过后，必须串行运行：

```powershell
npm test
$env:AGENT_TEST_WSL = '1'
npm test
```

两套都通过后，记录测试总数、通过数、失败数和跳过数，再进入下一阶段。

## 最终交付标准

- 四个阶段都有实现和测试记录；
- Safe、Personal、Advanced 的 readiness 状态真实可解释；
- 未实现或系统不支持的隔离能力保持不可用，不伪装成可用；
- 普通全量和原生 Windows/WSL 全量测试均通过；
- 文档、CLI `/doctor`、Gateway `/api/diagnostics` 和手工验收指南保持一致。

## 四阶段收尾说明

阶段 1-4 的实现已全部进入代码：Windows Worker、事务 journal/回滚、插件动态注册边界和 App/Gateway 审批续接。最终是否关闭本执行计划，以最后两套全量测试结果为准。
