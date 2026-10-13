# 01 · 决策记录

V2.0（GPT handoff）、`teamwork-technical-proposal.md`（下称 TP）、`teamwork-architecture.md`（下称 ARCH）之间的冲突与缺口裁决。实施者遇到本表未覆盖的冲突时，停止并提交决策请求，不自行选择。

## 1. 已裁决

| ID | 主题 | V2.0 | TP / ARCH | V2.1 裁决 | 理由 |
| --- | --- | --- | --- | --- | --- |
| D-01 | 平台执行抽象 | Managed Execution 一级能力，未定义存储 | ARCH：从 executeChat 抽 primitive | 采用 Managed Execution，**新增平台表 `managed_executions`**，`dispatch_key` 唯一 | 没有平台表，执行事实会散落在 `teamwork_runs`，边界不成立 |
| D-02 | Run 与 Execution 的关系 | 1:1，`execution_id` 挂在 Run 上 | — | 1:1；`teamwork_runs.execution_id` FK → `managed_executions.id`；Run 状态由 Execution 事实投影，Run 另有业务字段 | 同一 dispatch_key 永远指向同一 execution |
| D-03 | dispatch_key 重发 | "发现 queued Run 继续 dispatch 同一 key" | ARCH：进程内去重，重启失效 | queued 且 `send_state=not_sent` 才可直接发送；`send_state=sending/sent` 按 `02 §1.5` 判定。~~同实例查不到即判未接受~~ 已由 D-30 修正：查不到一律 unknown，只有 fence 回执能证明未接受 | V2.0 I-04 表述过强，runtime 重启后去重记录丢失 |
| D-04 | WorkItem 状态 | 新增 `submitted` | TP：running + "待协调员确认" | 采用 `submitted` | 显式状态便于查询、约束与 UI |
| D-05 | 命令幂等 | 独立 `teamwork_commands` | TP：request_id 记在 events | 采用独立表，`(task_id, request_id)` 唯一；events 只记业务活动 | 幂等账本与审计流分离 |
| D-06 | 资源记录 | 独立 `teamwork_resources`，task 上仍有 `resource_state` | TP：task 上 `resource_state` + share 记录 | 采用独立表；`teamwork_tasks.resource_state` 保留为**派生汇总**，只由 TW6 写，永不作为判定依据 | 多成员挂载需要逐条记录与补偿 |
| D-07 | resolve_execution 结论名 | `bind_existing / confirmed_not_started / confirmed_terminated` | TP：`confirmed_not_accepted` | 使用 `bind_existing / confirmed_not_accepted / confirmed_terminated` | "请求已发但 runtime 未接受"比"未开始"更准确 |
| D-08 | resolve_execution 权限 | Owner / Admin | TP：仅 owner | owner；平台 admin 可执行，但必须写 `actor_type=admin` 事件并通知 owner | 运维需要，但要可审计 |
| D-09 | 重试分类 | `retryable / non_retryable / unknown` | ARCH：直接按 error 退避 | 四类：`retryable / manual_only / non_retryable / unknown`。`manual_only` = 执行已开始、可能有副作用、失败原因可能可重试，只允许 owner 手动 retry | 模型中途 provider 错误时工具可能已执行，不能自动重试 |
| D-10 | 自动重试节奏 | 10s / 30s / 120s | ARCH：`min(10s·2^(n-1), 5min)` | Phase 1A：固定 10s / 30s / 120s，最多 3 次，仅 `retryable`；Phase 3：可换指数退避并尊重 Retry-After | 1A 保守 |
| D-11 | stall | 1A 只检测，`suspected_stall` | ARCH：查询 → interrupt → retry | 1A：`now - last_progress_at > 10min` → `getManagedExecution(probe)`；确认 running 则保持；确认终态则收敛；无法确定则 Task `blocked/suspected_stall`，Run 保持非终态占位。不自动 interrupt、不自动 retry | 中断无法确认时会造成重复执行 |
| D-12 | waiting_input 超时 | 未定义 | Symphony：不得无限挂起 | `waiting_input` 不计入 stall；在 Task 内无其他可推进工作时 Task → `blocked/awaiting_input`，发通知；1A 不自动超时失败；Phase 3 增加可配置超时 | 等人不是故障 |
| D-13 | 插件协议 | `protocolMajor + capabilities` | TP：写请求精确版本匹配 | 采用 `protocolMajor + capabilities`；写请求携带 `X-QAP-Teamwork-Protocol: <major>`，major 不同拒绝写；缺 capability 关闭对应功能 | 允许 UI 在同 major 内独立发布 |
| D-14 | Phase 划分 | 0 / 1A / 1B / 1C / 2 / 3 | ARCH：P0–P4 | 采用 V2.0 划分；ARCH 的 P4（外部 tracker、更多模板）记为 Phase 4 | 可靠性先于 UI |
| D-15 | pending_message 自动续发 | 未提及 | — | Managed Teamwork Session **禁用** `drainPendingMessage` 自动续发；用户补充输入写 `teamwork_events(user_input)` 并触发 reconcile | 否则会在 Run 之外产生无账本的 turn |
| D-16 | scheduler 身份 | 未提及 | TP：服务身份 | teamwork worker 使用服务身份（`/svc/v1` service secret）调用 CP 内部 reconcile 端点；不复用 `JobData.service_token` 用户令牌模式 | 用户令牌可能过期或被撤销，不应决定后台对账 |
| D-17 | 协调员派发资格 | 只列唤醒事件 | TP / ARCH：明确条件 | 采用 TP 规则（见 `ws-tw3`），并增加：正常结束但无 `pending_decision` → `blocked/no_decision` | 防止空转续聊 |
| D-18 | 续跑 prompt | 未提及 | ARCH：续轮只发续跑指引 | `continue` / `retry` Run 复用 Session，只发续跑指引 + 新输入摘要；Session 不可用时换新 Session 并发完整上下文 | Symphony 经验 |
| D-19 | workpad | 未提及 | ARCH | 保留，`teamwork_tasks.workpad` JSON；Phase 2 起 WorkItem 也有 `workpad` | 跨 Session 进度锚点 |
| D-20 | 单 CP | 未提及 | TP / ARCH | 明确单活 CP 前提，写入部署检查 | turn-gate 进程内实现 |
| D-21 | 外部 tracker | 未提及 | ARCH：扩展点 | Phase 4，本轮只在 contracts 中预留类型，不实现 | 避免双写 |
| D-22 | 成员范围 | 未提及 | TP：同 owner 同环境 | 采用 TP：协调员与成员同 owner、同 AFS 可共享环境。当前 Preview 允许加入他人 public Workspace，V2 **有意收窄** | AFS 是 Workspace 挂载权限，不是 Session ACL |
| D-23 | done 后 | — | TP：不重新打开 | done / cancelled 不重新打开；后续工作新建任务并记录 `source_task_id` | 验收版本不可变 |
| D-24 | 计划确认关卡 | — | TP：不设 | 不设；start 即授权在目标与 roster 内工作，最终验收仍由 owner | 减少打断 |
| D-25 | 看板卡粒度 | 一张卡一个 Task | TP 同 | 一张卡一个 Task；WorkItem 在详情 | 避免内部卡淹没目标 |
| D-26 | Phase 1A 无 WorkItem 时的完成 | — | TP：协调员可直接提交 | 允许协调员直接 `submit_review`，不强制拆 WorkItem | 单协调员闭环 |
| D-27 | 旧数据 | — | TP：不写兼容层 | 不写兼容层、不自动迁移、不清库；migration 对旧行给默认 `status='backlog'`；是否处置旧 Preview 数据是部署前单独决策 | 不假设可清空生产库 |
| D-28 | 删除 Task | 当前 Preview：DELETE 同时 teardown AFS | TP：归档不删 | V2 不提供硬删除 API；`archive` 只隐藏；永久删除与保留期另行设计 | 保留审计与恢复证据 |

