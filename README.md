# Personal Agent

## 项目目录

项目已按职责整理：`backend/` 为后端和 CLI，`frontend/` 为工作台和模型配置界面，`database/` 为 SQLite 连接层，`test/` 为测试和固定样本，`scripts/` 为运行与评测脚本，`docs/` 为文档，`skills/` 为项目技能，`artifacts/` 为生成的截图和评测报告。真实数据库、模型配置、会话和记忆仍保存在 `.agent-data/`，不迁移、不删除，也不提交到 Git。

详细结构和命令见 [项目目录说明](docs/project-layout.md)。在项目根目录使用原有启动命令；`npm test` 运行全部测试，`npm run test:backend` 只运行后端测试，`npm run test:ui` 运行全部前端测试。

## 个人版沙箱

当前按个人 Agent 的实用范围维护，不继续建设企业级隔离。保留只读离线命令、工作区文件工具、逐次审批写入与外部读取、超时取消、资源限制和审计。不开放宿主机任意命令、可写命令或直接联网，也不要求创建专用 Windows 账户和部署防火墙服务。

运行 `npm start` 后会显示沙箱状态。就绪时可以直接使用工具；不可用时仍能聊天，但工具禁用，并提示检查依赖与权限。启动探测使用独立临时目录，不会因为项目里有大文件就把所有工具禁用。

文件工具现在按操作准备快照：`read_file` 只复制目标文件，`list_files` 只复制当前层名称，`find_files` 复制名称而不复制正文，`search_text` 跳过超过原有 100 KB 搜索上限的正文，`file_info` 保留原始大小和修改时间。目录中的大文件不会影响其他小文件读取、列目录和名称查找。条目数、深度及总复制量仍有限制；命令仍需要完整的受限工作区快照，超限会拒绝并提示缩小范围。

根据参考图逐步搭建的本地个人 Agent。目前具备 CLI 基础与本地模型配置界面，不是图中全部功能的实现。

项目骨架、技术栈、权限规则与安全限制见 [架构说明](docs/architecture.md)，完整建设步骤见 [沙箱计划](docs/sandbox-plan.md)。Windows 上启动隔离自检通过后，工作区和外部只读文件工具由 WSL2 + Bubblewrap 中的受限进程读取；文件写入仍由宿主 Node.js 进程在差异预览和逐次确认后提交。CLI 强制要求沙箱和安全审计可用；失败时所有工具禁用，不会自动退回宿主机读取，普通聊天和会话功能仍可使用。网页工具通过独立受限传输访问；不开放宿主机任意命令执行。
`sandbox_command` 使用 WSL2 Ubuntu + Bubblewrap 执行只读命令。`sandbox_command_write` 使用 disposable writable copy，命令期间不挂载真实工作区，结束后收集差异并逐文件审批，再由宿主 broker 提交；沙箱内联网仍关闭。命令逐次确认，15 秒超时、每条输出流最多 64 KB。文件读取 worker 的输出上限为 256 KB、超时 10 秒。所有沙箱进程使用共同启动器和 Linux 监督进程，Ctrl+C 可取消执行，超时或退出时清理进程组，PID namespace 退出后销毁剩余子进程。逐进程上限为地址空间 512 MiB、CPU 时间 10 秒、128 个文件描述符、单文件 8 MiB、禁止 core dump；NPROC 64 是按真实用户计算的限制，**不是整个进程树的总内存、总 CPU 或磁盘配额**。私有路径被遮蔽，链接和硬链接拒绝。外部只读操作批准后仅挂载单个目标文件或目录，并在批准后与读取完成后复核身份；挂载瞬间的并发替换风险未消除。

写入预览具有绑定当前工作区的单次凭据，5 分钟过期，内容变化或重复提交会被拒绝。安全审计保存在 `.agent-data/security/audit.jsonl`，记录工具名、开始/结束状态、关联 ID 和耗时，不保存文件正文、查询文本、命令或密钥；超过 2 MB 时保留一份 `.previous` 后轮换。日志无法写入时阻止后续工具调用；如果操作完成后的日志失败，会明确提示操作可能已完成，不能盲目重试。该日志不是防篡改取证日志，Windows ACL 仍沿用当前用户权限。

