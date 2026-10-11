# 一键自动评测

## 快速开始

在 D:\personal agent 的 PowerShell 执行：

```powershell
npm run perf:smoke
npm run perf:local
```

- smoke：每个场景一个样本，无预热，用于验证流程；不能拿一次请求的 P95 宣称稳定性能。
- local：每道题预热一次、正式五次；本地目录 10/100/250 项的读取、分页和搜索；独立 Gateway 并发 1/2/4/8，各 100 次，重复三批；九道模拟 Agent 题；重试和取消测试。
- 两者不会调用外部模型，不读取日常工作区文件，不修改当前 Workbench 或已选模型。启动独立端口，无需手动启动 Workbench。
- 浏览器不可用会跳过浏览器场景，整体为 partial，不当作全部通过。网络和其他故障是 failed，不被吞掉。

## 真实模型

```powershell
npm run perf:real -- --allow-paid
```

使用项目已选模型，密钥只在内存中使用。每题默认一次预热、三次正式运行，串行执行；全批默认最多 120 次模型 HTTP 尝试（重试也计数），总预算 600 秒。没有 allow-paid 会在任何测试执行前拒绝。

```powershell
npm run perf:real -- --allow-paid --count 10 --warmup 2 --max-attempts 400 --seconds 1800
```

真实模式保留 Safe 策略和真实 WSL 文件读取；没有可用沙箱则跳过文件工具题，不启用主机读取降级。运行环境依赖检测耗时可能占用总时长预算。

没有配置自有公开 HTTPS 来源时，真实模式浏览器题跳过。部署 test/fixtures/performance/site 下的四个文件到自己控制的 HTTPS 网站根目录，然后执行：

```powershell
npm run perf:real -- --allow-paid --origin https://你的测试域名
```

这里只访问固定 dynamic.html、detail.html 等测试素材，不操作登录、表单、下载。测试运行器只批准当前回合中确切匹配固定来源/目标的 browser_open 审批，执行真实一次性审批/续接接口；否决题会自动拒绝。其他工具或参数由测试钩子阻止，不增加生产自动批准配置。

## 参数

| 参数 | 默认与限制 |
| --- | --- |
| --count | smoke=1、local=5、real=3；范围 1-30 |
| --warmup | smoke=0、其余=1；范围 0-5 |
| --max-attempts | real=120、其余=2000；范围 1-3000，包括预热、路由、执行、续接和重试 |
| --seconds | 总运行预算 600 秒；范围 5-3600 |
| --stability-seconds | 默认 0；范围 0-1800，必须小于总运行预算 |
| --origin | 自有公开 HTTPS 来源，无路径、查询和片段 |
| --input-price / --output-price | 每百万 Token 单价，必须一起提供 |
| --cached-price | 缓存输入单价，默认等于输入价 |
| --currency | 默认 USD，三位大写币种代码 |

示例：

```powershell
npm run perf:real -- --allow-paid --input-price 1 --output-price 3 --currency USD
npm run perf:local -- --stability-seconds 300 --seconds 900
```

稳定性参数只重复本地 /api/tools，间隔至少 100ms，按分钟输出数据；不调用付费模型，不代表长时间真实 Agent 稳定性。预算耗尽或取消会保留已完成样本和失败原因，不自动重新跑付费请求。

## 自动验收

题库使用独立 eval-data 文件，固定内容与源 test/fixtures/performance 相同。它与旧脚本题库不是完全相同的实验：为了确定性验收，要求结构化 JSON；不宣称开放式回答质量。

| 场景 | 验收标准 |
| --- | --- |
| 数字问答 | 精确 JSON answer=42；无工具调用 |
| 文件读取 | 项目五字段正确，且 read_file 实际结果含这些字段 |
| 分段读取 | startLine=10、lineCount=6；答案和工具结果逐行一致 |
| 搜索 | 查询、路径正确；答案与工具结果含 project.md 第 14 行 |
| 不存在文件 | not_found，失败读取与 ENOENT 错误原文，无成功读取结果 |
| 会议 | 三位负责人及日期正确，工具证据含行动项和不增加登录功能 |
| 动态浏览器 | browser_open 成功，来源正确，正文包含 JS_READY_7319 |
| 同源跟随 | 来源/目标一致，follow_link 证据、DETAIL_OK_7319、库存 37 件 |
| 审批拒绝 | denied，存在明确拒绝记录，没有成功读取证据 |

