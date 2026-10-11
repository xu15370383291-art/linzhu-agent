# Personal Agent 八项能力建设规划

## 文档目的

本文规划以下八项能力的目标、模块边界、数据模型、接口、权限、安全约束、测试矩阵、依赖顺序和完成标准：

1. Memory 长期记忆
2. Skills 技能系统
3. Sub-agent 子代理
4. 会话 rewind / 分支
5. Query Engine cache
6. 可配置 Hook
7. 精确 token 与成本统计
8. 可写命令沙箱

本文已按阶段落地。Memory、Skills、Hook、只读 Sub-agent、会话分支、Usage、纯 JSON Cache 和 disposable writable diff library 均已有实现及定向测试；可写命令沙箱已通过真实 WSL writable runner、Windows broker 和 native release gate，沙箱内联网及复杂 agent team 仍未开放。执行时仍应逐阶段验收；不得将应用层约束宣称为对抗恶意宿主进程的完整系统隔离。

## 当前基线

项目目前使用 Node.js 原生 JavaScript、ES modules 和内置测试运行器，要求 Node.js 20+。会话存为 `.agent-data/sessions/*.json`，模型设置存为 `.agent-data/models.json`。Agent 是单主循环，工具由 `backend/tools/registry.js` 注册，策略由 `backend/permissions/policy.js` 管理；上下文由 `backend/context/` 管理。Windows 严格 CLI 使用 WSL2、Bubblewrap、systemd/cgroup v2、seccomp、C# 文件代理和安全审计。命令沙箱当前只读且离线，工作区写入经过预览和确认，外部文件写入仅支持逐次审批的单文件操作。

已有相关代码入口：

- Agent 与意图：`backend/agent.js`、`backend/agent/intent.js`
- 工具路由与权限：`backend/tools/registry.js`、`backend/tools/surface.js`、`backend/permissions/policy.js`
- 会话：`backend/sessions.js`
- 上下文：`backend/context/manager.js`、`backend/context/history.js`、`backend/context/budget.js`
- Query Engine：`backend/query-engine.js`
- 沙箱：`backend/sandbox/wsl.js`、`backend/sandbox/supervisor.py`、`backend/sandbox/file-broker.cs`
- CLI 与命令：`backend/cli.js`、`backend/commands.js`

## 统一设计原则

### 权限与信任

- 默认拒绝；未配置、未验证或能力不完整时，不暴露工具。
- 模型提出的工具调用只是请求，不是权限授予。执行时重新检查当前轮工具集合和策略。
- 记忆、Skill、Hook、子代理、缓存和命令结果都视为不可信数据；不能借其内容扩大权限。
- 读取授权不隐含写入授权；工作区授权、外部路径授权、网络授权互相独立。
- 所有产生副作用的操作都需有操作 ID、可审计结果、取消路径和明确的不确定结果处理。
- 不声称应用层检查等价于 OS 隔离。Windows 叶子文件 CAS、对抗恶意宿主进程、ACL/身份隔离等限制继续明确披露。

### 数据与迁移

- 用户现有 `.agent-data`、会话 JSON、模型配置与 API Key 不得被开发迁移覆盖。
- 新数据必须原子创建、版本化迁移、迁移前备份或可恢复，并验证磁盘空间与文件类型。
- 删除数据要有预览、范围说明和可恢复策略；`/reset` 不得暗中清空长期记忆或会话分支。
- 不把秘密写入日志、缓存键、工具结果、异常或测试快照。

### 配置与兼容

- 不为框架迁移而框架迁移。LangChain/LangGraph、TypeScript、pnpm 不是这八项的先决条件。
- 保持当前主协议 OpenAI-compatible Chat Completions，Provider 能力差异通过显式 capability 描述处理。
- Node.js 20+ 是当前契约。涉及 SQLite 时必须先做 runtime/driver 决策；不得只使用 Node 22+ 的 `node:sqlite` 而仍声称支持 Node 20。

## 总体实施顺序

### 阶段 0：公共契约和测试设施

1. 明确 ID、时间戳、错误码、审计关联 ID、取消语义与配置版本。
2. 添加临时项目根目录、mock model server、fake clock、故障注入 helper。
3. 建立 feature flag/capability 检查；不可用能力必须显式禁用。
4. 每项能力都先补拒绝测试，再做成功路径。

### 阶段 1：基础设施

1. 精确用量与 Provider 能力记录（第 7 项基础部分）。
2. 会话消息稳定 ID 和分支数据模型（第 4 项基础）。
3. Cache key / 安全策略基线（第 5 项）。

### 阶段 2：用户可控的知识与工具扩展

1. Memory 存储、确认、检索和管理（第 1 项）。
2. Skills 清单、声明式权限和受控加载（第 2 项）。
3. 可配置 Hook 的声明式配置及受限执行（第 6 项）。

### 阶段 3：执行编排

1. Sub-agent 只读、单层委派（第 3 项）。
2. 会话 rewind、复制分支、显式合并（第 4 项完整能力）。
3. 在前述权限契约稳定后，做可写命令沙箱（第 8 项）。

