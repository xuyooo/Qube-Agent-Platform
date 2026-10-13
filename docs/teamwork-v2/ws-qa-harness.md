# WS-QA · 测试基础设施与验收矩阵

从 M0 开始，与 PL1 并行。必读：`00-architecture.md §10`、`02-contracts.md §1 §2`。

## 1. 拥有的文件

`test/fakes/fake-agent-server/**`（新建）、`control-plane/e2e/teamwork/**`、`control-plane/src/services/execution/__contract__/**`（runtime 契约测试套件，供 PL2 各子流运行）。

## 2. Fake agent-server

实现 `02-contracts.md §2` 的完整 HTTP 契约，并通过控制端点注入故障：

| 能力 | 说明 |
| --- | --- |
| 脚本化 turn | 按脚本发出 `session.started`、`item.*`（含 tool_call）、`question.requested`、`session.ended{reason}` |
| 调用计数 | 统计每个 `dispatch_key` 真正开始执行的次数（验证 I-04） |
| 延迟与挂起 | 在任意事件之间延迟，或无限挂起但持续发送 keepalive（验证 P-07） |
| 断连 | 在收到请求前 / 响应头后 / 某事件后断开连接 |
| 重启 | 清空 registry，生成新的 `runtime_instance_id` |
| 拒绝 | 返回 503（容量）、500（fatal）、provider 错误 |
| 能力开关 | 关闭 `executionLookup / interruptConfirm / waitingInput` 等 |
| interrupt | 立即确认，或延迟确认，或只送达不终止 |

CP 侧崩溃点通过测试钩子注入（环境变量控制的 `crashAt(point)`，仅在测试构建中启用）。

## 3. Phase 0 故障注入（G1）

| ID | 场景 | 期望 |
| --- | --- | --- |
| F-01 | 同 key 并发 dispatch ×10 | 仅 1 次执行；其余返回 deduplicated；执行行的 `status / send_state / ended_at / failure` 从未被失败的竞争者改写（不会被写成 interrupted） |
| F-02 | CP 在 `send_state=sending` 提交后、HTTP 发出前崩溃 | 重启后对同一实例 fence 返回 `fenced` → `failed{not_accepted}`，可安全重试；fence 之后到达的迟到请求被 409 拒绝 |
| F-03 | CP 在 HTTP 发出后、`session.started` 前崩溃 | 重启后 lookup 找到 → 绑定并继续；不产生第二次执行 |
| F-04 | 同 F-03，但 agent 同时重启 | `unknown` |
| F-05 | 同 F-03，但 runtime 无 lookup 能力 | `unknown` |
| F-06 | CP 在 turn 中途重启，session 已知 | reconnect 并补齐事件；终态正确 |
| F-07 | 只发 keepalive、无进展 10 分钟 | `last_progress_at` 不更新 |
| F-08 | interrupt 只送达不终止 | `confirmed=false`，状态保持非终态 |
| F-09 | 503 容量拒绝 | `failed{admission, capacity_unavailable}` |
| F-10 | lifecycle handler 抛错 | 执行照常完成；重投递后 handler 幂等 |
| F-11 | 取消与发送并发 ×100（含 turn-gate 排队中取消、执行行尚不存在时取消） | 每次恰好一方获胜；取消获胜时 agent 收到 0 次请求 |
| F-12 | 执行已完成并产生副作用，CP 未保存终态，runtime 记录层已淘汰（超过 60 分钟或超过 1000 条） | fence 返回 `seen`，结论 `unknown`，不重试 |
| F-13 | runtime 只有 lookup、没有 fence，lookup 返回 404 | 结论 `unknown`，不重试 |
| F-14 | 发送到已重启的实例 | 412 `instance_mismatch`，未执行，结论 `not_accepted` |
| F-16 | 执行级中断契约，对四个 runtime 分别运行：五种结果（interrupted / delivered、execution_mismatch、ended、fenced、unknown）；`session.started` 之前中断；中断与下一轮 `/chat` 并发 ×100 | 结果与 `02 §2.4` 一致；与下一轮并发时，要么中断旧一轮、要么返回 mismatch，新一轮从不被中断 |
| F-17 | 旧一轮已结束后，cancel 与下一轮 prompt 紧挨着到达；目标完成与 cancel 写入交错（ACP / DSH，×100） | 新一轮**从不**被中断。**硬性闸门**：失败则该 runtime 的执行级中断不通过验收，必须改用方式 (c) 并重测；修改 capability 不能让它通过（D-53） |
| F-18 | 方式 (c)：锁内终止子进程后，下一轮到达 | 下一轮正常执行（重新拉起并 `loadSession`，或按 D-32 换新 Session）；被终止的只有目标一轮 |

