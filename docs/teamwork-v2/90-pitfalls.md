# 90 · 踩坑登记册

所有已知陷阱集中登记于此。每条包含：陷阱、证据 / 来源、必须遵守的规则、负责工作流。新发现的陷阱通过 PR 追加，编号只增不改。

证据中的"代码"指 `main@80361d0` 的实际位置；"TP"指 `teamwork-technical-proposal.md`；"V2.0"指 GPT handoff；"Sym"指 Symphony SPEC。

## A. 执行与运行时（平台）

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-01 | `sessions.chat_status` 被当成执行或业务状态 | `services/db/sessions.ts:270` `transitionSessionStatus`；TP §1 | 执行状态只看 `managed_executions`；业务状态只看 teamwork 表；`idle` 不等于成功 | PL1, 全体 TW |
| P-02 | 新 session 在 `session.started` 之前没有 id | `dispatchChatTurn` async 模式等待 `session.started` | Execution 在 `session_id` 为空时仍可被查询、中断（按 dispatch_key） | PL1 |
| P-03 | `drainPendingMessage` 在 `session.ended` 后自动续发 pending 消息，产生 Run 之外的 turn | `executeChat.ts:267`、`sse.ts:588`、`session-recovery.ts:68` | Managed Teamwork Session 传 `disablePendingDrain=true`；补充输入走 `teamwork_events` | PL1, TW5 |
| P-04 | 启动恢复只处理 `chat_status='agent'` 的 session，reconnect 失败直接标 idle | `lib/session-recovery.ts` `recoverOrphanedSessions` | 先按 `managed_executions` 收敛，再跑旧恢复；reconnect 失败不能推断为结束，需 lookup | PL1 |
| P-05 | turn-gate 是进程内实现 | `services/chat/turn-gate.ts` | 单活 CP；多 CP 前不得声称并发安全 | PL1, INT |
| P-06 | 先发 HTTP 再记录"已发送"，崩溃后无法区分"未发"与"可能已发" | TP §8.2；V2.0 §11 | `send_state=sending` 必须在网络调用前提交 | PL1 |
| P-07 | SSE `:` keepalive（15s）被当成进展 | `agents/claude-code/src/server.ts` SessionSink；TP §8.3 | `last_progress_at` 只计模型 / 工具事件 | PL1, TW4 |
| P-08 | interrupt HTTP 200 或"已送达"被当成已停止 | `routes/workspaces/_shared.ts` `interruptAgentSession` 已区分 delivered / interrupted | 只有 `confirmed=true` 或终态事件才算停止 | PL1, TW2, TW4 |
| P-09 | lookup 打到错误 replica | `services/replica-router.ts`、`sessions.replica_ordinal`（migration 124） | 按 `replica_ordinal` 路由；实例 ID 不一致即视为不同实例 | PL1 |
| P-10 | autoscale 缩到 0 后 pod 消失，内存 registry 随之消失 | `internal/k8s-provider` AutoScalingWorkload | 终态必须在 CP 侧持久化；pod 消失时未持久化的执行 → unknown | PL1, PL2 |
| P-11 | autoscaled Workspace 满载返回 503 被当成执行失败并重试放大 | `executeChat` → `acquireTurn` | 映射为 `admission / capacity_unavailable`，按 Retry-After 退避；属于 retryable | PL1, TW4 |
| P-12 | lifecycle hook 在 CP 崩溃时丢失 | V2.0 §23 | 至少一次 + 幂等 + sweep 兜底（I-20） | PL1, TW3, TW4 |
| P-13 | ACP bridge 空闲 LRU（`BRIDGE_IDLE_TTL_MS=10min`、`BRIDGE_MAX_COUNT=10`）回收时连带丢失执行记录 | `internal/acp-adapter/acp-server.ts:113-114,178` | dispatch registry 与 bridge LRU 分离；registry 只淘汰已结束条目 | PL2b |
| P-14 | runtime 进程重启后内存去重失效，同 key 重发会执行第二次 | TP §8.2；V2.0 I-04 表述过强 | 重发前必须 lookup；实例 ID 变化 → unknown，不重发（D-03） | PL1, PL2, TW4 |
| P-15 | goose 的 session id 经过 `SessionIdCodec` 命名空间化 | `agents/goose/src/session-store.ts` | registry / lookup 返回对外 session id | PL2b |
| P-16 | 按 runtime 类型写分支 | V2.0 §9 | Teamwork 只读 `RuntimeExecutionCapabilities` | 全体 |
| P-17 | DSH `permissions:false`，不发权限请求；各 runtime 对 waiting_input 支持不同 | `agents/dsh/src/server.ts` | `waitingInput=false` 的 runtime 不能指望收到 question；UI 不显示"等待审批" | PL2c, TW4 |
| P-18 | 上游 `/chat` 超时 24h 与客户端解耦，被误当成总时长上限 | `executeChat` | 不以超时推断失败；stall 检测走 D-11 | PL1, TW4 |

