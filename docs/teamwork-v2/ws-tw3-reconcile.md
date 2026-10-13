# WS-TW3 · Reconcile、Dispatcher、Worker

Phase 1A（成员派发为 Phase 2）。必读：`00-architecture.md §6 §7 §8`、`02-contracts.md §3 §5（Reconciler）`；`90-pitfalls.md` P-24、P-62～P-64、P-69、P-71、P-83、P-89～P-94、P-97、P-101、P-115、P-123。

## 1. 拥有的文件

`plugins/teamwork/server/reconcile.ts`、`dispatcher.ts`、`sweep.ts`；`plugins/teamwork/worker/index.ts`；`control-plane/src/lib/jobs.ts` 中新增的事务内 send helper（与 INT 协调）。

## 2. 算法

```text
reconcile(task_id, reason):
  # ── 事务 1：判定与 claim（短事务，无网络调用） ─────────────────
  BEGIN
    settings = repos.settings.getLifecycle(tx)
    task = repos.tasks.lockForUpdate(tx, task_id)          # 不存在 → return
    runs    = repos.runs.listNonTerminal(tx, task_id)
    pending = repos.runs.listOutcomePending(tx, task_id)  # 终态但业务后果未处理（D-29）

    # A. 投影已有 Run（事实来自 managed_executions，由 TW4 判定）
    for run in runs:
      run = runLifecycle.projectFromExecution(tx, run, exec(run.dispatch_key))   # R1：唯一的执行派生字段写入口，seq 单调
      decision = runLifecycle.reconcileRun(tx, run, exec(run.dispatch_key), now)
      apply decision                                      # 可能：保持 / unknown / suspected_stall / 需要 probe；执行终态只来自投影
      if decision.becameTerminal: pending.push(run)       # 本次对账刚转为终态的也进入 B
      if decision.needsProbe: probes.push(run)            # 事务外执行
      # 恢复派发（D-37）：claim 已提交但执行从未真正发出
      if run.status == queued and (exec(run.dispatch_key) 不存在
                                   or (exec.status == queued and exec.send_state == not_sent)):   # 终态执行不重派（R2）
        redispatch.push(run)                              # 复用原 dispatch_key，事务外交给 dispatchOne

    # B. 终态 Run 的业务后果（hook 已写终态的 Run 也在这里处理，不依赖"本轮刚变终态"）
    for run in pending（按 ended_at, id 排序）:
      stateMachine.applyRunTerminal(task, run, facts)     # submitted / accept 前提 / in_review 判定 / 重试排期
      repos.runs.markOutcomeApplied(tx, run.id)           # 与业务转换同一事务；重复对账不会重复应用

    # C. 控制意图
    if task.control_intent in (pause, cancel):
      interrupts = active_runs(task)                      # 事务外中断
      if interrupts 为空 → 迁移到 blocked(paused) / cancelled
      COMMIT; goto 事务外

    # D. 待验收两步（02 §3.5，D-38）。只要 pending_review_run_id 非空，本轮一律不派发（I-28）
    if task.pending_review_run_id:
      rr = run(task.pending_review_run_id)
      if rr 非终态:                                        # 协调员提交后本轮尚未结束
        COMMIT; goto 事务外
      if not submission_valid(task, rr):                  # §3.5 第一步 1～5 不满足
        清空 pending_review_run_id; events.append(task.review_rejected{reason})   # 属于未处理输入，唤醒协调员
        # 不 return：继续 E，协调员可按资格规则被派发去修正
      elif sealed_ro(task):                               # §3.5 第二步：所有执行方写挂载已 ro + ready
        transition in_review; COMMIT; goto 事务外
      elif resource_state == failed:
        transition blocked(resource_failed)（保留 pending_review_run_id）; COMMIT; goto 事务外
      else:
        events.append(task.seal_requested)（dedupe_key=seal:{rr.id}:{attempt}）; seal_needed = true
        COMMIT; goto 事务外                                 # 事务外 sealForReview，完成后 enqueue reconcile

    # E. 派发
    if not lifecycleGuard.canDispatch(settings, task): COMMIT; goto 事务外
    if task.status not in (ready, in_progress): COMMIT; goto 事务外
    if task.resource_state != ready: 需要 ensureTaskResources（事务外）; COMMIT; goto 事务外

    candidates = []
    if coordinator_eligible(task, runs): candidates.push(coordinator)
    if phase2: candidates += member_eligible(task, runs)  # 按 priority, created_at, id 排序
    slots = min(MAX_MEMBER_PARALLELISM - active_member_runs, …)

    for c in candidates (受 slots 限制):
      run = repos.runs.insertQueued(tx, {
        kind, attempt, request_version: task.version,
        input_event_ids: reserve_inputs(c),               # 预留，不等于消费（P-90）
        dispatch_key: 'teamwork:' + run_id })             # Durable Claim（I-01）
      events.append(run.claimed)
    if 无候选且无活动 Run: 按 02 §3.4 进入 blocked(reason)
  COMMIT

  # ── 事务外：网络动作 ─────────────────────────────────────────
  for r in probes:       exec = execution.getManagedExecution(r.dispatch_key, {probe:true}); enqueue reconcile
  for r in runs with pending_resolution:                  # D-49：人工结论经平台写入，Run 只经投影更新（R1）
                         runLifecycle.applyPendingResolution(r); enqueue reconcile        # 内部调用 ExecutionPort.resolveManagedExecution
  for task with resources in state=resolved:
                         resources.continueAfterResolve(task_id); enqueue reconcile       # D-52：resolve_resource 之后探测并续接
                         # 下一次 reconcile 的 A 段投影 resolution，并清空 pending_resolution、写 run.resolved / run.resolve_rejected
  for r in interrupts:   execution.interruptManagedExecution(r.dispatch_key, {workspaceId, origin:'teamwork', originRef:r.id})
                         # 包括 queued / starting 且尚无执行行的 Run：插入墓碑，保证之后永不发送（02 §1.6）
  for r in new_queued ∪ redispatch:   dispatchOne(r)
                         # redispatch 中的 Run 可能正由另一个 reconcile 在 turn-gate 排队；
                         # 重复调用安全：PL1 进程内 singleflight 合并，发送权条件 UPDATE 只让一方发送（02 §1.6）
  resource actions:      resources.ensureTaskResources / sealForReview（seal_needed）/ releaseOnTerminal; enqueue reconcile

dispatchOne(run):
  # 事务 2：发送前复核（P-101）
  BEGIN; lock run + task
    stale = task.control_intent 非空 或 run.dispatch_epoch != task.dispatch_epoch 或 lifecycle 禁止
  COMMIT
  if stale:
    # 不得直接把 Run 写成终态（D-44，P-158）：有了 redispatch，另一个 reconcile 可能已经发出请求
    execution.interruptManagedExecution(run.dispatch_key, {workspaceId, origin:'teamwork', originRef: run.id})
    # 取消方获胜 → 执行 interrupted{cancelled_before_send}；发送方已获胜 → 在途执行，等待真实停止确认
    # Run 状态随后由 projectFromExecution 投影（R1）
    enqueue reconcile; return
  prompt = run.kind == initial ? context.buildInitialPrompt : context.buildContinuationPrompt
  if prompt 渲染失败:
    # 同样经取消协议收敛，终态记为 failed{prompt_render}（non_retryable），而不是直接写 Run
    execution.interruptManagedExecution(run.dispatch_key, {..., asFailure: {stage:'pre_dispatch', code:'prompt_render'}})
    enqueue reconcile; return
  execution.dispatchManagedTurn({ dispatchKey: run.dispatch_key, origin: 'teamwork', originRef: run.id,
      workspaceId, sessionId: reuse_session(run), message: prompt, userId: task.owner_user_id,
      disablePendingDrain: true })
  # 结果由 lifecycle hook 回写（TW4）；这里只记录 run.dispatched 事件
```

