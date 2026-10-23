# Batch C 实施报告

基线：`main@bc0393f0101a2d5a55069474d1ffd5a79ef7ff4a`。分支：`codex/qap-batch-c`。NAP 固定参考：`81c81e575e5997089c0a21b5b0843186ee0d76fd`。

## 功能映射与适配

| 阶段 | 实施 | 相对 NAP 的 QAP 适配 |
| --- | --- | --- |
| C1 | Browser Provider 选择、启动校验、Workspace 隔离、五工具适配 | 固定 neu-browser-mcp 0.2.3；保留 QAP 工具参数/响应及 /downloads；qap 名称映射第三方 createNapProvider；不搬入第三方新 MCP 工具，不改 Browser Panel 管理语义 |
| C2 | Question、Waiting 公共化；工具错误展示处理 | 直接迁移 QAP 的问题协议；后续活动降低错误强调但不改 isError，不宣称工具成功 |
| C3 | 受控 Composer、命令模板、触发菜单、图片、语音 | 参考 NAP 3d9b85b 通用组件；内置命令、API、文件/Agent 查询、语音、CRUD 留在 Web；输入清空由 Host 决定，按 Session 隔离图片与语音生命周期 |
| C4-A | SDK Store、实例 SSE Client、远端同步 Hook | 迁移当前 QAP Store 而非覆盖为 NAP Store；注入 drafts/toolResults/translation，保留 Batch A/B 状态机与自动续跑 |
| C4-B | Web 适配、薄重导出、独立包宿主、CI | 原 Store 路径只重导出 SDK；SSE 路径仅配置实例。SDK 内联 SSE Consumer，显式分发 CSS，临时目录 tarball 宿主独立构建和执行 |

C0～C4-A 已按阶段独立提交；C4-B 与最终质量门禁收尾单独提交；额外独立提交 CP 跨平台锁文件修复，只补足 npm 10/Linux 验证需要的可选依赖，无已有版本升级。完整提交记录见本分支 git log。

## 重要边界

- Core AgentCall/Session 调度、Turn Lock、数据库迁移和 Agent 镜像源码不变；Kanban 不在本批。
- `pending_agent_calls` 是现有服务端字段，本次补齐 Web getSession 类型并映射 SDK pendingAgentCalls；idle 时仍可显示等待，后续服务端轮次通过轮询和 SSE 接入。
- Web 的草稿、通知、缓存失效与 Plugin Tool Result Dispatcher 仍由 Host 管理；SDK 没有 Web 私有导入或 QAP HTTP 业务预设。
- Composer 不自动清空受控输入；支持纯图片发送与排队、IME、停止、文件/Agent 菜单。语音卸载清理与多实例 locale 独立，命令表单 ID 独立，disabled 阻止命令执行。
- 移除迁移后未使用的旧辅助函数和组件；只保留方案明确要求的 Store 同实现重导出。
- 独立宿主首次运行暴露的 JSX runtime 配置已修正，SDK 构建明确使用 automatic JSX。构建前只清理该 SDK 的 dist，避免打包陈旧声明。

## 验证与交付边界

详见 batch-c-test-report.md。测试包含模拟的超时/Abort/旧回调/会话隔离和 A/B 回归；不将模拟故障等同真实集群故障注入。发布与回滚见 batch-c-release-rollback.md。没有新增 SQL、没有发布 npm 包或镜像、没有部署、没有合并 main。

## 变更文件清单

以下相对固定基线列出，包含已提交阶段及本次收尾；六份交付报告另列于方案交付项。

- `.github/workflows/ci.yml`
- `control-plane/package-lock.json`
- `control-plane/package.json`
- `control-plane/src/mcp/tools/browser-provider.ts`
- `control-plane/src/mcp/tools/browser.test.ts`
- `control-plane/src/mcp/tools/browser.ts`
- `control-plane/src/mcp/tools/shared.ts`
- `control-plane/src/services/browser.ts`
- `internal/ui-sdk/package-lock.json`
- `internal/ui-sdk/package.json`
- `internal/ui-sdk/scripts/build.mjs`
- `internal/ui-sdk/scripts/test-host.mjs`
- `internal/ui-sdk/src/components/AskUserQuestionPanel.tsx`
- `internal/ui-sdk/src/components/MessageBubble.tsx`
- `internal/ui-sdk/src/components/ToolCallBlock.tsx`
- `internal/ui-sdk/src/components/ToolCallGroup.tsx`
- `internal/ui-sdk/src/components/WaitingOnAgentsNotice.tsx`
- `internal/ui-sdk/src/composer/CommandDialog.tsx`
- `internal/ui-sdk/src/composer/Composer.tsx`
- `internal/ui-sdk/src/composer/TriggerMenu.tsx`
- `internal/ui-sdk/src/composer/Voice.tsx`
- `internal/ui-sdk/src/composer/keys.test.ts`
- `internal/ui-sdk/src/composer/keys.ts`
- `internal/ui-sdk/src/composer/text.test.ts`
- `internal/ui-sdk/src/composer/text.ts`
- `internal/ui-sdk/src/composer/types.ts`
- `internal/ui-sdk/src/i18n.tsx`
- `internal/ui-sdk/src/index.ts`
- `internal/ui-sdk/src/lib/utils.ts`
- `internal/ui-sdk/src/locales/en-US.json`
- `internal/ui-sdk/src/locales/zh-CN.json`
- `internal/ui-sdk/src/question-types.ts`
- `internal/ui-sdk/src/session/agent-session-store.ts`
- `internal/ui-sdk/src/session/sse.ts`
- `internal/ui-sdk/src/session/types.ts`
- `internal/ui-sdk/src/session/use-remote-turn-sync.ts`
- `internal/ui-sdk/src/ui/badge.tsx`
- `internal/ui-sdk/src/ui/button.tsx`
- `internal/ui-sdk/src/ui/dialog.tsx`
- `internal/ui-sdk/src/ui/textarea.tsx`
- `internal/ui-sdk/styles.css`
- `internal/ui-sdk/tailwind.config.cjs`
- `internal/ui-sdk/test-host/index.html`
- `internal/ui-sdk/test-host/package.json`
- `internal/ui-sdk/test-host/smoke.mjs`
- `internal/ui-sdk/test-host/src/main.tsx`
- `internal/ui-sdk/test-host/tsconfig.json`
- `internal/ui-sdk/tsconfig.build.json`
- `knip.json`
- `web/package-lock.json`
- `web/package.json`
- `web/src/components/chat/VoiceInputButton.tsx`
- `web/src/components/workspace/CommandFields.tsx`
- `web/src/components/workspace/CommandTrigger.tsx`
- `web/src/components/workspace/FileMention.test.ts`
- `web/src/components/workspace/FileMention.tsx`
- `web/src/components/workspace/WorkspaceChatPanel.tsx`
- `web/src/components/workspace/sdk-composer.test.ts`
- `web/src/components/workspace/sdk-interactions.test.ts`
- `web/src/hooks/useChatSendKey.ts`
- `web/src/hooks/useWorkspaceComposer.ts`
- `web/src/lib/api/client.ts`
- `web/src/lib/api/sse.ts`
- `web/src/lib/api/types.ts`
- `web/src/lib/composer/preset.tsx`
- `web/src/lib/composer/types.ts`
- `web/src/lib/keyboard.ts`
- `web/src/stores/AgentSessionContext.tsx`
- `web/src/stores/agent-session-store.test.ts`
- `web/src/stores/agent-session-store.ts`
- `web/src/stores/composer-store.ts`
- `web/src/stores/sdk-session.test.ts`
- `web/vitest.config.ts`