## B. call_agent 与 MCP

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-20 | `call_agent` 直接 `fetch(${address}/chat)`，绕过 turn-gate、executeChat、重试与恢复 | `mcp/tools/agent.ts:635` | 改走 `dispatchManagedTurn(origin='call_agent')` | PL3 |
| P-21 | 成员 session 注册是 fire-and-forget，失败只打日志 | `mcp/tools/agent.ts:655-662` `.catch(console.error)` | Teamwork 绑定在 Run 生命周期事务内写入，失败必须可见 | PL3, TW4 |
| P-22 | `parent_session_id` 恒为 null | `mcp/tools/agent.ts:653` 注释 | 用 `parent_run_id` / `parent_execution_id` 还原调用链 | PL3, TW1 |
| P-23 | Task 作用域下 `resolveRosterMemberBySlug` 扩大了可调用范围（可调用 owner 私有 roster 成员） | `mcp/tools/agent.ts:588` | Managed Teamwork 禁用 call_agent 后删除此路径 | PL3, TW9 |
| P-24 | foreground 30s（`FOREGROUND_WAIT_MS`）后降级为 `get_agent_result` 轮询；协调员持槽同步等待 | `mcp/tools/agent.ts:50,699-719` | Teamwork 不用同步等待；协调员结束本轮，由 reconcile 在成员结果到达后唤醒 | PL3, TW3 |
| P-25 | `call_agent` 拒绝调用自己（同 Workspace） | `mcp/tools/agent.ts:595` | 协调员 Workspace 不能同时是成员；participants 路由已拒绝（`routes/teamwork.ts:323`），新实现保留 | TW2 |
| P-26 | MCP 只在"当前 Workspace 是协调员"时保留 task 上下文 | `mcp/server.ts` `findTaskBySession` | 改为 scope resolver 注册表，按 session → teamwork_sessions → Run 解析，成员有独立收窄作用域 | PL3, TW5 |
| P-27 | 目标 Workspace 只检查 `status==='running'` | `mcp/tools/agent.ts:599`、`routes/teamwork.ts:332` | Teamwork 派发前由 Managed Execution 负责 autostart；running 不代表共享目录可达 | PL3, TW6 |

## C. 前端插件与 host

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-30 | tool result 监听在懒加载首次匹配时丢弃当前事件 | `web/src/plugins/registry.ts` | tool handler 只做 UI 缓存刷新；业务状态来自服务端快照 | PL4, TW8 |
| P-31 | `plugins.enabled` 只是 DB 布尔，停用不能停止后台执行 | `services/db/plugins.ts` `setPluginEnabled` | 后台开关只看 `teamwork_plugin_settings.lifecycle`（I-22） | PL4, TW7 |
| P-32 | loader 在浏览器内缓存 `loaded / pendingLoads`，停用后已加载 JS 仍在 | `web/src/lib/plugin-loader.ts` | 不依赖前端卸载；服务端拒绝 | PL4, TW7 |
| P-33 | bundle URL 带版本，但 `getPluginBundle(id)` 只取当前 bundle，旧版本不可取回 | `routes/plugins.ts` | URL 版本与实际内容不符时拒绝返回；升级前 drain，不并行运行多版本 | PL4, TW7 |
| P-34 | manifest metadata 仅 `JSON.parse`，无 schema 校验 | `routes/plugins.ts` | Teamwork manifest 用 Zod 校验 | PL4, TW7 |
| P-35 | host 导出的会话 hooks 依赖 Provider，在 fleet 根组件裸用会失效 | `web/src/lib/host.ts` | 提供自带 Provider 的 `SessionView` | PL4 |
| P-36 | host 未导出 `QueryClientProvider`，插件用 React Query 会拿不到上下文 | 同上 | 插件自带 QueryClient 与 Provider | TW8 |
| P-37 | `PluginPanelProps` 要求 `workspaceId`；`useWsApps` 依赖 Workspace MCP 的 `ui_panel` | `web/src/plugins/types.ts`、`hooks/useWsApps.ts` | Teamwork 首页用 fleet app 贡献，不伪造 Workspace | PL4 |
| P-38 | `useFleetApps` 硬编码 `TeamworkApp`，`wsApps.tsx` 直接加载 `TeamworkSection` | 代码 | G4 删除硬编码，不能同时存在两套入口 | PL4, TW9 |
| P-39 | 插件 JS 以同源受信任代码运行，拥有当前用户浏览器上下文；manifest 能力声明不产生隔离 | TP §3.1.3 | 授权一律在服务端；只允许第一方插件 | PL4, TW7 |
| P-40 | app id 与宿主内置 app 冲突 | TP §3.1.2 | 使用命名空间 `teamwork.board` | PL4 |

