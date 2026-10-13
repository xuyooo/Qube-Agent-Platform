# WS-PL2 · agent-server 执行身份与查询

Phase 0。拆为三个互相独立的子流，可由三个 Agent 同时实现：

| 子流 | 范围 | 拥有的文件 |
| --- | --- | --- |
| PL2a | Claude Code | `agents/claude-code/**` |
| PL2b | ACP 公共骨架 + Codex + Goose | `internal/acp-adapter/**`、`agents/codex/**`、`agents/goose/**` |
| PL2c | DSH | `internal/dsh-adapter/**`、`agents/dsh/**` |

必读：`02-contracts.md §1.1（RuntimeExecutionCapabilities）§2`；`90-pitfalls.md` P-10、P-13～P-17。

## 1. 目标

让每个 runtime 在**不知道 Task / WorkItem / Kanban（I-13）**的前提下，提供：

1. `dispatch_key` 去重：同一实例内同 key 不启动第二次执行；
2. 按 `dispatch_key` 查询执行状态；
3. `runtime_instance_id`：进程级唯一，重启必变；
4. 可确认的 interrupt 结果；
5. 能力声明。

## 2. 共同实现规格

```ts
// 每个 server 内部
interface DispatchRecord {
  dispatchKey: string
  sessionId: string | null
  status: 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'interrupted'
  startedAt: string
  endedAt: string | null
}
const RUNTIME_INSTANCE_ID = crypto.randomUUID() // 模块加载时生成
```

- Registry：`Map<dispatchKey, DispatchRecord>`；结束后至少保留 60 分钟，总量上限 1000，只淘汰已结束条目。
- `POST /chat` 收到已存在的 `dispatch_key`：返回 `409`，body 为当前记录与 `runtime_instance_id`；**绝不**再次调用 SDK / 子进程。
- 请求体没有 `dispatch_key` 时，行为与现在完全一致（兼容非托管调用方）。
- `session.started` 事件附带 `dispatch_key` 与 `runtime_instance_id`（可选字段）。
- `GET /executions/:dispatch_key`：命中返回 200；未命中返回 `404 {runtime_instance_id}`。
- `POST /sessions/:id/interrupt`：响应 `{delivered, confirmed}`。`confirmed` 只在 turn 已确认终止时为 true；若 interrupt 发出后需要等待，最多同步等待 5s，超时返回 `confirmed:false`。
- `GET /info`：`runtime_instance_id` 与 `capabilities.execution`。
- 断线 buffer 模式（SessionSink / acp-server）保持：客户端断开时执行继续，registry 状态继续更新。

## 3. 各子流要点

**PL2a Claude Code**（`agents/claude-code/src/server.ts`、`agent.ts`）

- SDK `query()` 调用处（`agent.ts:316` 附近）之前写 registry；`UniversalEventTranslator` 产生 `session.started` 时补 `sessionId`。
- 能力：`dispatchIdentity / executionLookup / reconnect / interrupt / waitingInput` 均为 true；`interruptConfirm` 按实现确认后设置。

**PL2b ACP 骨架**（`internal/acp-adapter/acp-server.ts`、`acp-bridge.ts`）

- registry 放在 `createAcpAgentApp` 层，所有 ACP core 共享。
- **与 bridge LRU 分离**（P-13）：`BRIDGE_IDLE_TTL_MS` / `BRIDGE_MAX_COUNT` 回收 bridge 时不得删除 registry；bridge 被回收后 lookup 仍能返回终态。
- 执行进行中不得被 bridge LRU 回收（若当前实现可能回收活动 bridge，需修正并加测试）。
- Goose：registry 与 lookup 使用对外 session id（经 `SessionIdCodec` 编码后的值，P-15）。
- 能力按 `AcpAgentServerConfig.capabilities` 声明；Codex / Goose 分别确认 `waitingInput` 与 `interruptConfirm`。

**PL2c DSH**（`agents/dsh/src/runtime/platform-server.ts`、`internal/dsh-adapter/dsh-runtime.ts`）

- DSH 通过 `createAcpAgentApp` 复用骨架，但 bridge 不同；registry 应自动继承 PL2b 实现。**依赖**：PL2c 在 PL2b 的 registry PR 合入后 rebase；在此之前只做 DSH 专属部分（`session/cancel` → confirmed 语义、resume 映射）。
- `permissions:false`：`waitingInput` 声明为实际支持情况（P-17）。
- 已有的 `ctx.agents.resume()` / `agent.cancel()` 映射到 reconnect / interrupt 契约。

