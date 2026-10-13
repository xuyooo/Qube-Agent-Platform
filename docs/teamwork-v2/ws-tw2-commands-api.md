# WS-TW2 · 状态机、命令账本、HTTP API

Phase 1A。必读：`02-contracts.md §3 §5（StateMachine）§7 §8`；`90-pitfalls.md` P-25、P-50、P-52、P-53、P-63、P-65、P-83～P-88、P-121、P-125、P-132、P-138、P-139。

## 1. 拥有的文件

`plugins/teamwork/server/state-machine.ts`（纯函数）、`commands.ts`（命令处理管线）、`routes.ts`（Hono + zod-openapi）、`authz.ts`。

## 2. 分层

```text
routes.ts   认证 → 协议头检查 → 参数校验 → commands.handle()
commands.ts task 授权（非 owner → 404）→ BEGIN → commands.claim 原子占位（失败：读首次结果 / 422）→ lifecycle → lock task → version →
            stateMachine.applyCommand() → 写 task / events / commands → send reconcile → COMMIT
state-machine.ts  (task, command, ctx) → TransitionResult，无 IO，100% 单测覆盖
```

`applyRunTerminal` 同样在 state-machine 中实现，由 TW3 在 reconcile 事务内调用。

## 3. 任务

| # | 任务 | 完成标准 |
| --- | --- | --- |
| TW2-1 | 代码映射复核（旧 `routes/teamwork.ts` 各路由的去留） | |
| TW2-2 | state-machine：Task 转换表（`02 §3.1`）、blocked_reason 解除规则（§3.4）、in_review 条件（§3.5）、`allowedCommands` | 表格每一行一个测试；非法转换返回 409 |
| TW2-3 | 命令管线：**授权先于重放**（P-145）→ 事务内**原子占位** `commands.claim`（D-40，P-154）→ 占位失败则读取首次结果或返回 422 → lifecycle → 锁 task + version → 应用；拒绝也写入 `result_json` → 事务内 send | I-15、I-16、I-21；A-21、A-28 |
| TW2-4 | `start`：锁 `teamwork_plugin_settings` 行（P-121）→ 写 `workflow_snapshot`（从 TW5 取模板）、`started_at` | drain 并发测试 |
| TW2-5 | `pause / cancel`：只写 `control_intent` 并返回 202 + `action_state=pausing/cancelling`；迁移由 reconcile 在确认终止后完成（P-87） | |
| TW2-6 | `accept`：`result_run_id` 必须等于当前值（P-84）；调用 TW6 `verifyArtifactDigests`，不一致 409 `artifact_changed`；调用 TW6 `probeMounts`，任何执行方挂载为 rw 或 unknown 时 409 `mount_not_sealed`，Task → `blocked/resource_failed`（D-48）。两者都是网络调用：accept 命令先在事务外完成校验，再在命令事务内以 `expected_version` 提交迁移 | A-33 |
| TW2-6b | `resolve_execution` 改为异步：命令事务内调用 `runLifecycle.requestResolution`，返回 202；由 reconcile 调用 `applyPendingResolution`（D-49、D-57） | A-34 |
| TW2-6c | `resolve_resource`：命令事务内调用 `repos.resources.resolveUncertain`，影响 0 行返回 409；写 `resource.resolved`；入队 reconcile（D-52、D-57） | A-33c、A-37 |
| TW2-7 | `rework`：写 `input.user` 事件（含 note），清除当前待验收版本，保留历史；`work_item_ids` 显式重开（P-85） | |
| TW2-8 | `retry / resume / resolve_execution`：守卫在 TW2，领域判定调用 TW4 `resolveExecution` / `classifyFailure` | |
| TW2-9 | 路由（`02 §7`），固定路径先于 `/:id` 注册；404 不泄露存在性；426 协议不符 | |
| TW2-10 | `POST /api/teamwork`：lifecycle=active 才允许；协调员属于 owner；**不要求 running、不 provision**（P-50）；body 带 `request_id` | |
| TW2-11 | participants：同 owner 同环境（P-52）；协调员不能是成员（P-25）；有相关活动 Run 时 409（P-88） | |
| TW2-12 | `inputs`：写 `input.user` 并入队，**不直接启动 turn**；`comments` 只记活动（P-139） | |
| TW2-13 | `requests/:id/respond`：校验 request 属于该 task 的 Run，经 `ExecutionPort.respondToRequest` 路由到原 session（P-138） | |
| TW2-14 | 读接口：list（筛选后计数，P-132）、detail（`allowed_commands`）、runs、events、sessions | |
| TW2-15 | OpenAPI 注册，契约类型来自 `plugins/teamwork/contracts` | |
| TW2-16 | `start / resume / rework / retry / pause / cancel / resolve_execution` 在同一事务内 `dispatch_epoch += 1`（P-107，见 `ws-tw3 §2`） | 在途 queued Run 在这些命令后不会被发送 |

## 4. 权限

- 所有 task 读写：`owner_user_id = user.sub`。
- **平台 admin 例外清单**（D-56；这是唯一的权威清单，`02 §8` 引用它，不另行列举）：

  | 命令 | admin 可执行 | 附加要求 |
  | --- | --- | --- |
  | `resolve_execution` | 是（D-08） | 写 `actor_type=admin` 事件；通知 owner |
  | `resolve_resource` | 是（D-52、D-56） | 写 `actor_type=admin` 事件；通知 owner；只接受当前 `op_id`，否则 409 |
  | `POST /api/teamwork/plugin/commands` | 是（插件生命周期，TW7） | 写插件审计 |
  | 其他所有 task 命令与读接口 | 否 | admin 视同非 owner，返回 404 |

- 新增 admin 例外时，必须同时更新本表、对应命令的审计与通知规则，以及 A-37 一类的权限测试。
- 读取 Session / 文件：必须通过 task 关系检查（I-21），不能只凭 workspace_id / session_id。
- 不提供硬删除（D-28，P-53）。

## 5. 测试

- 状态机：全转换表 + 所有非法组合。
- 同一 `request_id` 重放 5 次：一个状态转换，返回同一响应。
- 另一个已认证用户拿着相同的 task_id 与 request_id 重放：返回 404，不返回缓存响应（A-21）。
- 同一 request_id、不同 payload：422 `request_id_reused`，不执行。
- 相同请求**并发**到达 ×10（不只是顺序重放）：恰好一次状态转换，10 个响应完全相同，不会出现"一个 202、其余 409"（A-28）。
- 并发 create ×10（同一 request_id）：只创建一个 Task，10 个响应相同。
- 首次得到 409 的命令再次重放：仍返回同一个 409，不会因为之后版本变化而被执行。
- admin 例外清单（A-37）：admin 对他人任务执行 `resolve_execution` / `resolve_resource` 成功，写 `actor_type=admin` 事件并通知 owner；admin 对他人任务执行其他命令（例如 `accept`、`start`）返回 404；普通非 owner 调用 `resolve_resource` 返回 404；带旧 `op_id` 的 `resolve_resource` 返回 409，资源状态不变。
- 命令成功后 lifecycle 变为 draining，再重放：仍返回首次结果。
- 两个用户（或两个标签页）同时 accept / rework：一个成功，一个 409（验收矩阵）。
- 旧协议头的写请求返回 426，后台无新执行。