## D. Teamwork 现有 Preview 行为

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-50 | 创建 Task 要求协调员 running 并立即 provision AFS；失败时**删除 Task** | `routes/teamwork.ts:159-173` | create 只写 backlog；资源在 start 后准备；失败保留 Task 与资源记录（`blocked/resource_failed`） | TW2, TW6 |
| P-51 | 添加成员时立即 mount；失败回滚 participant 行 | `routes/teamwork.ts:336-345` | 成员挂载在 dispatch 前按需确保，失败记录在 `teamwork_resources` | TW6 |
| P-52 | 成员可调用条件是"自己的或 public"，未检查同环境 | `routes/teamwork.ts:329-331` | 收窄为同 owner、同 AFS 可共享环境（D-22） | TW2, TW6 |
| P-53 | 删除 Task 时 teardown share 再删行 | `routes/teamwork.ts:259-262` | V2 不提供硬删除；archive 只隐藏（D-28） | TW2 |
| P-54 | Task context 在前端 `buildTeamworkContext()` 拼接 | `TeamworkSection.tsx` | 服务端生成（TW5） | TW5, TW9 |
| P-55 | 成员会话由 `deriveMemberSessions()` 解析协调员 tool result 得到，受消息加载范围影响 | `TeamworkSection.tsx` `TaskDetailView` | 用 `GET /:id/sessions` 关系查询 | TW8, TW9 |
| P-56 | 文档站写"任务结束回收"，但代码没有完成状态 | `docs-site/.../concepts/teamwork.md` | TW9 更新文档站 | TW9 |
| P-57 | 当前 UI 固定 360px 左栏，挤压聊天 | TP §4.2 | 详情侧栏 560–680px，窄屏全宽 | TW8 |

## E. 数据与事务

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-60 | 用 `(task_id, work_item_id)` nullable 联合唯一索引以为约束了协调员 | TP §6 | 两条 partial unique index（`02-contracts §4`） | TW1 |
| P-61 | `unknown` 被当作终态释放唯一约束，导致重复派发 | V2.0 §11 | `unknown` 列入活动状态集合 | TW1 |
| P-62 | 事务内等待模型输出或做网络调用 | V2.0 I-14 | 锁内只判定与写入；dispatch / interrupt / lookup / AFS 调用都在事务外 | 全体 |
| P-63 | 先提交业务写入再入队，崩溃丢唤醒 | TP §7 | pg-boss 12.14.0 `SendOptions.db` 事务内 send；sweep 兜底 | TW2, TW3 |
| P-64 | 把 queue job 成功当成任务推进成功 | TP §7 | job 成功 = 完成一次 reconcile；允许重复消息 | TW3 |
| P-65 | 命令先查 version 再查 request_id，超时重试变成 409 或第二个动作 | TP §9.2 | 先按 request_id 返回原结果，再查 version | TW2 |
| P-66 | migration 编号与 squash 前链条冲突会被静默跳过 | `control-plane/migrations/README.md` | 从 142 起由 INT 分配；文件名即身份，已应用不得改 | TW1, PL1, INT |
| P-67 | 旧 Preview 行没有新字段语义 | D-27 | 默认 backlog；不写兼容层、不自动迁移、不清库 | TW1 |
| P-68 | Session 在多个 Task / WorkItem 间复用 | TP §6 | `teamwork_sessions.session_id` 唯一（I-19） | TW1 |
| P-69 | 同一 Workspace 担任两个 WorkItem 时复用同一 Session | TP §6 | 不同 WorkItem 使用不同 Session | TW3, TW4 |
| P-70 | 依赖被取消当作满足 | TP §6 | 协调员必须显式调整并记录理由 | TW1, TW3 |
| P-71 | scheduler 以用户 `service_token` 调 CP（`JobData.service_token`） | `scheduler/src/handler.ts:24,120,131` | teamwork worker 用服务身份调内部端点（D-16） | TW3 |

