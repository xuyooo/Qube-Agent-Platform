# WS-TW5 · Context、模板、Workpad、MCP 工具

Phase 1A（`plan_items / accept_item` 为 Phase 2）。必读：`02-contracts.md §5（ContextBuilder / TeamworkToolsRegistrar）§6 §9`；`ws-pl3-call-agent.md §3`；`90-pitfalls.md` P-03、P-26、P-54、P-80、P-82、P-90、P-92、P-103、P-104、P-106、P-116、P-128、P-129。

## 1. 拥有的文件

`plugins/teamwork/server/context.ts`、`tools.ts`、`scope-resolver.ts`、`templates.ts`；`plugins/teamwork/templates/default.json`；`plugins/teamwork/contracts/result.ts`、`template.ts`（与 CT 协作，冻结后由 TW5 维护内容）。

## 2. Workflow Template

```ts
export const WorkflowTemplate = z.object({
  id: z.string(),
  revision: z.number().int(),
  coordinator_instruction: z.string(),          // 流程规则（对应 Symphony WORKFLOW.md 正文）
  member_role_guidance: z.array(z.object({ role: z.string(), guidance: z.string() })),
  artifact_requirements: z.string(),             // 产物放哪、命名、格式
  acceptance_requirements: z.string(),           // 验收证据要求
  continuation_guidance: z.string(),             // 续跑 / 重试轮次说明
}).strict()
```

- `start` 时把完整模板内容写入 `workflow_snapshot`（不是引用）。后续续跑与返工只用快照；修改模板只影响新任务。
- 模板只提供领域内容，**不能**定义状态、脚本 hooks、递归图，也不能覆盖 owner、并发上限、停止与审批规则（P-129）。
- 快照只冻结协作模板，不锁定模型、第三方工具或 Workspace 配置，不承诺完全可复现（P-128）。
- 首版只提供一个默认模板。它在 `artifact_requirements` 中写明：多 Agent 改代码时各自 Workspace 使用独立 repo / worktree，只共享报告、patch 与产物引用（P-116）。
- QA 回归、调研、代码交付等模板放到 Phase 4。

## 3. Context 构建

**本轮上下文块**（initial 与 continuation **共用**，D-43）：

- 本轮 `run_ref`，以及"所有 Teamwork 写工具都必须带上这个值"的说明（`02 §9.1`）；续跑时注明上一轮的值已失效；
- 本轮 kind 与 attempt；
- 本轮预留的输入（按 `input_event_ids`）：用户补充说明、问题回答、成员结果与 blocked 报告；
- 返工说明（rework 时）、`task.review_rejected` 的原因（提交无效时）；
- 上次失败原因（retry 时）；
- 已接受的结果摘要（协调员：已 done 的 WorkItem；成员：依赖项结果）。

换新 Session 时（`02 §9.1`、`ws-tw3 §3`），这些信息可能还没写进 workpad，只在上一轮对话里出现过。因此 initial prompt 也必须带上这个块，否则会丢失本轮输入（P-156）。

**Initial prompt** = 完整任务背景 + 本轮上下文块。完整任务背景包括：

- `workflow_snapshot.coordinator_instruction`，或成员的 role guidance；
- Task：标题、目标（brief）、验收项（带 id）、优先级；
- workpad（plan / checklist / notes / env stamp）；
- 参与者名单（**来自 DB，不接受浏览器提交的名单**）；
- 可用产物路径：`/mnt/afs/team-<taskId>/inputs`、本 Run 的输出目录；
- 预算剩余；
- 必须使用的 Teamwork 工具与结束规则："本轮结束前必须调用 `teamwork_report` 提交 `next_decision`，或调用 `teamwork_submit_review`"。

**Continuation prompt**（D-18）= `continuation_guidance` + 本轮上下文块：

- 不重发完整任务背景，因为它已在 Session 历史中；
- Session 不可复用时（换 Session），改发 initial prompt。

渲染规则：严格变量检查，缺字段即抛 `PromptRenderError`，Run 失败，`failure.code=prompt_render`，分类为 `non_retryable`（P-104）。

**Workpad**（D-19）：结构化 JSON `{plan:[], checklist:[{id,text,done}], notes:[], env_stamp}`，通过 `teamwork_report(progress, workpad_patch)` 以 JSON merge patch 方式更新。它是跨 Session 续跑的记忆锚点；每轮 context 自动带入。

## 4. Scope resolver 与工具