## 1.1 V2.2 评审修订（2026-09-28）

来源：对 V2.1 的外部设计评审，共 7 项。全部采纳。其中 #4、#6 经代码核对后，问题比评审描述的更具体（见 P-142、P-143）。

| ID | 评审项 | 结论 | 修订 | 影响文件 |
| --- | --- | --- | --- | --- |
| D-29 | #1 终态 Run 可能永远不触发业务推进 | 成立。hook 先写终态，reconcile 只读非终态 Run，`newly_terminal` 永远为空 | `teamwork_runs.outcome_applied_at` + 待处理索引；reconcile 读取 `listOutcomePending`，业务转换与标记同事务；新增 I-23、A-17 | 02 §4 §5、ws-tw3、ws-tw4 |
| D-30 | #2 registry 淘汰与"404 可安全重试"冲突 | 成立 | 404 一律 unknown；registry 分记录层与键集合层；新增 fence 端点作为唯一"未接受"证据；`/chat` 绑定 `expected_runtime_instance_id`，不一致返回 412 且不执行；新增 I-27、F-12～F-14 | 02 §1.5 §2、ws-pl1、ws-pl2、ws-tw4 |
| D-31 | #3 暂停检查后仍可能发送 | 成立。事务 2 复核之后还有 prompt 构建与 turn-gate 排队两个窗口 | 发送权在 turn-gate 之后以条件 UPDATE 取得；取消以同一条件竞争，只有一方获胜；取消可作用于尚不存在的执行行（墓碑）；新增 I-24、F-11、A-10b | 02 §1.1 §1.2 §1.6、ws-pl1、ws-tw3 |
| D-32 | #4 Session 复用导致迟到工具调用写入下一轮 | 成立，且代码中更明确：token 按 session 复用，ACP 在 session 创建时固化 headers | **V2.2.1 修订**：主方案为 `run_ref` 比对：CP 在 prompt 中下发本轮 Run id，写工具必须带回，与 session 当前非终态 Run 不一致即拒绝。兜底：终态不确定的 Run 之后换新 Session。**不改 agent-server**，不加 execution token、hop、turn 屏障，也不加 CP 派发屏障。删除 `sessionTokenScope`；更新 I-25、A-18、A-22 | 02 §2.3 §5 §9.1、ws-tw3、ws-tw5 |
| D-33 | #5 重放先于授权 | 成立 | 授权先于重放；重放仍先于 lifecycle 与 version；幂等范围改为 `scope_key`（create 为 `user:{id}:create`）；保存 `payload_hash`，不同 payload 返回 422；新增 I-26、A-21 | 02 §4 §7 §8、ws-tw2 |
| D-34 | #6 AFS 回执丢失 | 成立。`createDir` 无幂等键、无 lookup，`accessKey` 只返回一次 | 不再宣称每步幂等；逐步列出恢复能力；调用前持久化 `op_id`；返回后立即写 `resource_id / secret_ref`；回执丢失的目录标 `orphan_suspected` 并重建；挂载幂等性由 TW6-0 先验证；新增 `uncertain` 状态、A-19、A-20 | 02 §4、ws-tw6 |
| D-35 | #7 G2–G4 切换计划自相矛盾 | 成立 | G4 之前新实现只在测试装配（`control-plane/e2e/teamwork/app.ts`）中运行，生产只挂载旧实现；G4 一个原子切换 PR 同时替换路由、worker、MCP resolver、UI 入口并删除旧实现；session 唯一索引推迟到切换 migration 146 | 03 §4、ws-tw1、ws-tw9、02 §12 |