## F. 编排语义

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-80 | 以"最后一条消息说完成了"、工具调用结束或连接断开判断完成 | TP §1 | 完成以结构化 result + 验收为准 | TW4, TW5 |
| P-81 | CP 重启后因 `chat_status=idle` 把 Run 标为成功 | TP §8.3 | 按 execution 事实收敛 | TW4 |
| P-82 | 迟到结果、取消后的结果、旧 Run 的结果覆盖当前状态 | TP §5.2 | 只绑定当前 Run；其他只进历史（I-17） | TW4, TW5 |
| P-83 | 协调员提交最终结果的那一轮仍是活动 Run，立即转 in_review 违反"无活动 Run" | TP §5.3 | 记录 `pending_review_run_id`，该 Run 终止后 reconcile 再判定 | TW2, TW3 |
| P-84 | owner 验收旧版本交付物 | TP §5.3 | accept 必须带 `result_run_id` + `expected_version` | TW2 |
| P-85 | 返工清空历史或重跑已完成子任务 | TP §5.3 | 保留历史；只重开显式指定的 WorkItem | TW2 |
| P-86 | 暂停时停止整个共享 Workspace，影响其他任务 | TP §8.3 | 只中断该 Task 的 Session / Execution | TW2, TW4 |
| P-87 | 暂停 / 取消请求刚发出就显示"已暂停 / 已取消" | TP §5.1 | 显示"暂停中 / 取消中"，确认终止后才迁移 | TW2, TW8 |
| P-88 | 有活动相关 Run 时修改成员、执行者或验收目标 | TP §8.3 | 拒绝（409），先停止；工作记录与评论不受限 | TW2 |
| P-89 | 单个成员等待输入就把整个 Task 标为 blocked | TP §5.1 | 其他工作可推进时保持 in_progress + attention | TW3 |
| P-90 | 输入事件"预留"被当成"已处理"，重试时丢输入或重复处理 | TP §6 | claim 时写 `input_event_ids`；成功后 `consumed_by_run_id`；重试沿用未消费部分；用 dedupe_key | TW3, TW4, TW5 |
| P-91 | 协调员正常结束但没有提交决策，被无限唤醒续聊 | TP §7 | → `blocked/no_decision`（D-17） | TW3 |
| P-92 | 有未处理输入时，Run succeeded 就一次性消费整个输入集合 | TP §7 | 协调员必须明确 `consumed_input_event_ids` 或 continue / blocked | TW3, TW5 |
| P-93 | 成员结果每到一条就启动一次协调员 | TP §7 | 没有活动协调员 Run 时才唤醒；同期多条结果合并进下一轮 | TW3 |
| P-94 | 结果待协调员确认期间重派同一 WorkItem | TP §7 | submitted 状态不可 claim | TW3 |
| P-95 | 把 HTTP 超时、connection reset、SSE 断开当成可安全重试 | V2.0 §17 | 只有 confirmed retryable 才自动重试 | TW4 |
| P-96 | turn 中 provider 错误自动重试，但工具可能已产生副作用 | D-09 | `toolActivityObserved=true` → `manual_only` | TW4 |
| P-97 | continuation 计入失败重试次数，或反之 | V2.0 §34 | `coordinator_turn_count` 与 `retry_count` 分开 | TW3, TW4 |
| P-98 | 重试发了新的输入集合或丢了原输入 | TP §7 | 重试处理原输入集合中未完成部分 | TW4 |
| P-99 | suspected_stall 释放了活动约束，随后被重复派发 | D-11 | Run 保持非终态占位 | TW4 |
| P-100 | waiting_input 计入 stall | D-12 | 排除 | TW4 |
| P-101 | queued Run 在 admission 前未重读 `control_intent` 与 `request_version`，失效请求仍被发送 | TP §7 | dispatch 前重读；失效则 `not_accepted` 收敛 | TW3 |
| P-102 | 请求已在途时暂停 / 取消，只看有没有 session_id | TP §7 | 按 dispatch_key 查询 / 停止；确认未接受或已终止才释放 | TW4 |
| P-103 | 协调员与成员可递归委派 | TP §9.1 | 首版成员不再委派；WorkItem 只有一层 | TW5 |
| P-104 | Prompt 渲染失败被忽略，发出不完整上下文 | Sym §12.4 | 严格变量检查，失败即 Run 失败 | TW5 |
| P-105 | 等待输入无限挂起 | Sym §10.5 | 显式呈现 + 通知；Phase 3 可配置超时 | TW4, TW8 |
| P-106 | `wait_for_items` 在没有未完成 WorkItem 时被接受 | 推论 | 无可等待项时拒绝该决策 | TW5 |
| P-107 | 用 `task.version` 判断在途 queued Run 是否失效；Run 自身的投影写入也会增加 version，导致误判失效或漏判 | V2.1 设计复核 | 使用 `dispatch_epoch`：只有改变派发意图的命令递增，Run 记录 claim 时的 epoch | TW2, TW3 |

