# WS-TW4 · Run 生命周期、重试分类、Stall、Unknown

Phase 1A。必读：`02-contracts.md §1.3–1.5 §3.3 §5（RunLifecycle）§11`；`01-decisions.md` D-03、D-07～D-12；`90-pitfalls.md` P-07、P-08、P-11、P-14、P-17、P-21、P-80～P-82、P-86、P-90、P-95～P-102、P-105。

## 1. 拥有的文件

`plugins/teamwork/server/run-lifecycle.ts`、`retry.ts`、`health.ts`、`resolve-execution.ts`。

## 2. 职责

1. **执行投影**（`projectFromExecution`，R1，D-46）：Run 中由执行派生的字段（状态、session_id、started / ended / last_event / last_progress、pending_requests、runtime_instance_id）**只由这一个函数写入**。hook、reconcile、sweep 都调用它，dispatch、命令、reconcile 的其他步骤都不直接写这些字段。规则：
   - 读取 `managed_executions` 的**当前行**，不使用事件载荷里的状态（事件只是唤醒信号）；
   - 条件更新：`WHERE id=$run AND applied_exec_seq < $exec.last_seq`，同时写 `applied_exec_seq = exec.last_seq`；
   - Run 已是终态时，执行派生字段不再改变。迟到的旧事件（例如终态 seq=12 已应用后才到达的 running seq=11）因此不会让 Run 回退，也不会触发活动唯一约束冲突（P-160）；
   - 只做去重是不够的：迟到的旧序号事件不是"重复"，仍会覆盖新状态。

   **lifecycle hook**（`onExecutionEvent`）只做两件事：调用 `projectFromExecution`，并入队 reconcile。绑定 `teamwork_sessions` 在投影事务内完成（失败可见，P-21），写 `run.*` 事件，不做业务推进（业务推进在 reconcile 中）。hook 把 Run 写成终态时 `outcome_applied_at` 保持 NULL；reconcile 通过 `listOutcomePending` 找到它并应用业务后果（D-29）。**不得**依赖"reconcile 在本轮看到 Run 从非终态变为终态"。
2. **reconcileRun**（纯判定）：给定 Run 与 Execution，决定保持 / 终态 / 需要 probe / unknown / suspected_stall。
3. **classifyFailure**：失败分类。
4. **nextRetryAt**：重试排期。
5. **resolveExecution**：人工处理 unknown / suspected_stall。

## 3. 重试分类（D-09）

| 分类 | 判定 | 自动重试 | 手动 retry |
| --- | --- | --- | --- |
| `retryable` | `stage ∈ {pre_dispatch, admission, workspace_start}`（含 `session_busy`，D-65；但 `session_managed` 除外，它归 non_retryable）；或 `stage=transport` 且有 fence 回执 `fenced` 或 `412 instance_mismatch`（D-30） | 是，最多 3 次，10s / 30s / 120s（尊重更长的 Retry-After） | 是 |
| `manual_only` | `stage=in_turn` 且 `code ∈ {provider_error, provider_rate_limited, agent_http_status}` 且 `toolActivityObserved=true`；或 prompt 渲染以外的 in_turn 错误但无法判断副作用 | 否 | 是 |
| `non_retryable` | `code ∈ {permission_denied, invalid_configuration, budget_exhausted, agent_fatal, provider_auth_required, session_managed}` 或 `runtimeReportedFatal=true` | 否 | 修复原因后是 |
| `unknown` | Execution `unknown` | **禁止**（I-08） | 否，只能 `resolve_execution` |

补充：

- `stage=in_turn` 且 `toolActivityObserved=false` 的 provider 瞬时错误：归为 `retryable`（模型尚未执行任何工具）。
- HTTP 超时、connection reset、SSE 断开**本身不构成**分类依据（P-95），必须先查询执行事实。
- lookup 返回 404 **不构成**"未接受"的证据（P-141）。没有 fence 回执时一律归为 `unknown`。
- `interrupted` 由用户 pause / cancel 造成时（包括 `cancelled_before_send`）不计入失败，不重试；resume 后由 reconcile 按资格规则新建 Run。
- 自动重试耗尽 → Task `blocked/execution_failed`。
- `retry_count`（失败）与 `coordinator_turn_count`（续跑）严格分开（P-97）。
- 重试沿用原 Run 中未消费的 `input_event_ids`（P-98）；`kind=retry`，`parent_run_id` 指向失败 Run。

## 4. Stall（D-11）

```text
每次 reconcile，对 status ∈ {starting, running} 的 Run：
  if now - (last_progress_at ?? started_at) > STALL_THRESHOLD_MS (10min):
     needsProbe
probe 结果：
  runtime 确认 running            → 保持；清除 suspected_stall（如有）
  runtime 确认终态                 → 按终态收敛
  无法确定（无 lookup 能力 / 网络不通 / 实例变更）→ Run 保持非终态占位（P-99）
                                     Task → blocked/suspected_stall，写 run.suspected_stall
```

