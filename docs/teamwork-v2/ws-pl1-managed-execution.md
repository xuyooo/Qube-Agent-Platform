# WS-PL1 · Managed Execution 核心

Phase 0。必读：`00-architecture.md`、`02-contracts.md §1 §2`、`90-pitfalls.md` 中标注 PL1 的条目。

## 1. 目标

平台能够可靠回答：**一次 Agent Execution 到底发生了什么**。所有入口（Web Chat、API Chat、Scheduler、Connector、call_agent、Teamwork 协调员 / 成员）共享同一套底层执行 primitive。

## 2. 拥有的文件

- 新建 `control-plane/src/services/execution/`：`service.ts`（实现 `ManagedExecutionService`）、`repo.ts`、`recovery.ts`、`lifecycle-bus.ts`、`lookup.ts`、`*.test.ts`
- 修改 `control-plane/src/services/chat/executeChat.ts`、`dispatchChatTurn.ts`
- 修改 `control-plane/src/lib/sse.ts`、`lib/sse-aggregate.ts`、`lib/session-recovery.ts`、`lib/session-token.ts`
- 新建 `control-plane/migrations/148_managed_executions.sql`

## 3. 任务

| # | 任务 | 完成标准 |
| --- | --- | --- |
| PL1-1 | 提交代码映射复核（不改代码） | `03-parallel-plan.md §8` 中 PL1 行确认或修正 |
| PL1-2 | migration 148 + repo | 表与索引与契约一致；repo 单测 |
| PL1-3 | 从 `executeChat` 抽出执行核心 `runManagedTurn`：admission → `ensureWorkspaceRunning` → session 校验 → `pickReplicaForTurn` → token → `send_state=sending` 落库 → POST `/chat`（带 `dispatch_key`）→ `sent` → SSE 拦截持久化 | 现有 chat 路由、async / sync / stream 三种模式行为回归不变 |
| PL1-4 | `dispatchManagedTurn` 幂等：同 key 已存在时按 §1.5 恢复判定表返回，不重复 POST | 并发 10 次同 key 只有 1 次 POST（fake agent 计数） |
| PL1-4a | 发送权 / 取消权原子二选一（`02 §1.6`）：`not_sent → sending` 与 `not_sent → cancelled` 以同一条件 UPDATE 竞争；turn-gate 排队结束后才尝试取得发送权；取消可作用于尚不存在的执行行（墓碑）。**UPDATE 影响 0 行后重新读取，按实际状态返回，失败的竞争者不写执行状态**（D-36，P-150）；同 key 进程内 singleflight | F-11：取消与发送并发 ×100，每次恰好一方获胜；取消获胜时 fake agent 收到 0 次请求。F-01：同 key 并发 dispatch ×10，只执行一次，且执行行的 `status / send_state / ended_at / failure` 从未被失败的竞争者改写 |
| PL1-4d | 执行核心的判定（恢复判定表、发送权结果分类）写成纯函数，供 QA 属性测试使用（D-42） | PT-01 属性测试通过 |
| PL1-4e | 执行终态吸收（R2，D-45）：步骤 1 先判终态；发送权与取消 UPDATE 都带 `status='queued'`；所有写入路径（流消费、失败写回、恢复、probe、resolve）都带非终态条件与 `last_seq` 单调条件；`interruptManagedExecution` 支持 `asFailure` | A-31：发送前失败后同 key 再调用不会重启；PT-01 断言 I-32 |
| PL1-4b | 发送时携带 `expected_runtime_instance_id` | 412 被映射为 `not_accepted` |
| PL1-4c | 恢复：`send_state=sending/sent` 且 session 未知时调用 fence，按 `02 §1.5` 判定；普通 404 一律 `unknown` | F-12、F-13 |
| PL1-5 | SSE 事件 → `managed_executions` 投影（§1.3）；`seq` 单调；`last_progress_at` 只计模型 / 工具事件，节流 15s | 映射表逐行有测试 |
| PL1-6 | lifecycle bus：事件持久化**之后**回调各 origin handler；至少一次；handler 抛错不影响执行消费，记录日志 | handler 失败时执行仍完成；重启后 sweep 可补 |
| PL1-7 | `getManagedExecution(probe)`：按 `replica_ordinal` 路由到正确 replica 调 `GET /executions/:key`；比较 `runtime_instance_id` | 实例变化返回 unknown 判定 |
| PL1-8 | `interruptManagedExecution`：取消 UPDATE 影响 0 行后**重新读取**，已终态直接返回、不调用 runtime（P-164）；在途时调用 agent-server 的**执行级中断**（`02 §2.4`），不再使用不带 key 的 session 级 interrupt（I-35）；按五种结果收敛；`confirmed` 仅在收到终态事件或执行级中断确认终止时为 true | "HTTP 200 但未终止"用例；A-35：旧取消请求在下一轮启动后到达，不打断新一轮 |
| PL1-8c | 派发前检查目标 runtime 的 `/info`：`interruptTargeted=false` 的 runtime **拒绝托管派发**（`failed{pre_dispatch, invalid_configuration}`，non_retryable），而不是派发后无法安全停止（D-53，I-37） | 能力为 false 的 fake runtime 收到 0 次托管请求 |
| PL1-8b | `resolveManagedExecution`（D-49）：平台唯一的人工写入路径；bind_existing 先 probe；其他结论先发执行级中断，再条件 UPDATE 为终态；写 `resolution`，`last_seq + 1` | A-34 |
| PL1-9 | `reconnectManagedExecution`：复用现有 `reconnectFactory` → `/sessions/:id/reconnect` | CP 重启后继续消费并补齐事件 |
| PL1-10 | 启动恢复：先扫描非终态 `managed_executions` 按 §1.5 收敛，再运行现有 `recoverOrphanedSessions`；两者不得对同一 session 重复 reconnect | 故障注入 F-01～F-06 |
| PL1-11 | `disablePendingDrain`：为 true 时 `session.ended` 后不调用 `drainPendingMessage` | D-15 |
| PL1-12 | `respondToRequest`：转发到原 session 的 `/sessions/:id/respond`，更新 `pending_requests` | |
| PL1-13 | Web / API / scheduler / connector 入口统一改走 `dispatchManagedTurn`（origin 区分），外部 HTTP 契约不变 | 全部现有测试通过 |