## G. 资源与产物

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-110 | AFS 分配 / 挂载 / 回收不是 DB 事务 | TP §8.3 | 每步成功立即记录可恢复身份；失败保留阶段与错误；按标识幂等重放 | TW6 |
| P-111 | "吞掉 revoke 错误再删 DB 记录"，失去清理依据 | TP §8.3 | revoke 失败保留 `releasing/failed` 记录 | TW6 |
| P-112 | 路径分离被当成安全隔离 | TP §10 | 同 owner 是信任边界；不声称按 session 隔离文件 | TW6 |
| P-113 | checksum 被当成存储层不可变保证 | TP §10 | 提交时计算、验收前复核；变化则要求重新提交 | TW6 |
| P-114 | 未完成只读收敛就开放验收 | TP §10 | seal 失败阻止 accept | TW6 |
| P-115 | 返工时写挂载未恢复就派发新 Run | TP §10 | 恢复写挂载成功后才执行 | TW6, TW3 |
| P-116 | 多 Agent 共用同一 Git 工作树 | TP §10 | 各自 Workspace 独立 repo / worktree；只共享报告、patch、产物引用 | TW5（模板说明） |
| P-117 | done / cancelled 时删除交付物 | TP §10 | 保留；回收成员挂载，协调员保留只读 | TW6 |

## H. 插件生命周期

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-120 | draining 只等当前一轮 Run 结束就停掉插件 | TP §3.1.3 | draining 前已授权的任务允许派发、续跑、回复、返工、验收直至 done / cancelled | TW7 |
| P-121 | start 与 drain 并发，新任务漏入 drain 边界 | TP §3.1.3 | start 与进入 draining 都对 `teamwork_plugin_settings` 行加锁，与 task 授权同事务 | TW7, TW2 |
| P-122 | disabled 前只检查活动 Run 数量 | TP §3.1.3 | 检查所有已授权且非 done / cancelled 的任务、非终态 Run、未完成资源操作、blocked / unknown / in_review | TW7 |
| P-123 | 队列消息在执行时不重读 lifecycle | TP §3.1.3 | 每次 reconcile 先读 lifecycle | TW3, TW7 |
| P-124 | 升级时并行维护两套后端或给旧 preview 做状态推导 | TP §3.1.3 | 先 drain 再升级；不做旧状态推导 | TW7 |
| P-125 | 旧 bundle 或直接调用 API 绕过生命周期 | TP §12 | 服务端协议与 lifecycle 检查一致拒绝 | TW7, TW2 |
| P-126 | 通用插件管理接口（enabled / delete / upload）绕过 Teamwork 生命周期 | TP §3.1.2 | PL4 guard 扩展点强制调用 TW7 | PL4, TW7 |
| P-127 | 浏览器本地卸载被当成 disabled 检查依据 | TP §3.1.3 | 只以服务端状态为准 | TW7 |
| P-128 | 模板快照被当成完全可复现 | TP §3.1.4 | 只冻结协作模板，不锁定模型、第三方工具或 Workspace 配置 | TW5 |
| P-129 | 模板定义任意状态、脚本 hooks、递归图，或覆盖 owner / 并发 / 审批规则 | TP §3.1.4 | 模板只提供领域内容，固定 Zod schema | TW5 |

## I. UI

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-130 | 先拉快照再建 SSE，中间漏更新 | TP §9.2 | 先建订阅，再拉快照；期间通知继续失效缓存；重连再拉快照 | TW8 |
| P-131 | SSE 被当成事实来源 | V2.0 §49 | SSE 只做失效通知 | TW8 |
| P-132 | 列计数用已加载卡片数 | TP §4.1 | 服务端返回筛选后总数 | TW2, TW8 |
| P-133 | 详情深链接只存 localStorage | TP §4.1 | app 导航参数承载 `taskId / workItemId / runId` | TW8 |
| P-134 | 拖拽直接写 status | TP §4.1 | 拖拽映射为命令；运行中卡片不能拖入已完成；提供等价菜单与键盘操作 | TW8 |
| P-135 | 409 后保留乐观更新 | TP §4.1 | 撤销乐观变化，重取并解释原因 | TW8 |
| P-136 | 侧栏打开即订阅 token 流 | TP §4.2 | 只在展开会话页签时订阅 | TW8 |
| P-137 | runtime 未提供的用量显示 0 或估算费用 | TP §4.2 | 显示"未提供"；按 run / session 去重 | TW8 |
| P-138 | 回答问题发到协调员而不是提问的 session | TP §4.2 | 路由到原 session（`/requests/:id/respond`） | TW8, TW2 |
| P-139 | 普通评论唤醒 Agent；补充说明并发启动第二轮协调员 | TP §4.2 | 评论只记活动；补充说明排队到下一轮 | TW2, TW8 |
| P-140 | 展示模型猜测的进度百分比 | TP §4.1 | 只显示子任务完成数 / 总数与最近进展 | TW8 |

