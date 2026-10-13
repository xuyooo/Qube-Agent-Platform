# 02 · 冻结契约

本文件是所有工作流之间**唯一**的协作面。M0 里程碑时冻结；冻结后修改必须走契约 RFC（见 `03-parallel-plan.md §6`），由集成者合并，并通知所有依赖方。

代码落地位置：

- 平台契约：`internal/types/managed-execution.ts`（新建，CT 负责）、`internal/types/events.ts`（扩展）
- Teamwork 契约：`plugins/teamwork/contracts/*`（新建，CT 负责）

字段名使用 snake_case（DB / HTTP）与 camelCase（TS 内部）两种，映射一一对应。

---

## 1. Managed Execution（平台，PL1 提供）

### 1.1 TypeScript 接口

```ts
// internal/types/managed-execution.ts
export type ExecutionStatus =
  | 'queued' | 'starting' | 'running' | 'waiting_input'
  | 'succeeded' | 'failed' | 'interrupted' | 'unknown'

export const NON_TERMINAL_EXECUTION: ExecutionStatus[] =
  ['queued', 'starting', 'running', 'waiting_input', 'unknown'] // unknown 占位，不是终态

export type SendState = 'not_sent' | 'cancelled' | 'sending' | 'sent' | 'acknowledged'
// not_sent → cancelled 与 not_sent → sending 互斥，只能二选一（§1.6）

export type FailureStage =
  | 'pre_dispatch'      // 请求未离开 CP（校验、token、路由失败）
  | 'admission'         // turn-gate 拒绝 / 容量不足
  | 'workspace_start'   // ensureWorkspaceRunning 失败
  | 'transport'         // 发送阶段网络错误，runtime 是否收到未知
  | 'in_turn'           // runtime 已接受，turn 中失败
  | 'post_turn'         // 终态已知，持久化或收尾失败

export interface ExecutionFailure {
  stage: FailureStage
  code: string                 // 规范化错误码，见 §1.4
  message: string
  retryAfterMs?: number        // provider / admission 提示
  runtimeReportedFatal?: boolean
  toolActivityObserved: boolean // 失败前是否观察到 tool_call，用于 manual_only 判定
}

export interface RuntimeExecutionCapabilities {
  dispatchIdentity: boolean    // /chat 支持 dispatch_key 去重
  executionLookup: boolean     // 支持 GET /executions/:dispatch_key
  reconnect: boolean
  interrupt: boolean
  interruptTargeted: boolean   // 执行级中断**不会**影响目标以外的执行（隔离性，安全前提，D-53）。为 false 时 CP 不得对该 runtime 发起托管执行中断
  interruptConfirm: boolean    // 能否确认目标已停止（可确认性，活性）。只在 interruptTargeted=true 时有意义
  waitingInput: boolean        // 会发出 question.requested / 权限请求
}

export interface ManagedExecution {
  id: string
  dispatchKey: string
  origin: 'chat' | 'api' | 'scheduler' | 'connector' | 'call_agent' | 'teamwork'
  originRef: string | null     // teamwork: run_id；call_agent: caller session id
  workspaceId: string
  sessionId: string | null     // session.started 之前为 null
  parentExecutionId: string | null
  runtimeType: string          // workspace_config.agent_type
  runtimeInstanceId: string | null
  replicaOrdinal: number | null
  capabilities: RuntimeExecutionCapabilities
  status: ExecutionStatus
  sendState: SendState
  failure: ExecutionFailure | null
  pendingRequests: PendingRequest[]  // 原生 question / permission request
  turnStats: unknown | null          // TurnStats
  createdAt: string
  startedAt: string | null
  endedAt: string | null
  lastEventAt: string | null         // 任何事件，含 keepalive 以外的状态事件
  lastProgressAt: string | null      // 仅模型 / 工具进展，不含 SSE keepalive
}

export interface PendingRequest {
  requestId: string
  kind: 'question' | 'permission'
  sessionId: string
  status: 'pending' | 'answered' | 'cancelled'
  createdAt: string
}

export interface DispatchManagedTurnInput {
  dispatchKey: string          // 调用方生成并已持久化；teamwork 为 `teamwork:{run_id}`
  origin: ManagedExecution['origin']
  originRef?: string
  workspaceId: string
  sessionId?: string           // 续跑时复用
  parentExecutionId?: string
  message: string
  images?: unknown[]
  userId: string               // 以谁的身份执行（owner）
  disablePendingDrain?: boolean // D-15：teamwork 必须 true
  // 注意（D-32）：不再使用 sessionTokenScope。工具调用属于哪个 Run 由 Teamwork 层的
  // run_ref 比对决定（§9.1），平台层与 agent-server 不感知。
}

export interface DispatchResult {
  execution: ManagedExecution
  deduplicated: boolean        // 同 key 已存在，返回原执行
}

export interface ManagedExecutionService {
  /** 幂等：同 dispatchKey 返回同一 execution。只在拿到 admission 且请求已送达（或确定失败）后返回。
   *  不等待 turn 结束；CP 内部持续消费 agent SSE 并持久化。 */
  dispatchManagedTurn(input: DispatchManagedTurnInput): Promise<DispatchResult>

  /** probe=true 时对 runtime 发起实时查询（需 executionLookup）；否则只读 DB 事实。 */
  getManagedExecution(dispatchKey: string, opts?: { probe?: boolean }): Promise<ManagedExecution | null>

  /** 停止一个执行。发送权与取消权通过 §1.6 的原子状态转换竞争，只有一方获胜：
   *  - 尚未取得发送权（含 turn-gate 排队中、甚至行尚不存在）→ 写 cancel_requested_at，
   *    执行以 interrupted{code:cancelled_before_send} 终止，返回 confirmed=true，保证永不发送；
   *  - 已取得发送权 → 调用 runtime interrupt，返回 delivered / confirmed；delivered 不等于停止。
   *  行不存在时插入墓碑行（status=interrupted, send_state=cancelled），此后同 key 的
   *  dispatchManagedTurn 返回 deduplicated=true 且不发送。 */
  //  asFailure：取消方获胜时终态记为 failed{asFailure}（例如 prompt 渲染失败），而不是 interrupted；发送方已获胜时忽略
  interruptManagedExecution(dispatchKey: string, opts?: { workspaceId?: string; origin?: ManagedExecution['origin']; originRef?: string; asFailure?: ExecutionFailure }):
    Promise<{ delivered: boolean; confirmed: boolean; execution: ManagedExecution }>

  /** 恢复对仍在运行的 execution 的事件消费（CP 重启后） */
  reconnectManagedExecution(dispatchKey: string): Promise<ManagedExecution>

  /** 注册某 origin 的生命周期回调。事件已持久化后才回调；至少一次；处理必须幂等且快速（<1s，不做网络调用）。 */
  onExecutionLifecycle(origin: ManagedExecution['origin'], handler: (e: ExecutionLifecycleEvent) => Promise<void>): void

  /** 回答原生问题 / 权限请求，路由到原 session */
  respondToRequest(dispatchKey: string, requestId: string, answer: unknown): Promise<void>

  /** 会话守卫扩展点（D-66）。每次 dispatch（任何 origin）在 claim session 之前调用所有已注册守卫；
   *  任一守卫返回 reject，该 turn 以 failed{stage:'pre_dispatch', code:'session_managed'} 拒绝，HTTP 入口返回 409。
   *  平台不解读守卫的语义（I-13）；Teamwork 用它拒绝"非 teamwork origin 直接向受管 Session 发起 turn"。 */
  registerSessionGuard(guard: (ctx: { origin: ManagedExecution['origin']; workspaceId: string; sessionId: string | null; userId: string }) =>
    Promise<{ allow: true } | { allow: false; reason: string }>): void

  /** 人工处理不确定执行（D-49）。这是 `managed_executions` 唯一的人工写入路径；调用方不得绕过它直接改 Run。
   *  - 适用：status ∈ {unknown, running（suspected_stall）}；已终态时幂等返回现状，不改写（R2）；
   *  - bind_existing：先 probe，确认原执行在同一实例上仍然存在，再写入观察到的状态；probe 不能确认则拒绝；
   *  - confirmed_not_accepted / confirmed_terminated：先发一次执行级中断（§2.4，结果不阻塞本操作），
   *    再以条件 UPDATE 转为终态（failed{not_accepted} / interrupted 或 failed）；
   *  - 每次写入都记录 resolution、last_seq + 1，之后由 Teamwork 的统一投影更新 Run（R1）。
   *  包含网络调用，**不得**在调用方的 DB 事务内执行。 */
  resolveManagedExecution(dispatchKey: string, input: {
    decision: 'bind_existing' | 'confirmed_not_accepted' | 'confirmed_terminated'
    evidence: string
    actor: { type: 'user' | 'admin'; id: string }
    sideEffectsChecked?: boolean
    retryable?: boolean
  }): Promise<{ execution: ManagedExecution; applied: boolean; reason?: 'already_terminal' | 'probe_unconfirmed' }>
}

export interface ExecutionLifecycleEvent {
  type: 'admitted' | 'started' | 'waiting_input' | 'input_resolved' | 'progress' | 'terminal' | 'unknown'
  execution: ManagedExecution
  seq: number                  // 同一 execution 内单调递增，供幂等去重
}
```

`progress` 事件节流：同一 execution 每 15s 至多一次，只用于更新 `last_progress_at` 投影，不做业务推进。

### 1.2 平台表 `managed_executions`（PL1，migration 148）

```sql
CREATE TABLE managed_executions (
  id                   TEXT PRIMARY KEY,
  dispatch_key         TEXT NOT NULL UNIQUE,
  origin               TEXT NOT NULL,
  origin_ref           TEXT,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id),
  session_id           TEXT REFERENCES sessions(id),
  parent_execution_id  TEXT REFERENCES managed_executions(id),
  user_id              TEXT NOT NULL,
  runtime_type         TEXT NOT NULL,
  runtime_instance_id  TEXT,
  replica_ordinal      INT,
  capabilities         JSONB NOT NULL,
  status               TEXT NOT NULL,
  send_state           TEXT NOT NULL DEFAULT 'not_sent',
  cancel_requested_at  TIMESTAMPTZ,                  -- 取消意图；与发送权互斥（§1.6）
  send_claimed_at      TIMESTAMPTZ,                  -- 取得发送权的时间
  expected_instance_id TEXT,                         -- 发送时声明的目标 runtime 实例（§2.1）
  failure              JSONB,
  resolution           JSONB,                        -- 人工处理结论（D-49）：{decision, evidence, actor, side_effects_checked, retryable, at}
  pending_requests     JSONB NOT NULL DEFAULT '[]',
  turn_stats           JSONB,
  last_seq             BIGINT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,
  ended_at             TIMESTAMPTZ,
  last_event_at        TIMESTAMPTZ,
  last_progress_at     TIMESTAMPTZ
);
CREATE INDEX managed_executions_active_idx ON managed_executions (status)
  WHERE status IN ('queued','starting','running','waiting_input','unknown');
CREATE INDEX managed_executions_session_idx ON managed_executions (session_id);
CREATE INDEX managed_executions_origin_idx ON managed_executions (origin, origin_ref);
```