**事务 2 的复核不是最终防线**（D-31）。复核提交之后、真正发送之前还有 prompt 构建与 turn-gate 排队两个窗口，pause 可能在其中到达。最终防线是 PL1 的"发送权 / 取消权二选一"：pause 的 reconcile 会对所有 queued / starting Run 调用 `interruptManagedExecution`，无论落在哪个窗口，结果都只有两种：

- 取消方获胜：执行被终止为 `interrupted{cancelled_before_send}`，保证从未发送；
- 发送方已获胜：按在途执行处理，等待真实停止确认后才迁移到 `blocked/paused`。

注意：不能用 `task.version` 判断派发意图是否失效，因为 Run 自身的写入也会增加 version。规则：只有 `start / resume / rework / retry / pause / cancel / resolve_execution` 这些**改变派发意图**的命令会让在途 queued Run 失效。TW2 在这些命令中执行 `task.dispatch_epoch += 1`；Run 记录 claim 时的 `dispatch_epoch`；dispatchOne 复核时两者不一致即判为失效。`request_version` 仅用于审计。

## 3. 派发资格

**协调员**（全部满足）：

1. 没有非终态协调员 Run（DB 保证，I-03）；
2. `coordinator_turn_count < budget.max_coordinator_turns`（否则 `blocked/budget_exhausted`）；
3. 以下任一：首次启动（没有任何协调员 Run）；存在**未处理输入**（定义见下）；上一轮 `pending_decision=continue`；`next_run_at <= now` 的重试到期；
4. 上一轮 `pending_decision=wait_for_items` 时，**只有同时满足**以下两条才继续等待、不派发（D-39）：
   - 没有未处理输入；
   - 至少有一个 WorkItem 仍在推进：`running`，或 `ready` 且可以派发、或只在等待 running 项的依赖。

   否则唤醒协调员。特别是：成员 Run 成功后 WorkItem 处于 `submitted`，它**不算**"仍在推进"，而是需要协调员验收的未处理输入。旧规则把它当成"仍未完成"，会造成"协调员等成员完成、成员等协调员验收"的死锁（P-153）；