- 实现 PL3 的 `McpScopeResolver{kind:'teamwork'}`：`X-Session-Token` → session → `teamwork_sessions` → task / work_item / role（权限只来自这里）。
- **写工具的 Run 归属用 `run_ref` 比对**（D-32，`02 §9.1`）：
  - 每个写工具的 schema 把 `run_ref` 设为必填；
  - 处理时取该 session 当前非终态 Run，不存在或 id 与 `run_ref` 不等 → 返回 `stale_run_ref`，写 `run.stale_write` 事件，不改变状态；
  - 不能直接把"session 的当前非终态 Run"当作调用者，因为续跑与重试会复用 Session，上一轮迟到的调用会被算到下一轮（P-142）。
- prompt 与 `teamwork_get_context` 都要给出本轮 `run_ref`，并明确要求所有写工具带上它。
- 拒绝时的提示只说"请先调用 `teamwork_get_context` 再重试"，不在错误信息里直接回显当前 `run_ref`。
- 找到 scope 时，`disabledTools = ['call_agent', 'get_agent_result']`（受管 Session 禁用自由派发）。
- 协调员与成员的 scope 分开：成员只能读取自己的 WorkItem、依赖结果与共享输入；不能提交编排决策（P-26）。
- 工具参数不接受 `task_id / owner_id / run_id`；没有活动 Run 时写操作返回结构化错误（P-82）。

工具行为细则：

| 工具 | 细则 |
| --- | --- |
| `teamwork_get_context` | 返回 `AgentContext`；只读 |
| `teamwork_report` | `progress`：更新 workpad。`blocked`：写原因，本轮结束后 reconcile 判定。`result`：写当前 Run 的 `result_json`（schema 校验，artifact 的 `sha256` 由 TW6 计算，Agent 提交的值被忽略）。协调员的 `next_decision`：`continue / wait_for_items / blocked`，写到当前 Run 的 `pending_decision`。`wait_for_items` 在以下情况拒绝：没有仍在推进的 WorkItem（P-106）；或仍有 `submitted` 未验收的 WorkItem，此时协调员必须先 accept / rework（P-153）。`consumed_input_event_ids` 必须是本 Run 已预留的子集；Run succeeded 时再写 `consumed_by_run_id`（P-90、P-92） |
| `teamwork_submit_review` | 校验 RunResult；每个 acceptance criterion 都必须有 check；写 `pending_review_run_id` 与 `pending_decision=submit_review`；**不立即**转 in_review（P-83） |
| `teamwork_plan_items`（Phase 2） | 创建 WorkItem 与依赖（调用 TW1 查环）；assignee 必须在 roster 中；设 `wait_for_items`；不派发 |
| `teamwork_accept_item`（Phase 2） | 必须带 `result_run_id` 且等于该 WorkItem 最新 submitted 结果；rework 时清空 `result_run_id`、置 ready、写 note 事件 |

- 成员不能再委派（P-103）。
- 用户补充输入不通过 pending message 发送（P-03），而是由 context 在下一轮带入。

## 5. 任务

| # | 任务 | Phase |
| --- | --- | --- |
| TW5-1 | 代码映射复核（`buildTeamworkContext` 的内容盘点） | 1A |
| TW5-2 | 模板 schema + 默认模板 + 快照 | 1A |
| TW5-3 | initial / continuation prompt 构建 | 1A |
| TW5-4 | scope resolver | 1A |
| TW5-5 | `get_context / report / submit_review` | 1A |
| TW5-6 | `plan_items / accept_item` | 2 |

## 6. 测试

- 缺字段渲染失败 → Run failed(non_retryable)。
- 迟到的 report 不改变状态。
- 换新 Session 时，initial prompt 包含本轮预留的用户输入、返工说明与失败原因，即使这些内容没有写进 workpad（A-26）。
- 仍有 `submitted` 未验收项时 `wait_for_items` 被拒（M-10）。
- 上一轮 Run 的 `teamwork_report` 在下一轮 Run（同一 Session）启动后才到达：被拒绝并只记入历史，下一轮 Run 的 `result_json` 与 `pending_decision` 不变（A-18）。
- 写调用缺少 `run_ref`：schema 校验失败，不改变状态。
- 活动轮内带错 `run_ref`：返回 `stale_run_ref`；模型调用 `teamwork_get_context` 后用正确值重试成功。
- 成员调用协调员工具被拒。
- 受管 Session 中调用 `call_agent` 返回结构化错误。
- `consumed_input_event_ids` 含未预留 id 时被拒。