写入规则：`send_state` 必须在发起 HTTP 前通过 §1.6 的原子转换写为 `sending` 并提交；收到 agent 响应头后写 `sent`；收到 `session.started` 或 dispatch 回显后写 `acknowledged`。

### 1.3 UniversalEvent → Execution 状态映射

| 事实 | Execution 状态 | 备注 |
| --- | --- | --- |
| 行已创建，未发送 | `queued` | |
| admission 通过、发送中 | `starting` | turn-gate 排队期间仍为 `queued` |
| `session.started` | `running` | 绑定 `session_id`，`send_state=acknowledged` |
| `question.requested` / 权限请求 | `waiting_input` | 写 `pending_requests` |
| 请求被回答 | `running` | |
| `session.ended{reason:completed}` | `succeeded` | 写 `turn_stats` |
| `session.ended{reason:error}` | `failed` | `failure.stage=in_turn` |
| `session.ended{reason:interrupted}` | `interrupted` | |
| turn-gate 503 / 容量拒绝 | `failed` | `failure.stage=admission` |
| `ensureWorkspaceRunning` 失败 | `failed` | `failure.stage=workspace_start` |
| 发送前本地错误 | `failed` | `failure.stage=pre_dispatch` |
| `send_state=sending/sent` 后连接中断，且 lookup 无法确认 | `unknown` | `failure.stage=transport` |
| CP 重启：session 已知且 reconnect 成功 | 保持原状态并继续消费 | |
| CP 重启：session 未知、有 dispatch identity | 按 lookup 结果 | 见 §1.5 |
| lookup 显示 runtime 实例已变更 | `unknown` | 不得推断为未执行 |

`sessions.chat_status` 继续由现有逻辑维护，**不参与**上表判定。

### 1.4 规范化错误码（`failure.code`）

`capacity_unavailable`、`session_busy`（D-65）、`provider_auth_required`（D-68）、`session_managed`（D-66）、`workspace_start_failed`、`workspace_not_found`、`session_invalid`、`token_mint_failed`、`transport_error`、`agent_http_status`、`agent_fatal`、`provider_error`、`provider_rate_limited`、`permission_denied`、`invalid_configuration`、`budget_exhausted`、`interrupted_by_request`、`runtime_restarted`、`persist_failed`、`unknown`。

平台只报告事实（stage、code、retryAfterMs、toolActivityObserved）。**是否重试由 Teamwork 判定**（TW4）。

### 1.5 恢复判定表（PL1 实现，TW4 消费）

**普通 404 永远不是"未接受"的证据**（D-30）。registry 会淘汰已结束条目，记录不存在可能意味着"执行过但记录已淘汰"。只有 §2.2 的 fence 回执能证明"确定未接受"。

| `send_state` | session 已知 | 能力 | 查询 / fence 结果 | 结论 |
| --- | --- | --- | --- | --- |
| `not_sent` | — | — | — | 可直接发送同一 dispatch_key（仍需经 §1.6 取得发送权） |
| `cancelled` | — | — | — | 终态 `interrupted{cancelled_before_send}`，永不发送 |
| `sending` / `sent` | 否 | lookup | 找到，同实例 | 绑定并继续消费 |
| `sending` / `sent` | 否 | fence | `fenced`（同实例，签发前从未见过该 key） | `failed{stage:transport, code:not_accepted}`，可安全重试 |
| `sending` / `sent` | 否 | fence | `seen`（见过但记录已淘汰） | `unknown` |
| `sending` / `sent` | 否 | fence | `not_authoritative`（key 集合溢出） | `unknown` |
| `sending` / `sent` | 否 | 任意 | 实例已变 / 返回 412 以外的实例不一致 | `unknown` |
| `sending` / `sent` | 否 | 只有 lookup、无 fence | 404 | `unknown`（不再视为可安全重发） |
| `sending` / `sent` | 否 | — | 发送返回 `412 instance_mismatch` | `failed{stage:transport, code:not_accepted}`（runtime 保证 412 时未执行） |
| `acknowledged` | 是 | — | — | reconnect；失败再 lookup；仍不确定 → `unknown` |
| 任意 | 网络不通 | — | — | 保持原状态，下次 reconcile 再查；超过 10min → `unknown` |

### 1.6 发送权与取消权（原子二选一，D-31）

`dispatchManagedTurn` 的内部顺序：

```text
0. 进程内 singleflight：同一 dispatch_key 已有进行中的 dispatchManagedTurn 调用时，直接等待并共享它的结果
   （只是优化，避免同 key 重复占用 turn slot；正确性不依赖它，见步骤 4）
1. INSERT managed_executions(status=queued, send_state=not_sent) ON CONFLICT (dispatch_key) DO NOTHING
   已存在时**先看 status**（R2，D-45）：
     status 为终态（succeeded / failed / interrupted）→ 返回 deduplicated（原结果），不发送、不占 turn slot。
        典型情况：admission 或 workspace 启动失败后是 failed + not_sent，迟到的同 key 调用不得把它改回 starting；
        要重试必须由调用方新建 Run 和新的 dispatch_key（P-159）
   非终态时再按 send_state 处理：
     cancelled                    → 返回 deduplicated（interrupted），不发送
     sending / sent / acknowledged → 返回 deduplicated（已有执行），不发送；在途是否确定由 §1.5 恢复流程判断
     not_sent                     → 继续步骤 2（同一 key 可能由恢复派发再次进入，见 ws-tw3 §2）
2. acquireTurn（turn-gate 排队，可能等待）
3. ensureWorkspaceRunning、session 校验、replica 选择
4. 取得发送权（单条语句，事务外无锁等待）：
     UPDATE managed_executions
        SET send_state='sending', send_claimed_at=now(), status='starting',
            expected_instance_id=$inst
      WHERE dispatch_key=$k AND send_state='not_sent' AND cancel_requested_at IS NULL
        AND status = 'queued'                                   -- R2：终态不能被重新启动
   影响 1 行 → 继续步骤 5
   影响 0 行 → 释放 turn slot，**重新读取该行**，按实际状态返回，失败的竞争者**不写**执行状态（D-36）：
     send_state ∈ {sending, sent, acknowledged} → 另一个调用已取得发送权：返回 deduplicated（已有执行）
     send_state = cancelled                     → 取消方已写终态：返回 deduplicated（interrupted）
     send_state = not_sent 且 cancel_requested_at 非空 → 取消方已表态但尚未写终态：由本调用执行取消一侧的
         条件 UPDATE（WHERE send_state='not_sent'，与下方"取消"相同），然后重新读取并返回
     status 为终态（例如并发调用在 admission 阶段已失败）→ 返回 deduplicated（原结果），不写
     send_state = not_sent 且 cancel_requested_at 为空且 status = queued → 不应出现（UPDATE 条件本应命中）：记录错误，按步骤 4 重试一次
5. POST /chat（带 dispatch_key、expected_runtime_instance_id）
```

**R2：执行终态是吸收态**（I-32）。`managed_executions` 的所有写入路径都遵守同一条件：

- 涉及的路径：流消费、admission / workspace 启动失败写回、发送权、取消、恢复、probe 写回、resolve 写回；
- 从非终态到终态：`WHERE status NOT IN ('succeeded','failed','interrupted')`；
- 非终态字段更新（进展时间、pending_requests 等）：同样要求当前为非终态，并且 `last_seq` 单调递增（`WHERE last_seq < $seq`）；
- 同一 dispatch_key 进入终态后只能读，重试一律由调用方新建 dispatch_key。

**与会话 turn 租约的关系**（D-65，`main@0758e7e` 已有，`services/chat/session-turn.ts`、migration 147）：

- main 已实现"一个 session 同时只有一个 turn"：`sessions.turn_claim` 租约，TTL 60s，20s 续租，单条条件 UPDATE，**跨 replica 生效**。复用 session 时必须先 `claimSessionTurn`，拿不到返回 `409 session_busy`；新 session 在 `session.started` 后 `adopt`；恢复时 `adopt`。
- Managed Execution **复用**这个租约，不另造一套。`runManagedTurn` 的顺序为：步骤 1（执行行）→ **claim session（仅复用 session 时）** → 步骤 2 acquireTurn → 步骤 3 → 步骤 4 发送权 → 步骤 5 发送。租约的释放随 turn 结束（与现有 `releaseSession` 一致）。
- 两者职责不同，互不替代：
  - 租约：保证同一 session 不会同时跑两个 turn，**不按 dispatch_key 去重**；
  - dispatch_key 与发送权：保证同一次执行只发送一次、取消与发送二选一。
- `session_busy` 发生在发送之前，映射为 `failed{stage:'admission', code:'session_busy'}`，归为 `retryable`（P-177）。典型场景是上一轮刚结束、租约尚未释放，或者 CP 崩溃后租约要等 TTL 过期。注意不要把它和 `capacity_unavailable` 混在一起计数。
- 新 session 在 `session.started` 之前没有租约，此时发送权与 fence 照常适用。

"影响 0 行"**不等于**已取消。同一 key 的两个并发调用可能都读到 `not_sent`，一个取得发送权后，另一个的 UPDATE 同样影响 0 行，而此时请求可能已经在执行（P-150）。

取消：

```text
UPDATE managed_executions SET cancel_requested_at=now()
 WHERE dispatch_key=$k AND cancel_requested_at IS NULL
-- 随后：
UPDATE managed_executions SET send_state='cancelled', status='interrupted', ended_at=now(), failure=...
 WHERE dispatch_key=$k AND send_state='not_sent' AND status = 'queued'   -- R2：不覆盖已有终态
影响 1 行 → 取消方获胜，confirmed=true，保证永不发送
影响 0 行 → **重新读取该行**，不能直接当作"在途"（D-50，P-164）：
   status 已终态                  → 直接返回 confirmed=true 与该终态，**不调用 runtime**
                                    （目标执行已结束；若再按 session 中断，可能打断复用该 Session 的下一轮）
   send_state=cancelled            → 取消已生效，返回 confirmed=true
   send_state ∈ {sending, sent, acknowledged} 且非终态 → 发送方已获胜，调用 §2.4 的**执行级中断**
                                    （按 dispatch_key 定位，不按 session），按其结果收敛
行不存在 → INSERT 墓碑行（send_state='cancelled', status='interrupted'）ON CONFLICT 后重试上述语句
```

