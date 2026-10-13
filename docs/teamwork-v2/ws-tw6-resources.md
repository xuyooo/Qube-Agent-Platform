# WS-TW6 · AFS 资源与产物

Phase 1A（成员挂载为 Phase 2）。必读：`02-contracts.md §4（teamwork_resources）§5（ResourceManager）§6`；`90-pitfalls.md` P-27、P-50～P-52、P-110～P-117。

## 1. 拥有的文件

`plugins/teamwork/server/resources.ts`、`artifacts.ts`。从 `control-plane/src/services/teamwork.ts` 抽出 `provisionTeamworkShare / mountTeamworkShareForMember / unmountTeamworkShareForMember / teardownTeamworkShare` 的 AFS 调用逻辑（EXTRACT），通过现有 `services/afs.ts` 实现。旧文件保留至 G4，由 TW9 删除。

## 2. 目录约定

```text
/mnt/afs/team-<taskId>/
  inputs/                               # 输入材料；编排约定只读
  work-items/<workItemId>/<runId>/      # 成员独立输出；禁止并发写同一结果路径
  coordinator/<runId>/                  # 协调员工作输出
  deliverables/<resultRunId>/           # 最终提交版本
```

路径分离只是防止误覆盖，**不是**安全隔离（P-112）。同一 Workspace 内的其他 Session 也可能访问挂载；同 owner 是首版信任边界。

## 3. 资源生命周期

| 时机 | 操作（每步幂等，成功一步立即写 `teamwork_resources`） | 失败 |
| --- | --- | --- |
| create | 不做任何事（P-50） | — |
| start 后首次 reconcile | ensure 目录 → ensure share（`team-<taskId>`）→ ensure 协调员 rw mount | 保留 Task 与资源记录；Task `blocked/resource_failed`；可 `retry` 重放 |
| 成员首个 Run 前（Phase 2） | ensure 成员 rw mount；校验同环境可达（不只看 `status=running`，P-27） | 该 WorkItem blocked，其他继续 |
| 提交有效之后、进入 in_review 之前（`02 §3.5` 第一步满足后由 reconcile 触发） | `sealForReview`：确认相关写入 Run 已停止 → 把所有执行方的写挂载改为 ro（1A：协调员挂载；Phase 2：含成员挂载，P-157）→ 写 `ro + ready` | 失败 → 资源行 failed，Task `blocked/resource_failed`，保留 `pending_review_run_id`；retry 后重新 seal。seal 未完成前不能进入 in_review，也就不能 accept（P-114） |
| rework | 恢复所需写挂载，成功后才允许派发新 Run（P-115） | Task `blocked/resource_failed` |
| done / cancelled | 回收执行成员挂载；协调员保留 ro 挂载供 owner 浏览；**不删除**交付物（P-117） | 记录 `releasing / failed`，下次 sweep 重试 |
| archive | 不改变资源 | — |

规则：

- AFS 操作不在 DB 事务内（P-110）。流程：短事务写 `state=preparing` 与稳定的 `op_id` → 事务外调用 AFS → 短事务写 `ready + resource_id` 或 `failed + error`。
- **不能笼统宣称"每步幂等"**（D-34，P-143）。按 `main@80361d0` 的 `control-plane/src/services/afs.ts`，各步的恢复能力不同：

| 步骤 | 现有 API | 能否按操作身份查回 | "外部成功、回执丢失"时的处理 |
| --- | --- | --- | --- |
| 创建目录 | `createDir(env)`：由 AFS 生成 id，`accessKey` 只在返回值中出现一次 | **不能**：不接受调用方 id，没有 list / lookup | 该行停在 `preparing`、没有 `resource_id`，**且租约已过期** → 标为 `orphan_suspected`，记录 `op_id` 与时间，**重新创建**新目录。租约未过期的 `preparing` 是正常在途操作，不得当作孤儿（P-161）。孤儿目录没有 access key，不可访问也不可 revoke，按存储泄漏上报运维清理。这是已知且可接受的代价，不是正确性问题 |
| 登记 share | `createAfsShare(...)`（CP 自己的表） | 能：DB 写入 | 与 `resource_id / secret_ref` 在同一事务内写入 |
| 挂载 | `mountAtWorkspace(env, ws, dirId, accessKey, name, ro)`，挂载点由 `name` 决定 | 待确认：fuse-server 对"已挂载同一挂载点"是否幂等 | TW6-0 先验证；幂等则直接重放；不幂等则先 `unmountAtWorkspace` 再挂载，或把该步标为 `uncertain` 交人工 |
| 卸载 | `unmountAtWorkspace(env, ws, name)` | 按挂载点 | 失败保留 `releasing`，sweep 重试（P-111） |
| 回收目录 | `revokeDir(env, id, accessKey)` | 需要 `secret_ref` | `secret_ref` 丢失 → `orphan_suspected`，不删行 |