## 1.2 V2.2.2 评审修订（2026-09-28）

来源：对 V2.2.1 的第二轮外部设计评审，共 4 个 P1、3 个 P2，全部采纳。`run_ref` 加换新 Session 的方向保留，不重新引入 execution token。

| ID | 评审项 | 修订 | 影响文件 |
| --- | --- | --- | --- |
| D-36 | P1 #1 发送权竞争失败被当成取消 | UPDATE 影响 0 行后重新读取：另一方已取得发送权 → 返回已有执行；已取消 → 返回 interrupted；取消已表态未落终态 → 本方补写取消；失败方不写执行状态。增加同 key 进程内 singleflight（只是优化）。新增 I-29、P-150；F-01 增加"未被改写"断言 | 02 §1.6、ws-pl1、ws-qa |
| D-37 | P1 #2 queued Run 没有恢复派发 | reconcile A 段把"queued 且执行不存在或 not_sent"的 Run 放入 redispatch，复用原 dispatch_key，重新经过 epoch 复核与发送权竞争。依赖 D-36。新增 P-151、A-01a～c | ws-tw3 |
| D-38 | P1 #3 in_review 与 seal 互相等待 | 拆成两步：提交有效 → seal → 确认 ro 后进入 in_review。两步之间不派发（I-28）；提交无效则清空 pending_review_run_id 并写 `task.review_rejected` 唤醒协调员；seal 失败 → `blocked/resource_failed` 且保留提交；seal 覆盖所有执行方（1A 含协调员，P-157）。新增 A-23～A-25 | 02 §3.1 §3.5 §11、ws-tw3、ws-tw6 |
| D-39 | P1 #4 `wait_for_items` 死锁 | 统一定义"未处理输入"（用户输入、submitted 结果、成员 blocked 报告、review_rejected）；只有没有未处理输入且仍有推进中的工作时才等待；剩余项全部 blocked → `blocked/dependency`；有 submitted 未验收时拒绝 `wait_for_items`。新增 P-153、M-09、M-10 | ws-tw3、ws-tw5 |
| D-40 | P2 #5 并发重放拿到不同响应 | 事务内原子占位 `INSERT ... ON CONFLICT (scope_key, request_id) DO NOTHING RETURNING`；并发同 key 事务阻塞在唯一索引上；拒绝结果也写入 `result_json`；create 走同一机制；修正 §8 步骤编号。新增 P-154、A-28、PT-03 | 02 §5 §8、ws-tw1、ws-tw2 |
| D-41 | P2 #6 资源唯一约束管不住 NULL | 两条 partial unique index（task 级 / workspace 级），排除 `orphan_suspected`；`replaced_by` 字段；孤儿替换同一事务；released 行原地复用。不用 `NULLS NOT DISTINCT`。新增 I-30、P-155、A-27 | 02 §4 §5、ws-tw1、ws-tw6 |
| D-42 | 评审之外的补充：并发交错属性测试 | PL1、TW3、TW2 的核心判定写成纯函数；QA 对三者做随机交错测试（每场景 ≥ 500 种子）；G1 要求 PT-01，G2 要求 PT-02、PT-03 | ws-qa §7.1、ws-pl1、ws-tw3、03 §4 |
| D-43 | P2 #7 换新 Session 丢本轮输入 | initial 与 continuation 共用"本轮上下文块"：run_ref、预留输入、返工说明、review_rejected 原因、失败原因、已接受结果摘要；initial 另加完整背景。新增 P-156、A-26 | ws-tw5 |