另外：四个 runtime 运行同一套 contract test suite，输出一致的 Execution Facts；现有 chat（stream / async / sync）、scheduler、connector、call_agent 回归测试全部通过。

## 4. Phase 1A 验收（G2）

| ID | 场景 | 期望 |
| --- | --- | --- |
| A-01 | 创建 → start → 协调员 Run queued → CP 崩溃 → 重启 | 继续发送同一个 Run，不新建 |
| A-01a | claim 已提交、执行行尚未创建时崩溃 | 重启后该 Run 进入 redispatch，同一 dispatch_key 恰好发送一次 |
| A-01b | 执行行已创建、`send_state=not_sent` 时崩溃 | 同上 |
| A-01c | 在 turn-gate 排队中崩溃 | 同上 |
| A-02 | 完整闭环：协调员执行 → submit_review → 该 Run 结束 → in_review → owner accept → done | 各状态与事件正确 |
| A-03 | 重复点击 start / 同一 request_id 重放 | 一个状态转换，无重复 Run |
| A-04 | dispatch 身份不确定 | `execution_unknown`，无自动重试；retry / resume 被拒 |
| A-05 | resolve_execution 的三种结论 | 分别按 `ws-tw4 §5` 收敛 |
| A-06 | Run 长时间无进展 → probe 无法确定 | `suspected_stall`，不自动重跑、不中断，Run 保持占位 |
| A-07 | 确认的 pre-dispatch 瞬时失败 | 10s / 30s / 120s 自动重试，最多 3 次，之后 `execution_failed` |
| A-08 | turn 中 provider 错误且已有 tool 活动 | `manual_only`，不自动重试 |
| A-09 | pause 与完成事件竞态 | 停止意图优先；迟到结果不越过验收 |
| A-10 | pause 在 queued 与 dispatch 之间到达 | `not_accepted`，不发送 |
| A-11 | 协调员正常结束但未提交决策 | `blocked/no_decision` |
| A-12 | 协调员 turn 达到 20 次 | `blocked/budget_exhausted`；resume + 追加预算后继续 |
| A-13 | 两个会话同时 accept / rework | 一个成功，一个 409；不会验收旧结果 |
| A-14 | 结果文件提交后被改写 | accept 返回 `artifact_changed` |
| A-15 | AFS 第二步失败 / revoke 失败 | 记录保留、可重放、不静默丢失 |
| A-16 | 访问他人 task / session、伪造 Run、跨环境成员 | 请求被拒，且没有执行或挂载副作用 |
| A-10b | pause 在 dispatchOne 事务 2 复核提交之后、turn-gate 排队期间到达 | 执行以 `cancelled_before_send` 终止，fake agent 收到 0 次请求；Task 进入 `blocked/paused` |
| A-17 | lifecycle hook 先把 Run 写成终态，reconcile 之后才运行（包括 reconcile 延迟、重复投递） | 业务后果（重试排期、in_review 判定、成员 submitted）被应用恰好一次 |
| A-18 | 上一轮 Run 的 `teamwork_report` 在同一 Session 的下一轮 Run 启动之后到达 | 被拒绝并只记入历史；下一轮 Run 的结果与决策不受影响 |
| A-19 | AFS `createDir` 成功、写入 `resource_id` 前 CP 崩溃 | 行变为 `orphan_suspected` 并上报；重建新目录；Task 最终 ready |
| A-20 | AFS 挂载成功、写入 ready 前 CP 崩溃 | 按 TW6-0 结论重放或进入 `uncertain`，不静默当作成功 |
| A-21 | 另一个已认证用户重放相同的 task_id + request_id | 404，不返回缓存响应 |
| A-22 | 上一个 Run 经 `resolve_execution` 收敛后，旧 turn（fake agent 仍存活）调用 `teamwork_get_context` 再写入 | 新 Run 使用新 Session；旧 Session 上没有非终态 Run，写入被拒 |
| A-23 | submit_review 成功 → seal → in_review；seal 期间到达用户输入 | 不派发任何 Run；进入 in_review 后输入仍为未消费，在详情中可见 |
| A-24 | seal 失败 → retry → 成功；seal 中途 CP 重启 | 失败时 `blocked/resource_failed` 且保留 `pending_review_run_id`；retry 后重新 seal；重启后重放；只有全部 ro + ready 才进入 in_review |
| A-25 | 提交无效（缺少某项验收证据或产物 checksum 未算出） | `pending_review_run_id` 被清空，写 `task.review_rejected`，协调员被唤醒 |
| A-26 | 有未写进 workpad 的用户输入 / 返工说明时换新 Session | initial prompt 包含这些内容 |
| A-27 | 同一任务并发 `ensureTaskResources` ×10；孤儿替换与并发 ensure 交错 | 任何时刻恰好一个当前 share；fake AFS 记录的外部 `createDir` 调用次数为 1；最终挂载的目录就是当前 share 登记的目录 |
| A-29 | A 的 AFS 调用卡住直到租约过期，B 接手完成，A 随后迟到返回 | A 的 `commitOp` 影响 0 行；A 对自己创建的目录调用了 `revokeDir`；A 没有执行挂载；最终挂载的是 B 的目录 |
| A-30 | redispatch 交错：reconcile A 已发送 → 用户 pause → reconcile B 进入 dispatchOne 复核 | B 不直接写 Run 终态，而是走取消协议；发送方已获胜，Run 保持非终态，直到 runtime 确认停止后才进入 `blocked/paused` |
| A-31 | 发送前失败（admission 拒绝）后，同一 dispatch_key 再次被调用 | 执行保持 `failed`，不被改回 starting，不占 turn slot，返回原结果；重试产生新的 Run 与新的 dispatch_key |
| A-32 | 终态事件 seq=12 已投影并触发下一轮后，seq=11 的 running 事件首次到达；sweep 同时投影 | Run 不回退到非终态；不触发活动唯一约束冲突；`applied_exec_seq` 保持 12 |
| A-33 | 旧的 rw 挂载请求超时（fake AFS 挂起它） | 该行进入 `uncertain`；没有被租约过期接手；**seal 从未发出**；Task 停在 `blocked/resource_failed`，从未进入 in_review |
| A-33b | 同 A-33，旧 rw 请求分别在"探测显示不一致持续很久之后"、以及"人为模拟的验收时刻之后"才生效 | 系统在任何时刻都没有凭观察结果或等待时间解除 `uncertain`；从未发出新的 mutate_mount；从未进入 in_review |
| A-33c | `uncertain` 经两种证据之一解除（fake AFS 按序号拒绝 / 人工 `resolve_resource`） | 解除后按 `probeMounts` 决定完成或重新发起；之后 seal、in_review 正常 |
| A-33d | 旧 rw 请求延迟到 fuse-server 重启之后才送达新实例 | 系统不会因为实例变更就解除 `uncertain`；该行一直保持 `uncertain`，直到有上述两种证据之一；期间没有发出新的 mutate_mount，也没有进入 in_review。fake AFS 让延迟请求在新实例生效，断言后续探测能发现，并且 accept 被拒 |
| A-38 | 会话守卫：协调员 Session 在任务进行中，owner 或团队共享成员通过 Workspace chat / API chat / schedule 直接发 turn | 返回 `409 session_managed`；没有发送；没有 Run 之外的 turn；任务 done 后同样的请求被放行 |
| A-39 | Workspace 所有权转移：任务进行中尝试转移协调员 / 成员 Workspace；任务全部为终态后再转移 | 进行中时转移被拒并给出原因，DB 无任何变化；终态后转移成功，协调员任务的 owner 变为新 owner，不同 owner 的成员被移出并写 `participant.removed{workspace_transferred}`；teamwork 表只由钩子写入 |
| A-40 | 复用 Session 的 Run 遇到 `session_busy`（上一轮租约未释放 / 另一 replica 持有） | 归为 retryable，单独计数，按退避重试；不发送、不误判为容量不足 |
| A-37 | `resolve_resource` 权限：平台 admin 处理他人任务的资源故障；普通非 owner 用户调用；带旧 `op_id` 调用 | admin 成功，写 `actor_type=admin` 事件并通知 owner；非 owner 返回 404；旧 op_id 返回 409，不改变资源状态 |
| A-34 | resolve_execution（三种结论）→ CP 重启 → 该执行的旧事件再到达 | 结论经平台写入 `resolution`，Run 只经投影更新；重启后状态不变；旧事件不回退；下一个 Run 使用新 Session |
| A-35 | 上一轮已结束、同一 Session 已开始下一轮，此时一个迟到的取消请求到达 | 取消侧重新读取发现目标已终态，不调用 runtime；即使调用了执行级中断，也返回 `ended` 或 `execution_mismatch`；新一轮不被中断 |
| A-36 | 请求已发出、agent 尚未收到时调用执行级中断 | 返回 `fenced`；之后到达的 `/chat` 被 409 拒绝且不执行；结论 `not_accepted` |
| A-28 | 相同命令（同 request_id、同 payload）并发 ×10；并发 create ×10 | 恰好一次状态转换 / 一个 Task，10 个响应完全相同 |

