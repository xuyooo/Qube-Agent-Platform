# Batch C UI SDK 契约

## 公共入口

@qap/ui-sdk 导出 Transcript、MessageBubble、AskUserQuestionPanel、AskUserRequest / AskUserQuestionItem / AskUserQuestionOption、WaitingOnAgentsNotice、Composer 及其 Props/Handle、createAgentSessionStore、createSessionSSEClient、useRemoteTurnSync 和客户端类型。

AskUserQuestionPanel 只发出 answers 回调；多选以逗号连接，保留现有协议。WaitingOnAgentsNotice 接收 count，不请求 API 或调度 Agent。ToolCall 的后续活动只改变错误视觉强调，绝不修改 isError 或推断任务成功。

## Composer

value/onChange 为受控输入。onSubmit(text, images) 不清空输入或附件；onRunCommand 也不清空输入，Host 决定发送成功或排队后的草稿处理。running、pending、onStop、disabled、readOnly 描述状态。commands/loadCommands/triggers/voice/attachments/toolbar 均由 Host 提供，不直接调用 QAP API。ComposerHandle.focus 和 insertAtCaret 负责焦点与插入。

命令配置 CRUD 留在 Web；SDK CommandDialog 仅负责模板参数输入。QAP 文件、Agent 查询和语音 /api/asr/transcribe 由 web/src/hooks/useWorkspaceComposer.ts 与 web/src/lib/composer 提供。Web Composer 按 Session 挂载，图片草稿按 Session 隔离；语音卸载后不把迟到转写插入新会话。

## Session Store

createAgentSessionStore(workspaceId, deps, options) 每次返回独立 zustand vanilla Store。必需 deps.api、deps.sse、deps.effects；可选 deps.drafts（get/clear/migrate）、deps.toolResults（dispatch/destroy）、deps.translate。没有 Draft 或 Plugin 能力的宿主可省略对应接口。

API getSession 必须提供 chat_status、pending_message、pending_agent_calls；last_active_at 用于远端同步。公开 pendingAgentCalls 状态；idle 不代表调用全部结束。API 和 SSE 的任务调度仍由 Core 决定，客户端只观察。Store 处理历史、发送、排队、停止、问题、远端重连与切换版本防护。chatEndpoint 和 locale 为实例选项。

useRemoteTurnSync 在活动会话可见时定时调用 sync，避免重叠请求；onSync 供 Host 更新缓存。它不决定 Core 的投递结果。

## SSE

createSessionSSEClient 必须传入 apiUrl 和 proxyUrl。credentials 默认 same-origin，可设 include/omit；fetch 与异步 getHeaders 可注入 Cookie 或 Bearer Token 认证。headers 每次请求重新取得，自定义 chatEndpoint 保留。旧回调在 Abort 后被屏蔽；会话 ID 过滤、有限重连预算和 SSE Consumer 行为延续 QAP 当前实现。没有全局可变端点配置。

## 分发与样式

SDK 构建为 dist/index.js ESM，React/i18next 等宿主依赖保持 external，现有 SSE Consumer 实现内联打包，不要求 @qap/sse-consumer npm 包或 Vite alias。声明入口 dist/types/ui-sdk/src/index.d.ts，相关声明随 dist 一起交付。

独立宿主安装包后显式 import '@qap/ui-sdk/styles.css'。CSS 包含设计 tokens 与 SDK 源码扫描生成的 Tailwind utilities，不需要扫描 Web 源码。样式带有 Tailwind base reset，宿主应显式决定载入顺序及主题覆盖；可覆盖同名设计变量。不需要安装 QAP Web。

原 web/src/stores/agent-session-store.ts 仅重导出 SDK API；SSE 原路径是配置 SDK 实例的 Host Adapter，不保留第二份解析器或状态机。Host Provider 负责认证、草稿、Plugin Dispatcher、缓存和通知音。没有 Kanban 业务逻辑。

## 多实例与质量门禁

Composer、Question、Waiting 支持 locale；Transcript Provider 使用实例语言副本，不改其他宿主的语言。Web 文件/Agent 查询与内置命令只存在 Host Adapter。SDK 公共入口作为 Knip entry；Web 对 @qap/ui-sdk 的忽略只用于其源码 alias 的依赖识别，SDK 的源文件和公共导出仍单独分析。Composer 的纯函数测试由 Web Vitest 执行，因此 SDK Knip 忽略 vitest 的未列依赖提示。独立宿主使用 npm pack 的 tarball 在系统临时目录安装、类型检查、Vite 构建和 JSDOM 执行，不从 Web 导入源码。CI 增加独立打包宿主任务及 SDK Diff Biome。