## 1.3 V2.2.3 评审修订（2026-09-28）

来源：对 V2.2.2 的第三轮外部设计评审，共 3 个 P1、1 个 P2，全部采纳。其中三条根因相同：多个地方直接写执行或 Run 状态，而且没有"终态不可回退"的约束。因此合并为三条统一规则（R1～R3），而不是逐条打补丁。

| ID | 评审项 | 修订 | 影响文件 |
| --- | --- | --- | --- |
| D-44 | P1 #1 redispatch 失效时直接写 not_accepted | 失效分支与 prompt 渲染失败都改走 `interruptManagedExecution`（新增 `asFailure` 选项）；Run 状态只由投影得出。新增 P-158、A-30 | ws-tw3、02 §1.1 |
| D-45 | P1 #2 终态 not_sent 执行能被同 key 重启（**R2**） | 步骤 1 先判终态；发送权与取消 UPDATE 都加 `status='queued'`；`managed_executions` 所有写入路径都遵守非终态条件与 `last_seq` 单调；终态后同 key 只读。新增 I-32、P-159、A-31 | 02 §1.6、ws-pl1 |
| D-46 | P1 #3 事件乱序回退（**R1**） | `projectFromExecution` 作为 Run 执行派生字段的唯一写入口：读取执行当前行，`applied_exec_seq` 单调，终态不回退；hook 只当唤醒信号；hook、reconcile、sweep 共用。新增 `teamwork_runs.applied_exec_seq`、I-31、P-160、A-32 | 02 §4 §5、ws-tw3、ws-tw4 |
| D-47 | P2 #4 行唯一不等于外部操作一次（**R3**） | 资源外部操作领租约（`lease_until` + `op_id`）；AFS 调用超时小于租约；只有租约过期才判孤儿；`commitOp` 校验 op_id 与 `replaced_by`，过期操作回收自己创建的目录且不继续后续步骤；A-27 改为断言外部调用次数与最终挂载目录。新增 I-33、P-161、A-29 | 02 §4 §5、ws-tw6、ws-qa |