## J. V2.1 设计评审发现（V2.2 修订）

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-141 | runtime registry 会淘汰已结束记录，同实例的 404 被当成"从未执行"，已产生副作用的执行被重复执行 | V2.1 `02 §1.5` 旧表 vs `ws-pl2` registry 淘汰规则 | 404 一律 `unknown`；只有 fence 回执 `fenced` 或 412 能证明未接受（D-30） | PL1, PL2, TW4 |
| P-142 | session token 按 session 复用（`lib/session-token.ts` `ensureTokenForSession`），ACP core 在 session 创建 / 加载时固化 `X-Session-Token`（`internal/acp-adapter/acp-server.ts:377,430,521`）；从 session 推断"当前 Run"会把上一轮迟到的工具调用绑到下一轮 | 代码 | 写工具必须带 `run_ref` 并与当前 Run 比对；终态不确定后换新 Session（D-32，`02 §9.1`） | TW3, TW5 |
| P-148 | 用可预测的 Run id（自增、时间序）作为 `run_ref`，旧 turn 可以猜出下一轮的值 | V2.2.1 设计 | Run id 使用 UUIDv4 或同等随机度 | TW1 |
| P-149 | 旧 turn 在执行状态不明时仍然存活，调用 `teamwork_get_context` 拿到新 `run_ref` 后写入新 Run | V2.2.1 设计 | 终态不确定的 Run 之后，下一个 Run 必须换新 Session（`02 §9.1` 表） | TW3 |

## K. V2.2.1 设计评审发现（V2.2.2 修订）

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-150 | 发送权条件 UPDATE 影响 0 行就判定"已取消"。同一 key 两个并发 dispatch 都读到 `not_sent`，一方取得发送权后，另一方同样影响 0 行，把正在执行的请求改写成 interrupted | V2.2.1 `02 §1.6` 步骤 4 | 影响 0 行后重新读取，按实际状态返回；失败的竞争者不写执行状态（D-36，I-29） | PL1 |
| P-151 | 只派发本轮新插入的 queued Run；claim 提交后、执行行创建前崩溃，旧 queued Run 永久占位，又不会被派发 | V2.2.1 `ws-tw3 §2` | queued 且执行不存在或 `not_sent` 的 Run 进入恢复派发，复用原 dispatch_key（D-37） | TW3 |
| P-152 | 把"已只读收敛"列为进入 in_review 的前提，又要进入 in_review 后才触发 seal，两者互相等待 | V2.2.1 `02 §3.5` 与 `ws-tw3` D 段 | 两步：提交有效 → seal → 确认 ro → 进入 in_review（D-38） | TW3, TW6 |
| P-153 | `wait_for_items` 把 `submitted` 当成"仍未完成"；成员等协调员验收，协调员等成员完成，形成死锁 | V2.2.1 `ws-tw3 §3` | submitted 属于未处理输入，会唤醒协调员；只有没有未处理输入且仍有推进中的工作时才等待（D-39） | TW3, TW5 |
| P-154 | 命令"先查重、后加锁"。相同请求并发到达时都查不到记录，先到者成功，后到者撞上版本冲突返回 409，而不是首次响应 | V2.2.1 `02 §8` | 事务内 `INSERT ... ON CONFLICT DO NOTHING RETURNING` 原子占位，拒绝结果也写入（D-40） | TW1, TW2 |
| P-155 | `UNIQUE (task_id, type, workspace_id)` 中 `workspace_id` 可为 NULL，普通唯一约束允许多个 NULL，同一任务可以登记多个 share；保留孤儿历史行后也分不清哪个是当前资源 | V2.2.1 `02 §4` | 两条 partial unique index，排除 `orphan_suspected`；孤儿替换在同一事务内完成（D-41） | TW1, TW6 |
| P-156 | 换新 Session 时只发完整背景与 workpad；本轮预留的用户输入、返工说明、失败原因如果还没写进 workpad，就会丢失 | V2.2.1 `ws-tw5 §3` | initial 与 continuation 共用"本轮上下文块"（D-43） | TW5 |
| P-157 | 只把成员挂载改为只读；Phase 1A 只有协调员，seal 形同虚设，协调员在待验收期间仍可改写交付物 | V2.2.2 设计复核 | seal 覆盖所有执行方的写挂载，1A 即包括协调员 | TW6 |