最新系统边界：工作区和外部读取先由 Windows 句柄代理生成受限快照，再只读挂载到 WSL；复制期间锁住祖先路径和文件，不再直接挂载用户的实时目录。单次快照最多 5,000 项、深度 32、单文件 2 MB、合计 32 MB，超过则拒绝，因此大型项目可能需要后续的按需快照支持。代理使用系统已有的 .NET Framework C# 编译器构建，不需要安装 SDK。严格 CLI 写入通过该代理进行暂存和原子发布，不先截断原文件；叶子文件校验到替换仍不是无竞态比较交换。

WSL 执行现在还必须具备用户级 systemd、cgroup v2 和 `libseccomp.so.2`。整树限制为 384 MiB 总内存、禁止 swap、64 个任务、100% CPU 配额、20 秒服务生命周期；原有 15 秒命令/10 秒读取限制仍保留。子进程继承 `no_new_privs` 和 seccomp 拒绝规则。以上补充了前述逐进程限制，但主 Node 进程与 Windows 代理仍是当前用户权限，尚不是低权限账户或服务隔离；可写命令、受控联网、Windows 专用账户/ACL/防火墙尚未实现。

工具按 `workspace.read`、`workspace.write`、`external.read`、`external.write`、`sandbox.command` 分组。意图路由筛选模型可见工具，执行器也只接受本轮开放的工具。默认 Safe 模式仍使用外部读取审批和写入审批；Workbench/CLI 可切换到 `personal` 个人文件模式。个人文件模式允许模型根据用户意图读取、创建和编辑普通绝对路径，操作仍经过受保护路径、链接、硬链接、文件一致性和审计检查。检测到目标属于其他项目根目录时，个人模式拒绝写入；删除、命令、联网、消息、任务、MCP 和插件不会因个人模式自动放行。个人模式可通过 Workbench 权限菜单或 CLI `/security-mode personal` 开启，切回 Safe 使用 `/security-mode safe`；模式切换立即保存，当前正在执行的回合保持原策略，下一回合立即使用新模式，不需要重启。

工具注册表提供 `file_info`、`read_file`、`list_files`、`find_files`、`search_text`、`write_file`、`edit_file`、`external_write_file` 和 `external_edit_file`。`file_info` 查看类型、字节大小、修改时间和可用时的文本行数；`read_file` 可用 `startLine` / `lineCount` 按行读取（单次最多 200 行，文件最多 2 MB）；`find_files` 按文件名片段查找，`search_text` 查找文件内容。`list_files` 默认返回 `{items, nextCursor}`，搜索结果也包含 `nextCursor` 供后续调用。游标只在当前进程有效、10 分钟后过期；目录列表翻页时如果条目变化会要求重来。每页最多扫描 2,000 项，结果仍有上限。用户要求全部结果时，Agent 会优先继续翻页；如果仍有未读取的页，回答会明确标注只检查了部分结果。`edit_file` 和 `external_edit_file` 只替换恰好出现一次的指定旧文本；所有写入工具都先展示差异，再逐次询问，默认拒绝。交互终端的审批页可用上下键、PgUp/PgDn 翻阅已生成的预览，只有按 `y` 才批准，按 `n`、Esc 或 Ctrl+C 拒绝；超过 200 行的差异会标明预览已截断。如果文件在确认期间变化，写入取消。高置信度的工作区事实问题会要求模型先取得工具证据；模型漏调用时会有限重试。工具结果包含错误码和成功状态。默认每回合最多 24 轮模型循环、64 次工具调用、连续 5 次工具失败；可通过 `AGENT_MAX_ROUNDS`、`AGENT_MAX_TOOL_CALLS` 和 `AGENT_MAX_CONSECUTIVE_FAILURES` 调整，但硬上限分别为 64、256 和 8。若工具已成功执行而后续模型请求失败，已发生的操作与失败说明仍会写入当前会话。