- `waiting_input` 不参与 stall（P-100）。
- SSE keepalive 不算进展（P-07）。
- Phase 1A **不自动 interrupt、不自动 retry**（I-09）。
- 状态后来可确认时（例如事件恢复），自动解除 suspected_stall。

## 5. Unknown 与 resolve_execution（D-07、D-08）

进入 unknown：Execution 为 unknown（`02 §1.5`）。Run 保持占位，Task → `blocked/execution_unknown`。

`resolve_execution {run_id, decision, evidence, side_effects_checked, retryable}`：

**写入路径**（D-49）：人工结论不能直接改 Run，否则违反 R1（P-163）。流程分三段：

1. **命令**（TW2，事务内）：校验权限、`expected_version`、`request_id`；调用 `runLifecycle.requestResolution(tx, run, input)`，它把结论写入 `teamwork_runs.pending_resolution` 并写 `run.resolve_requested` 事件；返回 202 `action_state=resolving`。
2. **reconcile**（事务外）：对有 `pending_resolution` 的 Run，调用 `runLifecycle.applyPendingResolution(run)`，它内部调用 `ExecutionPort.resolveManagedExecution(dispatch_key, ...)`。这一步包含 probe 或执行级中断等网络调用，所以不能放在命令事务里。
3. **投影**（事务内）：平台已写入 `resolution` 并使 `last_seq + 1`；`projectFromExecution` 据此更新 Run；清空 `pending_resolution`，写 `run.resolved`。平台返回 `applied=false` 时（已终态或 probe 不能确认），同样清空，并写 `run.resolve_rejected{reason}`。

| decision | 平台执行的操作 | 投影后 Run |
| --- | --- | --- |
| `bind_existing` | probe；确认原执行在同一实例仍存在，才写入观察到的状态，否则拒绝 | 按观察到的状态继续跟踪；Task 回 in_progress |
| `confirmed_not_accepted` | 先发执行级中断（结果不阻塞），再条件 UPDATE 为 `failed{not_accepted}` | 终态，释放占位 |
| `confirmed_terminated` | 同上，终态为 `interrupted`，或 `failed`（`retryable=false`） | 终态；`retryable=true` 才允许后续 `retry` |

- 经 resolve 收敛的 Run，下一个 Run 必须换新 Session（`02 §9.1`）。判断依据是投影出来的 `resolution` 字段。
- resolve 之后 CP 重启、或旧事件再到达：执行已经是终态且 `last_seq` 已递增，投影不会回退（A-34）。

- 仍有停止意图时只完成停止，不派发。
- 证据不足保持 unknown。
- 结论、操作者、时间写入 `run.resolved` 事件；不删除原 Run 来解锁。
- 普通 retry / resume 一律拒绝绕过 unknown。

## 6. 结果绑定（I-17）

- `teamwork_report(result)` / `submit_review` 写入的结果先挂在**当前**非终态 Run 上；Run `succeeded` 后才成为可接受结果。
- 迟到结果（Run 已终态）、取消后的结果、旧 Run 的结果：保存到事件历史，不改变 `result_run_id`、WorkItem 或 Task 状态（P-82）。
- Run `succeeded` 但成员未提交 result → WorkItem `blocked/no_result`（Phase 2）。
- Run `succeeded` 不等于完成（I-05，P-80）；CP 重启不因 `chat_status=idle` 判定成功（P-81）。

## 7. 等待输入

- Execution `waiting_input` → Run `waiting_input`，写 `pending_requests`，发通知（现有 notifications）。
- 回答走 `respondToRequest`，不用普通聊天消息替代工具审批。
- runtime `waitingInput=false` 时不会收到此状态（P-17）。
- Phase 1A 不设超时（D-12）；Phase 3 增加可配置超时（P-105）。

## 8. 任务

| # | 任务 |
| --- | --- |
| TW4-1 | 代码映射复核 |
| TW4-2 | `onExecutionEvent` 投影 + session 绑定 + 幂等 |
| TW4-3 | `reconcileRun` 纯判定（全表测试） |
| TW4-4 | `classifyFailure` + `nextRetryAt` |
| TW4-5 | stall 检测与 suspected_stall |
| TW4-6 | resolve_execution |
| TW4-7 | 结果绑定规则 |
| TW4-8 | 停止流程：按 dispatch_key 中断该 Task 的执行（不停整个 Workspace，P-86）；请求在途、尚无 session_id 时也要覆盖（P-102） |

## 9. 测试

分类表每一行；stall 三种 probe 结果；unknown 下 retry 被拒；resolve 三种结论；迟到结果不覆盖；hook 重复投递幂等。