### 阶段 4：跨模块验收

验证 Memory + Skills + 子代理 + 分支 + Cache + Hook + 成本统计 + 可写沙箱组合时，用户确认、审计、取消、会话持久化和回滚语义一致。

建议按 7、4（数据模型）、5、1、2、6、3、8 的顺序实施。第 8 项风险最高，只有差异导出、文件 broker 与冲突检测完成后才开放。

---

# 1. Memory 长期记忆

## 1.1 目标与非目标

目标是让 Agent 在不同会话间保留少量、可查看、可修改、可删除、可追溯且有作用域的事实，并在相关问题中按预算检索。记忆是背景资料，不是系统指令，也不是当前工作区的实时证据。

第一版不做向量数据库、自动摄取所有对话、网页自动记忆、秘密管理、无确认的高影响事实更新或跨用户同步。

## 1.2 记忆类型与作用域

- `profile`：用户长期稳定背景，例如主要操作系统。
- `preference`：语言、回答格式、工具确认偏好。
- `project`：绑定规范化项目根目录和项目 ID 的技术事实、约束、决定。
- `task`：短期任务状态，必须可过期或标记完成。

作用域：`global`、`project`。第一版不提供对话 session 专属长期记忆，避免恢复会话造成隐式权限变化。Project ID 使用规范化根路径加随机稳定 ID；数据库不以用户可控项目名作为唯一身份。

## 1.3 存储选择

推荐 SQLite + FTS5，数据库位于 `.agent-data/memory.sqlite`。实施前进行驱动 spike：

- 如果项目必须继续支持 Node 20，采用受维护且支持目标 Windows/Node ABI 的 SQLite driver；验证预编译包、升级兼容、无网络安装和打包许可。
- 如果接受将最低版本提升至支持稳定 `node:sqlite` 的 Node LTS，可用内置驱动，但必须同步更新 `engines`、README、启动错误和 CI 矩阵。
- 不允许静默退化到 JSON Memory；数据库不可用时禁用记忆能力但保留普通聊天。

定义 repository 接口，业务逻辑不直接依赖具体驱动。启动时启用 WAL（确认文件系统支持）、外键、busy timeout、迁移版本表；数据库及临时文件排除于外部读取和普通 workspace 工具。

## 1.4 建议数据模型

`memory_items`：

- `id` UUID
- `kind`、`scope`、`project_id`
- `content`、`normalized_content`
- `status`: `candidate|active|superseded|deleted`
- `confidence`、`sensitivity`
- `source_session_id`、`source_message_id`
- `created_at`、`updated_at`、`last_used_at`、`expires_at`
- `supersedes_id`、`version`

另建：

- `memory_fts`：只索引 active 且低敏内容；删除/停用时同步移除。
- `memory_events`：操作 ID、记忆 ID、动作、actor、时间、结果，不记录正文。
- `memory_projects`：项目 ID、规范化根标识、显示名、创建时间。

正文敏感度要有字段，但高敏内容默认拒绝持久化；不要将 API Key、密码、Cookie、token、`.env`、证件/金融数据保存在 Memory。

## 1.5 模块与接口

建议新增：

- `backend/memory/store.js`：迁移、事务、CRUD、FTS 查询。
- `backend/memory/service.js`：校验、候选、去重、作用域和过期规则。
- `backend/memory/retrieval.js`：检索排序、限量、预算截断。
- `backend/memory/redaction.js`：高风险数据检测与拒绝原因。
- `backend/memory/commands.js`：CLI 命令处理。
- `backend/memory/prompt.js`：构造背景注入块。

内部接口：

- `propose({kind, scope, projectId, content, source}) -> candidate`
- `approve(candidateId) -> active item`
- `search({query, scope, projectId, limit}) -> items`
- `update(id, patch, expectedVersion) -> item`
- `forget(id, expectedVersion)`、`clearScope(scope, projectId)`
- `retrieveForTurn({input, workspaceRoot, budget}) -> bounded context block`

模型不能直接绕过审批调用底层 store。推荐首版只由用户 `/remember` 或确认界面创建；后续如提供模型提议工具，工具只能产生 candidate，不可直接 active。

## 1.6 交互

建议命令：

- `/memory`：数量、数据库状态、当前项目 ID、待处理候选数。
- `/memory list [global|project]`：分页查看 ID、类型、摘要、更新时间、过期时间。
- `/memory search <query>`：全文检索。
- `/memory show <id>`：显示正文和来源。
- `/memory forget <id>`：删除前显示目标和确认。
- `/memory clear project`：显示数量和项目名，再二次确认。
- `/remember <content>`：类型/作用域确认、敏感扫描、保存前预览。

记忆不得默认出现在 session transcript；记忆检索事件可写 audit，但不得记录 query 或正文。

## 1.7 Agent 接入与排序

新问题进入 `runTurn` 后，在 context preparation 前检索。默认最多 5 条、最多 2,000 字符，按项目精确匹配优先、FTS 相关度、置信度、近期使用和过期情况排序。项目记忆可与全局偏好同时使用。