## 1.4 V2.2.4 评审修订（2026-09-28）

来源：对 V2.2.3 的第四轮外部设计评审，3 个 P1，全部采纳；中断契约吸收了 astra 的补充方案。三条的共同点是 DB 状态与外部执行之间的确认边界，归并为 **R4**（I-34）。

| ID | 评审项 | 修订 | 影响文件 |
| --- | --- | --- | --- |
| D-48 | P1 #1 租约挡不住迟到的挂载请求（**R4**） | 外部操作分两类：`create_object`（createDir）可凭租约过期接手并回收迟到结果；`mutate_mount`（mount / seal / 恢复 rw / unmount / revoke）不确定时进入 `uncertain`，不能凭租约过期接手，必须观察实际状态。seal 完成与 accept 都以 `probeMounts` 的观察结果为准；in_review 期间 sweep 周期探测。探测方式见 Q-09，长期方案见 Q-07。新增 P-162、A-33 | 02 §4 §5、ws-tw6、ws-tw2 |
| D-49 | P1 #2 resolve_execution 与 R1 没有接通 | 平台新增 `resolveManagedExecution`，作为执行行唯一的人工写入路径：写 `resolution`，`last_seq + 1`，按 R2 条件转为终态；bind_existing 先 probe，其他结论先发执行级中断。`resolve_execution` 命令改为异步：写 `pending_resolution`，由 reconcile 在事务外调用平台，Run 经投影更新。新增 P-163、A-34 | 02 §1.1 §1.2 §4 §8、ws-pl1、ws-tw2、ws-tw3、ws-tw4 |
| D-50 | P1 #3 取消 0 行被当成在途，session 级中断误伤下一轮 | 取消侧 0 行后重新读取，已终态不调用 runtime。agent-server 提供**执行级中断**：`POST /executions/:key/interrupt`，外加 session 路由的 `expected_dispatch_key` 兼容入口，两者同一实现。原子地匹配执行身份并中断被匹配那一轮的句柄；五种结果：interrupted / delivered、execution_mismatch、ended、fenced、unknown。claude-code 用每轮 AbortController；ACP / DSH 用 session 级互斥锁；每个 runtime 实测"迟到的 cancel 是空操作"。~~不通过则声明 `interruptConfirm=false`~~（已由 D-53 修正：隔离失败不能降级，必须改用锁内终止子进程）。新增 I-35、P-164～P-167、F-16、F-17、A-35、A-36 | 02 §1.6 §2 §2.4、ws-pl1、ws-pl2 |
| D-51 | 统一规则 R4 | "对外部系统的写操作，要么在外部按操作身份定位和隔离，要么在结果不确定时标记为 uncertain，直到观察到实际状态再继续。DB 条件写入不能替代外部确认。"新增 I-34 | 00 §10 |

与 astra 中断方案的对照：采纳其五种结果语义（原方案只有两种）和"捕获被匹配那一轮句柄"的实现约束；寻址方式改为以 dispatch_key 为主，因为 `session.started` 之前没有 session_id；保留 session 路由作为兼容入口。另外补充了各 runtime 取消句柄粒度的差异，以及实测要求。

## 1.5 V2.2.5 评审修订（2026-09-28）

来源：对 V2.2.4 的第五轮外部设计评审，2 个 P1，全部采纳。这两条都是 2.2.4 自己引入的捷径（"观察一段时间没变化就当旧请求已失效"、"实测不过就降级 capability"），它们违反了刚确立的 R4。整体架构不变。