- `createDir` 返回后必须**立即**在一个短事务里写入 `resource_id` 与加密的 `secret_ref`，再做下一步。崩溃窗口缩小到"返回值到这次写入之间"，这个窗口里的产物就是上表的孤儿目录。
- 更好的长期方案是让 AFS controller 支持调用方提供幂等键（`CreateDir{client_op_id}`）或按名称查询。这需要改 AFS 服务，列为 Q-07，不阻塞 1A。
- 已登记的资源按"当前资源"核查，重复调用不重复创建。**当前资源**是指同一 `(task_id, type)`（task 级）或 `(task_id, type, workspace_id)`（workspace 级）下 `state <> 'orphan_suspected'` 的那一行，由 `02 §4` 的两条 partial unique index 保证至多一行（D-41）。普通 `UNIQUE (task_id, type, workspace_id)` 对 `workspace_id IS NULL` 的 task 级 share 不起作用（P-155）。
- 并发 ensure：第二个事务插入当前资源时撞上 partial unique index，改为读取已有行，再按下方租约规则决定"等待"还是"接手"，不另建。

**外部操作租约**（R3，D-47，I-33）。当前资源行唯一，只保证 DB 里不出现两条记录；它**不能**保证外部操作只执行一次。正常在途的 `createDir` 在另一个 ensure 看来，和崩溃残留一模一样。因此：

1. **领租约**（短事务）：`claimLease`，即条件 UPDATE `WHERE lease_until IS NULL OR lease_until < now()`，写入新的 `op_id`、`op_attempt+1`、`lease_until = now() + LEASE_MS`。领不到说明有正常在途操作：本次 ensure 返回 `in_progress`，完成后由对方入队 reconcile，本方不调用 AFS。
2. **调用 AFS**（事务外）：单次调用的超时必须**小于** `LEASE_MS`（建议 `LEASE_MS=120s`、调用超时 60s），保证租约不会在调用进行中过期。
3. **落库**（短事务）：`commitOp`，即 `WHERE id=$id AND op_id=$opId AND replaced_by IS NULL`。
   - 影响 1 行：写 `resource_id / secret_ref / state`，清空 `lease_until`。
   - 影响 0 行：本操作已**过期**（租约被他人接手，或该行已被替换）。这时本方手里还有 `accessKey`，必须立即 `revokeDir` 回收自己刚创建的目录，并且**不再执行**后续挂载，结果不落库。
4. **后续步骤**（登记 share、挂载、seal、卸载、回收）：每一步都重新 `claimLease`，并在步骤开始前和落库时校验 `op_id`，过期的操作不能继续。
5. 只有租约**已过期**的 `preparing` 才能进入孤儿判定（`replaceOrphan`）。这条**只适用于创建独立对象**，见下文。

**两类外部操作**（R4，D-48，I-34）。租约与 `commitOp` 只能挡住**过期结果落库**，挡不住**过期请求在外部生效**：客户端超时并不代表 AFS 服务端已经停止处理（P-162）。两类操作的后果不同，所以处理方式不同：

| 类型 | 操作 | 结果不确定时 | 能否凭租约过期接手 |
| --- | --- | --- | --- |
| `create_object`：创建独立对象 | `createDir` | 迟到的请求只会多出一个独立目录，不影响已有对象。允许接手；过期操作返回后回收自己创建的目录 | 能 |
| `mutate_mount`：修改共享挂载 | mount、seal（改 ro）、恢复 rw、unmount、revokeDir | 迟到的请求会**改变别人已经确认过的实际状态**。例如旧的 rw 挂载请求在新的 ro seal 之后才生效 | **不能**：该行进入 `uncertain`，必须先观察实际挂载状态 |

补充租约规则：CP 进程内对同一 task 的资源流程加进程内互斥，作为优化减少无效领取；正确性仍靠租约与 `commitOp` 条件。

`mutate_mount` 的规则（D-52）：

