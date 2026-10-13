# WS-TW1 · Schema、Migration、Repository

Phase 1A（151 为 Phase 2）。必读：`02-contracts.md §4 §5（TeamworkRepos）§12`；`90-pitfalls.md` P-22、P-60～P-70。

## 1. 拥有的文件

`control-plane/migrations/149_teamwork_v2_core.sql`、`150_teamwork_plugin_settings.sql`、`151_teamwork_work_items.sql`；`plugins/teamwork/server/db/**`（`tx.ts`、`tasks.ts`、`runs.ts`、`events.ts`、`commands.ts`、`resources.ts`、`sessions.ts`、`settings.ts`、`work-items.ts`、`roster.ts`）。

## 2. 任务

| # | 任务 | 完成标准 |
| --- | --- | --- |
| TW1-1 | 代码映射复核（`services/db/teamwork.ts` 中哪些函数迁入：`listRosterCandidates`、`addTeamworkSession`、`findTaskBySession` 等） | |
| TW1-2 | migration 149 / 150 | 在全新库与"已有 Preview 数据的库"上都能执行；旧行 `status='backlog'`；执行后旧代码仍可正常读写（G4 前生产仍跑旧实现） |
| TW1-2b | migration 152（切换期约束），只随 G4 切换 PR 合入 | 预发演练通过 |
| TW1-3 | `db/tx.ts`：只实现事务 helper（`WithTx`），支持把同一 client 传给 pg-boss `send({db})`；`Tx` 类型由 CT2 定义在 `contracts/tx.ts`，这里只引用（D-62） | TW2 / TW3 使用同一 helper |
| TW1-4 | repos 按 `TeamworkRepos` 接口实现 | 每个方法有真实 PostgreSQL 测试 |
| TW1-5 | `runs.insertQueued` 违反 partial unique 时抛 `ActiveRunExists`（映射 PG 23505 + 索引名）；Run id 使用 UUIDv4 等随机值，因为它同时是 `run_ref`（P-148） | 并发插入测试 |
| TW1-6 | `tasks.update` 乐观锁：`WHERE id=$1 AND version=$2`，`version = version + 1`；不符抛 `VersionConflict` | |
| TW1-7 | `sessions.bind`：跨 task / work_item 绑定抛错（I-19）；写 `parent_session_id` | |
| TW1-8 | `events.append`：`dedupe_key` 冲突返回 null（不抛） | |
| TW1-9 | `listBoard`：返回**筛选后**各列总数 + 游标分页；done / cancelled 默认只取最近 N 条 | P-132 |
| TW1-10 | `roster.ts`：候选成员 = 同 owner、同 AFS 可共享环境（D-22） | |
| TW1-11 | Phase 2：migration 151、`work-items.ts`，依赖写入时同 task 检查与无环检查（DFS，事务内） | 环被拒绝 |
| TW1-12 | fake repos（内存实现）供其他 TW 工作流单测使用 | 与真实实现共享同一套 contract test |

## 3. 要点

- **两条 partial unique index**，不要用 `(task_id, work_item_id)` 联合唯一（P-60）。
- 活动状态集合固定为 `queued / starting / running / waiting_input / unknown`（P-61），在代码中只定义一次（contracts 常量）。
- `teamwork_sessions.session_id` 唯一（P-68）。唯一索引放在 `152_teamwork_cutover.sql`，随 G4 切换执行（D-35）；在此之前 `sessions.bind` 在写入事务内检查。旧 Preview 数据中若已有重复，切换前需检查并记录；**不得**自动删除，冲突时 migration 失败并提示人工处理。
- `runs.listOutcomePending` / `markOutcomeApplied`（D-29）：终态 Run 的业务后果只应用一次。
- `teamwork_runs.applied_exec_seq`（D-46）：`runs.update` 不提供修改执行派生字段的通用入口，这些字段只能经 TW4 的 `projectFromExecution`，并以 `applied_exec_seq < $seq` 为条件更新。
- `teamwork_resources.lease_until`（D-47）：提供 `claimLease` / `commitOp`，两者都是单条条件 UPDATE。
- `commands` 唯一键为 `(scope_key, request_id)`，保存 `payload_hash`（D-33）；`commands.claim` 用 `INSERT ... ON CONFLICT DO NOTHING RETURNING` 原子占位，不要"先查后插"（D-40，P-154）。
- `resources` 保存 `op_id`、`op_attempt`、`secret_ref`、`replaced_by`，状态含 `uncertain / orphan_suspected`（D-34）。当前资源唯一性用两条 partial unique index，不用普通 UNIQUE（D-41，P-155）；`upsert` 的 ON CONFLICT 目标分别对应这两条索引；`replaceOrphan` 在同一事务内完成"旧行标孤儿 + 插入新行"。
- `teamwork_tasks.resource_state` 由 TW6 写，repo 只提供字段读写，不做推导（D-06）。
- 所有 repo 方法只接受调用方传入的 `tx`，不自行开事务；不在 repo 内做网络调用（I-14）。
- migration 文件名即身份，不得改名或改内容（P-66）。
- 不写旧 Preview 数据兼容层或推导（P-67）。

## 4. 测试

- 并发 `insertQueued` ×20（同 task 协调员）：只有一行成功。
- unknown 状态的 Run 存在时，再插入 queued 失败。
- 版本冲突、dedupe、session 跨任务绑定。
- 依赖环（A→B→C→A）被拒绝；跨 task 依赖被拒绝。
