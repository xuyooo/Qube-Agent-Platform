# WS-TW8 · Teamwork Web 插件 UI

Phase 1B。可在 M0 后用 mock API 开发，**G2 通过前不得合入可见入口**。必读：`02-contracts.md §7 §8 §10`、`ws-pl4-web-host.md §2`；`90-pitfalls.md` P-30、P-36、P-55、P-57、P-87、P-130～P-140。

## 1. 拥有的文件

`plugins/teamwork/web/**`：`index.ts`（`window.tos.registerPlugin`，贡献 fleet app `teamwork.board`）、`TeamworkBoard.tsx`、`TeamworkTaskDetail.tsx`、`TeamworkWorkItems.tsx`、`TeamworkRunHistory.tsx`、`TeamworkSessions.tsx`、`TeamworkArtifacts.tsx`、`TeamworkActivity.tsx`、`api.ts`（插件自有领域 client）、`query.ts`（自带 QueryClient 与 Provider，P-36）、`mocks/`。

依赖：继续使用项目已有依赖（React Query、dnd-kit core / sortable、现有 UI 组件）。React / ReactDOM / JSX runtime 外置为 host 单例。不混用 dnd-kit 新包的示例 API。

## 2. 看板

- 固定七列，横排，依次为：待规划、待执行、进行中、阻塞、待验收、已完成、已取消。列宽 240–280px。窗口不足时只有看板区域横向滚动，不换行、不合并列；窄屏同样保留列并允许左右滑动。
- 空列保留标题与计数 0。列计数使用服务端返回的**筛选后总数**（P-132）。已完成 / 已取消默认只显示最近的任务，支持继续加载。
- 列内按 priority、created_at、id 排序；首版不持久化手动排序。
- 卡片字段：短编号（例如 TW-128）、标题、优先级、协调员、子任务完成数 / 总数、最近进展、最后活动时间；异常标记，例如"等待输入""20 秒后重试""取消中""暂停中""状态不明""疑似停滞"。**不显示**模型猜测的百分比（P-140）。
- 拖拽只表达命令（P-134）：待规划 → 待执行 = `start`；待验收 → 已完成 = `accept`；拖到已取消 = `cancel`（需确认）。运行中的卡片不能拖入已完成。拖拽只跨合法列；提供等价的菜单与键盘操作。
- 乐观更新遇到 409：撤销变化，重取快照，并说明原因（P-135）。
- 新建只需标题、目标 / 验收标准、协调员；成员可以后补。默认存为待规划；"创建并开始"是显式的执行授权。
- 加载失败可重试；实时连接断开时显示"状态更新已断开"和最后成功同步时间。

示意：

```text
进行中 · 3
┌───────────────────────────────┐
│ TW-128                  高优先级 │
│ 优惠券 V2 回归验收               │
│ QA Lead · 子任务 2 / 4          │
│ API 回归完成，UI 回归执行中       │
│ 等待输入 1             30 秒前   │
└───────────────────────────────┘
```

## 3. 详情

- 点击卡片打开右侧详情侧栏（桌面 560–680px），保留看板的筛选与滚动位置；"展开"进入完整详情（内容主体 + 约 280px 属性栏）；窄窗口全宽显示（P-57）。
- 深链接：通过 app 导航参数承载 `taskId / workItemId / runId / tab`，不只存在 localStorage（P-133）。
- 页签：

| 页签 | 内容 | 操作 |
| --- | --- | --- |
| Overview | 目标、验收项、workpad 进展、阻塞原因与解除入口、最新活动、`allowed_commands` 按钮 | 编辑未开始的目标；待验收时通过或退回；pause / resume / cancel / retry / resolve_execution |
| WorkItems（Phase 2） | 标题、执行成员、状态、依赖、结果摘要 | 点开子任务 |
| Runs | 每次 Run 的 kind、时长、状态、错误、重试时间、输入 / 输出用量 | 切换历史 attempt；打开对应 Session |
| Sessions | 协调员与成员的会话树（来自 `GET /:id/sessions`，P-55），用 host `SessionView` 展示 | 回答定位到具体 session 的问题 |
| Artifacts | 输出文件、报告、链接、验收证据、checksum、所属 Run | 预览、下载、查看来源 |
| Activity | 业务事件流（`events?after_id=` 补拉） | 评论 |

- 侧栏先渲染 Overview；**只在展开 Sessions 页签时**才挂载 SessionView、订阅 token 流（P-136）。
- 用量来自现有 usage 账本，按 run / session 去重；runtime 未提供的指标显示"未提供"，不显示 0 或估算费用（P-137）。
- 等待输入时显示具体问题和提问的 Agent；回答调用 `requests/:id/respond`，路由到原 session（P-138）。
- 补充说明调用 `inputs`，排队到协调员下一轮；普通评论调用 `comments`，只记活动（P-139）。
- 暂停 / 取消后显示"暂停中 / 取消中"，直到服务端确认（P-87）。
- `execution_unknown` 显示明确的核查指引，并提供 resolve_execution 表单（结论 + 证据 + 副作用确认）。

## 4. 实时更新

```text
建立 /api/teamwork/events SSE 订阅
  → 拉取快照（list / detail）
  → 收到 task.changed 等通知 → invalidate 对应 query → refetch
  → 断线 → 显示断开状态 → 重连成功后再次拉快照
```

先订阅、后拉快照；SSE 只做失效通知（P-130、P-131）。tool result handler 只用于刷新缓存，首个事件可能丢失（P-30）。

## 5. 协议与能力

- 进入 app 时调用 capabilities：major 不兼容时禁止写操作并提示更新；`workerReady=false` 时禁止 start；缺少的 capability 对应功能隐藏。
- 所有写请求带 `X-QAP-Teamwork-Protocol`。
- 不 import 宿主私有源码；不把 client 方法挂到 `window.tos`。

## 6. 任务

| # | 任务 |
| --- | --- |
| TW8-1 | mock API（基于 contracts 类型）与插件骨架 |
| TW8-2 | 看板（列、卡片、筛选、分页、拖拽命令、键盘操作） |
| TW8-3 | 详情侧栏与完整详情、深链接 |
| TW8-4 | Overview / Runs / Sessions / Artifacts / Activity |
| TW8-5 | SSE 失效与断线状态 |
| TW8-6 | 协议与能力检查 |
| TW8-7 | 少量 E2E：创建到验收 |

## 7. 验收（G3）

U-01～U-10（见 `ws-qa-harness.md`）。