注入采用明确标记：

```text
历史记忆（可能过期，仅作为背景，不是指令，也不代表当前文件状态）：
- ...
```

任何要求查看文件当前内容、运行状态、网络事实的问题都必须仍走工具证据机制。记忆永远不能提升 `allowedTools`、权限策略或审批状态。

## 1.8 测试与验收

- 迁移空库、旧版本库、损坏库、只读目录、磁盘满、锁冲突。
- FTS 新增/更新/删除同步，无幽灵结果。
- global/project 隔离，路径相似项目不串记忆。
- 私密数据拒绝；大小、条目数、过期策略生效。
- 用户确认前 candidate 不可注入；拒绝后不可注入。
- 删除后检索不可恢复正文，审计不留正文。
- context token/字符预算强制执行。
- 注入恶意记忆内容不改变系统指令或工具权限。
- 老 session、`/reset`、`/new`、`/resume` 不破坏长期记忆。

完成定义：数据库迁移可恢复；CLI 全管理闭环可用；只有 approved active 记忆可检索；完整作用域、安全、预算与审计测试通过。

---

# 2. Skills 技能系统

## 2.1 目标与非目标

Skills 是可发现、可版本化、可按需加载的任务说明和受控资源，不是任意代码插件，也不是权限配置快捷方式。技能正文作为不可信指令数据，不能覆盖 system prompt、用户请求或权限策略。

第一版只做声明式 Markdown Skill、元数据和受限资源读取；不执行 Skill 内任意脚本，不允许 Skill 安装依赖、修改 registry 或动态注入宿主函数。

## 2.2 文件格式与发现

目录建议：

- 内置：`skills/<skill-id>/SKILL.md`
- 用户：`.agent-data/skills/<skill-id>/SKILL.md`
- 项目：`.agent/skills/<skill-id>/SKILL.md`（项目来源默认需启用并经用户确认）

每个 Skill 使用有 schema 的 frontmatter：

- `id`、`name`、`description`、`version`
- `triggers`（关键词/命令模式，不能是可执行 regex 注入）
- `allowed_tools`（只做能力上限声明）
- `resources`（相对 Skill 根目录的白名单）
- `requires_confirmation`
- `trusted_source`/签名摘要可选

发现时检查路径包含、符号链接/reparse point、文件大小、编码、重复 ID、metadata 类型、版本范围。拒绝 Skill 根目录外的引用和链接逃逸。

## 2.3 模块与接口

新增：

- `backend/skills/manifest.js`：schema 校验。
- `backend/skills/discovery.js`：扫描和来源优先级。
- `backend/skills/loader.js`：加载选定 Skill 与白名单资源。
- `backend/skills/selector.js`：基于意图和显式选择计算候选。
- `backend/skills/commands.js`：`/skills` 管理交互。
- `backend/skills/store.js`：启用状态、信任状态、版本摘要。

接口：

- `listSkills({source, enabled})`
- `inspectSkill(id)`
- `loadSkill(id, {userRequested, allowedTools})`
- `enableSkill/disableSkill`
- `validateResources(id, paths)`

`get_skills` 返回元信息摘要；`load_skill` 只能加载通过校验的 Skill，结果以 bounded untrusted context 传给模型。

## 2.4 工具和权限

第一版可提供模型只读工具：

- `get_skills(query?)`
- `load_skill(skill_id)`

`load_skill` 不执行代码、不授权工具；若 Skill 要使用工具，仍必须由本轮意图路由和 PermissionPolicy 显式开放。Skill 声明 `allowed_tools` 是上限建议，不是 grant。高风险 Skill 首次加载需用户确认来源和内容摘要；更新后摘要变化需重新确认。

`skill-creator` 先做为内置 CLI 命令模板生成器，写入仅限 Skills 专用目录，生成前显示文件清单/diff 并逐次审批。PDF/外部社区 Skill 后续单独验安全，不能默认执行下载包。

## 2.5 资源与版本

资源只能通过 Skill API 读取，路径必须相对、规范化后仍在该 Skill 目录；限制单文件大小、总资源大小和文件数量。禁止资源中包含执行路径、任意 shell、动态 import 或凭据引用并被执行。

用户/项目同 ID 冲突采用显式优先级和警告，不能静默覆盖内置 Skill。记录 manifest 内容摘要，Skill 更改后版本状态失效并重新审核。

## 2.6 测试与验收

- malformed frontmatter、重复 ID、路径逃逸、链接、超大文件拒绝。
- 内置/用户/项目冲突优先级稳定。
- Skill 指令尝试覆盖系统提示、要求泄露文件或调用隐藏工具，均被当作不可信内容处理。
- 未启用、未确认或版本变化 Skill 不加载。
- load 不执行任意 JS/Python/shell。
- tools 声明不能绕过本轮工具集合。
- 资源读取范围、总量和超时受限。
- `/skills` list/show/enable/disable/create 的审批、取消和损坏恢复测试。

完成定义：Skill 能发现、检查、查看、启用、加载、停用；资源访问受限；加载本身不增加权限；恶意 Skill 测试证明边界有效。