两条 UPDATE 都以 `send_state='not_sent'` 为条件，PostgreSQL 行锁保证只有一方成功。turn-gate 排队期间（步骤 2）到达的取消会让步骤 4 影响 0 行。

**调用方前置条件（Teamwork）**：`dispatchOne` 在事务 2 复核 `dispatch_epoch` 后仍可能遇到之后到达的 pause。pause 命令的 reconcile 对该 Task 所有 queued / starting Run 调用 `interruptManagedExecution`（包括尚未创建执行行的 Run，此时插入墓碑），因此无论 pause 落在哪个窗口，都只有"未发送"或"在途等待确认"两种结果。

---

## 2. agent-server HTTP 扩展（PL2 提供，PL1 消费）

所有 core（claude-code、codex、goose、dsh）实现一致的扩展；不含任何 Teamwork 语义（I-13）。

| 接口 | 变化 |
| --- | --- |
| `GET /info` | `AgentInfo` 增加 `runtime_instance_id`（进程启动时生成的 UUID）与 `capabilities.execution: RuntimeExecutionCapabilities` |
| `POST /chat` | body 增加可选 `dispatch_key`。同一实例内重复 key：若执行仍在进行返回 `409 {dispatch_key, session_id, status}`，若已结束返回 `409` 且带终态；不得启动第二次执行 |
| SSE 首事件 | `session.started` 增加 `dispatch_key`、`runtime_instance_id` 字段（`internal/types/events.ts` 扩展，可选字段） |
| `GET /executions/:dispatch_key` | 新增。`200 {dispatch_key, session_id, status: running|waiting_input|succeeded|failed|interrupted, runtime_instance_id, started_at, ended_at}`；未知返回 `404 {runtime_instance_id}`（必须带实例 ID，调用方据此判断是否同实例） |
| `POST /executions/:dispatch_key/interrupt` | 新增（§2.4）。**执行级中断**：按 dispatch_key 定位，原子地"匹配执行身份 + 发出中断" |
| `POST /sessions/:id/interrupt` | 兼容入口。body 带 `expected_dispatch_key` 时与上一行共用同一实现；不带时保持现有行为，**托管执行不得使用**不带 key 的调用（I-35） |
| `POST /executions/:dispatch_key/fence` | 新增（§2.2）。原子地"查询或拒绝"该 key |
| `POST /chat` 新增字段 | `expected_runtime_instance_id`（§2.1，携带 dispatch_key 时必填） |

### 2.1 实例绑定发送

- `POST /chat` 在携带 `dispatch_key` 时**必须**同时携带 `expected_runtime_instance_id`（CP 从最近一次 `/info` 取得）。
- 与本进程 `runtime_instance_id` 不一致时返回 `412 {code:'instance_mismatch', runtime_instance_id}`，并**保证不执行**。
- 因此，一次发送要么落在声明的实例上，要么被明确拒绝；之后对该实例的 fence 结果才具有权威性。

### 2.2 Dispatch registry 与 fence

registry 分两层：

| 层 | 内容 | 保留 |
| --- | --- | --- |
| 记录层 | 完整 `DispatchRecord`（session、状态、时间） | 结束后至少 60 分钟；上限 1000 条；只淘汰已结束条目 |
| 键集合层 | 只存 `dispatch_key` 与 `seen / fenced` 标记 | 进程生命周期内不淘汰；上限 200,000 个；超出后 `authoritative=false` |

`POST /executions/:dispatch_key/fence`（单线程原子，与 `/chat` 的受理共享同一把进程内锁）：

| 键集合中的状态 | 行为 | 响应 |
| --- | --- | --- |
| 从未见过 | 写入 `fenced`，之后到达的同 key `/chat` 返回 `409 {status:'fenced'}` 且**不执行** | `200 {result:'fenced', runtime_instance_id}` |
| 已见过，记录仍在 | 不变 | `200 {result:'seen', record, runtime_instance_id}` |
| 已见过，记录已淘汰 | 不变 | `200 {result:'seen', record:null, runtime_instance_id}` |
| 键集合已溢出 | 不变 | `200 {result:'not_authoritative', runtime_instance_id}` |

`fenced` 是唯一可以证明"确定未接受"的回执（D-30）。`GET /executions/:key` 的 404 只表示"当前没有记录"，不能作为未执行的证据。

其他规则：

- 与 ACP bridge 的 LRU（`BRIDGE_MAX_COUNT`、`BRIDGE_IDLE_TTL_MS`）**完全独立**；bridge 被回收不得删除 registry 任何一层。
- registry 不持久化；进程重启后 `runtime_instance_id` 必然变化，旧实例上的执行一律 `unknown`。
- goose 使用 `SessionIdCodec` 对 session id 做命名空间处理，registry 与 lookup 返回的必须是对外 session id。

### 2.3 工具调用归属（不在 agent-server 层处理）

agent-server 与平台层**不负责**判断工具调用属于哪个执行，也不新增任何 header、hop 或 turn 屏障。session token 继续按 session 复用（现状）。工具调用的 Run 归属由 Teamwork 层的 `run_ref` 比对解决，见 §9.1（D-32）。

### 2.4 执行级中断（D-50，I-35）

问题：现有 `/sessions/:id/interrupt` 中断的是"这个 session 当前在跑的那一轮"。Session 复用后，一个迟到的取消请求可能打断下一轮（P-165）。仅在 CP 里先读状态再中断也不行，读和中断之间仍可能换轮。

接口：

```http
POST /executions/:dispatch_key/interrupt
POST /sessions/:sessionId/interrupt      { "expected_dispatch_key": "teamwork:<runId>" }   # 兼容入口，同一实现
```

按 dispatch_key 寻址是必要的：请求已发出、`session.started` 尚未回来时，CP 没有 session_id，session 路由无法定位这一轮（P-167）。

结果（五种）：

| 情况 | 响应 | CP 的处理 |
| --- | --- | --- |
| 目标就是该 session 当前执行 | `200 {outcome:'interrupted', confirmed:true}`，或 `{outcome:'delivered', confirmed:false}` | confirmed → 按终态收敛；delivered → 保留占位，等终态事件 |
| 该 session 当前是另一轮执行 | `409 {outcome:'execution_mismatch', current_dispatch_key}`，**不发出中断** | 目标已不在执行，重新读取 / probe 目标执行状态后收敛 |
| 目标执行已结束，记录还在 | `200 {outcome:'ended', status}` | 按该终态收敛，不影响当前轮 |
| 键集合中从未见过该 key | 原子写入 `fenced`（与 §2.2 fence 相同），之后到达的 `/chat` 被 409 拒绝；返回 `200 {outcome:'fenced'}` | 确定未接受，`failed{not_accepted}` |
| 见过但记录已淘汰 / 键集合溢出 | `200 {outcome:'unknown'}` | 保留占位，执行保持非终态或转 `unknown` |

**实现约束**（PL2 必须满足）：

1. 必须捕获并操作**被匹配的那一轮**的执行对象或取消句柄。**禁止**在 HTTP handler 里比较一下 key，再异步调用"取消当前 session"：两步之间可能进入新一轮（P-166）。
2. 取消句柄从 `/chat` 受理时就要登记到 registry，不是等 `session.started` 之后。这样尚未开始的执行也能被中断（例如 bridge 还在启动时，就置位"不要发 prompt"）。
3. **隔离性是硬性前提**（D-53，I-37）："不会中断目标以外的执行"必须被保证，不能降级。它和"能否确认已停止"是两种不同的能力：

   - 确认不了是否停止：可以降级，保留占位，走 unknown 与人工 resolve；
   - 可能取消错执行：副作用已经发生，`confirmed=false` 撤销不了它（P-169）。

   因此 `interruptConfirm=false` 只能用于"隔离正确、但停止结果暂时无法确认"的情况，**不能**用来掩盖隔离失败。

   每个 runtime 至少满足以下一种隔离方式：

   | 方式 | 做法 | 适用 |
   | --- | --- | --- |
   | (a) 每轮取消句柄 | 捕获并 abort 被匹配那一轮自己的句柄 | claude-code（每次 `query()` 的 AbortController） |
   | (b) 协议层 cancel + 实测通过 | session 锁内"匹配 + 写 cancel"；F-17 实测证明迟到的 cancel 不会影响下一轮。**另外**：cancel 写入时目标恰好完成（响应与 cancel 交错）属于不确定情况，agent-server 在发送下一轮 prompt 前必须先重建子进程，不能让可能未被消化的 cancel 留给下一轮 | ACP / DSH，仅在 F-17 通过时 |
   | (c) 终止子进程（兜底） | session 锁内确认当前执行就是目标，然后终止该 session 的子进程。下一轮 prompt 必须持有同一把锁才能发出，所以被终止的只可能是目标这一轮；隔离不依赖子进程如何处理 cancel。代价是下一轮需要重新拉起进程并 `loadSession`；runtime 不支持会话重载时，CP 让下一个 Run 换新 Session（沿用 D-32 兜底），进度由 workpad 保留 | 任何 runtime；(b) 未通过时必须使用 |

   注意：stdin 写入有序**不等于**子进程处理有序。(b) 必须靠实测证明，不能靠这个推理成立。

4. 各 runtime 的锁与句柄细节：
   - **claude-code**：每次 `query()` 都有自己的 AbortController，这就是单轮句柄。registry 记录中直接保存它，匹配后对它调用 abort。
   - **ACP（codex / goose）与 DSH**：`session/cancel` 在协议层面是按 session 取消的，没有单轮句柄。agent-server 对每个 session 加互斥锁，下面两件事都在这把锁内完成：
     - "匹配当前执行 + 把 cancel 写入子进程 stdin 并 flush"；
     - "受理下一个 `/chat` 并发送下一轮 prompt"。

     这把锁只保证**写入顺序**，不保证子进程的**处理顺序**（P-169）。是否足以隔离，由 F-17 实测决定；不通过就用方式 (c)。