## 上下文管理

模型连接页可以设置上下文窗口和输出预留 tokens；旧配置默认按 32768 / 4096 估算。请按实际服务商的模型文档填写，`/context` 显示的用量是保守估算，不保证与服务端 tokenizer 完全一致。每次请求会预留输出和安全余量，历史工具结果只在发送给模型的视图中截断，本地会话原文不变。较早的完整轮次在预算不足时会由当前模型生成摘要，保留近期三轮原文。摘要请求使用模型 API，可能产生费用；失败时不提交压缩边界。服务端仍报上下文超限时只在上下文确实缩短后重试一次。

- `/context`：查看当前预算、估算用量、摘要和工具结果截断情况。
- `/compact`：手动压缩较早的完整轮次，至少保留最近一轮；历史原文仍在本地会话文件中。
- `/reset`：清空当前会话发送给模型的历史视图，但不删除本地会话原文。
- `/new`：创建完全独立的新会话。

Gateway 回合会持久化任务计划和步骤状态。Workbench 会显示理解需求、工具执行、审批等待、成功、失败、取消和 Gateway 重启中断等状态；失败或取消的终态回合可以从原始用户请求重新创建一个受绑定的新回合，不会重复提交旧回合本身。重试前会校验会话中的用户请求没有被修改，旧计划只作为恢复参考，不会授予新的工具权限。

当模型判断存在多个合理目标且无法从上下文可靠确定时，可以调用 `ask_user` 暂停当前 Gateway 回合。Workbench 会显示 2-8 个选项，用户可用上下键切换并按 Enter 选择；选择只作为当前任务的补充上下文，不授予权限，也不会直接执行副作用操作。选择会校验客户端、回合和选项 ID，之后继续原回合。没有交互式用户界面的后台运行方式不会暴露此工具。

Workbench 输入框上方可以通过“浏览文件夹”选择项目工作区，也可从最近项目切换。选择项目后发送第一条消息时创建绑定该目录的新会话；同一项目可以有多个彼此独立的会话。已有会话保持普通会话，不会自动迁移。项目会话的相对文件路径和 `sandbox_command` 以绑定项目目录为根；明确提供绝对路径时仍可使用已有外部文件工具处理其他位置，继续遵守当前安全模式的确认、路径检查和审计。项目路径保存在主工作区的 `.agent-data/sessions/` 会话记录中，最近项目列表保存在 `.agent-data/projects.json`；目录被移动或删除后，项目会话会明确报错，不会静默切回主工作区。Windows 使用系统文件夹选择器，取消选择不改变当前工作。

当前只处理文本及 OpenAI 兼容 Chat Completions 消息；没有图片 token 估算或跨会话聊天原文记忆。长期记忆是独立的、用户可审核的 SQLite 记录，不等同于完整保存和召回所有历史对话。不要依赖摘要保留早期对话的逐字细节。

## 模型配置界面

在项目目录运行 `npm run models`，终端会显示一个 `http://127.0.0.1:<端口>/` 地址，在本机浏览器打开。界面可以新增、编辑、删除、测试并选用模型。配置名称、Provider、模型 ID、基础 API 地址（自动拼接 `/chat/completions`）或完整请求 URL，以及 API Key。当前支持 OpenAI-compatible 和 Ollama/本地无 Key 连接；Provider registry 会记录 Chat、流式、工具、JSON 等能力状态。保存后在交互式 CLI 用 `/models` 打开键盘菜单，也可使用 `/models use <连接名称>`。CLI 每次请求会读取当前选中的模型。