---

# 3. Sub-agent 子代理

## 3.1 目标与非目标

让主 Agent 将明确子任务委派给受限 agent，获得独立上下文和可校验结果，再由主 Agent 综合。第一版只允许单层、只读、有限并发的研究型子代理，不允许递归 spawn、后台常驻 Agent、跨会话自主任务或自动文件写入。

## 3.2 架构

新增 `backend/subagents/`：

- `registry.js`：Agent 类型及 capability 声明。
- `runner.js`：生命周期、并发、取消、deadline。
- `context.js`：创建最小子任务上下文。
- `policy.js`：子代理权限的交集策略。
- `result.js`：结构化结果和验证。
- `budget.js`：模型轮数、工具数、token 与时间预算。

子代理不得复用主会话对象并直接 append 消息。输入必须是主 Agent 生成的任务说明、必要上下文片段、只读资源清单和取消信号；结果包含结论、证据引用、未完成项、错误码和消耗统计。

## 3.3 权限模型

有效能力为：

```text
子 Agent 配置 capability
∩ 主 Agent 当前轮 exposed tool set
∩ 用户显式批准的委派范围
∩ 当前环境通过的 sandbox capabilities
```

第一版子代理默认只可调用 `workspace.read`。不得有 `workspace.write`、`external.write`、`sandbox.command`、`network.read`，除非某一专用 agent type 通过单独风险评审并逐次审批。子代理的模型自行请求工具也要走正常 registry 校验。

不要把主会话全部历史、所有记忆、全部 Skill 内容无差别复制给子代理。只传与任务相关的上下文，来源与敏感度保留标签。

## 3.4 调度和结果整合

- 第一版同一 turn 最多 2 个子代理、总深度 1、单个 deadline 和总 token 上限。
- 并发仅用于执行模式明确为并行的只读任务；写操作永不并行委派。
- 主 Agent 等待所有任务或达到 deadline，取消必须传播到模型请求、工具调用和子进程。
- 子代理结果作为 tool observation 返回主模型；结果不能直接展示为最终答案，主模型须整合并披露分歧。
- 子代理失败不自动无限重试；主 Agent 可基于错误决定继续或降级。

## 3.5 接口与审计

内部工具建议 `delegate_task`，参数仅包括 task、agent_type、明确路径范围、是否允许网络（第一版固定 false）。模型不能自行填任意工具 allowlist。派发前给用户展示任务摘要、agent 类型、路径范围、模型/预算和外发内容提醒；允许低风险只读任务走默认策略前必须经过单独产品决策，首版推荐逐次确认。

审计记录 parent_turn_id、subagent_id、类型、状态、duration、token/cost，不记任务正文和文件内容。会话记录子代理摘要与引用，不保存完整隐藏思维链；只保留可见结构化结果。

## 3.6 测试与验收

- 子代理越权写文件、联网、外读均被拒绝。
- 不能递归创建子代理或逃逸路径范围。
- 最小上下文无跨项目/跨分支泄露。
- 并发上限、token/deadline、取消和失败清理。
- 一个失败另一个成功、全部失败、部分结果时主流程有效。
- 结构化结果校验，未配对 tool call 不进入主 transcript。
- 审计含 parent-child 关联但无 payload。
- 子代理结果含恶意指令不会改变主 Agent system/policy。

完成定义：只读子代理在预算范围内独立执行、取消、审计和汇总；全权限交集测试通过；子代理无法造成未批准副作用。

---

# 4. 会话 rewind / 分支

## 4.1 目标与兼容策略

支持查看历史节点、从指定节点创建分支、在当前分支上回退模型可见位置，以及将分支结果以用户审阅方式合并。现有 session JSON 继续可读；迁移采用新增字段的向后兼容方案，不改写旧消息正文。

第一版不物理删除原始 transcript；“rewind”只移动活动分支 head 或创建新分支。这样可以恢复，也不破坏审计与来源。

## 4.2 数据模型

在 session 中增加：

- `schemaVersion`
- `messages[]` 中稳定 `messageId`、`turnId`、`parentMessageId`、`branchId`、`createdAt`
- `branches[]`: `branchId`、`name`、`headMessageId`、`forkedFromMessageId`、`createdAt`、`status`
- `activeBranchId`
- `checkpoints[]`：对应 context compact checkpoint 和摘要版本

旧会话加载时派生单一 `main` branch；首次写入时迁移到新 schema，先写临时文件、fsync、原子 rename，并保留可恢复备份。若迁移失败，不改旧文件。

## 4.3 语义

- 新消息只追加到 active branch 的父链。
- fork 创建新 branch，父分支不变；默认共享 fork 点以前的不可变消息引用。
- rewind 设置分支 head 到选中节点；不删除后续节点。
- 从旧节点继续生成自动创建新 branch，避免覆盖旧未来。
- merge 不是自动拼接两个 transcript；用户选择需合并的消息/总结，展示 diff 后生成新的合并节点。
- compact/reset checkpoint 按 branch 隔离。摘要不能跨分支复用，除非来源前缀完全相同。

