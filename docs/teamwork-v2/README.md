# QAP Teamwork V2.1 文档集

版本：2.2.10　状态：已同步到 `main@0758e7e`，待评审后冻结 M0　日期：2026-10-09

2.2.0 变更：采纳外部设计评审的 7 项意见（D-29～D-35，见 `01-decisions.md §1.1`；踩坑 P-141～P-147；不变量 I-23～I-27；新增测试 F-11～F-14、A-10b、A-17～A-21）。

2.2.1 变更：D-32 改为 `run_ref` 比对 + 终态不确定时换新 Session，不改 agent-server（去掉 execution token、hop、turn 屏障）；新增 P-148、P-149、A-22；删除 F-15。

2.2.2 变更：采纳第二轮评审 7 项（D-36～D-41、D-43）并补充并发交错属性测试（D-42），见 `01-decisions.md §1.2`。主要改动：

- 发送权竞争失败后重新读取，不再误判为取消；
- queued Run 的恢复派发；
- 进入待验收拆成"提交有效 → seal → 确认只读"两步，两步之间不派发；
- 统一"未处理输入"定义，修复 `wait_for_items` 死锁；
- 命令原子占位，覆盖并发重放；
- 资源当前唯一性改用 partial index；
- initial / continuation 共用本轮上下文块。

新增：不变量 I-28～I-30；踩坑 P-150～P-157；测试 A-01a～c、A-23～A-28、M-09、M-10、PT-01～PT-03。

2.2.3 变更：采纳第三轮评审 4 项（D-44～D-47，见 `01-decisions.md §1.3`），归并为三条统一规则：

- **R1**：Run 的执行派生字段只由投影函数写入，seq 单调；
- **R2**：执行终态是吸收态；
- **R3**：资源外部操作必须在租约内执行。

新增：不变量 I-31～I-33；踩坑 P-158～P-161；测试 A-29～A-32。架构一致性复核见 `01-decisions.md §1.3.1`：没有架构偏离。

2.2.4 变更：采纳第四轮评审 3 项，并吸收 astra 的中断方案（D-48～D-51，见 `01-decisions.md §1.4`），归并为 **R4**：

> 对外部系统的写操作，要么在外部按操作身份定位和隔离，要么在结果不确定时标记为 uncertain，直到观察到实际状态再继续。DB 条件写入不能替代外部确认。

主要改动：

- AFS 外部操作分为"创建独立对象"与"修改共享挂载"两类；后者结果不确定时不能凭租约过期接手；seal 与 accept 以观察到的实际挂载状态为准；
- 平台新增 `resolveManagedExecution`，人工 resolve 经平台写入、Run 经投影更新；
- agent-server 新增**执行级中断**（按 dispatch_key 定位，原子匹配并中断，五种结果）；取消侧 0 行后重新读取。

新增：不变量 I-34、I-35；踩坑 P-162～P-167；测试 F-16、F-17、A-33～A-36；未决问题 Q-09。

2.2.5 变更：采纳第五轮评审 2 项（D-52～D-54，见 `01-decisions.md §1.5`）。两条都是 2.2.4 自己引入的捷径，违反了 R4，现已删除：

- 挂载操作的 `uncertain` 不再凭"观察一段时间没变化"解除，只凭旧操作已终止的证据（AFS 序号拒绝 / fuse 实例变更 / 人工 `resolve_resource`）；存在 `uncertain` 时禁止新的挂载修改；
- 执行级中断的**隔离性**是硬性前提，与**可确认性**拆成两个能力（`interruptTargeted` / `interruptConfirm`）；隔离方式三选一，兜底为锁内终止子进程；F-17 是硬性闸门，不能靠降级 capability 过关。

R4 补充一句："等待时间不是证据；降级 capability 不能代替满足安全性。"

新增：不变量 I-36、I-37；踩坑 P-168～P-170；测试 A-33b、A-33c、F-18；命令 `resolve_resource`。

2.2.6 变更：采纳第六轮评审 2 项（D-55、D-56，见 `01-decisions.md §1.6`）。评审结论：完成后可进入 M0 冻结与 Phase 0 实施。