5. 上一轮正常结束但 `pending_decision` 为空 → **不派发**，Task → `blocked/no_decision`（P-91）。

**成员 WorkItem**（Phase 2，全部满足）：`status=ready`；依赖全部 done；没有待确认结果（submitted 不可 claim，P-94）；没有非终态 Run；没有停止意图；预算与权限通过；成员挂载 ready（否则先 `ensureMemberMount`，P-115）；`next_run_at` 为空或已到期。

**未处理输入**（协调员唤醒与等待判定共用这一个定义）：

- 未消费的 `input.user / input.answer` 事件；
- 处于 `submitted`、尚未被协调员 accept / rework 的 WorkItem 结果（Phase 2）；
- 尚未被协调员 Run 消费的成员 `blocked` 报告（Phase 2）；
- `task.review_rejected` 事件（提交无效，需要协调员修正）。

没有未处理输入、也没有任何仍在推进的 WorkItem（例如剩余项全部 blocked）时，不能无限等待：Task → `blocked/dependency`，附说明"所有剩余工作项都无法推进"，由 owner 补充输入或处理。

**合并唤醒**（P-93）：多个成员结果在协调员空闲期间到达，只触发一次协调员 Run，`input_event_ids` 包含全部结果事件。

**Session 复用**：`continue / retry / rework` 默认复用该 Task（协调员）或该 WorkItem 最近一个 Session；同一 Workspace 担任不同 WorkItem 时使用不同 Session（P-69）。

**换新 Session 的兜底规则**（D-32，`02 §9.1` 表）：claim 新 Run 时检查上一个 Run 的结束方式。以下情况 `reuse_session` 返回空，新 Run 使用新 Session 和 initial prompt（完整上下文 + workpad）：

- 上一个 Run 经 `resolve_execution` 从 `unknown / suspected_stall` 收敛；
- 上一个 Run 为 `interrupted` 但中断未确认（按 fence 或超时收敛）；
- 上一个 Run 期间出现过 `run.stale_write`，且结束时没有有效结果或决策。

原因：这些情况下旧 turn 可能仍然存活，能通过 `teamwork_get_context` 拿到新 `run_ref`（P-149）。换新 Session 后，旧 Session 上没有非终态 Run，它的任何写调用都会被拒。

## 4. Worker 与唤醒

