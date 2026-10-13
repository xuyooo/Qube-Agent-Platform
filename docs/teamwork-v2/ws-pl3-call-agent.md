# WS-PL3 · call_agent 收敛与 MCP 作用域扩展点

Phase 0。必读：`02-contracts.md §1 §5（TeamworkToolsRegistrar）§9`；`90-pitfalls.md` P-20～P-27。

## 1. 目标

1. 普通 Workspace 的 `call_agent` 保留能力，但底层改走 `dispatchManagedTurn(origin='call_agent')`，删除重复的生命周期处理。
2. MCP server 提供**通用 scope resolver 注册表**，移除核心层直接读 Teamwork 表的专用判断。
3. Managed Teamwork Session 中禁用自由 `call_agent`。

## 2. 拥有的文件

`control-plane/src/mcp/server.ts`、`mcp/tools.ts`、`mcp/tools/agent.ts`，新建 `mcp/scope-registry.ts`。

## 3. Scope resolver 扩展点

```ts
// control-plane/src/mcp/scope-registry.ts
export interface McpScope {
  kind: string                         // 例如 'teamwork'
  data: Record<string, unknown>        // 由 resolver 定义，核心层不解读
  disabledTools?: string[]             // 例如 ['call_agent', 'get_agent_result']
}
export interface McpScopeResolver {
  kind: string
  // 平台只传 workspace 与 session。工具调用的 Run 归属由 scope 自己的工具校验（Teamwork 用 run_ref，02 §9.1）
  resolve(ctx: { workspaceId: string; sessionId: string | null }): Promise<McpScope | null>
  registerTools(server: McpServerLike, scope: McpScope): void
}
export function registerMcpScopeResolver(r: McpScopeResolver): void
```

`handleMcpRequest` 流程：`X-Workspace-ID` + workspace token 认证 → `X-Session-Token` 解析 sessionId → 依次调用已注册 resolver → 注册平台工具（跳过 `disabledTools`）→ 注册 scope 工具。

Teamwork resolver 由 TW5 实现并在 `registerTeamwork` 中注册；PL3 只提供机制，并用一个测试 resolver 验证。

## 4. call_agent 改造

| 现状 | 改造后 |
| --- | --- |
| `fetch(${address}/chat)` 直连（`agent.ts:635`） | `dispatchManagedTurn({origin:'call_agent', originRef: callerSessionId, parentExecutionId, workspaceId: target.id, sessionId, message})` |
| `runSubAgentTurn` 自己消费 SSE、SerialQueue 注册 session | 由 Managed Execution 持久化；foreground 等待通过订阅 lifecycle 或轮询 `getManagedExecution` 实现 |
| foreground `FOREGROUND_WAIT_MS=30s` 后提示用 `get_agent_result` | 语义保留；`get_agent_result` 改为读 `managed_executions` + 最终消息 |
| 成员 session 注册 fire-and-forget `.catch(console.error)`（P-21） | 普通 call_agent 不再写 `teamwork_sessions`（该表只由 Teamwork 写） |
| `parent_session_id` 恒为 null（P-22） | 写 `parent_execution_id` |
| Task 作用域下 `resolveRosterMemberBySlug` 扩大可达范围（P-23） | 删除；Managed Teamwork 中 call_agent 被禁用 |
| 自调用拒绝（`agent.ts:595`）、session 归属校验（`agent.ts:608-623`） | 保留 |
| `target.status !== 'running'` 直接报错（P-27） | 保留对普通 call_agent 的行为；autostart 仍由 Managed Execution 处理 |

**过渡期**：G4 之前旧 Teamwork Preview 仍在运行。在 TW5 的 resolver 上线前，旧 `findTaskBySession` 路径保留在一个明确标注的 `legacyTeamworkScope` 函数中，G4 由 TW9 删除。

## 5. 任务

| # | 任务 | 完成标准 |
| --- | --- | --- |
| PL3-1 | 代码映射复核 | |
| PL3-2 | scope registry + 测试 resolver | 注册 / 禁用工具生效 |
| PL3-3 | 把现有 Teamwork 作用域逻辑移入 `legacyTeamworkScope` | 旧 Preview 行为不变 |
| PL3-4 | call_agent 改走 Managed Execution（依赖 PL1 合入） | foreground / background / 多轮 session 回归通过；turn-gate 生效 |
| PL3-5 | `get_agent_result` 改读执行事实 | |
| PL3-6 | `disabledTools` 生效时调用返回结构化错误 | |

## 6. 测试

- call_agent 满载 Workspace 时得到 admission 错误，而不是绕过 turn-gate。
- CP 在 call_agent 子执行中途重启：子执行被恢复或进入 unknown，不重复执行。
- scope resolver 抛错时平台工具仍可用，Teamwork 工具不注册，并记录日志。