- **资源恢复基线**只有两种证据：AFS 服务端操作序号、人工确认。"fuse-server 实例变更"不再作为证据，因为旧请求可能在重启后才送达新实例。将来启用必须同时满足三个前提。人工确认也须写明旧请求已无法送达的依据，不能只写"已重启 sidecar"。
- **admin 例外清单**统一放在 `ws-tw2 §4`，包括 `resolve_execution`、`resolve_resource` 和插件命令，契约只引用它。

新增：踩坑 P-171、P-172；测试 A-33d、A-37。

2.2.7 变更：把设计拆成可直接派发给 Agent 的工作包（D-57、D-58，见 `01-decisions.md §1.7`）。

- **修正 ports 滞后**（阻塞 M0）：
  - `ExecutionPort` 补上 `resolveManagedExecution`；
  - `RunLifecycle.resolveExecution(tx, …)` 拆成 `requestResolution`（事务内）与 `applyPendingResolution`（事务外）；
  - `ResourceManager` 增加 `continueAfterResolve`，资源 repo 增加 `resolveUncertain`，资源状态增加 `resolved`。
- **新增 `04-task-board.md`**：
  - 56 个工作包（含 Phase 2 与条件 WP），每个都写明开工依赖、集成依赖、只写文件、完成标准与验证、规模；
  - Agent 派发模板；
  - 共享 fake 规格（7 种 fake 及故障开关）；
  - WP 级依赖图、7 个波次、关键路径（约 24 个 Agent 工作日到 G2）、10 个 Agent 的参考分配。
- 补齐此前缺少任务的 CT、QA、INT、TW9。
- PL1 拆为 5 个 WP，以文件隔离热点（D-58）。

新增：踩坑 P-173。

2.2.8 变更：采纳任务板评审 3 项，并修正自查发现的同类问题（D-59～D-61，见 `01-decisions.md §1.8`）。

- **规则 R-WP**：依赖分开工 / 合入 / 闸门三类；WP 的完成标准只用本 WP 范围内能运行的测试；卡片中的 A / L / M 场景指 fake 级变体。
- **PL1b** 只验收执行核心，F-11 移到 PL1d 与 G1；桩期间生产入口不调到桩方法，旧路由由 PL1d / PL1c 各自切换。
- **新增 WP-INT4 / INT4b**：`registerTeamwork` 完整装配，测试装配与生产共用。插件 Web bundle 构建归 TW8a。
- **QA7 拆为 QA7-U / QA7-L**；INT3 改为"候选 PR → 预发验收（G4）→ 合并"，消除切换验收循环。
- 依赖图、波次（W0～W7）、关键路径（TW 链约 22 天，到 G2 约 26.5 天）、Agent 分配同步更新。工作包共 59 个。

新增：踩坑 P-174。

2.2.9 变更：派发前的两处修正（D-62、D-63，见 `01-decisions.md §1.9`）。评审结论：修正后可进入 M0 与首批派发。

- `Tx` 类型及 ports 引用的全部类型归 CT2，放在 `contracts/` 中；`ports.ts` 只能从 contracts 与 `internal/types` 导入。TW1a 只实现事务 helper。这消除了 CT2 ↔ TW1a 的编译循环。路径别名 `@qap/types` 在仓库中不存在，改为相对路径。
- 删除 `03 §6` 的线性合并顺序，合并顺序统一以任务板依赖为准，闸门只定义验收顺序；分支按 WP 命名。

新增：踩坑 P-175。

2.2.10 变更：基线从 `main@80361d0` 同步到 `main@0758e7e`（D-64～D-68，见 `01-decisions.md §1.10`）。

- migration 编号顺移到 148～152（142～147 已被 main 占用），以合并时为准；
- Managed Execution 复用 main 新增的会话 turn 租约，`session_busy` 为可重试；
- 新增会话守卫扩展点：拒绝直接向受管 Session 发 turn；
- 新增 Workspace 所有权转移钩子：转移不再直接改写 teamwork 表；roster 严格同 owner，不受团队共享影响；
- ACP `authRequired` 带结构化错误码。

新增：WP-PL4d、WP-TW2c（工作包共 61 个）；踩坑 P-176～P-180；测试 A-38～A-40；未决问题 Q-10。
代码基线：设计于 `main@80361d0`，2.2.10 同步到 `main@0758e7e`　参考实现：Symphony `8001b52`

