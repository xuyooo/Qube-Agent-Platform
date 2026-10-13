# WS-PL4 · Web host 扩展点与插件路由守卫

Phase 1B（host）/ 1C（guard）。可在 M0 后立即开始。必读：`02-contracts.md §10`；`90-pitfalls.md` P-30～P-40、P-126。

## 1. 拥有的文件

`web/src/lib/host.ts`、`web/src/plugins/types.ts`、`web/src/plugins/registry.ts`、`web/src/lib/plugin-loader.ts`、`web/src/lib/plugin-lazy-registry.ts`、`web/src/hooks/useFleetApps.ts`；`control-plane/src/routes/plugins.ts`、`control-plane/src/services/db/plugins.ts`。

## 2. 前端扩展（host API major = 1）

| 能力 | 规格 |
| --- | --- |
| Fleet app 贡献 | `WorkspacePlugin` 增加 `apps: FleetAppContribution[]`（`{id, label, icon, scope:'fleet', component}`）；manifest `owns.apps` 同步声明；`registerPlugin` 仍是唯一注册入口；新增可订阅的 app registry；`useFleetApps` 合并已启用插件的 app；app id 必须带插件命名空间（`teamwork.board`），与内置 app 冲突时拒绝注册（P-40） |
| 懒加载 | lazy loader 能从 app 占位入口触发加载；加载失败或版本不匹配显示明确错误，不静默回退 |
| SessionView | `host.SessionView({workspaceId, sessionId, mode:'readonly'|'interactive'})`，内部自带会话 Provider、ChatPanel 与原生问题处理（P-35）；插件只选择目标，不复制 AgentSessionStore、Chat 生命周期、问题协议、流式 UI、reconnect |
| 导航参数 | app 窗口支持结构化参数（`{taskId, workItemId, runId, tab}`），刷新与复制链接可恢复（P-133） |
| host 版本 | `window.tos.hostApiMajor = 1`；插件据此判断 |
| 共享依赖 | React / ReactDOM / JSX runtime 继续作为 host 单例外置；**不**导出 QueryClient（插件自带，P-36） |
| tool result handler | 保持"只刷新 UI 缓存"语义，文档化"懒加载首个事件可能丢失"（P-30） |

不允许插件 import 宿主私有源码；不在 `window.tos` 挂 Teamwork 专用 client 方法。

## 3. 服务端插件路由守卫

```ts
// control-plane/src/routes/plugins.ts
export interface PluginGuard {
  pluginId: string
  beforeEnable?(ctx): Promise<void>     // 抛错即拒绝
  beforeDisable?(ctx): Promise<void>
  beforeUpload?(ctx, manifest): Promise<void>
  beforeDelete?(ctx): Promise<void>
}
export function registerPluginGuard(g: PluginGuard): void
```

- 通用 `enabled / delete / upload` 接口在执行前调用对应 guard（P-126）；Teamwork guard 由 TW7 实现并注册。
- `GET` bundle：URL 中的版本必须等于实际存储内容的版本，否则 404（P-33）。
- manifest 提供 Zod 校验钩子（P-34）。

## 4. 任务

| # | 任务 | Phase |
| --- | --- | --- |
| PL4-1 | 代码映射复核 | M0 后 |
| PL4-2 | apps 贡献 + registry + useFleetApps 合并（保留硬编码 TeamworkApp，G4 由 TW9 删除） | 1B |
| PL4-3 | 懒加载占位与版本错误 | 1B |
| PL4-4 | SessionView | 1B |
| PL4-5 | 导航参数深链接 | 1B |
| PL4-6 | plugin guard 扩展点 + bundle 版本校验 + manifest 校验钩子 | 1C |

## 5. 测试

- 没有任何 Workspace MCP 配置时，fleet app 仍出现（验收 L-02）。
- 注册与内置 app 同 id 的插件被拒绝。
- SessionView 在 fleet 根下可以完整显示会话并回答原生问题。
- guard 抛错时通用插件接口返回 409，DB 不变。
