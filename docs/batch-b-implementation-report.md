# QAP Batch B 实施报告

## 基线与范围

分支 codex/qap-batch-b 从 Batch A 877134736d42b70dbfde5b8b493dc3e69d35f9c8 创建，未重做 A，未使用旧 main。NAP 固定参考 81c81e575e5997089c0a21b5b0843186ee0d76fd，主要映射其 4ffe5d8（AgentCall）、273fe0a（注入轮次回调）、fa6b050（Web 跟随异步会话）的实现。

B1–B5 已在代码中实现。C1 Browser Provider、C2/C3 公共组件抽取未实施；C4 Session Store 迁移仍等待 B 契约评审稳定。Memory Reflect 保持独立。没有合并 main、推送 B、发布包或部署。

## 代码映射

| 能力 | 主要代码 | 完成内容 |
| --- | --- | --- |
| B1 持久化 | migrations/148_agent_calls.sql、services/db/agent-calls.ts | 调用状态、结果快照、投递状态、带令牌租约、重试和恢复查询 |
| B2 自动投递与恢复 | services/chat/agent-call-delivery.ts、src/index.ts | Core 扫描、结果合并、父轮次续跑、忙会话重试、权限撤销停止、嵌套结果与提问 |
| B3 MCP / Session / SSE | mcp/tools/agent.ts、lib/sse.ts、services/chat/executeChat.ts、lib/session-recovery.ts | 持久化后承诺交接、轮次完成钩子、用户输入优先、失联恢复、旧流替换防误结算 |
| B4 API | internal/types/api.ts、routes/workspaces、dispatchChatTurn.ts、skills | Session 与同步 Chat 待调用计数、QAP OpenAPI / API Skill 和脚本 |
| B5 最小 Web | WorkspaceChatPanel、WorkspaceSessionsPanel、ui-sdk/tool-renderers/mcp/agent.tsx | 等待提示、活动会话可见时轮询同步、结果展示，保留现有私有 Store |

上述 control-plane 路径省略 src 前缀。完整文件列表见末尾。

## 相对 NAP 的适配

保留其 Core 表驱动投递与注入 StartTurn / TurnHooks 的分层方式。QAP 原有 MCP 请求上下文、权限、Turn Lock、排队消息及现有 Teamwork 绑定继续使用。自动投递不依赖 Teamwork / Kanban；没有 Kanban 必填字段、私有 Web Store 依赖或通用事件总线。

额外修正：租约令牌防止旧持有者确认新租约，并在慢请求期间续租；问题通知按领取时快照确认，避免吞掉随后完成的结果；持久化结果文本与已完成轮次标记；恢复时未知结局保守报失败；重检调用者权限；调用记录写入失败不宣称自动交接成功；前台失败不返回 ended；旧流关闭不结算替换后的新轮次。UI SDK 只改 AgentCall 展示，不包含 Kanban 逻辑。

Web 使用 QAP 现有消息 Store，在活动会话可见时每 5 秒检查一次，覆盖待调用计数从零快速变回零以及人工回答后的续跑。没有迁移 C4 Store。API Skill 从 QAP 源码重新生成，保留 QAP 命名。

## 验证、迁移及回滚

- [测试与故障注入报告](batch-b-test-report.md)
- [数据迁移与版本契约](batch-b-migration-report.md)
- [回滚方案](batch-b-rollback-report.md)

最终检查：控制面 TypeScript 类型检查、控制面构建、Web TypeScript/Vite 构建、UI SDK 构建均通过。Web 保留既有 bundle 大小与 Browserslist 数据年龄警告；改动文件 lint 剩余 3 项 Batch A 原有问题，详见测试报告。

## 剩余风险

投递语义为至少一次：父轮次已启动但 ACK 尚未持久化时崩溃，恢复可能再次投递。租约隔离与 Session Lock 缩小竞争窗口，不构成跨数据库/Agent 的恰好一次保证。结果文本截断投递上限 16000 字符，完整快照可通过 get_agent_result 读取。达到重试/投递次数限制会停止自动推进，需要检查记录。

真实集群故障注入、真实浏览器、模型/工具副作用和生产迁移未验收。上线前还要评估 Batch A 尚未执行的外部验证。未生成或发布任何新云端镜像。

## 功能提交

- 214ca1e：AgentCall 持久化与投递租约
- 53e21e5：AgentCall 异步结果投递与恢复扫描
- fffacb2：AgentCall 结果快照与故障恢复隔离
- 003ccc2：Session 自动续跑与 AgentCall API
- fc23842：AgentCall 等待状态与异步结果展示

API Skill 与本报告另行提交。各提交组成一个完整 Batch B，发布使用最终批次版本。

## 变更文件

- control-plane/migrations/148_agent_calls.sql
- control-plane/package-lock.json
- control-plane/package.json
- control-plane/src/index.ts
- control-plane/src/lib/session-recovery.ts
- control-plane/src/lib/sse-replace.test.ts
- control-plane/src/lib/sse.ts
- control-plane/src/mcp/tools.ts
- control-plane/src/mcp/tools/agent-handoff.test.ts
- control-plane/src/mcp/tools/agent.test.ts
- control-plane/src/mcp/tools/agent.ts
- control-plane/src/routes/proxy.ts
- control-plane/src/routes/system-workspaces.ts
- control-plane/src/routes/workspaces/chat.ts
- control-plane/src/routes/workspaces/read.ts
- control-plane/src/routes/workspaces/sessions.test.ts
- control-plane/src/routes/workspaces/sessions.ts
- control-plane/src/services/chat/agent-call-delivery-format.test.ts
- control-plane/src/services/chat/agent-call-delivery.test.ts
- control-plane/src/services/chat/agent-call-delivery.ts
- control-plane/src/services/chat/dispatchChatTurn.test.ts
- control-plane/src/services/chat/dispatchChatTurn.ts
- control-plane/src/services/chat/executeChat.test.ts
- control-plane/src/services/chat/executeChat.ts
- control-plane/src/services/db/agent-calls.integration.test.ts
- control-plane/src/services/db/agent-calls.test.ts
- control-plane/src/services/db/agent-calls.ts
- control-plane/src/services/db/sessions.ts
- control-plane/src/services/db/types.ts
- docs/batch-b-migration-report.md
- docs/batch-b-rollback-report.md
- docs/batch-b-test-report.md
- internal/types/agent-call-delivery.ts
- internal/types/api.ts
- internal/types/index.ts
- internal/ui-sdk/src/tool-renderers/mcp/agent.tsx
- skills/assets/qap-api/scripts/handoff.sh
- skills/qap-api/SKILL.md
- skills/qap-api/references/operations/get-api-workspaces-id-sessions-sessionId.md
- skills/qap-api/references/operations/get-api-workspaces-id-sessions.md
- skills/qap-api/references/operations/post-api-workspaces-id-chat.md
- skills/qap-api/scripts/handoff.sh
- skills/specs/control-plane.json
- skills/templates/skill.md.eta
- web/src/components/workspace/WorkspaceChatPanel.tsx
- web/src/components/workspace/WorkspaceSessionsPanel.tsx
- web/src/components/workspace/agent-result.test.ts
- web/src/locales/en-US.json
- web/src/locales/zh-CN.json
- web/vitest.config.ts

- docs/batch-b-implementation-report.md