V2.1 合并了三份来源：GPT《QAP Teamwork V2 架构设计与实施 Handoff》(2.0.0)、`docs/teamwork-technical-proposal.md`（产品与细节方案）、`docs/teamwork-architecture.md`（Symphony 映射与架构视图）。三者冲突之处以本文档集为准，决策见 `01-decisions.md`。

## 为什么拆成多份文档

本次改造按**多 Agent 并行开发**组织：每个工作流（Workstream）由一个 Agent 在独立 worktree 中实现。每个 Agent 只需读取：

1. `04-task-board.md` 中自己的**工作包卡片**与 §2 派发模板（规定能写哪些文件、何时能开工、怎样算完成）
2. `00-architecture.md`：全局边界与不变量（必读，约 15 分钟）
3. `02-contracts.md`：冻结的跨模块契约（读卡片指定的章节）
4. 自己的 `ws-*.md`：职责、接口、设计要点、测试
5. `90-pitfalls.md` 中卡片列出的条目

不需要读其他工作流文档。跨工作流协作只通过 `02-contracts.md` 中的接口进行。

## 文件索引

| 文件 | 内容 | 读者 |
| --- | --- | --- |
| `00-architecture.md` | 分层、领域模型、平台/Teamwork 边界、不变量、Symphony 映射 | 全体 |
| `01-decisions.md` | V2.0 与既有方案的差异裁决、未决问题 | 架构 / 集成者 |
| `02-contracts.md` | 冻结契约：Managed Execution、agent-server 扩展、Teamwork 内部模块接口、DB schema、API、工具、事件 | 全体 |
| `03-parallel-plan.md` | 工作流划分、依赖 DAG、里程碑与集成闸门、文件所有权、分支协议、交付模板、初始代码映射 | 集成者 / 全体 |
| `04-task-board.md` | **派发索引**：工作包（WP）卡片、Agent 派发模板、共享 fake 规格、WP 级依赖图、波次、关键路径与并发建议 | 集成者（派发）/ 被派发的 Agent |
| `ws-pl1-managed-execution.md` | 平台：Managed Execution 核心 | PL1 |
| `ws-pl2-runtime-adapters.md` | 平台：agent-server 执行身份与查询 | PL2 |
| `ws-pl3-call-agent.md` | 平台：call_agent 收敛与 MCP 作用域扩展点 | PL3 |
| `ws-pl4-web-host.md` | 平台：前端 host / 插件扩展点 / 插件路由守卫 | PL4 |
| `ws-tw1-schema-repos.md` | Teamwork：schema、migration、repository | TW1 |
| `ws-tw2-commands-api.md` | Teamwork：状态机、命令账本、HTTP API | TW2 |
| `ws-tw3-reconcile.md` | Teamwork：reconcile、dispatcher、worker | TW3 |
| `ws-tw4-run-lifecycle.md` | Teamwork：Run 生命周期、重试分类、stall、unknown | TW4 |
| `ws-tw5-context-tools.md` | Teamwork：上下文、模板、workpad、MCP 工具 | TW5 |
| `ws-tw6-resources.md` | Teamwork：AFS 资源与产物 | TW6 |
| `ws-tw7-plugin-lifecycle.md` | Teamwork：插件生命周期、协议、能力 | TW7 |
| `ws-tw8-web-ui.md` | Teamwork：Web 插件 UI | TW8 |
| `ws-tw9-cutover.md` | Teamwork：旧实现迁出与删除 | TW9 |
| `ws-qa-harness.md` | 测试：fake agent-server、故障注入、验收矩阵 | QA |
| `90-pitfalls.md` | 踩坑登记册（全部已知陷阱，按 WS 标注） | 全体 |

## 首批实施范围

只做 **Phase 0 + Phase 1A**：Managed Execution Foundation + 持久化单协调员 Teamwork。确认 G1、G2 闸门通过后，才进入 Phase 1B / 1C / 2。详见 `03-parallel-plan.md`。

实施者不得把本文档集解释为"一次性实现全部 V2"，也不得在提交代码映射报告前开始大规模改代码。

## 旧文档

`docs/teamwork-technical-proposal.md` 与 `docs/teamwork-architecture.md` 保留作为来源和背景，内容已被本文档集吸收。两者与本文档集不一致时，以本文档集为准。