5. **F-17 是执行级中断的硬性验收项**：某个 runtime 用方式 (b) 未通过 F-17，必须改用方式 (c)，并重新通过 F-16 / F-17。**不能**靠把 capability 改成 false 宣告通过（P-170）。
6. 任何 runtime 都**不得**对托管执行使用 session 级 cancel，除非它满足方式 (b) 且 F-17 通过。
7. `interruptTargeted=false` 的 runtime 不能提供执行级中断；PL1 对这类 runtime 的托管执行拒绝派发（启动时检查 `/info`），而不是派发后无法安全停止。

## 3. Teamwork 状态与转换（TW2 实现，全体遵守）

### 3.1 Task 转换表

| 从 | 触发 | 到 | 守卫 |
| --- | --- | --- | --- |
| backlog | `start` | ready | owner；lifecycle=active；有 coordinator；目标非空；锁 `teamwork_plugin_settings` 行 |
| backlog | `cancel` | cancelled | 无执行 |
| ready | 首个协调员 Run admitted | in_progress | |
| ready | 资源准备失败 | blocked(resource_failed) | |
| in_progress | 无可推进工作 | blocked(reason) | 见 §3.4 |
| in_progress / blocked | `pause` | （intent=pause）→ blocked(paused) | 所有 Run 确认终止后才迁移 |
| blocked(paused) | `resume` | ready 或 in_progress | 从未启动过回 ready |
| blocked(其他) | 原因解除 / `retry` / `resolve_execution` | ready 或 in_progress | 按原因各自守卫 |
| in_progress | 提交有效（§3.5 第一步）且只读收敛已确认（§3.5 第二步） | in_review | 两步之间不派发任何 Run（I-28） |
| in_review | `accept(result_run_id, version)` | done | 产物 checksum 复核通过；只读收敛完成 |
| in_review | `rework(note)` | in_progress | 写 user_input 事件；清除当前待验收版本 |
| 任意非终态 | `cancel` | （intent=cancel）→ cancelled | 所有 Run 确认终止后才迁移 |
| done / cancelled | `archive` | 不变，`archived_at` 置位 | |

### 3.2 WorkItem 转换表（Phase 2）

| 从 | 触发 | 到 |
| --- | --- | --- |
| ready | 成员 Run claim | running |
| running | 成员 Run succeeded 且已提交 result | submitted |
| running | 成员 Run succeeded 但未提交 result | blocked(no_result) |
| running | Run failed 且可自动重试 | ready（`next_run_at` 置位） |
| running | Run failed 且不可自动重试 / unknown | blocked |
| submitted | 协调员 `accept(result_run_id)` | done |
| submitted | 协调员 `rework(note)` | ready（`result_run_id` 清空，历史保留） |
| blocked | 原因解除 / 协调员调整 | ready |
| 任意非终态 | 协调员取消 / Task 取消 | cancelled |

### 3.3 Run `kind`

| kind | 触发 | Session | Prompt | 计数 |
| --- | --- | --- | --- | --- |
| `initial` | 首次派发 | 新建 | 完整上下文 | — |
| `continue` | 上一轮 `pending_decision=continue`，或有未消费输入 | 复用 | 续跑指引 + 新输入摘要 | `coordinator_turn_count` +1 |
| `retry` | 重试（自动或手动） | 复用（不可用则新建并发完整上下文） | 续跑指引 + 上次失败原因 | `retry_count` +1 |
| `rework` | owner / 协调员退回 | 复用 | 修改说明作为新输入 | 重置 `retry_count` |

### 3.4 blocked_reason 与解除方式

| reason | 进入条件 | 解除方式 |
| --- | --- | --- |
| `awaiting_input` | 有 pending request 且无其他可推进工作 | 回答原生请求 |
| `paused` | pause 确认 | `resume` |
| `dependency` | 所有剩余 WorkItem 都在等未满足依赖（Phase 2） | 协调员调整依赖 / 取消受影响项 |
| `execution_failed` | 不可自动重试的失败、或自动重试耗尽 | `retry`（manual） |
| `workspace_unavailable` | 协调员或成员 Workspace 不存在 / 不可运行 | 修复后 `retry` |
| `resource_failed` | AFS share / mount 失败 | `retry`（资源步骤幂等重放） |
| `permission_changed` | owner 失去 Workspace 访问 / 成员不再同 owner | 修复后 `retry` |
| `budget_exhausted` | `coordinator_turn_count` 或重试达上限 | owner `resume` 并追加预算（写事件） |
| `execution_unknown` | Run unknown | `resolve_execution` |
| `suspected_stall` | stall 检测无法确认状态 | 状态可确认后自动解除；或 owner `pause` / `cancel` / `resolve_execution` |
| `no_decision` | 协调员正常结束但未提交 `pending_decision` | owner 补充输入或 `retry` |

只有部分成员等待输入、其他子任务仍在运行时，Task 保持 `in_progress` 并显示 attention，不整体 blocked。

### 3.5 进入 in_review：两步（D-38）

V2.2.1 把"已只读收敛"列为前提，同时又要求进入 in_review 后才触发 seal，两者互相等待（P-152）。改为两步：

**第一步：判定提交是否有效**（reconcile 事务内）。条件全部满足：

1. 协调员已通过 `teamwork_submit_review` 记录提交意图（`pending_review_run_id`），且该 Run 已 `succeeded`；
2. 所有 `required=true` 的 WorkItem 为 done；
3. 没有非终态 Run；
4. 没有未解决的 pending request；
5. result 含 summary、逐项验收证据、产物引用，且产物 checksum 已计算。

- 满足：写 `task.seal_requested` 事件，事务外调用 TW6 `sealForReview`，Task 保持 `in_progress`。
- 该 Run 已终态但条件不满足：提交无效。清空 `pending_review_run_id`，写 `task.review_rejected`（附原因）。该事件属于"未处理输入"，会唤醒协调员下一轮修正。
- 该 Run 仍未终态：等待，不派发。

**第二步：确认只读收敛**（下一次 reconcile）：

6. 所有执行方的写挂载已收敛为 `ro` 且 `state=ready`：Phase 1A 为协调员挂载；Phase 2 起包括所有执行成员挂载（P-157）。

- 满足：迁移到 `in_review`。
- seal 失败：Task → `blocked/resource_failed`，**保留** `pending_review_run_id`。owner `retry` 后回到 `in_progress`，reconcile 重新执行 seal，第一步不必重做。
- 中途重启：按资源行状态重放 seal（幂等），不重做第一步。

**两步之间禁止派发**（I-28）：只要 `pending_review_run_id` 非空且尚未进入 `in_review`，reconcile 不派发任何 Run。期间到达的用户输入保留为未消费事件，进入 in_review 后在详情中显示，由 owner 决定是否 `rework`（rework 会把这些输入带入下一轮）。

## 4. Teamwork DB schema（TW1 实现）

Migration 编号预分配见 §12。以下为规范定义。旧表以 `ALTER` 扩展，旧行默认 `status='backlog'`，不迁移语义（D-27）。

