# WS-TW7 · 插件生命周期、协议、Capabilities

Phase 1A 最小实现 + Phase 1C 完整实现。必读：`02-contracts.md §7 §10`、`ws-pl4-web-host.md §3`；`90-pitfalls.md` P-31～P-34、P-39、P-120～P-127。

## 1. 拥有的文件

`plugins/teamwork/server/lifecycle.ts`、`capabilities.ts`、`plugin-guard.ts`；`plugins/teamwork/plugin.json`；migration 150 的内容（由 TW1 提交）。

## 2. 产品形态

| 组成 | 内容 | 发布方式 |
| --- | --- | --- |
| Teamwork Web plugin | Kanban、详情、成员、结果卡片、API client | 现有 IIFE bundle 上传与分发；React 取自 host |
| Teamwork server module | 投影、状态机、领域 API / MCP、reconcile、资源、模板快照 | 受信任第一方源码；CP 启动时静态注册；scheduler 加载同一功能的薄 worker |
| Workflow templates | 协调员说明、成员职责建议、验收要求 | 首版一个默认模板 |

平台继续拥有：认证、Workspace / Session、实际 Agent 执行、admission、原生审批 / 问题、interrupt / reconnect、队列引擎、AFS 基础操作。

## 3. 生命周期语义

| 状态 | 允许 | 禁止 |
| --- | --- | --- |
| `active` | 新建、start、所有派发、续跑、重试、返工 | — |
| `draining` | **进入 draining 前已 start 的任务**：派发成员、续跑、回复、返工、验收、取消，直至 done / cancelled（P-120）；看板与处理入口保留 | 新建、新任务 start |
| `disabled` | 只读历史 API；必要的幂等资源清理 | 任何新的 Agent Execution；从 disabled 恢复模型执行 |

转换：

- `active → draining`：锁配置行，与 start 同一把锁（P-121）。
- `draining → disabled`：检查（P-122）：
  - 所有已授权（`started_at` 非空）且非 done / cancelled 的任务；
  - 所有非终态 Run，包括 unknown；
  - 所有未完成的资源操作；
  - blocked / unknown / in_review 状态的任务。

  任一项存在即拒绝，并返回清单。需要立即停用时，管理员先显式取消这些任务，并等待真实停止确认。
- `disabled → active`：尚未启动的草稿可以重新开始。

**唯一执行开关**：`teamwork_plugin_settings.lifecycle`。`plugins.enabled` 只决定 bundle 是否分发（P-31、I-22）。队列消息在执行前重新读取 lifecycle（P-123）。浏览器本地卸载不作为判断依据（P-127）。

## 4. 安装、升级、卸载

- **安装 / 启用**：CP 与 scheduler 部署中必须已有匹配的 server module 与 schema；上传 bundle；capabilities 检查协议与 `workerReady` 通过后才可切到 active。只有 UI bundle 时，页面显示"缺少 Teamwork 后端能力"，不接受 start。
- **升级**：先 draining；确认没有在途执行、未解决的 unknown、需要续跑或等待验收的旧任务；再更新 server module 与 bundle；检查协议后启用。不同时维护两套后端实现，不给旧 preview 做状态推导或迁移（P-124）。
- **卸载 UI bundle**：只允许在 disabled 状态下进行；不删除历史数据库、Session 与文件；之后通过授权 API 或重新安装同版本查看历史。
- **绕过防护**：PL4 的 plugin guard 对 Teamwork 的 enable / disable / upload / delete 调用本模块检查（P-126）；旧 bundle 或直接调用 API 同样被服务端拒绝（P-125）。

## 5. 协议

- `PROTOCOL_MAJOR = 1`。写请求带 `X-QAP-Teamwork-Protocol`；major 不符返回 426。
- capabilities 按 `02 §10` 输出；UI 按 capability 开关功能。
- 同一 major 内独立发布 UI 不会让旧页面自动失效；所有页面仍然要通过当前权限与 lifecycle 检查。

## 6. 权限与信任

首版由管理员对整个平台启用；task 的数据权限仍按 owner。插件前端是受信任的同源 JS，拥有当前用户的浏览器上下文；manifest 能力声明不产生安全隔离（P-39）。所有授权在服务端完成。

## 7. 任务

| # | 任务 | Phase |
| --- | --- | --- |
| TW7-1 | 代码映射复核 | 1A |
| TW7-2 | `LifecycleGuard`（assertCanStart / assertCanDispatch）+ seed 为 active 的开发配置 | 1A |
| TW7-3 | capabilities 端点 + 协议头中间件 | 1A |
| TW7-4 | `plugin/commands`（enable / drain / disable）+ disabled 检查清单 | 1C |
| TW7-5 | PL4 guard 注册、manifest Zod 校验 | 1C |
| TW7-6 | 安装 / 升级 / 卸载流程与运维文档 | 1C |

## 8. 测试

drain 与 start 并发；blocked / unknown / in_review 存在时 disable 被拒；stale UI、直接 API 调用、通用插件接口的绕过尝试都被拒；只上传 UI 时不能 start；卸载后重装，历史可读。