## L. V2.2.2 设计评审发现（V2.2.3 修订）

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-158 | dispatchOne 复核发现失效时直接把 Run 写成 `failed{not_accepted}`，假定尚未发送。有了 redispatch 后，另一个 reconcile 可能已经发出请求，停止流程会显示"已暂停"，底层执行却还在跑 | V2.2.2 `ws-tw3 §2` | 失效分支统一走 `interruptManagedExecution`，由执行层判定是否已发送；Run 状态只来自投影（D-44） | TW3 |
| P-159 | 只按 `send_state` 决定能否发送。admission 失败后是 `failed + not_sent`，迟到的同 key 调用会把终态执行改回 starting，绕过重试次数、退避和新 Run 记录；singleflight 挡不住执行结束之后的重放 | V2.2.2 `02 §1.6` | 先判终态；发送权与取消 UPDATE 都加 `status='queued'`；终态吸收（D-45） | PL1 |
| P-160 | lifecycle 事件只按 `(execution_id, seq)` 去重，迟到的旧序号事件不算重复，会把已终态的 Run 改回非终态，造成错误占位或唯一约束冲突 | V2.2.2 `ws-tw4 §2` | 投影时读取执行当前行，`applied_exec_seq` 单调，终态不回退（D-46） | TW4 |
| P-161 | 当前资源行唯一就以为外部操作只执行一次。A 的 `createDir` 正常在途时，B 读到"preparing 且无 resource_id"，当作孤儿替换，结果创建了两个目录，A 返回后还可能写回旧行或挂载旧目录 | V2.2.2 `ws-tw6 §3` | 外部操作领租约；只有租约过期才判孤儿；`commitOp` 校验 op_id，过期操作回收自己的目录并停止（D-47） | TW6 |

## M. V2.2.3 设计评审发现（V2.2.4 修订）

本节几条问题的共同点：DB 条件写入只能保护数据库状态，挡不住已经发到外部系统的副作用（R4）。

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-162 | 把"客户端超时小于租约"当作外部操作不会重叠的保证。客户端超时并不代表 AFS 服务端已停止处理：旧的 rw 挂载请求可能在新的 ro seal 之后才生效；`commitOp` 虽然拒绝了旧结果落库，实际挂载却已恢复为 rw | V2.2.3 `ws-tw6 §3` | 修改共享挂载的操作结果不确定时进入 `uncertain`，不能凭租约过期接手；以观察到的实际状态为准（D-48） | TW6 |
| P-163 | 人工 resolve 直接修改 Run 的执行状态，绕过统一投影；平台接口又没有对应能力，实施者只能二选一：违反 R1，或无法解除 unknown | V2.2.3 `ws-tw4 §5` | 平台提供 `resolveManagedExecution`，Run 经投影更新；命令异步执行（D-49） | PL1, TW2, TW4 |
| P-164 | 取消 UPDATE 影响 0 行就当作"执行在途"，直接调用 runtime interrupt。0 行也可能表示执行已经结束 | V2.2.3 `02 §1.6` | 重新读取；已终态直接返回，不调用 runtime（D-50） | PL1 |
| P-165 | 按 session 中断。Session 复用后，迟到的取消请求会打断下一轮 | 现有 `/sessions/:id/interrupt` | 执行级中断：按 dispatch_key 定位，由 agent-server 原子地匹配并中断（I-35） | PL1, PL2 |
| P-166 | 在 HTTP handler 里先比较 dispatch_key，再异步调用"取消当前 session"。比较和取消之间可能进入新一轮 | astra 评审补充 | 捕获并操作被匹配那一轮的执行对象或取消句柄；ACP / DSH 用 session 级互斥锁覆盖"匹配 + 写 cancel"与"受理下一轮 + 发 prompt" | PL2 |
| P-167 | 只提供 session 路由的中断。请求已发出、`session.started` 尚未回来时，CP 没有 session_id，无法定位这一轮 | V2.2.4 设计复核 | 按 dispatch_key 寻址；取消句柄在 `/chat` 受理时登记；未见过的 key 原子 fence | PL2 |

## N. V2.2.4 设计评审发现（V2.2.5 修订）

本节两条都是 2.2.4 自己引入的捷径，违反了 R4。

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-168 | 挂载状态与目标不一致、并持续一段观察窗口，就认定旧请求已失效并重新发起。这仍是用等待时间推断外部操作已结束；旧请求可能在窗口之后、甚至在 accept 最后一次探测之后才生效 | V2.2.4 `ws-tw6 §3` | 删除按窗口自动恢复；`probeMounts` 只证明当前状态；`uncertain` 只凭旧操作已终止的证据解除；存在 `uncertain` 时禁止新的挂载修改（D-52，I-36） | TW6 |
| P-169 | 以为"session 锁保证 cancel 先写入 stdin"就等于子进程按这个顺序处理；并且把"无法确认是否停止"和"可能取消错执行"当成同一种缺陷，一律降级为 `interruptConfirm=false` | V2.2.4 `02 §2.4` | 隔离性是硬性前提，与可确认性分开声明（`interruptTargeted` / `interruptConfirm`）；写入顺序不等于处理顺序，必须实测（D-53，I-37） | PL2 |
| P-170 | F-17 实测失败后，把 capability 改成 false 就宣告通过 | V2.2.4 `ws-qa F-17` | F-17 是硬性闸门；失败必须改用方式 (c)（锁内终止子进程）并重测 | PL2, QA |