## 5. Phase 1B UI（G3）

| ID | 场景 |
| --- | --- |
| U-01 | 七列横向排列，空列显示 0，窄屏可横向滑动 |
| U-02 | 列计数在分页和筛选下正确 |
| U-03 | 拖拽发出命令；运行中卡片不能拖入已完成；有键盘等价操作 |
| U-04 | 409 回滚乐观更新并说明原因 |
| U-05 | SSE 断线显示状态；重连后快照恢复 |
| U-06 | 深链接刷新可恢复 |
| U-07 | 关闭浏览器再打开，状态、历史、产物一致；运行不受影响 |
| U-08 | 只有展开 Sessions 页签才订阅 token 流 |
| U-09 | 问题回答回到原 session；用量缺失显示"未提供" |
| U-10 | 创建 → 开始 → 后台执行 → 关闭浏览器 → 再打开 → 查看产物 → 验收通过（E2E） |

## 6. Phase 1C 生命周期（G4）

| ID | 场景 | 期望 |
| --- | --- | --- |
| L-01 | 只上传 UI、未部署 server module，或协议不匹配 | 显示缺少能力 / 版本错误；不能 start |
| L-02 | 没有任何 Workspace MCP 配置 | 首页仍能发现 Teamwork；首个 tool 事件丢失不影响任务 |
| L-03 | drain 与 start 并发 | 边界由配置行锁决定；草稿不能新开始 |
| L-04 | 存在 blocked / unknown / in_review 时尝试 disable 或升级 | 被拒，并保留处理入口 |
| L-05 | stale UI、直接 API、通用插件管理接口的绕过尝试 | 一致拒绝，后台无新执行 |
| L-06 | 卸载、重装、模板更新 | 没有隐式数据删除；历史可读；已启动任务使用快照 |
| L-07 | 删除内置入口后（**在 WP-INT3 切换候选 PR 的预发部署上执行**，D-61） | 只有插件启用时才有入口；不存在两套 Teamwork |
| L-08 | draining 期间已授权任务 | 可以继续派发、续跑、返工、验收直至完成 |