| ID | 评审项 | 修订 | 影响文件 |
| --- | --- | --- | --- |
| D-52 | P1 #1 观察窗口不能证明旧请求失效 | 删除按观察窗口自动恢复的规则；`probeMounts` 只证明当前状态。`uncertain` 只凭证据解除：AFS 序号拒绝（Q-07）、~~fuse-server 实例已变更~~（已由 D-55 移除）、人工 `resolve_resource`。同一挂载点存在 `uncertain` 时禁止任何新的 mutate_mount，所以 seal 不会发出，也不会进入 in_review。新增命令 `resolve_resource`、I-36、P-168、A-33b、A-33c | ws-tw6、02 §8、ws-qa |
| D-53 | P1 #2 隔离失败不能降级为 `interruptConfirm=false` | 隔离性与可确认性拆成两个能力：`interruptTargeted`（安全前提）与 `interruptConfirm`（活性）。隔离方式三选一：(a) 每轮句柄；(b) 协议 cancel 且 F-17 通过，交错时发 prompt 前重建子进程；(c) 锁内终止子进程（兜底）。F-17 为硬性闸门，失败必须改用 (c)，不能改 capability 过关。`interruptTargeted=false` 的 runtime 拒绝托管派发。新增 I-37、P-169、P-170、F-18、PL1-8c | 02 §1.1 §2.4、ws-pl1、ws-pl2、ws-qa、03 §4 |
| D-54 | R4 补充 | "等待时间不是证据；降级 capability 不能代替满足安全性。"写入 I-34 | 00 §10 |

## 1.6 V2.2.6 评审修订（2026-09-28）

来源：对 V2.2.5 的第六轮外部设计评审，1 个 P1、1 个 P2，全部采纳。评审结论是：完成这两处修订后，可以进入 M0 契约冻结与 Phase 0 实施。

| ID | 评审项 | 修订 | 影响文件 |
| --- | --- | --- | --- |
| D-55 | P1 #1 fuse-server 实例变更不足以证明旧请求不会生效 | 移除"实例变更"自动证据。资源恢复基线只有两种证据：AFS 服务端操作序号、人工确认。将来要启用实例变更，必须同时满足三个前提：请求携带目标实例身份、新实例拒绝旧请求且无副作用、上游不重放。人工确认也不能只凭"已重启 sidecar"，执行人需写明旧请求已无法送达的依据。新增 P-171、A-33d | ws-tw6、00 §10、ws-qa |
| D-56 | P2 #2 `resolve_resource` 的 admin 权限未同步到授权规则 | 在 `ws-tw2 §4` 建立唯一的 admin 例外清单（`resolve_execution`、`resolve_resource`、插件命令），`02 §8` 引用它而不另行列举；admin 操作写 `actor_type=admin` 事件并通知 owner。新增 P-172、A-37 | ws-tw2、02 §8 |

## 1.7 V2.2.7 派发化（2026-09-28）

来源：自查"2.2.6 是否已经是可以由多 Agent 并发执行的子任务"。结论是工作流一级已经具备，任务一级还不能直接派发，而且 ports 落后于 2.2.x 的修订。

| ID | 主题 | 修订 | 影响文件 |
| --- | --- | --- | --- |
| D-57 | ports 与 2.2.x 修订不一致（阻塞 M0） | `ExecutionPort` 补 `resolveManagedExecution`；`RunLifecycle.resolveExecution(tx, …)` 拆成 `requestResolution`（事务内）与 `applyPendingResolution`（事务外），消除与 D-49 的冲突；`ResourceManager.continueAfterResolve`；`resources.resolveUncertain`；资源状态增加 `resolved`。规定以后任何契约 RFC 必须在同一 PR 内同步 `02 §5`（P-173） | 02 §4 §5、ws-tw2、ws-tw3、ws-tw4、ws-tw6 |
| D-58 | 派发单位与 PL1 拆分 | 派发单位改为工作包（WP），由 `04-task-board.md` 统一索引：开工依赖 / 集成依赖 / 只写文件 / 完成标准 / 规模 / 波次。PL1 按文件拆成 5 个 WP（热点文件只归 PL1b 与 PL1c），PL1b 提供转发桩，让 PL1c / PL1d 不必修改 `service.ts`。补齐 CT、QA、INT、TW9 的 WP；规定共享 fake 只由 CT / QA 提供 | 04、03 §5 §6.1、README |

## 1.8 V2.2.8 任务板闭环（2026-09-28）

来源：对 2.2.7 任务板的外部评审，3 个 P1，全部采纳。自查又发现 3 处同类问题：TW2b 引用了 QA5 的 PT-03；PL1b～d、PL2d～f 把真实 runner 标成了"可先用 fake"；多个 WP 直接引用了只有闸门才能运行的 A / L 场景。另有一处漏项：插件 Web bundle 构建没有归属。根因相同：WP 的完成标准引用了后续 WP 才提供的测试或装配。因此定一条统一规则 R-WP。