```sql
-- 149_teamwork_v2_core.sql
ALTER TABLE teamwork_tasks
  ADD COLUMN status                 TEXT NOT NULL DEFAULT 'backlog',
  ADD COLUMN priority               INT  NOT NULL DEFAULT 3,            -- 1 最高 .. 4 最低
  ADD COLUMN acceptance_criteria    JSONB NOT NULL DEFAULT '[]',        -- [{id, text}]
  ADD COLUMN version                INT  NOT NULL DEFAULT 1,
  ADD COLUMN dispatch_epoch         INT  NOT NULL DEFAULT 0,            -- 改变派发意图的命令 +1（见 ws-tw3 §2）
  ADD COLUMN control_intent         TEXT,                               -- pause | cancel | NULL
  ADD COLUMN blocked_reason         TEXT,
  ADD COLUMN blocked_detail         JSONB,                              -- {message, work_item_id?, run_id?}
  ADD COLUMN workflow_snapshot      JSONB,                              -- start 时写入
  ADD COLUMN workpad                JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN result_run_id          TEXT,                               -- 当前待验收 / 已验收版本
  ADD COLUMN pending_review_run_id  TEXT,                               -- submit_review 意图所在 Run
  ADD COLUMN next_run_at            TIMESTAMPTZ,
  ADD COLUMN retry_count            INT  NOT NULL DEFAULT 0,
  ADD COLUMN coordinator_turn_count INT  NOT NULL DEFAULT 0,
  ADD COLUMN budget                 JSONB NOT NULL DEFAULT '{}',        -- 覆盖 §11 默认值（仅 owner resume 追加）
  ADD COLUMN resource_state         TEXT NOT NULL DEFAULT 'unprepared', -- 派生汇总，仅 TW6 写（D-06）
  ADD COLUMN source_task_id         TEXT,
  ADD COLUMN started_at             TIMESTAMPTZ,                        -- 首次 start 被接受的时间
  ADD COLUMN completed_at           TIMESTAMPTZ,
  ADD COLUMN archived_at            TIMESTAMPTZ;
ALTER TABLE teamwork_tasks ADD CONSTRAINT teamwork_tasks_status_chk CHECK (status IN
  ('backlog','ready','in_progress','blocked','in_review','done','cancelled'));
CREATE INDEX teamwork_tasks_board_idx
  ON teamwork_tasks (owner_user_id, status, priority, created_at, id) WHERE archived_at IS NULL;
CREATE INDEX teamwork_tasks_sweep_idx ON teamwork_tasks (status, next_run_at)
  WHERE status IN ('ready','in_progress','blocked');

ALTER TABLE teamwork_participants ADD COLUMN role_description TEXT;

ALTER TABLE teamwork_sessions ADD COLUMN work_item_id TEXT;      -- 协调员为 NULL
-- I-19 的唯一索引 teamwork_sessions_session_uq 放在 152_teamwork_cutover.sql，随 G4 原子切换执行（D-35）；
-- 在此之前由 TW1 repo 在写入事务内检查，测试装配中照常生效

CREATE TABLE teamwork_runs (
  id                   TEXT PRIMARY KEY,
  task_id              TEXT NOT NULL REFERENCES teamwork_tasks(id),
  work_item_id         TEXT,                          -- NULL = 协调员 Run
  execution_id         TEXT REFERENCES managed_executions(id),
  dispatch_key         TEXT NOT NULL UNIQUE,          -- teamwork:{id}
  session_id           TEXT,
  parent_run_id        TEXT REFERENCES teamwork_runs(id),
  attempt              INT  NOT NULL,
  kind                 TEXT NOT NULL,                 -- initial | continue | retry | rework
  status               TEXT NOT NULL DEFAULT 'queued',
  request_version      INT  NOT NULL,                 -- claim 时 task / work_item 的 version（审计用）
  dispatch_epoch       INT  NOT NULL,                 -- claim 时 task.dispatch_epoch；不一致即派发意图失效
  input_event_ids      BIGINT[] NOT NULL DEFAULT '{}',-- 本轮预留的输入事件
  pending_decision     TEXT,                          -- continue | wait_for_items | submit_review | blocked
  pending_requests     JSONB NOT NULL DEFAULT '[]',
  retry_classification TEXT,                          -- retryable | manual_only | non_retryable | unknown
  result_json          JSONB,
  runtime_instance_id  TEXT,
  error_code           TEXT,
  error_detail         JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,
  ended_at             TIMESTAMPTZ,
  last_event_at        TIMESTAMPTZ,
  last_progress_at     TIMESTAMPTZ,
  outcome_applied_at   TIMESTAMPTZ,             -- 终态的业务后果已由 reconcile 处理（D-29）；非终态恒为 NULL
  applied_exec_seq     BIGINT NOT NULL DEFAULT 0, -- 已投影到本 Run 的 managed_executions.last_seq（R1，D-46）
  pending_resolution   JSONB                     -- resolve_execution 命令写入的待执行人工结论（D-49）；平台处理后清空。业务字段，不属于执行派生字段
);
-- 待处理的终态 Run：reconcile 必须同时读取非终态 Run 与这些 Run
CREATE INDEX teamwork_runs_outcome_pending_idx ON teamwork_runs (task_id)
  WHERE outcome_applied_at IS NULL
    AND status IN ('succeeded','failed','interrupted');
-- I-03 协调员、I-02 工作项：两条独立 partial index。nullable 联合唯一索引约束不到协调员。
CREATE UNIQUE INDEX teamwork_runs_active_coord_uq ON teamwork_runs (task_id)
  WHERE work_item_id IS NULL
    AND status IN ('queued','starting','running','waiting_input','unknown');
CREATE UNIQUE INDEX teamwork_runs_active_item_uq ON teamwork_runs (work_item_id)
  WHERE work_item_id IS NOT NULL
    AND status IN ('queued','starting','running','waiting_input','unknown');
CREATE INDEX teamwork_runs_task_idx ON teamwork_runs (task_id, created_at DESC);

CREATE TABLE teamwork_events (
  id                 BIGSERIAL PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES teamwork_tasks(id),
  work_item_id       TEXT,
  run_id             TEXT,
  type               TEXT NOT NULL,
  actor_type         TEXT NOT NULL,        -- user | admin | agent | system
  actor_id           TEXT,
  payload            JSONB NOT NULL DEFAULT '{}',
  dedupe_key         TEXT UNIQUE,
  consumed_by_run_id TEXT,                 -- 输入类事件被哪个 Run 成功消费
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX teamwork_events_task_idx ON teamwork_events (task_id, id);

CREATE TABLE teamwork_commands (
  id               TEXT PRIMARY KEY,
  scope_key        TEXT NOT NULL,          -- 'task:{task_id}'；create 命令为 'user:{user_id}:create'（D-33）
  task_id          TEXT,                   -- create 成功后回填
  request_id       TEXT NOT NULL,
  command          TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,          -- sha256(canonical(command, expected_version, payload))
  expected_version INT,
  actor_id         TEXT NOT NULL,
  status           TEXT NOT NULL,          -- accepted | rejected | completed
  result_json      JSONB,                  -- 首次响应体；重放前必须先通过当前调用者的授权检查
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  UNIQUE (scope_key, request_id)
);

CREATE TABLE teamwork_resources (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES teamwork_tasks(id),
  type         TEXT NOT NULL,              -- afs_share | afs_mount | deliverable_mount
  workspace_id TEXT,                       -- mount 类必填
  op_id        TEXT NOT NULL,              -- 调用外部系统之前持久化的稳定操作身份（D-34）
  op_attempt   INT  NOT NULL DEFAULT 0,
  lease_until  TIMESTAMPTZ,                -- 外部操作租约（R3，D-47）；持有者为 op_id，过期前其他调用不得操作
  op_kind      TEXT,                       -- create_object | mutate_mount（D-48）：两类外部操作的不确定处理方式不同
  observed_mode TEXT,                      -- 最近一次探测到的实际挂载状态：ro | rw | absent | unknown（D-48）
  observed_at  TIMESTAMPTZ,
  resource_id  TEXT,                       -- 外部 share / mount 标识，外部调用返回后立即写
  secret_ref   TEXT,                       -- 例如 AFS access key 的加密引用；丢失即无法 revoke
  state        TEXT NOT NULL,              -- preparing | ready | uncertain | resolved | releasing | released | failed | orphan_suspected
                                           -- resolved：uncertain 已凭证据解除（D-52），等待 continueAfterResolve 探测后续接
  mode         TEXT,                       -- rw | ro
  error_code   TEXT,
  error_detail JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_by  TEXT                        -- orphan_suspected 行指向替代它的新行
);
-- 当前资源唯一性（D-41）。普通 UNIQUE 允许多个 NULL，约束不到 task 级 share（P-155）；
-- orphan_suspected 是历史记录，不参与当前唯一性。不用 NULLS NOT DISTINCT（需要 PG15+）。
CREATE UNIQUE INDEX teamwork_resources_task_current_uq ON teamwork_resources (task_id, type)
  WHERE workspace_id IS NULL AND state <> 'orphan_suspected';
CREATE UNIQUE INDEX teamwork_resources_ws_current_uq ON teamwork_resources (task_id, type, workspace_id)
  WHERE workspace_id IS NOT NULL AND state <> 'orphan_suspected';
-- released 的行是"当前资源"，rework 时原地改回 preparing 复用，不新建行
```

```sql
-- 150_teamwork_plugin_settings.sql（内容由 TW7 定义，TW1 统一提交）
CREATE TABLE teamwork_plugin_settings (
  id         INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lifecycle  TEXT NOT NULL DEFAULT 'disabled',   -- active | draining | disabled
  version    TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
```

```sql
-- 151_teamwork_work_items.sql（Phase 2）
CREATE TABLE teamwork_work_items (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES teamwork_tasks(id),
  title                 TEXT NOT NULL,
  description           TEXT,
  acceptance_criteria   JSONB NOT NULL DEFAULT '[]',
  assignee_workspace_id TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'ready',
  required              BOOLEAN NOT NULL DEFAULT true,
  result_run_id         TEXT,
  next_run_at           TIMESTAMPTZ,
  retry_count           INT NOT NULL DEFAULT 0,
  workpad               JSONB NOT NULL DEFAULT '{}',
  version               INT NOT NULL DEFAULT 1,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE teamwork_runs ADD CONSTRAINT teamwork_runs_item_fk
  FOREIGN KEY (work_item_id) REFERENCES teamwork_work_items(id);
CREATE TABLE teamwork_work_item_dependencies (
  work_item_id            TEXT NOT NULL REFERENCES teamwork_work_items(id),
  depends_on_work_item_id TEXT NOT NULL REFERENCES teamwork_work_items(id),
  PRIMARY KEY (work_item_id, depends_on_work_item_id),
  CHECK (work_item_id <> depends_on_work_item_id)
);
-- 同 task 检查与无环检查由 TW1 repo 在写入事务内完成
```

约束补充：

- `unknown` 计入活动约束（占位），不能当作终态释放。
- 所有关系写入都校验 task 一致：Run 的 work_item 属于该 task，Session 不跨 task / work item，依赖双方属于同一 task。
- 同一 Workspace 担任不同成员工作时，使用不同 Session。
- 依赖被取消**不等于**依赖已满足。协调员必须显式修改依赖或取消受影响项，并记录理由。

## 5. Teamwork 内部模块接口（TW 工作流之间）

目的：各 TW 工作流可以用 fake 实现并行开发。所有函数接收显式事务 `tx`，或明确声明在事务外调用。