错答案、缺少证据、意外工具失败、未知工具范围、格式不符都失败。评分规则和题目保存于 scripts/eval/cases.js。预热样本仍被验收，但不进入正式延迟统计。

## 报告与口径

每次输出至 artifacts/performance/<唯一批次>/：

- samples.jsonl：每个样本的原始参数、合成素材结果、验收、调用与耗时。真实题也仅允许固定素材；不要放真实账号或机密信息到测试网页。
- summary.json：所有记录、环境、素材 SHA-256、配置、各场景统计、接口各批数据、资源和完整性说明。
- report.md：中文结果摘要，包含失败与跳过、限制、用量和成本来源。
- workspace/：本批次独立工作区、会话、审计，保留以便复核。不会自动删除任何已有文件。

退出码：failed=1；passed/partial=0。CI 如果要求全部覆盖，必须额外检查 summary.json 的 result 是否为 passed。缺少依赖不能凭退出码 0 宣称全部通过。

1. 端到端从 POST 之前计时到最终 HTTP 响应读取完成，包括审批续接；不含建会话或准备测试素材。
2. 首段表使用客户端收到首个非空 turn.delta 的时间；服务器发出时间另存 firstOutputMs。中间说明也属于首段，不等同最终回答。无流式输出时为 null，不是零。
3. 工具时间来自 Agent onStatus.durationMs，以 Date.now 毫秒分辨率测量，包括工具内检查、审计和验收，不是纯磁盘读取时间。0ms 在这个口径可能是分辨率限制。
4. 模型 call.durationMs 是完整逻辑调用，HTTP attempt.headersMs 只计到响应头；每个真实发送的重试都计数。总调用含规划分类等。测试预算耗尽时可能被原请求层包装为 NETWORK，失败报告保留已发送次数。
5. Token 只汇总服务商实际返回值，不估算缺失值。所有调用成功、每次有输入/输出用量、无重试及异常 HTTP，才标记用量完整。失败或重试可能仍计费，因此成本留未知，不把缺失当零。
6. 本地模型返回固定合成用量，标记 synthetic-fixture，绝不能用于真实成本。价格估算不等于账单；没有价格保持 null。缓存价不同且 provider 未报 cachedInputTokens 时不计算成本。
7. 百分位为 nearest-rank，少于 1000 样本不报 P99。通过样本延迟与全样本状态/耗时一起报告，跳过不算通过；不同场景不混合。五次样本的 P95 仅供基线探索，应扩大样本复测。
8. Node RSS/CPU 每秒采样，覆盖同一进程内的运行器、客户端、模拟服务、Gateway；不覆盖 Edge/WSL 子进程。CPU 是单核口径。只能称本评测进程资源，不能称 Agent 全进程树资源峰值；短时峰值可能漏采。
9. 接口请求为闭环固定并发，三个批次分别报告；Agent 题串行，不能从 HTTP QPS 推断 Agent 并发容量。没有 Workbench 预览代理或 UI 绘制，不能称为完整前端性能。
10. local 浏览器使用真实 Edge 和受限固定素材传输，不访问公网，不验证 DNS/TLS。real + origin 才包含公网导航和原有安全策略。

## 验证与复测

```powershell
npm run perf:test
```

先让评测器测试通过，再独立执行 perf:local。不要在性能基线运行时同时跑 npm test、编译或其他高负载任务。对比批次必须同硬件、模型、推理挡位、版本、样本和预热配置；报告保留环境和素材指纹。没有复测数据不宣称优化提升。

当前工具不提供 Edge/WSL 全进程树资源采样、真实模型并发容量或任意开放式答案的语义评分。这些明确排除，避免结果超出实际测量范围。