模型元数据存放于 `.agent-data/models.json`，API Key 通过 Windows DPAPI 保存在 `.agent-data/secrets.json`，模型文件只保留 `secret://` 引用。旧版本明文 Key 会在读取并成功迁移后自动删除；迁移失败会 fail closed，不会静默继续写明文。接口与列表不会回传 Key，也不要把本地配置端口暴露到外部网络。测试连接使用页面当前填写的参数（包括未保存的新增或修改），不会保存配置或切换当前模型；会发送一条非流式最小请求，可能产生少量费用。页面显示耗时或鉴权、地址/模型、限流、服务端、网络、格式、超时等诊断；成功仅证明此非流式请求可用，不代表流式输出或工具调用一定兼容。模型连接默认启用流式输出；如果兼容服务不支持流式协议，可在连接设置里关闭。

### Local Gateway

运行 `npm run gateway` 可启动仅监听 `127.0.0.1` 的本地服务，提供统一的 Models、Sessions、Memory、Skills、Tools、Tasks、Messages、MCP、Plugins、Approvals、Diagnostics 和事件 API，并提供默认的安全 `/api/turns` 回合入口。需要跨进程访问时设置 `AGENT_GATEWAY_TOKEN`，客户端使用 `Authorization: Bearer <token>`；默认不监听公网。事件可通过 `/api/events` 使用 SSE 或 WebSocket 订阅。默认 Gateway 回合在模型、审计或已验证沙箱不可用时 fail-closed，不会静默执行宿主机高风险操作。

常用 CLI 管理入口包括：`/providers`、`/skills`、`/memory`、`/tasks`、`/messages`、`/mcp`、`/plugins`。Skill 是不执行代码的 Markdown 扩展；Memory 支持 global/project/session/task 范围、关键词检索和中文短语回退，自动建议先进入 candidate，确认后才会进入长期上下文；可用 `/memory candidates` 查看待审核记录，使用 `/memory review <id> active supersedes=<旧记忆 ID>` 让新记忆取代同范围旧记忆。用户明确说“记住”“以后都”“我偏好”或“本项目采用”时，系统只创建候选，不自动启用。记忆会保存来源类型、有限长度的原始表达和提取理由，并记录创建、审核、编辑、取代、删除和恢复版本；可用 `/memory history <id>` 查看历史，`/memory restore <id> <版本号>` 恢复版本。任务支持 once、interval、daily、cron 和 heartbeat；Webhook 消息必须显式启用并使用幂等键；MCP Server 和本地插件必须逐个查看权限并审批。

### Gateway 常驻自动化

任务调度器只在 Gateway 进程运行期间执行。普通启动方式仍是：

```powershell
npm run gateway
```

如果希望 Gateway 在异常退出后有限次数重启，可使用：

```powershell
$env:AGENT_WORKSPACE = (Get-Location).Path
npm run gateway:background
```

后台入口默认只监听 `127.0.0.1`，使用 `.agent-data/gateway.lock` 防止同一个工作区启动多个 Gateway；锁包含 PID 和随机令牌，正常关闭会清理，已不存在的进程留下的锁可以被安全回收。重启次数和等待时间有上限，不会无限重启故障进程。该入口不是 Windows Service 安装器，也不会擅自修改注册表或开机启动项；开机自启配置只保存在 `.agent-data/gateway-autostart.json`，由后续宿主安装方式读取。

常驻任务的状态保存在 `.agent-data/tasks.json`。每个任务都有独立权限快照、运行锁、并发配额、超时、取消、有限重试和死信状态；Gateway 重启时遗留的 `running` 任务会标记为 `interrupted`，不会自动重复执行，必须显式恢复：

```text
/tasks diagnostics
/tasks cancel <task-id>
/tasks recover <task-id>
/tasks history <task-id>
```

Gateway API 对应接口包括 `GET /api/tasks/diagnostics`、`POST /api/tasks/<id>/cancel`、`POST /api/tasks/<id>/recover` 和 `GET/POST /api/gateway/autostart`。创建、运行、暂停、恢复、取消、死信恢复和自启设置都是管理操作，需要通过 ApprovalManager；任务本身不会继承交互会话的审批或无限权限。没有运行 Gateway 时，CLI 仍可以查看和手动运行任务，但不会声称后台调度正在运行。