- 队列 `teamwork-reconcile`，payload 只有 `{task_id, reason}`，**不是 prompt**（不可无限重放原始指令）。
- 使用 pg-boss `singletonKey = task_id` + 短 `singletonSeconds` 合并高频唤醒；重复消息由锁和唯一约束兜底。
- 重试到期：`send(..., {startAfter: next_run_at})`。
- sweep 每 60s：`ready`、到期重试、有 `control_intent`、有 unknown / suspected_stall、`last_progress_at` 超过阈值的任务。
- worker 调用 `POST /internal/teamwork/reconcile`，服务身份（D-16，P-71）；**不写任何 Task 状态**（I-12）。
- 每次 reconcile 先读 lifecycle（P-123）。
- job 成功只表示完成一次对账（P-64）；reconcile HTTP 暂时失败由 pg-boss 重试，只收敛已有 Run，不盲发 prompt。

## 5. 与 TW2 的约定

- `dispatch_epoch` 已写入契约（`02 §4`）。TW2 负责在 §2 列出的命令中递增；TW3 负责在 claim 时记录、在 dispatchOne 时复核。

## 6. 任务

| # | 任务 | Phase |
| --- | --- | --- |
| TW3-1 | 代码映射复核 | 1A |
| TW3-2 | 事务内 send helper | 1A |
| TW3-3 | reconcile 事务 1 + 事务外动作框架 | 1A |
| TW3-4 | 协调员资格与 `no_decision` | 1A |
| TW3-5 | dispatchOne（发送前复核、prompt 失败处理） | 1A |
| TW3-6 | pause / cancel 收敛 | 1A |
| TW3-7 | 待验收两步：提交有效性判定 → seal → 确认 ro 后进入 in_review；两步之间不派发 | 1A |
| TW3-7b | 恢复派发：queued 且执行未发送的 Run 进入 redispatch | 1A |
| TW3-7c | reconcile 判定部分写成纯函数（输入：task、runs、executions、events、resources；输出：决策与动作列表），供 QA 属性测试使用（D-42） | 1A |
| TW3-8 | worker、singleton、startAfter、sweep | 1A |
| TW3-9 | 成员资格、并行槽位、合并唤醒、依赖 | 2 |

## 7. 测试

- 用 fake `ExecutionPort`：
  - 同一 task 并发 reconcile ×10，只产生 1 个 queued Run；
  - claim 后、dispatch 前崩溃，下次 reconcile 继续发送同一 `dispatch_key`（`send_state=not_sent`）；
  - pause 在 queued 与 dispatch 之间到达，Run 以 `not_accepted` 收敛，不发送；
  - pause 在事务 2 复核提交之后、turn-gate 排队期间到达：执行以 `cancelled_before_send` 终止，fake agent 收到 0 次请求（A-10b）；
  - pause 在 Run 已 claim、执行行尚未创建时到达：插入墓碑，之后的 dispatch 不发送；
  - lifecycle hook 先把 Run 写成 succeeded，之后 reconcile 才运行：业务后果仍被应用恰好一次（A-17）；
  - 对同一终态 Run 重复 reconcile ×5：`applyRunTerminal` 只生效一次；
  - claim 提交后、执行行创建前崩溃；执行行为 `not_sent` 时崩溃；turn-gate 排队中崩溃：重启后同一 `dispatch_key` 恰好发送一次，不新建 Run（A-01a～c）；
  - 两个 reconcile 同时把同一 queued Run 放进 redispatch：只发送一次，执行状态不被失败方改写；
  - submit_review 成功 → seal → in_review；seal 期间到达的用户输入不唤醒协调员（A-23）；
  - seal 失败 → `blocked/resource_failed` → retry → seal 成功 → in_review；seal 中途重启后继续（A-24）；
  - 提交无效（例如缺少某项验收证据）→ `review_rejected` → 协调员被唤醒（A-25）。
- Phase 2：没有任何用户输入时，成员 succeeded → submitted → 协调员被唤醒 → accept → done（M-09）；剩余项全部 blocked 时进入 `blocked/dependency`，不无限等待。
- `no_decision`、`wait_for_items`、预算耗尽。
- Phase 2：依赖未满足不派发；合并唤醒；只重试失败项。