```ts
// plugins/teamwork/server/ports.ts（CT 负责定义，M0 冻结）
// 2.2.9（D-62）：Tx 类型属于契约，由 CT2 定义在 contracts 中；TW1a 的 db/tx.ts 只实现事务 helper 并引用它。
// 仓库没有 @qap/* 路径别名，跨包一律用相对路径（与现有 control-plane 代码一致）。
import type { Tx } from '../contracts/tx'
import type { ManagedExecutionService, ManagedExecution, ExecutionLifecycleEvent } from '../../../internal/types/managed-execution'

// ── TW1 repositories ────────────────────────────────────────────
export interface TeamworkRepos {
  tasks: {
    lockForUpdate(tx: Tx, taskId: string): Promise<TaskRow | null>
    get(tx: Tx, taskId: string): Promise<TaskRow | null>
    update(tx: Tx, taskId: string, patch: Partial<TaskRow>, expectedVersion: number): Promise<TaskRow> // version 不符抛 VersionConflict
    listBoard(tx: Tx, q: BoardQuery): Promise<{ items: TaskSummary[]; counts: Record<TaskStatus, number>; nextCursor?: string }>
    listSweepCandidates(tx: Tx, now: Date, limit: number): Promise<string[]>
  }
  runs: {
    insertQueued(tx: Tx, r: NewRun): Promise<RunRow>            // 违反 partial unique 抛 ActiveRunExists
    lockForUpdate(tx: Tx, runId: string): Promise<RunRow | null>
    listNonTerminal(tx: Tx, taskId: string): Promise<RunRow[]>
    listOutcomePending(tx: Tx, taskId: string): Promise<RunRow[]>   // 终态且 outcome_applied_at IS NULL，FOR UPDATE
    markOutcomeApplied(tx: Tx, runId: string): Promise<void>        // 必须与业务转换同一事务
    update(tx: Tx, runId: string, patch: Partial<RunRow>): Promise<RunRow>
    listByTask(tx: Tx, taskId: string, cursor?: string): Promise<Page<RunRow>>
  }
  events: {
    append(tx: Tx, e: NewEvent): Promise<EventRow | null>       // dedupe_key 冲突返回 null
    listAfter(tx: Tx, taskId: string, afterId: number, limit: number): Promise<EventRow[]>
    unconsumedInputs(tx: Tx, taskId: string): Promise<EventRow[]>
    markConsumed(tx: Tx, eventIds: number[], runId: string): Promise<void>
  }
  commands: {
    find(tx: Tx, scopeKey: string, requestId: string): Promise<CommandRow | null>  // 只能在授权检查之后调用
    // 原子占位（D-40）：INSERT ... ON CONFLICT (scope_key, request_id) DO NOTHING RETURNING。
    // 返回 claimed=true 表示本事务拥有该命令；claimed=false 时返回已提交的既有行
    // （并发的同 key 事务会阻塞在唯一索引上，直到先到者提交或回滚）
    claim(tx: Tx, c: NewCommand): Promise<{ claimed: true; row: CommandRow } | { claimed: false; row: CommandRow }>
    complete(tx: Tx, id: string, status: 'completed' | 'rejected', result: unknown): Promise<void>
  }
  resources: {
    upsert(tx: Tx, r: ResourceKey, patch: Partial<ResourceRow>): Promise<ResourceRow>  // ON CONFLICT 目标为 §4 的两条 partial index
    replaceOrphan(tx: Tx, orphanId: string, fresh: NewResource): Promise<ResourceRow>  // 同一事务：旧行 → orphan_suspected + replaced_by，插入新行；只允许对租约已过期的行调用
    // R3（D-47）：领取外部操作租约。条件 UPDATE：lease_until IS NULL OR lease_until < now()，写入新 op_id、op_attempt+1、lease_until
    claimLease(tx: Tx, resourceId: string, leaseMs: number): Promise<{ opId: string } | null>
    // 外部结果落库：WHERE id=$id AND op_id=$opId AND replaced_by IS NULL；影响 0 行 = 本操作已过期
    commitOp(tx: Tx, resourceId: string, opId: string, patch: Partial<ResourceRow>): Promise<boolean>
    // resolve_resource 命令事务内调用（D-52、D-57）：WHERE id=$id AND op_id=$opId AND state='uncertain'，
    // 改为 state='resolved'、清空 lease_until。影响 0 行 = op_id 已过期或状态不对，命令返回 409
    resolveUncertain(tx: Tx, resourceId: string, opId: string): Promise<boolean>
    listByTask(tx: Tx, taskId: string): Promise<ResourceRow[]>
  }
  sessions: {
    bind(tx: Tx, b: { taskId: string; workItemId: string | null; sessionId: string; role: 'coordinator' | 'member'; parentSessionId: string | null }): Promise<void> // 跨 task 绑定抛错
    // 返回 session 所属 task / work_item / role，以及该 session 当前非终态 Run（可能为空）。
    // 写工具必须再用调用携带的 run_ref 与之比对（§9.1，D-32），不能直接把该 Run 当作调用者
    resolveScope(tx: Tx, sessionId: string): Promise<SessionScope | null>
    listByTask(tx: Tx, taskId: string): Promise<SessionRelation[]>
  }
  settings: {
    lockLifecycle(tx: Tx): Promise<PluginSettingsRow>          // SELECT ... FOR UPDATE
    getLifecycle(tx: Tx): Promise<PluginSettingsRow>
  }
  workItems?: WorkItemRepo                                       // Phase 2
}

// ── TW2 state machine（纯函数，无 IO） ───────────────────────────
export interface StateMachine {
  applyCommand(task: TaskRow, cmd: CommandEnvelope, ctx: CommandContext): TransitionResult
  applyRunTerminal(task: TaskRow, run: RunRow, facts: RunTerminalFacts): TransitionResult
  allowedCommands(task: TaskRow, ctx: CommandContext): CommandName[]
}
export interface TransitionResult {
  taskPatch: Partial<TaskRow>
  events: NewEvent[]
  enqueueReconcile: boolean
  response: unknown                          // 写入 teamwork_commands.result_json
  error?: { http: 404 | 409 | 422; code: string; message: string }
}

// ── TW3 reconcile（在 CP 内执行） ────────────────────────────────
export interface Reconciler {
  reconcile(taskId: string, reason: ReconcileReason): Promise<ReconcileOutcome> // 内部自行开短事务，事务外 dispatch
  sweep(now: Date): Promise<number>
}
export type ReconcileReason =
  | 'command' | 'run_lifecycle' | 'tool_report' | 'user_input' | 'retry_due'
  | 'resource_change' | 'execution_health' | 'sweep'

// ── TW4 run lifecycle ───────────────────────────────────────────
export interface RunLifecycle {
  onExecutionEvent(e: ExecutionLifecycleEvent): Promise<void>    // 注册给 PL1；只当唤醒信号：调用 projectFromExecution 后 enqueue reconcile
  // R1（D-46）：Run 中由执行派生的字段只由这一个函数写入。读取 managed_executions **当前行**（不信任事件载荷），
  // 仅当 exec.last_seq > run.applied_exec_seq 时应用；Run 已终态时不再改变执行派生字段。hook、reconcile、sweep 共用
  projectFromExecution(tx: Tx, run: RunRow, exec: ManagedExecution): Promise<RunRow>
  reconcileRun(tx: Tx, run: RunRow, exec: ManagedExecution | null, now: Date): RunReconcileDecision // 纯判定
  classifyFailure(exec: ManagedExecution): RetryClassification
  nextRetryAt(run: RunRow, cls: RetryClassification, now: Date): Date | null
  // 2.2.7 修正（D-57）：原 resolveExecution(tx, ...) 是同步、带事务的签名，与 D-49 冲突，拆成两步：
  // ① 命令事务内：校验 decision 与 Run 状态，写 pending_resolution 与 run.resolve_requested。不做网络调用
  requestResolution(tx: Tx, run: RunRow, input: ResolveExecutionInput): Promise<void>
  // ② reconcile 事务外：调用 ExecutionPort.resolveManagedExecution；结果由下一次投影写回 Run（R1），
  //    并清空 pending_resolution、写 run.resolved / run.resolve_rejected
  applyPendingResolution(run: RunRow): Promise<{ applied: boolean; reason?: 'already_terminal' | 'probe_unconfirmed' }>
}

// ── TW5 context & tools ─────────────────────────────────────────
export interface ContextBuilder {
  buildInitialPrompt(tx: Tx, run: RunRow): Promise<string>       // 严格变量检查；失败抛 PromptRenderError
  buildContinuationPrompt(tx: Tx, run: RunRow): Promise<string>
  getAgentContext(tx: Tx, scope: SessionScope): Promise<AgentContext> // teamwork_get_context 返回体
}
export interface TeamworkToolsRegistrar {
  register(server: McpServerLike, scope: SessionScope): void    // 由 PL3 scope resolver 回调
}

// ── TW6 resources ───────────────────────────────────────────────
export interface ResourceManager {
  ensureTaskResources(taskId: string): Promise<ResourceOutcome>  // 事务外，幂等，每步落库
  ensureMemberMount(taskId: string, workspaceId: string): Promise<ResourceOutcome>
  sealForReview(taskId: string): Promise<ResourceOutcome>        // 所有执行方写挂载收敛为 ro（1A：协调员；2：含成员）；幂等，可重放
  releaseOnTerminal(taskId: string): Promise<ResourceOutcome>
  computeArtifactDigests(taskId: string, runId: string, artifacts: ArtifactRef[]): Promise<ArtifactRef[]>
  verifyArtifactDigests(taskId: string, artifacts: ArtifactRef[]): Promise<{ ok: boolean; mismatched: string[] }>
  // D-48：观察实际挂载状态，写 observed_mode / observed_at。seal 是否完成、accept 能否进行，都以观察结果为准，而不是请求是否成功
  probeMounts(taskId: string): Promise<{ workspaceId: string; name: string; mode: 'ro' | 'rw' | 'absent' | 'unknown' }[]>
  // 2.2.7 补充（D-57）：resolve_resource 之后的续接（事务外）。对 state=resolved 的行先 probeMounts，
  // 已达目标 → ready；未达 → 重新领租约并发起该操作
  continueAfterResolve(taskId: string): Promise<ResourceOutcome>
}

// ── TW7 lifecycle ───────────────────────────────────────────────
export interface LifecycleGuard {
  assertCanStart(tx: Tx): Promise<void>                          // 需先 lockLifecycle
  assertCanDispatch(tx: Tx, task: TaskRow): Promise<void>        // draining 只允许已授权任务
  capabilities(): CapabilitiesResponse
}

// ── 平台依赖（PL1 提供，TW 只通过此接口访问执行层） ─────────────────
export type ExecutionPort = Pick<ManagedExecutionService,
  'dispatchManagedTurn' | 'getManagedExecution' | 'interruptManagedExecution' |
  'reconnectManagedExecution' | 'onExecutionLifecycle' | 'respondToRequest' | 'resolveManagedExecution' | 'registerSessionGuard'>

// ── 平台扩展点：Workspace 所有权转移（D-67，PL4d 提供；main@0758e7e 已有转移功能） ──
// 现有 services/workspace-transfer.ts 在转移事务内直接改写 teamwork_participants / teamwork_tasks（P-178）。
// V2 改为由 Teamwork 注册钩子，平台在转移事务内调用；平台代码不再出现 teamwork 表名。
export interface WorkspaceTransferHook {
  name: string
  /** 转移请求被接受前调用（事务外，只读）。返回 reject 则拒绝转移，并把原因展示给用户 */
  check(ctx: { workspaceId: string; fromUserId: string; toUserId: string }): Promise<{ allow: true } | { allow: false; reason: string }>
  /** 转移事务内调用，传入同一个事务 client；只能写钩子自己拥有的表 */
  apply(tx: Tx, ctx: { workspaceId: string; fromUserId: string; toUserId: string }): Promise<void>
}
// registerTeamwork 通过 deps.workspaceTransfer.register(hook) 注册
// 2.2.7 修正（D-57）：补上 resolveManagedExecution（D-49）。ExecutionPort 必须与 §1.1 ManagedExecutionService 的公开方法保持一致
```

**ports 引用的所有类型都必须在 M0 前由 CT2 定义在 `plugins/teamwork/contracts/` 中**（D-62）。ports.ts 只能从 contracts 和 `internal/types` 导入，不能导入 `server/` 下任何实现文件。这些类型包括：`Tx`、`WithTx`、`TaskRow`、`TaskStatus`、`TaskSummary`、`BoardQuery`、`RunRow`、`NewRun`、`EventRow`、`NewEvent`、`CommandRow`、`NewCommand`、`CommandEnvelope`、`CommandName`、`CommandContext`、`ResourceRow`、`ResourceKey`、`NewResource`、`PluginSettingsRow`、`SessionScope`、`SessionRelation`、`Page`、`TransitionResult`、`RunTerminalFacts`、`RunReconcileDecision`、`RetryClassification`、`ResolveExecutionInput`、`ReconcileReason`、`ReconcileOutcome`、`ResourceOutcome`、`AgentContext`、`CapabilitiesResponse`、`McpServerLike`、`WorkItemRepo`（Phase 2，可先定义为空接口）。