## 4.4 CLI 与 API

命令建议：

- `/branches`：列出分支及 head。
- `/branch create <name> [message-id]`
- `/branch use <id>`
- `/rewind <message-id>`：显示目标和将被隐藏的后续轮数，确认后移动 head。
- `/branch diff <a> <b>`：比较用户可见轮次，不显示工具 payload。
- `/branch merge <source>`：显示合并摘要/冲突，用户确认后创建 merge node。

恢复菜单可显示当前分支名。内部服务接口保持 Sessions 层负责持久化，UI 不直接编辑 JSON。

## 4.5 与上下文和工具的关系

当前 `ContextManager` 通过 `startIndex` 压缩线性历史。分支化后需要改为按 active branch 的有序 message projection 取得历史，并在每个分支保存独立 summary/checkpoint。工具调用和结果保持成对；不能从 tool call 与其 tool result 中间 fork/rewind。

Tool result 仍不显示在历史 UI，但恢复上下文时必须保留执行链必要消息。已发生文件写入、命令执行和外部写入不能因 rewind 回滚；UI 明确提示 rewind 只影响后续对话上下文，不撤销副作用。

## 4.6 测试与验收

- 旧 session 兼容读取、迁移中断、损坏文件恢复。
- 分支 head、fork 点、命名和重启持久化。
- 一个分支新增消息不改变另一个分支。
- 不允许在未闭合 tool call 边界处分叉。
- rewind 后旧未来仍可查看和恢复。
- compact/reset 只改变当前 branch。
- merge 保留来源、冲突预览和审批。
- 已执行副作用不会被宣称回滚。
- transcript UI 不泄露工具内部 payload。

完成定义：多分支可持久化、切换、rewind、fork、比较和人工合并；旧 session 无数据丢失；上下文压缩与分支隔离正确。

---

# 5. Query Engine cache

## 5.1 目标与缓存范围

减少完全相同、无副作用模型请求的重复延迟和费用。默认只缓存最终纯文本回答。第一版禁止缓存包含工具调用的响应，禁止缓存有工具定义、`tool_choice != none`、流式过程、Memory/Skill/Hook/子代理运行中的请求，避免缓存跨权限或跳过副作用。

命中缓存只能返回原模型答复，不执行隐藏工具；如果答复依赖实时数据，要由意图策略判定不可缓存。

## 5.2 Cache key

采用规范 JSON + SHA-256。输入包括：

- provider endpoint origin/path（凭据剔除）
- model ID 和模型配置 revision
- temperature/top_p/seed/response format 等实际采样参数
- system prompt hash
- 有序 messages 完整内容、role、tool_call_id 和分支版本
- `tool_choice` 与 tool schema hash
- max tokens、上下文预算策略版本
- streaming mode（首版缓存策略会直接排除 stream）
- memory/skill/hook 版本摘要（只在相应能力明确允许缓存后纳入）

不得把 API key 写入 key 或日志；服务端相同 endpoint 的不同凭据可能返回不同权限结果，首版可用本地 HMAC(installation secret, credential fingerprint) 区分，不存密钥本身。若无法安全区分凭据，关闭该连接缓存。

## 5.3 存储与策略

第一版采用 SQLite cache table 或有界文件 cache；若 Memory 已使用 SQLite，则共用 DB 进程/driver，但用独立表和 quota。字段：key、response JSON、model、created_at、expires_at、estimated tokens、actual usage、response hash、schema version。响应不得包含 API key、headers、隐式工具授权或完整私密路径。

默认 TTL 5 分钟、按连接可关闭；总上限建议 100 MiB、LRU 淘汰、单条上限 1 MiB。403/429/5xx/timeout/invalid response 均不缓存。含工具调用、错误、用户拒绝审批的结果不缓存。

CLI：`/cache status|clear|disable|enable`；清理需要确保只删除 cache namespace，不影响 Memory DB。

## 5.4 与 Session/Branch/Memory 的一致性

分支 head、消息 ID 和工具结果是 key 输入；分支变化必然产生新 key。Memory 注入变化要进 key，或直接关闭相关请求缓存。缓存命中标记 `cached=true` 和原始创建时间，但不伪造 provider latency/usage。命中回答可在 UI 标为来自本地缓存；token/cost 统计记为本地零 provider cost，而不是原请求的再次费用。

## 5.5 测试与验收

- 完全相同输入命中；任一 system/message/tool/model/config/branch/memory 变化 miss。
- 工具调用响应从不 cache；读实时文件/网页意图默认绕过。
- error、partial stream、cancel、拒绝审批不写 cache。
- TTL、LRU、容量限制、损坏条目删除和并发写安全。
- 删除 cache 不删除 session、model config 或 memory。
- 密钥、凭据、秘密正文不进入日志/cache key 明文。
- provider usage 与 cache hit 统计不混淆。

完成定义：明确可解释的 cache eligibility、稳定 key、容量和清除管理、分支/配置隔离与费用统计正确。

---

# 6. 可配置 Hook

## 6.1 目标与非目标