## 3.1 V2.2 新增要求（评审修订）

- **记录淘汰不能让 404 变成"未执行"**（P-141）：registry 分记录层与键集合层（`02 §2.2`）；实现 `POST /executions/:key/fence`，与 `/chat` 受理共用同一把进程内锁，保证 fence 与受理只有一个先发生。
- **实例绑定**：携带 `dispatch_key` 的 `/chat` 必须带 `expected_runtime_instance_id`，不一致返回 412 且保证不执行（`02 §2.1`）。
- **执行级中断**（D-50，P-165～P-167，`02 §2.4`）：
  - 中断必须按 dispatch_key 定位，并原子地完成"匹配当前执行身份 + 发出中断"；
  - **禁止**在 handler 里比较 key 后，再异步调用"取消当前 session"；
  - 取消句柄从 `/chat` 受理时就要登记，这样 `session.started` 之前的执行也能被中断；
  - 这是平台已有的 dispatch_key 执行身份能力，agent-server 不需要理解 Teamwork，也不涉及 execution token 或 MCP header 改造。
- **不负责工具调用归属**：不新增 header、hop 或 turn 屏障，MCP 配置与 session token 保持现状。工具调用属于哪个 Run 由 Teamwork 的 `run_ref` 比对解决（`02 §9.1`，D-32）。

## 4. 任务

| # | 任务 | 子流 |
| --- | --- | --- |
| PL2-1 | 代码映射复核 | 各自 |
| PL2-2 | registry + `/chat` 去重 + 409 | a / b |
| PL2-3 | `GET /executions/:key` | a / b |
| PL2-4 | `runtime_instance_id` 与 `/info` 能力 | a / b / c |
| PL2-5 | interrupt `{delivered, confirmed}` | a / b / c |
| PL2-6 | `session.started` 附带字段 | a / b |
| PL2-7 | DSH cancel / resume 契约映射 | c |
| PL2-8 | 契约一致性测试：同一组用例对四个 core 运行（由 QA 提供 contract test suite） | 各自 |
| PL2-9 | 两层 registry + fence 端点 | b（a、c 复用或各自实现同一语义） |
| PL2-10 | 412 实例绑定 | a / b |
| PL2-12 | **统一执行级中断**（`02 §2.4`，D-50）：`POST /executions/:key/interrupt` + session 路由的 `expected_dispatch_key` 兼容入口；五种结果；取消句柄在 `/chat` 受理时登记 | a / b / c |
| PL2-13 | 各 runtime 按 `02 §2.4` 的隔离方式实现：claude-code 用 (a) 每轮 AbortController；ACP / DSH 先实现 (b)（session 锁 + 协议 cancel + 交错时重建子进程），同时实现 (c)（锁内终止子进程）作为兜底 | a / b / c |
| PL2-14 | F-17 实测：旧一轮结束后再收到 cancel 不影响下一轮。**这是硬性验收项**：(b) 不通过就切换到 (c) 并重测，不能靠把 capability 改成 false 过关（D-53） | a / b / c |
| PL2-14b | `/info` 声明 `interruptTargeted` 与 `interruptConfirm` 两个独立能力；`interruptTargeted=true` 必须有 F-16 / F-17 通过记录作为依据 | a / b / c |
| PL2-15 | （仅当 TW6-0 结论为方案 b 时）只读端点 `GET /mounts/:name`，返回 pod 内 `/mnt/afs/<name>` 的实际挂载选项（ro / rw / absent） | a / b / c |

## 5. 测试

- 同 key 并发 `/chat` ×10：只执行一次，其余 409。
- 执行结束后 60 分钟内 lookup 可得终态；bridge 回收后仍可得。
- 记录层淘汰后 fence 返回 `seen`，不返回 `fenced`；键集合溢出后返回 `not_authoritative`。
- fence 与同 key `/chat` 并发 ×100：要么 fence=`fenced` 且 chat 返回 409 不执行，要么 chat 先受理、fence=`seen`。
- 重启进程后 lookup 返回 404 且 `runtime_instance_id` 变化。
- interrupt 在长工具调用中：先 `confirmed:false`，终态后 lookup 为 `interrupted`。
- 无 `dispatch_key` 的旧调用行为不变。