模型请求对网络故障、HTTP 429 和 5xx 最多重试两次（合计三次请求），限速时最多等待五秒后重试；鉴权和请求参数错误不会重试。流式响应开始后断开不会重新发送，以免重复工具调用。交互终端中回答会逐步显示，Ctrl+C 可取消等待中或生成中的模型请求；不完整回答不会作为完整消息保存。流式输出和重试并不意味着服务端操作可以撤销。

## 运行

一键自动评测：`npm run perf:smoke` 验证评测流程，`npm run perf:local` 执行不调用外部模型的本地评测，`npm run perf:real -- --allow-paid` 显式启用真实模型评测。测试使用独立工作区和端口，不停止现有 Workbench；结果保存至 `artifacts/performance/<批次>/report.md`。自动验收、指标口径、依赖跳过和成本限制见 [一键自动评测说明](docs/auto-evaluation.md)。先用 `npm run perf:test` 验证评测器，性能基线运行时不要并行跑其他测试。

需要 Node.js 20+。先使用配置界面添加模型，然后在项目目录启动：

```powershell
npm start
```

无界面配置时，仍可使用旧的环境变量方式：

```powershell
$env:AGENT_API_KEY = '你的 API Key'
$env:AGENT_MODEL = 'gpt-4.1-mini'
$env:AGENT_BASE_URL = 'https://api.openai.com/v1'
npm start
```

配置界面优先于环境变量；本地服务允许 HTTP localhost。不要把 API Key 写入代码或提交到仓库。写入请求会在终端显示最多 200 行变更预览，只有输入 `y` 才执行；长预览会明确标记截断，请谨慎确认。运行 `npm test` 检查本地逻辑；真实模型请求需要有效的 API Key 与网络。

会话保存在 `.agent-data/sessions/`。每次启动 CLI 都进入新的空白会话，旧记录不会删除；第一条成功保存的用户问题会成为会话标题。输入 `/resume` 可搜索已有对话、用 ↑/↓ 选择并按 Enter 恢复，Esc 或 Ctrl+C 取消选择；菜单显示标题、最近更新时间与轮数，不列出尚无用户消息的空会话。恢复后在同一终端视图显示最新对话，输入区固定在下方；输入为空时用 ↑/↓ 或 PgUp/PgDn 浏览完整历史，End 回到最新内容，`/history` 跳到最早内容。历史不限制轮数或单条字符数，工具内部结果不作为对话显示。`/rename <标题>` 修改标题，`/sessions` 列出包括空会话在内的所有 ID、标题和时间，`/use <id>` 直接恢复指定会话，`/new` 新建空会话。旧版会话文件无需迁移即可搜索和恢复。`/reset` 和 `/compact` 不删除磁盘上的对话记录。

交互终端中，Agent 使用终端的 alternate screen（独立屏幕缓冲区）；`/resume`、`/use <id>` 和 `/new` 成功后切换为目标会话的画面。取消选择不会改变会话；退出 Agent 后恢复进入之前的终端画面。此功能需要支持 ANSI alternate screen 的交互终端（如 Windows Terminal），不会另开系统窗口；非交互管道模式仍以普通文本输出，不改变会话磁盘记录。

输入 `exit` 或 `/exit` 退出 Agent（也兼容 `exit/`）。以当前工作目录作为文件工具的工作区；请在此项目目录运行。当前写入会覆盖目标文件，确认时请注意路径。