| ID | 评审项 | 修订 | 影响文件 |
| --- | --- | --- | --- |
| D-59 | P1 #1 PL1b 验收依赖 PL1d；以及同类问题 | **R-WP**：依赖分为开工 / 合入 / 闸门三类；完成标准只用"开工 + 合入依赖"范围内能运行的测试；卡片中的 A / L / M 场景指 fake 级变体。PL1b 只验收执行核心，F-11 移到 PL1d 与 G1；桩期间生产入口不得调到桩方法，旧 interrupt 路由由 PL1d 切换、旧恢复流程由 PL1c 切换。PT-03 从 TW2b 移到 QA5；QA1 / QA2 改为相关 WP 的合入依赖。新增 P-174 | 04 §3 §5 §7 |
| D-60 | P1 #2 缺少完整装配 | 新增 WP-INT4（`registerTeamwork` 完整装配，`ExecutionPort` 等依赖注入，测试与生产共用）和 WP-INT4b（注册 plugin guard）；QA4 只调用 INT4，不另写装配；INT3 的生产入口调用同一个函数。插件 Web bundle 构建归 TW8a。关键路径变为 TW 链约 22 天，到 G2 约 26.5 天 | 04 §5.1 §5.3 §5.4 §6 §7、03 §4.2 |
| D-61 | P1 #3 QA7 → G3 → INT3 循环 | QA7 拆为 QA7-U（→ G3）与 QA7-L。L-01～L-06、L-08 在切换前于测试装配中执行；L-07 与切换 / 回滚演练在 INT3 **候选 PR** 的预发部署上执行，通过即 G4，之后才合并 INT3 | 04、03 §4、ws-tw9、ws-qa |

## 1.9 V2.2.9 派发前修正（2026-09-28）

来源：对 2.2.8 的外部评审，1 个 P1、1 个 P2，全部采纳。评审结论：修正后可以进入 M0 契约落地与首批工作包派发。

| ID | 评审项 | 修订 | 影响文件 |
| --- | --- | --- | --- |
| D-62 | P1 M0 契约编译依赖 M0 之后才创建的 `Tx` | `Tx` / `WithTx` 类型移入 `contracts/tx.ts`，由 CT2 交付；TW1a 的 `db/tx.ts` 只实现 helper。自查同类问题：ports 引用的全部 Row / Input / Outcome 类型都明确归 CT2；ports.ts 只能从 contracts 与 `internal/types` 导入，并加检查。顺带修正：契约中的 `@qap/types/...` 路径别名在仓库中不存在，改为相对路径。新增 P-175 | 02 §5、04 WP-CT2 / WP-TW1a、ws-tw1 |
| D-63 | P2 03 的线性合并顺序与任务板冲突 | 删除 `03 §6` 的线性合并顺序，合并顺序统一以 `04` 的开工 / 合入依赖为准；Phase 与闸门只定义验收顺序。分支命名统一为按 WP（`tw2/<wp-id>-<slug>`） | 03 §6 |

### 1.3.1 架构一致性复核（截至 2.2.9）

三轮评审共做了 22 项修订。逐项对照 V2.0 / V2.1 确立的架构决定：