让用户在工具调用生命周期中执行有限的检查或变换：`pre-tool`、`post-tool`、`on-error`。Hook 默认是声明式过滤和策略，不是任意宿主机脚本执行器。

第一版只支持 JSON 配置规则和内置动作，例如 deny、require confirmation、mask output、add bounded metadata。任意 JS、PowerShell、Python Hook 属于后续独立高风险能力，不与本期混做。

## 6.2 配置模型

配置文件 `.agent-data/hooks.json`，schema version、hook ID、event、priority、enabled、tool matcher、条件、动作、timeout、failure policy。Matcher 只允许工具名精确值或已审查的前缀，不允许任意 eval/regex 灾难性回溯。

配置加载时进行 schema validation、最大 hook 数、总字节数和动作白名单校验；含未知字段时拒绝或禁用该条并说明，不 silently ignore 高风险字段。

## 6.3 生命周期和数据契约

- `pre-tool`: 工具参数通过 schema/path 基本校验后、审批前或执行前的固定阶段运行。返回 `continue|deny|require_user_confirmation`，禁止篡改已批准的参数。
- Approval：若 Hook 改变展示内容或影响目标，必须将变更体现在最终审批页面和票据中；批准后冻结 payload。
- Execute：Hook 不可并行重复调用有副作用工具。
- `post-tool`: 只消费结构化结果，可拒绝向模型传递、截断/脱敏输出；不得回滚已完成操作。脱敏必须保留结果有效 schema。
- `on-error`: 可记录本地事件或改变可见错误说明，不得自动重试副作用操作。

Hook 需要独立 context：tool name、correlation ID、scope、摘要化 args、result status；不传密钥或完整文件正文，除非将来经明确授权。

## 6.4 安全与故障策略

- Hook 失败默认 fail closed 对写、命令、外部读写；普通只读 Hook 可以配置 fail closed/fail open，但默认 fail closed。
- 每个 Hook 最多 100 ms（规则引擎）和 8 KiB 输出；总链最多 500 ms。
- Hook 审计只记 ID、事件、动作、结果与耗时，不记 payload。
- Hook 配置只能由用户 CLI/API 编辑，修改前预览 diff；首次启用高影响 Hook 需确认。
- 没有 Hook 能增加工具集合、绕过 User approval、关闭安全审计或改变 sandbox readiness。

## 6.5 CLI 管理与测试

命令 `/hooks list|show|enable|disable|validate|reload`，新增 `/hooks edit` 可输出配置模板或打开安全编辑流程。校验工具报告冲突和优先级，不执行 hook。

测试：顺序确定、deny 优先级、重复事件、超时、异常、无效输出、脱敏后 JSON validity、审批冻结 payload、审计失败、Hook 不得 grant tool、配置原子更新与损坏恢复。

完成定义：不执行任意代码的可配置 Hook 已覆盖核心生命周期，超时/错误策略确定，拒绝绕过测试完整。

---

# 7. 精确 token 与成本统计

## 7.1 “精确”的定义

优先采纳 Provider 返回的 usage，作为该请求的服务端实际统计；provider 不返回 usage 时使用 tokenizer 估算并明确标注 `estimated`。不同服务商 tokenizer、cached tokens、reasoning tokens、tool tokens 定义不一致，不能声称统一精确。成本是依据用户维护的价格表计算出的估算账单，不等价于供应商账单。

## 7.2 Provider usage 规范化

定义 canonical usage：

- `inputTokens`
- `outputTokens`
- `totalTokens`
- `cachedInputTokens?`
- `reasoningTokens?`
- `source: provider|tokenizer_estimate|fallback_estimate`
- `providerRaw` 仅白名单字段，限制体积，不保存秘密。

解析多种兼容字段：`prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens` 等。数值必须为非负安全整数，矛盾值拒收并回退估算。

## 7.3 Tokenizer adapter

新增 `backend/usage/tokenizers/` adapter，根据 model/provider 精确匹配 tokenizer。每个 adapter 有版本号和测试向量。没有已知 tokenizer 时继续使用现有保守估算，并标记 source。不能仅按模型名前缀误判 tokenizer。

OpenAI-compatible provider 未必 OpenAI tokenizer，因此模型连接配置可选 `tokenizerId` 和 capabilities。模型配置 API 校验该字段，默认未知。

## 7.4 价格模型与统计

新增 `backend/usage/pricing.js` 和可版本化价格目录：每百万输入/输出 token 价格、cached input 价格、币种、有效起止时间、来源 URL/用户自定义。用户需能编辑自定义费率，默认不假装知道第三方 endpoint 的价格。

每次成功/失败请求写 usage event：request ID、session/branch ID、model ID、usage source、tokens、price table version、estimated cost、cache hit、timestamp、status。不得保存 messages、key 或 endpoint query credentials。

流式 usage 要支持 SSE 最后 usage chunk（如果 provider 提供）；没有则按实际发出/收到文本 tokenizer 估算。取消流标为 partial usage，不得伪装完整账单。

UI/命令：