`Tx` 契约（`plugins/teamwork/contracts/tx.ts`，CT2 交付，D-62）：

```ts
// 只描述 repos 需要的最小能力，不绑定具体驱动；TW1a 用 pg 的 PoolClient 实现，InMemoryRepos 用内存实现
export interface Tx {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }>
  /** pg-boss 事务内 send 需要的底层 client（SendOptions.db.executeSql）；InMemoryRepos 返回 FakeQueue 可识别的句柄 */
  readonly sendDb: unknown
}
export type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>
```

注入：`plugins/teamwork/server/index.ts` 的 `registerTeamwork(deps)` 负责组装（集成者维护），其中 `deps` 至少包含 `db`、`boss`、`execution: ExecutionPort`、`afs`（现有 AFS 服务）、`mcpScopeRegistry`（PL3）、`pluginGuardRegistry`（PL4）、`auth`。

## 6. 结果与产物 schema（TW5 定义，TW2 / TW4 / TW6 / TW8 消费）

```ts
// plugins/teamwork/contracts/result.ts
export const AcceptanceCheck = z.object({
  criterion_id: z.string(),
  outcome: z.enum(['passed', 'failed', 'not_run']),   // 不允许 unknown 自动当通过
  evidence: z.string().min(1),
  artifact_names: z.array(z.string()).default([]),
})
export const ArtifactRef = z.object({
  name: z.string(),
  kind: z.enum(['file', 'report', 'link', 'patch']),
  relative_path_or_url: z.string(),                   // file/report/patch：相对 /mnt/afs/team-<taskId>/
  sha256: z.string().optional(),                      // 平台计算，Agent 提交的值被忽略
  size_bytes: z.number().int().optional(),
  run_id: z.string(),                                 // 服务端填写
})
export const RunResult = z.object({
  summary: z.string().min(1),
  acceptance_checks: z.array(AcceptanceCheck),
  artifacts: z.array(ArtifactRef.omit({ sha256: true, size_bytes: true, run_id: true })),
})
```

- 外部链接（`kind=link`）只记录 URL 与提交时说明，不宣称内容不可变，不能单独作为需要固定内容的验收证据。
- `file / report / patch` 的 `sha256 / size_bytes` 由 TW6 在提交时计算，写入 Run 的 `result_json`；验收前再次核对，不一致则拒绝 accept 并要求重新提交。

## 7. HTTP API（TW2 实现，TW8 消费）

所有路由由 Teamwork server module 注册在 `/api/teamwork`。契约类型由 `plugins/teamwork/contracts` 统一拥有，并接入 CP OpenAPI，不在平台与插件两处复制。**固定路径必须先于 `/:id` 注册**。

| Method / path | 说明 | Phase |
| --- | --- | --- |
| `GET /api/teamwork/capabilities` | 鉴权后返回 §10 能力体 | 1A |
| `POST /api/teamwork/plugin/commands` | 管理员 `enable / drain / disable`；`request_id` 去重；按 TW7 检查在途工作 | 1C（1A 用 seed 设为 active） |
| `GET /api/teamwork/roster-candidates` | 可加入的 Workspace（同 owner、同环境） | 1A |
| `GET /api/teamwork/events` | 当前 owner 的 SSE 变更通知（`task.changed / run.changed / work_item.changed / event.appended`），只用于缓存失效，不广播 token | 1B |
| `POST /api/teamwork` | 创建 backlog；lifecycle=active 才允许；**不要求协调员 running、不 provision AFS**；body 带 `request_id`，幂等范围为 `user:{user_id}:create` | 1A |
| `GET /api/teamwork?status=&priority=&coordinator=&q=&archived=&cursor=` | 看板摘要 + **筛选后**的服务端列计数；游标分页；不返回 transcript | 1A |
| `GET /api/teamwork/:id` | Task 详情、当前结果、WorkItem 计数、最新活动、`allowed_commands`、`version` | 1A |
| `PATCH /api/teamwork/:id` | 仅改允许编辑的 `name / brief / acceptance_criteria / priority`，必须带 `expected_version`；**禁止 status** | 1A |
| `POST /api/teamwork/:id/commands` | 命令信封 §8 | 1A |
| `POST /api/teamwork/:id/participants`、`DELETE .../:workspaceId` | 修改 roster；有相关活动 Run 时 409 | 1A |
| `POST /api/teamwork/:id/inputs` | 向协调员补充信息：写 `user_input` 事件并入队 reconcile，**不直接启动 turn** | 1A |
| `POST /api/teamwork/:id/requests/:requestId/respond` | 回答原生 question / permission，路由到原 session（经 PL1 `respondToRequest`） | 1A |
| `POST /api/teamwork/:id/comments` | 普通评论，只记活动，**默认不唤醒 Agent** | 1B |
| `GET /api/teamwork/:id/work-items` | 子任务与依赖摘要 | 2 |
| `GET /api/teamwork/:id/runs?cursor=` | Run 历史：kind、状态、耗时、错误、重试时间、用量、session 链接 | 1A |
| `GET /api/teamwork/:id/events?after_id=&limit=` | 业务活动补拉，按 id 升序 | 1A |
| `GET /api/teamwork/:id/sessions` | 真实 Session 关系树（替代 `deriveMemberSessions`） | 1A |
| `GET /api/teamwork/:id/artifacts` | 产物列表（按 Run），含 checksum 与来源 | 1B |
| `POST /internal/teamwork/reconcile` | scheduler worker 专用，服务身份（D-16），不挂在用户 API 下 | 1A |

响应码约定：

- 异步命令返回 `202` + 最新 Task 快照 + `action_state`（例如 `pausing`）。
- 版本冲突或非法转换返回 `409`，body 带当前 `version` 与 `allowed_commands`。
- 未授权或不存在的 task 一律返回 `404`，不泄露存在性。
- 协议 major 不符返回 `426 {code: 'teamwork_protocol_mismatch', server_major}`。
- lifecycle 不允许返回 `409 {code: 'teamwork_lifecycle', lifecycle}`。

浏览器发出的所有 Teamwork **写**请求都携带 `X-QAP-Teamwork-Protocol: <major>`（D-13）。缺失视为不匹配。

## 8. 命令信封（TW2）

```json
{
  "command": "start",
  "expected_version": 4,
  "request_id": "0b6f…uuid",
  "payload": {}
}
```

| command | payload | 允许的 Task 状态 | 说明 |
| --- | --- | --- | --- |
| `start` | — | backlog | 写 `workflow_snapshot`、`started_at`；与 lifecycle 行锁同事务 |
| `pause` | — | ready / in_progress / blocked(非 paused) | 写 `control_intent=pause` |
| `resume` | `{add_budget?}` | blocked(paused / budget_exhausted) | budget 追加写事件；suspected_stall 不能 resume，只能等状态可确认后自动解除，或 pause / cancel / resolve_execution |
| `cancel` | `{reason}` | 任意非终态 | 写 `control_intent=cancel` |
| `retry` | `{run_id?}` | blocked(execution_failed / workspace_unavailable / resource_failed / permission_changed / no_decision) | 手动重试；`manual_only` 与 `non_retryable` 只能走这里 |
| `accept` | `{result_run_id}` | in_review | 必须等于当前 `result_run_id`；复核 checksum |
| `rework` | `{note, work_item_ids?}` | in_review | 写 user_input 事件；不重跑已 done 的 WorkItem，除非在 `work_item_ids` 中显式重开 |
| `archive` | — | done / cancelled | 只设 `archived_at` |
| `resolve_resource` | `{resource_id, op_id, evidence, action_taken}` | blocked(resource_failed) 且该资源行为 `uncertain` | 人工确认旧的 mutate_mount 操作已终止（D-52）。只接受当前 `op_id`；写 `resource.resolved` 事件；随后 reconcile 以 `probeMounts` 决定完成或重新发起。owner 或 admin；admin 需通知 owner |
| `resolve_execution` | `{run_id, decision, evidence, side_effects_checked?, retryable?}` | blocked(execution_unknown / suspected_stall) | `decision ∈ bind_existing / confirmed_not_accepted / confirmed_terminated`；**异步**：命令事务只写 `teamwork_runs.pending_resolution` 并返回 202 `action_state=resolving`，reconcile 在事务外调用平台 `resolveManagedExecution`，Run 经投影更新（D-49）；证据不足保持 unknown |

处理顺序：

1. 认证；校验协议头。
2. **授权**：加载 task，确认当前调用者是 owner，或者调用者是平台 admin 且命令在 `ws-tw2-commands-api.md §4` 的 admin 例外清单中（目前为 `resolve_execution`、`resolve_resource`，D-56）。不满足一律返回 `404`。授权**必须先于**任何缓存响应的返回（D-33）。create 命令没有 task，`scope_key=user:{当前用户}:create`，天然只能命中调用者自己的记录。
3. `BEGIN`，**原子占位**（D-40）：`repos.commands.claim`，即 `INSERT teamwork_commands(scope_key, request_id, payload_hash, status='accepted', ...) ON CONFLICT (scope_key, request_id) DO NOTHING RETURNING`。
   - 返回了行：本事务拥有该命令，继续第 4 步。
   - 没返回行：说明已有同 key 记录。并发的同 key 事务会阻塞在唯一索引上，直到先到者提交；先到者回滚则本事务的 INSERT 成功，按"返回了行"处理。随后读取既有行：
     - `payload_hash` 相同：`ROLLBACK`，原样返回 `result_json`（首次结果，包括首次得到的 409 / 422 拒绝）；
     - `payload_hash` 不同：`ROLLBACK`，返回 `422 {code:'request_id_reused'}`。
   - 这一步先于 lifecycle 与 version 检查，所以超时重试、双击、并发重放都拿到同一个响应。
   - create 命令没有 task 行，同样用 `scope_key=user:{id}:create` 占位，不需要额外的锁。
4. 校验 lifecycle。
5. 锁 task，校验 `expected_version`。
6. 调用 `StateMachine.applyCommand`，在同一事务内写 task、events，把响应写入本命令行的 `result_json`，并 send reconcile。
   - 第 4、5、6 步的**拒绝**（lifecycle 不允许、409 版本冲突、非法转换）同样写入 `result_json`，`status='rejected'`，并提交，这样之后的重放得到同一个拒绝。
7. COMMIT 后返回。