## 4. 设计要点

- **dispatch_key 生成**：非 Teamwork 入口由 PL1 生成（例如 `chat:{uuid}`）；Teamwork 由调用方传入 `teamwork:{run_id}` 且已在其事务中持久化。
- **不阻塞调用方**：`dispatchManagedTurn` 在 admission 通过且请求送达（或确定失败）后返回；turn 的 SSE 由 CP 内部持续消费。stream 模式的 HTTP 客户端通过现有广播订阅同一执行。
- **send_state 写入必须先于网络调用提交**，这是区分"未发送"与"可能已发送"的唯一依据。
- **发送权在 turn-gate 之后取得**。turn-gate 排队可能很久；在排队期间到达的取消必须能阻止发送。不要在进入 turn-gate 之前就把 `send_state` 改成 `sending`（P-144）。
- **404 不是证据**。只有 fence 回执 `fenced` 或 `412 instance_mismatch` 能证明未接受（P-141）。
- 取消墓碑：`interruptManagedExecution` 对不存在的 dispatch_key 插入 `send_state=cancelled` 的行，调用方必须提供 `workspaceId / origin / originRef`。
- **session.started 之前 `session_id` 为空**：新 session 在 async 模式下本来就要等 `session.started`；lookup 结果中的 `session_id` 用于补绑定。
- **turn-gate 单进程**：不要试图用 DB 实现跨进程 admission；保持现状并在启动时记录"单活 CP"假设。
- **autoscaled workspace 满载返回 503**：映射为 `failed{stage:admission, code:capacity_unavailable}`，并透传 `Retry-After`（若有）。
- **24h 上游超时**：保持与客户端解耦；Managed Execution 不引入新的总时长上限。
- **shutdown**：现有 `drainActiveStreams` 保留；关闭前把仍在运行的执行保持为非终态，由下次启动恢复。

## 5. 测试

- 单元：状态映射、恢复判定表（每一行）、seq 去重、progress 节流。
- 集成（真实 PostgreSQL + QA fake agent-server）：F-01～F-10。
- 回归：现有 `control-plane` vitest 全绿；e2e chat 用例。

## 6. 本工作流相关踩坑

P-01～P-12、P-14、P-16、P-18、P-62、P-66、P-141、P-144（见 `90-pitfalls.md`）。