| 架构决定 | 状态 | 说明 |
| --- | --- | --- |
| 平台管"执行如何可靠发生"，Teamwork 管"哪些执行应该发生、对业务意味着什么" | 未变，边界更清楚 | 工具调用归属改用 `run_ref` 放在 Teamwork 层（D-32），平台与 agent-server 仍然不感知 Task / Run（I-13） |
| Task → WorkItem → Run → Managed Execution → Session 分层 | 未变 | Run 的执行派生字段改为从 Execution 投影（R1），这是对"Run 与 Execution 1:1、事实来自平台"（D-02）的落实 |
| reconcile 是唯一自动推进器；先 claim 后 dispatch；网络调用不持事务 | 未变 | 恢复派发（D-37）、失效走取消协议（D-44）、资源租约（D-47）都在这个模型内，租约也不持有事务 |
| 不确定就停（unknown → 人工 resolve） | 未变，更严格 | 404 不再算证据（D-30），终态吸收（R2），外部操作不确定时标记 uncertain（R4）；人工 resolve 也经平台写入（D-49） |
| agent-server 不理解 Teamwork（I-13） | 未变 | 执行级中断与 fence 都只使用平台已有的 dispatch_key 执行身份（D-50） |
| 插件形态：Web bundle + 第一方 server module + 模板；lifecycle 独立 | 未变 | 切换方式改为测试装配 + G4 原子切换（D-35），属于交付计划，不是架构 |
| 七列 Kanban、详情、SSE 只做失效通知 | 未变 | 评审没有涉及 |
| Phase 0 → 1A → 1B → 1C → 2 → 3 与闸门 | 未变 | 闸门的测试清单扩大，并增加属性测试 |
| 单活 CP 前提 | 未变，依赖更多 | singleflight、turn-gate、进程内资源互斥都依赖它。它们只是优化，正确性由 DB 条件保证，但多 CP 时仍需整体复核 |

结论：**没有架构偏离**。所有修订都在并发与恢复协议这一层，即"同一个边界上如何保证正确"，没有改变组件划分、职责归属或数据流向。

有变化的是契约的**规模**：Managed Execution 契约从 V2.0 的 4 个函数，增加了发送权 / 取消权竞争、fence、实例绑定、终态吸收、人工 resolve、执行级中断；不变量从 14 条增加到 35 条。这是把"可靠执行"真正写清楚的代价，不是方向改变。

四轮评审的问题逐轮收窄：

| 轮次 | 问题层级 |
| --- | --- |
| 第一轮 | 边界级：执行身份、切换计划、授权 |
| 第二轮 | 流程级：恢复派发、两步验收、等待死锁 |
| 第三轮 | 修复之间的组合交错：R1～R3 |
| 第四轮 | DB 与外部系统的确认边界：R4 |
| 第五轮 | R4 的执行纪律：不能用等待时间或降级 capability 绕过 R4 |
| 第六轮 | R4 的证据标准（组件实例变更不是证据）与一处权限清单不同步；评审结论：修订后可冻结 M0 |

截至 2.2.5，四条统一规则 R1～R4 覆盖了已知的全部并发与恢复问题类别；第五轮没有出现新的问题类别，只是纠正了违反 R4 的两处捷径。不变量共 37 条。后续评审建议只针对 R1～R4 的组合进行；剩余的交错问题交给 PT-01～PT-03 属性测试与 G1 / G2 闸门。

## 2. 未决问题（不阻塞 Phase 0 / 1A）

| ID | 问题 | 默认假设 | 需要谁决定 |
| --- | --- | --- | --- |
| Q-01 | 多 CP 副本的时间表 | 本轮不支持 | 平台负责人 |
| Q-02 | Phase 3 是否允许按 runtime capability 自动 stall 恢复 | 仅 `interrupt=true && executionLookup=true` 的 runtime | 平台 + Teamwork |
| Q-03 | 跨用户 Teamwork | 不做 | 产品 |
| Q-04 | 产物保留期与永久删除 | 不自动删除 | 产品 + 合规 |
| Q-05 | Jira / GitLab 导入是否提前 | Phase 4 | 产品 |
| Q-06 | 预算是否引入 token / 费用上限 | 1A 只有 turn 与重试次数 | 产品 |
| Q-07 | AFS 服务端是否支持：调用方幂等键（`CreateDir{client_op_id}`）、按名称查询、**按操作序号拒绝过期的挂载请求**。前两项用于消除孤儿目录，最后一项从根本上解决 P-162 | 1A 接受孤儿目录泄漏；挂载不确定时走 `uncertain` + 观察 | AFS 负责人 |
| Q-08 | fence 键集合上限 200,000 是否足够；超出后是否需要按时间分段 | 超出即 `not_authoritative` | 平台 |
| Q-09 | 实际挂载状态怎么观察（`probeMounts`）：fuse-server 状态 RPC，或 agent-server 读取 `/proc/mounts`。另：将来能否满足"实例变更"作为自动证据的三个前提（D-55） | TW6-0 调研后决定。在 Q-07 到位前，`mutate_mount` 超时一律人工 `resolve_resource` | AFS 负责人 + 平台 |