## 9. Agent 工具（TW5 实现；权限来自 session 绑定，归属由 run_ref 比对，I-21、I-25）

| 工具 | 调用者 | 输入 | 行为 | Phase |
| --- | --- | --- | --- | --- |
| `teamwork_get_context` | 协调员 / 成员 | — | 返回 `AgentContext`：Task、当前 WorkItem、依赖结果摘要、参与者、产物、pending input、预算剩余、`allowed_actions`、workflow_snapshot，以及当前活动 Run 的 `run_ref` | 1A |
| `teamwork_report` | 协调员 / 成员 | `{run_ref, kind: progress|blocked|result, workpad_patch?, result?, next_decision?, consumed_input_event_ids?}` | progress 更新 workpad；result 写当前 Run 的 `result_json`；协调员可提交 `next_decision ∈ continue / wait_for_items / blocked`；成员**无**编排决策权限 | 1A |
| `teamwork_submit_review` | 协调员 | `{run_ref, ...RunResult}` | 记录 `pending_review_run_id` 与 `pending_decision=submit_review`；本轮 Run 结束后由 reconcile 检查 §3.5 | 1A |
| `teamwork_plan_items` | 协调员 | `{run_ref, items:[{key, title, description, assignee_workspace_id, acceptance_criteria, required, depends_on_keys}]}` | 持久化 WorkItem 与依赖（写时查环）；设 `pending_decision=wait_for_items`；**不派发** | 2 |
| `teamwork_accept_item` | 协调员 | `{run_ref, work_item_id, result_run_id, decision: accept|rework, note?}` | 必须绑定 `result_run_id` 防止接受旧结果 | 2 |

### 9.0 受管 Session 的直接 turn（D-66）

受管 Teamwork Session（出现在 `teamwork_sessions` 中、且所属 task 未到终态）只能由 Teamwork 的 Run 驱动。如果有人通过 Workspace 聊天面板、API chat、schedule、connector 直接向它发 turn，就会产生一个没有 Run 记账的 turn。它会改变对话上下文和 AFS 内容，而且在复用 session 时与下一个 Run 争抢 `session_busy`。

main 的团队共享（D-67）让能访问 Workspace 的人变多了，这个问题因此更容易发生（P-179）。规则：

- Teamwork 通过 `registerSessionGuard` 注册守卫：`origin !== 'teamwork'` 且 session 属于非终态的 Teamwork task 时拒绝，返回 `409 session_managed`，并提示"请在 Teamwork 任务中补充说明"。
- Task 进入 done / cancelled / archived 后，守卫放行，用户可以在原 Session 上继续自由对话；这不影响已验收的结果。
- UI（TW8 / 现有 WorkspaceChatPanel）对受管 Session 显示只读提示与跳转链接。WorkspaceChatPanel 的改动由 TW9 在 G4 切换时一并处理。

### 9.1 run_ref：工具调用的 Run 归属（D-32）

问题：session token 按 session 复用（`lib/session-token.ts` `ensureTokenForSession`），ACP core 在创建 / 加载 session 时就把 `X-Session-Token` 固化进 MCP 配置（`internal/acp-adapter/acp-server.ts:377,430,521`）。续跑与重试复用 Session，只凭"session 的当前非终态 Run"会把上一轮迟到的写调用算到下一轮头上。

做法（借鉴 Symphony：身份随调用携带，而不是在调用到达时推断）：

1. `run_ref` 就是 `teamwork_runs.id`。Run id 必须是随机、不可预测的值（UUIDv4 或同等随机度），不能用自增或可推算的编号。
2. CP 在每一轮 prompt 中写明本轮 `run_ref`（initial prompt 与 continuation prompt 都要写）。`teamwork_get_context` 也返回当前活动 Run 的 `run_ref`。
3. 所有**写**工具必须携带 `run_ref`。CP 处理顺序：
   1. `X-Session-Token` → session → `teamwork_sessions`，确定 task / work_item / role 与权限（权限只来自这里）；
   2. 取该 session 当前非终态 Run；
   3. 该 Run 不存在，或 `run.id != run_ref` → 拒绝，返回 `{code:'stale_run_ref', hint:'call teamwork_get_context and retry'}`，内容只记入历史（`run.stale_write` 事件），不改变任何状态。
4. `run_ref` 只能让调用被拒，不能扩大权限。它和"工具参数不接受 `task_id / owner_id / run_id` 作为身份"的规则不冲突。
5. 只读工具 `teamwork_get_context` 不需要 `run_ref`。

为什么能彻底挡住迟到调用：迟到调用在它那一轮就已生成，携带的是旧 Run 的 `run_ref`；新一轮的 Run id 在旧调用生成时还不存在，模型不可能提前带上。

**残余风险与兜底（换新 Session）**：如果旧 turn 实际上还活着（例如中断未确认、执行状态不明），它可能调用 `teamwork_get_context` 取到新 Run 的 `run_ref` 再写入。因此以下情况下，下一个 Run **必须使用新 Session**，不复用旧 Session：

| 上一个 Run 的结束方式 | 下一个 Run |
| --- | --- |
| `succeeded`（收到 `session.ended{completed}`） | 可以复用 Session |
| `failed` 且终态由 runtime 事件确认 | 可以复用 Session |
| `interrupted` 且 `confirmed=true` | 可以复用 Session |
| 经 `resolve_execution` 处理的 `unknown` / `suspected_stall` | **新 Session** |
| `interrupted` 但未确认终止（例如按 fence / 超时收敛） | **新 Session** |
| 本轮出现过 `stale_run_ref` 拒绝，且本轮结束时没有有效结果或决策 | **新 Session** |

换新 Session 后，旧 Session 上已经没有非终态 Run，旧 turn 的任何写调用都会被拒。新 Session 使用 initial prompt（完整上下文 + workpad），不依赖对话历史。

其他规则：

- 调用者没有活动 Run 时（例如迟到调用），写操作返回结构化错误，不改变状态。
- 不支持的工具名或参数错误返回结构化失败，不让会话卡住。
- 受管 Teamwork Session 中禁用自由 `call_agent`（PL3）。
- 首版成员不能再委派下一级。

## 10. Capabilities 响应（TW7）

```json
{
  "protocolMajor": 1,
  "serverVersion": "2.1.0",
  "lifecycle": "active",
  "workerReady": true,
  "capabilities": [
    "fleet-app-v1", "session-view-v1", "managed-execution-v1",
    "resolve-execution-v1", "work-items-v1", "artifacts-v1", "events-sse-v1"
  ],
  "hostRequirements": { "hostApiMajor": 1 }
}
```

- Web 插件进入界面及发出写命令前检查；major 不兼容时禁止写。
- 缺少某 capability 时关闭对应功能，不回退到旧接口。
- `workerReady=false` 时 UI 显示"后台执行不可用"，禁止 start。

## 11. 业务事件类型与常量

事件 `type`（`teamwork_events.type`）：

`task.created / task.started / task.updated / task.paused / task.resumed / task.blocked / task.unblocked / task.cancel_requested / task.cancelled / task.review_submitted / task.seal_requested / task.review_rejected / task.accepted / task.reworked / task.archived / task.budget_extended`
`run.claimed / run.dispatched / run.started / run.waiting_input / run.succeeded / run.failed / run.interrupted / run.unknown / run.resolved / run.retry_scheduled / run.suspected_stall / run.stale_write`
`work_item.created / work_item.updated / work_item.submitted / work_item.accepted / work_item.reworked / work_item.cancelled`
`resource.preparing / resource.ready / resource.failed / resource.released`
`input.user / input.answer / comment`
`participant.added / participant.removed`

不记录 token 流；Agent transcript 属于 Session。

常量（`plugins/teamwork/contracts/constants.ts`，首版不提供用户配置界面）：

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `MAX_MEMBER_PARALLELISM` | 3 | 每 Task |
| `MAX_COORDINATOR_TURNS` | 20 | continuation 计数，不含 retry |
| `MAX_AUTO_RETRIES` | 3 | 仅 `retryable` |
| `AUTO_RETRY_DELAYS_MS` | `[10_000, 30_000, 120_000]` | Phase 1A |
| `STALL_THRESHOLD_MS` | 600_000 | 基于 `last_progress_at` |
| `UNKNOWN_PROBE_WINDOW_MS` | 600_000 | 网络不通超过此窗口 → unknown |
| `SWEEP_INTERVAL_MS` | 60_000 | |
| `PROGRESS_WRITE_THROTTLE_MS` | 15_000 | |
| `PROTOCOL_MAJOR` | 1 | |

## 12. Migration 编号预分配

编号由集成者分配；工作流不得自行取号。`001–114` 被 squash 前链条占用。

**2.2.10 重排**（D-64）：设计时预留的 142～146 已被 main 上的其他工作占用（`142_message_event_count` ～ `147_session_turn_claim`，截至 `main@0758e7e`），因此整体顺移：

| 编号 | 文件 | 负责 | Phase |
| --- | --- | --- | --- |
| 148 | `148_managed_executions.sql` | PL1 | 0 |
| 149 | `149_teamwork_v2_core.sql` | TW1 | 1A |
| 150 | `150_teamwork_plugin_settings.sql` | TW1（内容 TW7） | 1A |
| 151 | `151_teamwork_work_items.sql` | TW1 | 2 |
| 152 | `152_teamwork_cutover.sql`：`teamwork_sessions_session_uq` 等切换期约束（D-35） | TW1，随 G4 切换 PR 合入 | 1C |
| 153–155 | 预留 | 集成者 | — |

**main 仍在并行开发，编号以合并时为准**（P-176）：

- WP 分支上的 migration 先按上表命名；
- INT 在合并前检查 main 的最新编号，如有冲突，要求作者改名后再合并；
- 只有尚未在任何环境应用过的 migration 才能改名，已应用的不得改名或改内容，修正只能新建编号。

## 13. 预留：Tracker Adapter（Phase 4，本轮只定义类型）

```ts
export interface TeamworkTrackerAdapter {
  kind: string
  fetchByStates(states: string[]): Promise<NormalizedIssue[]>
  fetchByIds(ids: string[]): Promise<NormalizedIssue[]>   // 结果中缺失 = 不再可见
  agentToolSpecs?(): ToolSpec[]
  executeAgentTool?(name: string, args: unknown, ctx: { issue: NormalizedIssue }): Promise<ToolResult>
  secretEnvNames?(): string[]                              // 不下发给 Agent
}
```

外部 issue 只作为创建 Task 的来源与状态回写目标；业务状态仍以本地表为准。