- 调用超时、断连，或返回无法判定：资源行进入 `uncertain`，**保留租约持有者**，不允许他人接手。
- **`probeMounts` 只证明当前状态，不证明旧请求以后不会生效**（P-168）。所以观察结果**不能**用来解除 `uncertain`，也**不能**凭"等了足够久没变化"推断旧请求已失效。等待时间不是证据（R4）。
- `uncertain` 只有在拿到以下**证据之一**后才能解除：

| 证据 | 含义 | 状态 |
| --- | --- | --- |
| AFS 服务端按操作序号拒绝过期请求，并确认旧 op 已被拒绝或已完成 | 旧请求不可能再生效 | 依赖 Q-07，尚不具备 |
| 人工确认：owner 或 admin 通过 `resolve_resource` 命令确认旧操作已终止，附证据 | 人工承担判断 | 始终可用 |

**资源恢复基线**（D-55）：只有上面两种证据。

**"fuse-server 实例已变更"不是证据，已移除**（P-171）。实例重启只说明旧进程没了，不说明旧请求没了：旧请求可能还在网络中，或者在 remote AFS 的 env-runner / tunnel 上游队列里，等重启后才送到新实例并生效。runtime 那边能用实例隔离，是因为发送时带了 `expected_runtime_instance_id`，新实例会拒绝不属于自己的请求；挂载请求目前没有这一层。

将来如果要启用"实例变更"作为自动证据，必须**同时**满足以下三条，并由 TW6-0 或后续工作逐条验证，而不只是确认"能读到实例 ID"：

1. 挂载请求携带目标 fuse-server 实例身份（类似 `expected_instance_id`）；
2. 新实例拒绝携带旧实例身份的请求，并保证被拒请求不产生任何效果；
3. 上游（CP gRPC 客户端、remote AFS 的 env-runner / tunnel）不会把旧请求重放到新实例。

**人工确认的证据要求**：同样不能只凭"已重启 afs-fuse sidecar"。重启本身不证明旧请求不会迟到，理由同上。执行人需要确认旧请求已无法再送达，并在 `evidence` 中写明依据。例如：

- 在 fuse-server 日志中确认该 op 已被处理或拒绝；
- 确认该请求的上游连接已断开，且不存在会重放它的队列。

系统记录执行人与证据。即使人工确认后，accept 前探测、in_review 周期探测与 checksum 复核仍然继续生效，用来发现残余风险，但不作为"已安全"的依据。

- 解除的写法：`resolve_resource` 命令事务内调用 `repos.resources.resolveUncertain(tx, id, op_id)`，行从 `uncertain` 变为 `resolved`。之后 reconcile 在事务外调用 `continueAfterResolve`，以 `probeMounts` 的观察结果决定下一步：已达目标 → `ready`；未达 → 重新领租约并发起该操作（D-57）。
- **同一挂载点存在 `uncertain` 操作时，禁止发起任何新的 `mutate_mount` 操作**（I-36）。这条才是真正挡住"旧 rw 在新 ro 之后生效"的规则：旧 rw 还不确定时 seal 根本不会发出，Task 停在 `blocked/resource_failed`，不可能进入 in_review，也就不可能被 accept。
- seal 的前置条件：该任务所有执行方挂载**都没有** `uncertain` 操作。
- **seal 完成以观察结果为准**：只有 `probeMounts` 显示所有执行方挂载都是 `ro`，并且没有未解除的 `uncertain`，才满足 `02 §3.5` 第二步。请求返回成功不算。
- **accept 前再观察一次**：TW2 的 accept 调用 `probeMounts`；发现任何执行方挂载变成了 `rw`、或存在 `uncertain` → 拒绝 accept，Task `blocked/resource_failed`，要求重新 seal 与重新校验 checksum。
- in_review 期间 sweep 周期性 `probeMounts`，发现变成 rw 同样处理。
- 周期探测与 checksum 复核（P-113）是**发现异常**的手段，不是"已经安全"的依据。

运维说明：在 Q-07（AFS 服务端操作序号）到位之前，挂载操作超时只能人工处理。挂载超时应当罕见，但它是一个真实存在的人工入口，需要写进运维手册。
- 孤儿替换必须在**同一事务**内完成（`repos.resources.replaceOrphan`）：旧行改为 `orphan_suspected` 并写 `replaced_by`，然后插入新的当前资源行。分成两个事务会出现"没有当前资源"或"两个当前资源"的中间状态。
- `released` 的行仍是当前资源。rework 需要恢复写挂载时，原地改回 `preparing` 复用，不新建行。
- 任何一行处于 `uncertain` 时，Task 保持 `blocked/resource_failed`，retry 前需要人工确认。
- revoke 失败**不得**删除记录（P-111）。
- `teamwork_tasks.resource_state` 由本工作流根据所有资源行汇总写入：全部 ready → `ready`；任一 failed / uncertain → `failed`；有 preparing / resolved → `preparing`。`orphan_suspected` 的行不参与汇总（已被新行取代），只进运维报告。
- 旧 Preview 任务已有 `afs_share_id`：首次 ensure 时把它作为已存在 share 登记（`resource_id = afs_share_id`），不重复创建、不删除。

