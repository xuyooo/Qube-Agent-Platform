# WS-TW9 · 旧实现迁出与删除

Phase 1B 末到 1C（G4）。依赖：TW2、TW5、TW8 已合入；PL3 的 scope registry 与 TW5 resolver 已上线。必读：`03-parallel-plan.md §8`；`90-pitfalls.md` P-23、P-38、P-54～P-56。

## 1. 冻结规则

从 M0 开始，以下文件**冻结**：只允许修复阻断性 bug，不得新增功能。

`control-plane/src/routes/teamwork.ts`、`control-plane/src/services/teamwork.ts`、`control-plane/src/services/db/teamwork.ts`、`web/src/components/teamwork/**`、`web/src/lib/api/client.ts` 中的 Teamwork 方法。

## 1.1 切换方式（D-35）

G4 之前新实现只在测试装配中运行；生产只挂载旧实现。本工作流的删除与 INT 的注册变更放在**同一个原子切换 PR** 中（`03-parallel-plan.md §4.2`），不存在新旧入口同时服务的中间状态，也不写兼容层。该 PR 先以**候选**形式部署到预发，L-07 与切换 / 回滚演练通过（G4）后才合并（D-61）。

## 2. 删除清单（G4）

| 项 | 前置条件 |
| --- | --- |
| `control-plane/src/routes/teamwork.ts` | 插件路由已在同一 URL `/api/teamwork` 注册；INT 已从 `control-plane/src/index.ts` 移除旧挂载 |
| `control-plane/src/services/teamwork.ts` | TW6 已完成 AFS 逻辑的 EXTRACT |
| `control-plane/src/services/db/teamwork.ts` | TW1 已迁入所需查询 |
| `mcp/server.ts` 中 `legacyTeamworkScope`、`mcp/tools/agent.ts` 中的 `resolveRosterMemberBySlug` 路径（P-23） | TW5 resolver 已上线；由 PL3 执行删除，TW9 验收 |
| `web/src/components/teamwork/TeamworkSection.tsx`、`TeamworkTimeline.tsx`（可复用部分已移入插件） | TW8 已合入 |
| `web/src/hooks/useFleetApps.ts` 中硬编码的 `TeamworkApp`（P-38） | PL4 apps 贡献已合入；由 PL4 执行删除，TW9 验收 |
| `web/src/components/shell/apps/wsApps.tsx` 中 Teamwork wrapper / import | 同上 |
| `web/src/lib/api/client.ts` 中 Teamwork 方法 | 插件使用自己的 client |
| `internal/types/api.ts` 中 Teamwork 定义 | 改由 plugin contracts 拥有，CP OpenAPI 从该包注册，避免两份 schema 漂移 |
| `session-source.ts`、`AgentSessionContext.tsx` 中的 Teamwork 引用 | 逐一确认后移除或改为通用 |

不设置旧接口兼容层；API URL 继续使用 `/api/teamwork`，但只有一个新实现。

## 3. 文档

- 更新 `docs-site/src/content/docs/concepts/teamwork.md` 与 `zh-cn` 版本（P-56），描述 V2 状态、验收与限制（同 owner 同环境、单 CP）。
- 更新 `API_INVENTORY.md` 中的 Teamwork 部分。

## 4. 数据

- 不删除旧 Preview 数据（D-27）。旧行已被 migration 143 标为 backlog，可在新 UI 中查看或开始。
- 旧 `afs_share_id` 由 TW6 登记为已存在 share。
- 是否处置旧数据是部署前的单独决策，本工作流不执行。

## 5. 验收（G4）

- 删掉内置 Teamwork app 后，只有插件启用时才出现可执行入口；不存在两套 Teamwork。
- 关闭所有页面后，任务仍能推进。
- 禁用分发或保留旧页面都不能绕过服务端 lifecycle。
- 插件 UI 没有 import 宿主私有代码；完整会话展示与原生问题处理通过版本化的 host 能力完成。
- `rg -n "TeamworkSection|deriveMemberSessions|buildTeamworkContext|findTaskBySession|resolveRosterMemberBySlug"` 无结果（测试与文档除外）。
