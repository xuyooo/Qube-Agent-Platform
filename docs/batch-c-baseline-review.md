# Batch C 基线与兼容性审查

2026-10-22，从 origin/main bc0393f0101a2d5a55069474d1ffd5a79ef7ff4a 创建 codex/qap-batch-c。已 fetch 确认没有更新主干；A/B 均已合并，不重复实施。NAP 固定参考 81c81e575e5997089c0a21b5b0843186ee0d76fd。工作区仅有原有未跟踪 %SystemDrive%/、API_INVENTORY.md，保持不动。

## 现有契约与处理

| 范围 | 证据 / 风险 | 实施方式 |
| --- | --- | --- |
| Browser MCP | browser.ts 的五个工具；create 返回 browser_id/status/expires_at/CDP/connect/live_view；list 返回 items；文件返回 files 或 ready/url/path/size/modified_at；delete 返回文本 | 保留 QAP 注册与格式，由 Provider Adapter 处理后端差异，错误改为 MCP isError |
| Browser 权限 | Owner Token；list metadata 过滤；文件与删除没有额外工作区检查 | 每个 ID 操作验证 Workspace 标签；Hosted 不使用 Owner Token |
| Browser Panel | 直接调用现有 services/browser 管理接口 | 不改管理路由、Panel 或数据库 |
| SDK | 现有 Transcript/MessageBubble/ToolRenderers；独立 i18n；tsc 输出 ESM 无打包；依赖宿主 Tailwind 扫描 | 增加公共交互与 SDK 构建/样式消费验证 |
| Composer | ChatPanel 包含语音、图片、队列、IME、草稿；CommandTrigger 混合数据查询与表单；CommandDialog 是命令配置 CRUD | 抽离通用 Composer；命令数据、CRUD、文件、语音与状态保留 Host Adapter |
| Store | zustand vanilla，已有 API/SSE/effects 注入，但直接导入 Web i18n、Draft 与 Plugin Dispatcher | 从 QAP 当前实现迁移，注入剩余宿主服务，不复制 NAP 整个 Store |
| SSE | runTurn/readSSE，共享源码包；Cookie 硬编码、固定路径 | 实例级 URL/fetch/headers/credentials，打包 Consumer 到 SDK 产物 |
| AgentCall | B 自动投递/等待计数/远端轮询/用户草稿协调均在当前基线 | 不改 Core/迁移；迁移客户端时保留现有回归测试并覆盖实例隔离 |

## 实施顺序

C0 审查 → C1 Provider → C2 公共交互 → C3 Composer → C4-A SDK Store/SSE → C4-B Host 切换与回归。参考 NAP 对应提交以阅读和针对性实现方式适配，不直接 cherry-pick。

本方案明确要求 C4 保留薄导出层，这一具体要求优先于通用的“不保留兼容层”指令：只允许重导出同一实现，不能创建第二个 Store。所有后端协议仍使用 QAP 当前 API。

## 质量与发布

逐阶段测试、独立提交；最终执行类型检查、单元测试、Diff Biome、Skills 一致性、Knip、独立 React 宿主打包及加载。真实 Hosted Provider 验收需可用凭据与外部服务；不伪报通过。仅 qap-cp 需要重建（包含 Web）；不新增迁移、不改 AgentCall 数据、不引入 Kanban。源码 PR 与镜像/正式发布/部署分离，本轮不自动发布镜像、Tag、合并或部署。