## O. V2.2.5 设计评审发现（V2.2.6 修订）

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-171 | 把"fuse-server 实例已变更"当作旧挂载请求不会生效的证据。旧请求可能还在网络或上游队列中，重启后才送到新实例；挂载请求没有类似 `expected_runtime_instance_id` 的实例绑定，runtime 的实例隔离结论不能直接套用。人工确认若只写"已重启 sidecar"，也有同样问题 | V2.2.5 `ws-tw6 §3` | 恢复基线只有 AFS 服务端操作序号与人工确认；启用实例变更须同时满足三个前提；人工确认须写明旧请求已无法送达的依据（D-55） | TW6 |
| P-172 | 命令契约新增了 admin 可执行的命令，但授权规则里的 admin 例外清单没有同步，admin 实际会收到 404 | V2.2.5 `02 §8` vs `ws-tw2 §4` | admin 例外清单只在 `ws-tw2 §4` 维护一份，契约引用它；新增例外时同步审计、通知与权限测试（D-56） | TW2 |

## P. V2.2.7 派发化自查

| ID | 陷阱 | 证据 | 规则 | WS |
| --- | --- | --- | --- | --- |
| P-174 | WP 的完成标准引用了后续 WP 才提供的东西：PL1b 要通过 PL1d 才实现的 F-11；TW2b 要通过 QA5 的 PT-03；TW3b / TW7b 等直接要求只有测试装配或闸门才能运行的 A / L 场景；QA4 需要的完整装配没有任何 WP 负责；QA7 要求切换后才可能通过的 L-07。结果是 Agent 无法独立完成并合入，或者被迫自行补做别人的工作 | 2.2.7 任务板评审 | R-WP：依赖分开工 / 合入 / 闸门三类；完成标准只用"开工 + 合入依赖"范围内能运行的测试；场景编号指 fake 级变体；修改任务板时卡片、依赖图、波次、关键路径、分配表同步（D-59～D-61） | INT |
| P-175 | 冻结的契约文件引用了冻结之后才由实现 WP 创建的类型（`ports.ts` 导入 `./db/tx`），导致 M0 无法编译、形成 CT2 ↔ TW1a 循环；同时引用了仓库中不存在的路径别名 `@qap/types` | 2.2.8 `02 §5` | ports 只能从 contracts 与 `internal/types` 导入；ports 引用的类型全部由 CT2 定义；跨包使用相对路径（D-62） | CT |
| P-173 | 修订流程与正文时没有同步 `02 §5` 的 ports：`resolveExecution` 仍是带事务的同步签名，`ExecutionPort` 缺 `resolveManagedExecution`，`ResourceManager` 缺 resolve 续接。CT 按旧 ports 冻结的话，各 Agent 会按互相矛盾的接口实现 | V2.2.6 `02 §5` vs D-49、D-52 | 任何契约 RFC 必须在同一 PR 内同步 ports；CT 在冻结前逐项核对 ports 与正文 | CT, INT |
| P-143 | AFS `createDir` 由服务端生成 id，`accessKey` 只在返回值中出现一次，且没有 lookup；"先调用、后落库"在回执丢失时既无法查回也无法 revoke | `control-plane/src/services/afs.ts:87-96` | 不宣称每步幂等；逐步定义恢复方式；孤儿目录标 `orphan_suspected` 上报（D-34） | TW6 |
| P-144 | 在 turn-gate 之前就取得发送权，排队期间到达的 pause 无法阻止发送 | V2.1 `ws-tw3` dispatchOne | turn-gate 之后才用条件 UPDATE 取得发送权；取消与发送二选一（D-31） | PL1, TW3 |
| P-145 | 命令重放先于授权返回缓存响应，其他已认证用户可以读到原始命令响应与 task 快照 | V2.1 `02 §8` 处理顺序 | 授权先于重放；重放仍先于 lifecycle 与 version；payload 不同返回 422（D-33） | TW2 |
| P-146 | reconcile 只读非终态 Run，hook 已写为终态的 Run 永远不会被应用业务后果 | V2.1 `ws-tw3` 算法 vs `ws-tw4` hook | 持久化 `outcome_applied_at`，reconcile 读取待处理终态 Run（D-29） | TW3, TW4 |
| P-147 | 新旧实现使用同一 URL，G2–G4 期间同时挂载会互相覆盖，旧 UI 又不满足新协议 | V2.1 `03 §4` 与 `§8` | G4 之前新实现只在测试装配中运行；G4 原子切换（D-35） | INT, TW9 |