## 7. Phase 2 多 Agent（G5）

| ID | 场景 |
| --- | --- |
| M-01 | 两个成员 WorkItem 并行执行 |
| M-02 | 依赖未满足的汇总项不提前派发 |
| M-03 | 只有一项失败时只重试该项 |
| M-04 | 成员 succeeded → submitted → 协调员 accept → done |
| M-05 | 多个成员结果合并为一次协调员唤醒 |
| M-06 | 循环依赖在写入时被拒绝 |
| M-07 | 一个成员等待输入，其他成员继续；Task 保持 in_progress + attention |
| M-08 | 换设备看到相同的子任务和会话关系 |
| M-09 | 没有任何用户输入：成员 succeeded → submitted → 协调员被唤醒 → accept → done；剩余项全部 blocked 时进入 `blocked/dependency` |
| M-10 | 仍有 submitted 未验收项时，协调员提交 `wait_for_items` 被拒 |

## 7.1 并发交错属性测试（D-42）

两轮评审发现的 P1 都出在并发交错上，靠文档评审很难找全。因此对三处核心判定做随机交错测试：

| 对象 | 纯函数提供方 | 事件集合 |
| --- | --- | --- |
| 执行核心：发送权 / 取消权 / 恢复判定 | PL1（PL1-4d） | dispatch（同 key 多个）、cancel、turn-gate 放行、HTTP 成功 / 断连、CP 崩溃重启、runtime 重启、fence、lookup |
| reconcile 判定 | TW3（TW3-7c） | reconcile（多个并发）、lifecycle hook（重复 / 乱序 / 丢失）、工具 report（含迟到）、pause / cancel / resume、seal 成功 / 失败、资源 ensure |
| 命令管线 | TW2 | 同一命令的并发与重放、不同 payload 复用 request_id、版本变化、lifecycle 变化 |

