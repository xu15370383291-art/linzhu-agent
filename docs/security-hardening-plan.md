# Agent 安全加固执行计划

## 目标

让模型只能提出结构化操作请求，不能自行扩大路径、工具、网络、消息、Secret 或任务权限。所有高风险副作用都必须经过策略、Capability、审批、目标复核和受控 Broker。

## 已完成基线

- Protected path policy
- External read/write separation
- Change plan file/byte limits
- Single-use Capability Token
- Trash and restore layer
- Task permission snapshot and enforcement
- WSL/Bubblewrap command isolation
- Windows atomic commit broker
- Secret Store and redaction
- Prompt-injection boundary tests

## 本轮阶段

### 阶段 A：统一 Broker 契约

- 结构化操作请求：tool、operation、resource、capability、approval、limits。
- Broker 在执行前统一校验路径、Token、审批、资源配额和 protected path。
- Broker 永远不接受模型直接提供的“已批准”字段。
- Broker 输出只返回结构化结果，不返回 Secret 或内部权限细节。

状态：已完成。CLI、Gateway、Trash、ChangePlan、外部写入、消息、MCP、插件运行时和可写沙箱已接入共享 Broker；事件只记录结构化元数据。

验收：正常提交、拒绝、过期、重放、路径变化、内容变化、配额超限、审计失败均有测试覆盖。

### 阶段 B：红队安全测试

- 相对路径和绝对路径绕过。
- Windows `\\?\\`、UNC、大小写、尾随点、尾随空格、ADS。
- Junction、Symbolic Link、Hard Link、父目录替换。
- Capability 重放、过期、scope 变化。
- 批量操作文件数/字节数耗尽。
- 恶意文件、Skill、网页、MCP 返回内容。
- Task 权限扩大、网络/消息越权。
- Secret 出现在错误、日志、Session、Cache、Usage、事件中的扫描。

状态：已完成当前红队矩阵。普通全量测试覆盖 274 项，原生 Windows/WSL 全量覆盖 274 项；UNC、`\\?\\`、父目录替换和长期任务资源耗尽仍列为后续扩展矩阵。

验收：已覆盖的攻击在副作用发生前失败；原文件保持不变；审计记录不含 Secret 和正文。

### 阶段 C：Worker 边界和运行诊断

- 明确 CLI 主 Node 进程仍是当前用户权限。
- 受控命令继续只能走 WSL/Bubblewrap。
- 文件写入继续只能走 Windows Broker/atomic commit。
- 启动诊断显示 Worker、WSL、Broker、Secret Store、Audit readiness。
- 不在没有系统级隔离能力时假装提供“全电脑安全读写”。

状态：基础边界已完成。Gateway 默认回合、CLI、任务执行器和 WSL Worker 在依赖缺失时 fail closed；Gateway `/api/diagnostics` 和 CLI `/doctor` 会报告 readiness。

Windows Restricted Token + 低完整性 + Job Object Worker 已实现并接入 Gateway host；Worker 只接受受限只读命令，探测失败仍自动回落 Safe。AppContainer/独立低权限账户不是当前实现的必要前提，Node 主进程仍是当前用户权限。

验收：依赖缺失时 fail closed；普通聊天仍可用；工具不会静默回退到宿主机任意执行。

## 已完成的运行时接线

- `npm start` Agent 回合已注入消息、任务、MCP、Trash 和受控进程服务；消息、任务和 MCP 使用共享 OperationBroker。
- 普通闲聊不会暴露消息、任务、MCP、进程工具；只有明确意图才会按工具组暴露。
- Gateway 默认 `/api/turns` 已有安全回合执行器；没有模型、审计或已验证沙箱时明确失败，不回退到宿主机任意执行。
- 定时任务拥有独立 Session、权限快照、工具/路径/网络/消息开关、文件配额、有限重试和历史记录。

## 后续增强项（不属于本轮四阶段未完成项）

1. Windows Worker 的 AppContainer/独立低权限账户增强：当前 Restricted Token、低完整性、Job Object、超时清理和真实探测已完成；更强的 AppContainer 隔离可作为后续增强。
2. 批量写入增强：事务日志和逆序回滚已完成；遇到外部修改时会进入 `manual-review`，后续可继续增强跨进程锁和更强的崩溃注入测试。
3. 插件动态运行时增强：基础动态注册边界已完成；仍不自动加载插件 entry，后续可为每类注册项增加更细的 UI 展示和 Provider/Channel 专用适配器。
4. Gateway 审批与 `/api/turns` 的跨请求续接：已完成 turn/session/clientIdentity 绑定、一次性票据、脱敏摘要、持久化、202 等待审批和续接资源复核。

## 每阶段测试规则

```powershell
npm test
$env:AGENT_TEST_WSL = '1'
npm test
```

只有普通全量和原生全量都通过，阶段才算完成。