- `/usage`：当前会话 token/cost、provider vs estimate 分开显示。
- `/usage daily|monthly`：总计、按模型、按 session 汇总。
- `/usage pricing`：查看/编辑费率和有效日期。
- `/usage export`：导出不含文本/密钥的 CSV/JSON。

## 7.5 上下文预算联动

ContextManager 继续负责发送前 budget estimate；实际 provider usage 到达后只更新用量记录和 `lastUsage`，不回写历史估算。提示区标出 `~` 估算与 provider 实际的区别。成本价格缺失时显示 token 数和“价格未配置”，不得显示 0 元误导。

## 7.6 测试与验收

- usage 字段各 provider 变体、缺失、负数、溢出、互相矛盾。
- 流式末尾 usage、无 usage、异常中断、取消 partial。
- tokenizer adapter golden tests 和版本切换。
- 价格有效时间、缓存输入价、币种和小数精度（整数微单位或 decimal，不用浮点累计）。
- cache hit 不重复记 provider 成本；重试每个真实请求单独统计。
- 不同 session/branch 聚合、时区边界、导出脱敏。
- API Key 和正文从 usage store、审计和导出中不可检索。

完成定义：服务端 usage 原样规范化、估算路径标明不确定性、费率可审计，费用汇总与缓存/重试/流式行为一致。

---

# 8. 可写命令沙箱

## 8.1 目标和安全前提

让模型在隔离环境中运行有限命令并提出文件变更；命令不得直接写用户真实工作区。使用一次性 snapshot/overlay 或 disposable copy，在沙箱内读写；退出后 host broker 收集变化清单，展示 diff，用户批准后逐文件冲突检测并提交。

这不是把现有 WSL 只读 mount 改成 writable。禁止直接以读写方式 bind 用户目录。不得开放网络。必须继续使用 systemd/cgroup、bubblewrap、seccomp、namespace、时间/内存/任务/磁盘配额和取消清理。

## 8.2 生命周期

1. 检查 sandbox readiness、audit 和工具策略。
2. 选择用户批准的 workspace 子树；禁止 `.agent-data`、`.git`（首版整个排除）、`.env*`、依赖、链接、硬链接和特殊文件。
3. 用 Windows handle broker 创建锁定快照，记录每文件身份、原始 hash、大小和元数据；总快照有 entry/depth/byte 配额。
4. 将快照复制到每次调用专属的可写 disposable tree，bubblewrap 只挂载该临时树为 writable；宿主机真实工作区仍未挂载或只读。
5. 审批具体 command、cwd、可写 scope、超时/资源预算；不允许模型把 argv 变更藏在确认文本外。
6. 执行后 sandbox 结束并清理子进程；扫描临时树差异，拒绝新增链接、ADS、硬链接、特殊文件、超限文件和 scope 外变化。
7. 生成 manifest：create/modify/delete/rename 首版建议只允许 create/modify，删除/移动先拒绝；按路径生成 diff，显示截断状态。
8. 用户确认 diff 后 broker 对每个目标核对原始 identity/hash，stale 任一文件则默认整批拒绝（第一版原子批量语义）；stage 全部输出并 fsync，然后逐文件发布。
9. 记录提交结果；不确定提交必须报告每个文件状态，禁止自动盲目重试。

## 8.3 建议接口

工具先提供 `sandbox_command_write` 或 `sandbox_apply`，不要让现有 `sandbox_command` 静默切换语义。参数：command、scope path(s)、timeout profile；没有任意 host path、env passthrough 或 network flag。返回执行输出及 `changeSetId`，由独立 `sandbox_review_changes(changeSetId)` 展示并确认，不在模型拿到结果时自动提交。

Host service:

- `prepareWritableSnapshot(scope, limits)`
- `executeWritable(command, snapshotId, limits, signal)`
- `collectDiff(snapshotId)`
- `validateChangeSet(changeSetId)`
- `approveAndCommit(changeSetId, approvalTicket)`
- `discard(changeSetId)`

ChangeSet 必须进程内短期存储，workspace-bound、单次、5 分钟过期、内容 hash 绑定；不允许 callback 修改批准 payload。

## 8.4 资源限制和系统要求

复用已验证 WSL 启动器的 cgroup 限制：MemoryMax、MemorySwapMax=0、TasksMax、CPUQuota、RuntimeMaxSec；再增加整个临时工作树磁盘配额和总 snapshot/output 限制。`RLIMIT_FSIZE` 不足以限制树总量，需要配额文件系统、project quota 或受控 tmpfs 方案，经实机验证后选定。

明确验证 no network、no host mounts、no WSL interop、no privileged syscalls、进程树退出后消失。若 systemd/cgroup/seccomp/磁盘 quota 任一能力不可验证，工具隐藏并 fail closed。

## 8.5 提交语义与恢复

第一版仅 create/modify，最多例如 100 文件/10 MB diff；每个目标绑定 broker 获取的原始 Windows file identity/hash。所有文件在准备阶段先 stage；发布阶段出现中途失败时需要事务日志和恢复策略：能回滚的文件回滚；不能确定时保留 journal 并报告 partial，不得宣称原子全成或全败。