做法：

- 用内存模型驱动纯函数，每个场景随机打乱事件顺序，CI 中每个场景至少跑 500 个随机种子。失败时输出种子与事件序列，方便复现。
- 每一步之后断言：I-01～I-04、I-08、I-16～I-18、I-23、I-24、I-28～I-33。
- 事件集合中加入：同一 queued Run 被多个 reconcile 放入 redispatch、发送前失败后同 key 重放、lifecycle 事件乱序（旧 seq 晚到）、资源外部调用卡住直到租约过期。
- 编号：`PT-01` 执行核心、`PT-02` reconcile、`PT-03` 命令管线（`PT` 前缀与踩坑编号 `P-xxx` 区分）。
- G1 要求 PT-01 通过；G2 要求 PT-02、PT-03 通过。

## 8. 不变量测试映射

| 不变量 | 测试 |
| --- | --- |
| I-01 | A-01、TW3 并发 reconcile |
| I-02 / I-03 | TW1 并发 insert、unknown 占位 |
| I-04 | F-01～F-05、F-12～F-14 |
| I-05 / I-06 / I-07 | A-02、M-04、A-13 |
| I-08 | A-04 |
| I-09 | A-06 |
| I-10 | TW2 PATCH status 被拒、U-03 |
| I-11 | CP 重启时 `chat_status=idle` 不改变 Run（A-01 变体） |
| I-12 | worker 代码静态检查：不 import state-machine 或 repos 写方法 |
| I-13 | PL2 代码静态检查：不出现 teamwork 标识 |
| I-14 | 事务 helper 在事务内检测到网络调用时抛错（测试构建钩子） |
| I-15 | 在 COMMIT 前崩溃，队列无消息；COMMIT 后消息必达 |
| I-16 | A-03 |
| I-17 | A-09、迟到 report |
| I-18 | A-09、A-10 |
| I-19 | TW1 session 跨任务绑定被拒 |
| I-20 | F-10 |
| I-21 | A-16 |
| I-22 | L-05 |
| I-23 | A-17 |
| I-24 | F-11、A-10b |
| I-25 | A-18、A-22 |
| I-26 | A-21 |
| I-27 | F-12、F-13 |
| I-28 | A-23、A-24、PT-02 |
| I-29 | F-01、PT-01 |
| I-30 | A-27、PT-02 |
| I-16（并发） | A-28、PT-03 |
| I-31 | A-30、A-32、PT-02 |
| I-32 | A-31、PT-01 |
| I-33 | A-27、A-29、PT-02 |
| I-34 | A-33、A-36、PT-02 |
| I-35 | F-16、F-17、A-35、PT-01 |
| I-36 | A-33、A-33b、A-33c、PT-02 |
| I-37 | F-17、F-18、PL1-8c 用例 |
| I-36（实例变更不是证据） | A-33d |
| I-21（admin 例外清单） | A-37 |

## 9. 原则

- 使用真实 PostgreSQL 事务、约束和执行生命周期；只对 Agent 外部运行边界使用可控替身。
- UI 只做少量 E2E（创建到验收）。
- 每个闸门报告写明：运行命令、通过数、失败项、未覆盖项。