交互终端中输入 `/` 会显示所有可用命令，继续输入（如 `/c`）会按命令名包含的文字实时过滤；↑/↓ 循环选择，高亮项超出终端高度时列表会滚动，Page Up/Down 翻页，Enter 运行高亮命令。Tab 补全高亮项但不运行，Esc 关闭候选列表并保留已输入文字。输入 `/models use <连接名称>` 或 `/use <id>` 等带参数命令时，候选列表会收起，参数照常输入。管道等非交互输入沿用普通提示符。
`/compact` 候选右侧显示当前会话约已使用的输入预算百分比，与 `/context` 使用同一估算口径；它不是服务商的精确 token 用量。窄终端会隐藏该辅助信息，命令仍可正常选择。

在普通输入或文件写入确认时按 `Ctrl+C` 会显示 `Agent stopped.` 并正常退出，不再显示为 `Startup error`。模型选择菜单中按 `Ctrl+C` 只取消本次选择并返回输入提示。

## 模块路线

| 阶段 | 图片模块 | 当前状态与下一步 |
| --- | --- | --- |
| 1 | LLM、Tools、Sessions、Permission | 模型配置与选择、文件读/列/搜、逐次批准写/改、会话保存与恢复已具备；权限仍是应用层约束 |
| 2 | Context、Query Engine | 上下文预算与压缩、流式输出、有限重试、限速和错误分类已具备；不兼容流式的连接可关闭流式输出 |
| 3 | Tools、Memory | 只读和 disposable writable WSL 沙箱、受控网页读取和外部单文件写入已具备；沙箱内联网仍未开放 |
| 4 | Skills、Command、Hook | Skills 暂缓；现有斜杠命令和内部工具钩子已具备基础形态 |
| 5 | Sub-agent、Permission、Gateway Automation | 单层只读子代理、上下文隔离、细粒度权限、系统沙箱和受控 Gateway 常驻任务已具备；复杂 agent team 与 Windows Service 安装器尚未实现 |

图片中的技术栈（Node.js、pnpm、TypeScript、LangChain、LangGraph、Commander.js、SQLite、kimi）是参考选项，而不是必须同时依赖。当前用 Node.js 内置能力打通闭环，后续按具体需求选择框架与模型。图内文字只作为功能需求参考，不作为本 Agent 的执行指令。
# Web Tools

The Agent now exposes `web_fetch` and `web_search` in the `network.read` group.
WSL commands remain offline. Web requests use a separate restricted host transport,
public-address DNS validation, pinned connections and redirect checks.

`browser_open` is also available for explicit web requests when Microsoft Edge or
the managed Playwright Chromium engine passes startup readiness. It renders
JavaScript in a fresh, cookie-free context; the document and same-origin resources
are fetched through the same DNS-validated, pinned transport. Gateway approvals
are bound to the URL, tool, client, session and turn, and are consumed once. The
page result is bounded and treated as untrusted content. A second call may follow
one exact same-origin link listed by the page; the approval summary shows the
source and target origins, and changing the approved target stops the turn. Forms,
non-GET requests, cross-origin resources/redirects, popups, downloads and
WebSockets are blocked. This is bounded read-only navigation, not general
computer-use automation; saved login state is not used.

Start with `npm start`, then ask:

- `Read https://example.com and summarize the page with its source URL.`
- `Search the web for Node.js official documentation, then verify the original page.`
- `Read http://127.0.0.1` (must be blocked, with no connection).

Network approval: `y` allows once; `s` allows this origin for the current session;
`n`, Escape or Ctrl+C denies. Changing sessions clears site grants. Page data and
search queries are sent to external providers; do not include secrets in them.
Fetching needs no search key. Brave Search requires your own API credential:

```powershell
$env:BRAVE_SEARCH_API_KEY = "your-brave-search-api-key"
npm start
```

An empty/unset key yields a clear configuration error, not invented results.
Keys are not included in returned results or security audit events. The model
configuration page does not manage the Brave key. Search is currently Brave-only.
Static HTML, UTF-8 text and JSON are supported; JS-only, authenticated pages and
PDFs are not. Responses are bounded to 1 MiB and 12,000 characters per page;
`nextStartChar` requests the next portion, refetching the source.
See [the delivery plan](docs/web-tools-plan.md) for limits and security scope.