记录 `.agent-data` 中不含正文的 journal：transaction ID、目标路径受限/哈希化表示、每个文件状态、stage ID、时间。启动恢复扫描只针对自有 stage 命名和 journal，绝不自动删除不认识的文件。

仍不能声称对恶意管理员、宿主 Node 被攻陷或 Windows 所有文件系统竞态提供保护；至少保留最终 leaf replacement 非 CAS 的披露。

## 8.6 测试与验收

- 只读模式保持不变；新工具不可用时旧工具不升级权限。
- command 拒绝、审批取消、超时、输出限制、内存/任务/磁盘耗尽。
- 进程 fork/background child 清理；宿主真实文件始终未被沙箱直接修改。
- snapshot 输入链接/硬链接/ADS/reparse/private path 拒绝。
- diff 捕获 create/modify；恶意文件类型、权限、路径、大小变化拒绝。
- 同步并发修改：任何 stale 文件导致提交按设计拒绝，不覆盖外部更改。
- callback 篡改 command/diff/ticket 无效；ticket replay/expiry/workspace mismatch 拒绝。
- stage 准备失败、磁盘满、broker crash、部分 publish、重启恢复。
- 审计 start/end、审计失败阻止操作、完成后 audit failure 明确 uncertain effect。
- 完整 WSL/Windows 原生测试；至少做系统调用、网络、路径替换和资源消耗攻击测试。

完成定义：真实 workspace 永不作为 writable sandbox mount；只有逐文件 diff 审批后才由 broker 提交；冲突、崩溃、取消和部分失败都有确定或明确不确定结果；native release gate 全过。

---

## 跨模块联动验收

八项分别通过单测不等于整体完成。必须再验证以下流程：

1. Memory 检索随 branch fork 隔离，分支内新增记忆候选默认绑定分支项目 scope，而不是改全局记忆。
2. Skill 加载内容参与 Context 预算、Cache key 和分支 transcript 来源；更新 Skill 后旧 cache 不能复用。
3. Sub-agent 继承当前 branch 的只读消息 projection 和 scope，不能看到其他 branch 的后续消息。
4. Hook deny 在子代理、Skill 工具和可写 sandbox 提交前都一致阻止；post-hook 失败不能伪装回滚已完成副作用。
5. Cache 命中不得跳过用户审批、Hook、审计、当前 workspace 证据读取或 sandbox change review。
6. Usage 对模型重试、cache hit、sub-agent、hook 拒绝、sandbox 二次提交分别计数，不重复或漏算。
7. `/rewind` 不回滚已发生的外部写入或 sandbox commit；界面显示副作用仍存在。
8. Audit、Usage、Memory、Cache 数据损坏分别降级，不互相误删；需要 fail closed 的副作用操作继续 fail closed。
9. Ctrl+C 从主 Agent 传播到子代理、Hook、Query Engine、WSL、diff review；终端 raw mode/alternate screen 最终恢复。
10. 会话保存失败、数据库锁、磁盘满、模型中途断线和 broker 部分提交后，工具调用/结果仍满足 transcript pairing，状态明示。

## 每项标准交付流程

每项合并前必须完成：

1. 设计评审：写清威胁模型、scope、审批、资源、数据生命周期和失败语义。
2. schema/API review：包括版本、兼容、错误码、取消和最大尺寸。
3. 单元与性质测试：成功、拒绝、边界值、损坏、重放和并发。
4. 联动测试：至少与一个现有模块端到端交互。
5. 原生测试：凡涉及 Windows broker/WSL 必须真实运行，mock 不能代替 release gate。
6. 文档：README 功能范围、architecture boundary、操作说明、限制和恢复步骤同步。
7. 验收报告：测试总数、通过/失败/跳过，原生环境版本，未覆盖风险明确列出。

## 建议拆分为独立里程碑

| 里程碑 | 范围 | 放行条件 |
| --- | --- | --- |
| M0 | usage schema、稳定 message/branch ID、runtime/SQLite spike | 基础契约评审通过 |
| M1 | token/cost usage 记录与命令 | Provider 与估算明确区分，费用不误报 |
| M2 | session branch/fork/rewind 基础模型 | 旧会话兼容，副作用不可被伪称撤销 |
| M3 | Query cache | 纯文本安全缓存，工具/实时证据请求绕过 |
| M4 | Memory v1 | 用户确认、作用域、删除、审计、检索预算完整 |
| M5 | Skills v1 | 声明式加载，不执行任意代码，不扩大权限 |
| M6 | Hook v1 | 声明式规则、超时、fail closed、无权限提升 |
| M7 | Sub-agent v1 | 单层只读委派、预算和能力交集完整 |
| M8 | Writable sandbox | disposable write tree、review/commit、冲突恢复和真实原生验收 |

如果实现中发现某里程碑改变权限边界或持久化格式，应暂停后续依赖模块，先更新本文和验收设计。不要以“功能已接上”代替能力验证，也不要在未完成 M8 release gate 时声称可写命令沙箱安全可用。