## 4. 产物

- `computeArtifactDigests`：Agent 提交 result 时，对 `file / report / patch` 类产物通过现有文件访问路径计算 `sha256 / size_bytes`，写入 Run 的 `result_json`；路径必须落在 `/mnt/afs/team-<taskId>/` 内，禁止 `..` 越界。
- `verifyArtifactDigests`：accept 前重新计算；不一致返回 mismatched 列表，TW2 拒绝验收并要求重新提交（P-113）。
- 外部链接只记录 URL 与说明，不计算 checksum。
- checksum 不代表存储层不可变；同 owner 的其他访问路径仍在信任边界内。

## 5. 任务

| # | 任务 | Phase |
| --- | --- | --- |
| TW6-0 | 开工第一项，结论写回 §3：① `mountAtWorkspace` 对同一挂载点重复调用的行为（内置 AFS 与 remote AFS 两种环境）；② 调研"实例变更"成为自动证据的**三个前提**能否满足（§3 资源恢复基线下方列出：请求携带目标实例身份、新实例拒绝旧请求且无副作用、上游不重放）。只能读到实例 ID 不够；结论只作为将来的改进依据，**本轮不启用**（D-55）；③ **`probeMounts` 的实现方式**（Q-09），按优先级：(a) fuse-server 是否有挂载状态 RPC；(b) 若没有，由 CP 经 agent-server 在 pod 内读取 `/proc/mounts` 中 `/mnt/afs/<name>` 的挂载选项（需要 agent-server 增加一个只读端点，由 PL2 实现）；(c) 长期：AFS 服务端支持按操作序号拒绝过期请求（Q-07） | 1A |
| TW6-1 | 代码映射复核 | 1A |
| TW6-2 | ensureTaskResources（目录 / share / 协调员 mount） | 1A |
| TW6-3 | 资源汇总写 `resource_state` | 1A |
| TW6-4 | sealForReview / releaseOnTerminal | 1A |
| TW6-5 | computeArtifactDigests / verifyArtifactDigests | 1A |
| TW6-6 | 旧 `afs_share_id` 登记 | 1A |
| TW6-7 | ensureMemberMount + 同环境检查 | 2 |

## 6. 测试（fake AFS）

- 第二步失败：记录保留，retry 后从第二步继续，不重复创建第一步。
- `createDir` 成功后、写入 `resource_id` 前崩溃：该行变为 `orphan_suspected`，重新创建新目录，孤儿被上报；Task 最终 ready（A-19）。
- 挂载成功后、写入 ready 前崩溃：按 TW6-0 的结论重放或进入 `uncertain`，不静默当作成功（A-20）。
- `secret_ref` 丢失时 revoke：行保持 `orphan_suspected`，不删除。
- revoke 失败：记录为 failed，sweep 重试成功后才变 released。
- seal 失败时 Task 不会进入 in_review，也就不能 accept；retry 后 seal 成功再进入。
- seal 中途崩溃：部分挂载已 ro、部分仍 rw，重启后重放完成，不会提前进入 in_review。
- 1A 只有协调员挂载时，seal 同样把它改为 ro；in_review 期间协调员 Workspace 无法改写交付物。
- 同一任务并发 `ensureTaskResources` ×10：只有一个当前 share，其余调用读取它继续；DB 测试直接验证两条 partial unique index（A-27）。
- 孤儿替换与并发 ensure 交错：任何时刻都恰好有一个当前资源行。
- A 的 `createDir` 在途、未返回时 B 执行 ensure：B 领不到租约，不调用 AFS；外部 `createDir` 只调用一次；最终挂载的是 A 的目录（A-27）。
- A 的调用卡住导致租约过期，B 接手并完成；随后 A 迟到返回：A 的 `commitOp` 影响 0 行，A 回收了自己创建的目录且没有挂载；最终挂载的是 B 的目录（A-29）。
- 提交后改写文件：accept 返回 `artifact_changed`。
- 越界路径被拒。
