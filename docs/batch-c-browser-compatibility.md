# Browser Provider 兼容性

固定依赖 neu-browser-mcp 0.2.3（与 NAP 固定参考一致）。只使用 Provider API，保留 QAP 五工具注册，不直接注册该包的新工具集。源码/类型审查：包 dist/types.d.ts 和 dist/index.js。

| Backend | 隔离 | CDP / Live View | 文件 |
| --- | --- | --- | --- |
| qap（默认） | Owner Token + browser.workspace_id metadata | HTTP CDP、WebSocket、Live View | 列表和带访问令牌的下载 URL |
| kernel | 平台 API Key + 服务端 tags 过滤 | WebSocket / Live View；HTTP CDP 为 null | 列表支持；无下载 URL，get_browser_file_url 明确 isError |
| browser-use | 平台 API Key + 服务端 metadata 过滤 | 按 provider 返回能力 | 本版本不暴露文件操作，工具返回 isError |
| hyperbrowser / nap / 未知名称 | 拒绝启动 | 不适用 | 不适用 |

BROWSER_BACKEND 默认 qap；BROWSER_SERVICE_URL 默认 http://qap-browser:3005；BROWSER_PUBLIC_URL 配置外部下载地址。Kernel 用 KERNEL_API_KEY，Browser Use 用 BROWSER_USE_API_KEY。Hosted 不请求 Owner Token。缺少凭据/无效 backend/无效 QAP URL 在模块启动初始化时失败。

保留 create_browser、list_browsers、list_browser_files、get_browser_file_url、delete_browser 参数名与返回包装。create 的 status 现在反映就绪查询后的状态；timeout_seconds 校验正整数及 Provider 上限。无连接信息明确 null。默认文件目录继续 /downloads，Hosted 的实际下载目录可能不同，应显式传 path。所有 ID 操作先用 Workspace 过滤列表确认所有权；失败不调用文件或删除接口。

Provider 原始异常体可能含凭据，因此返回统一 MCP isError，不回显服务端错误体。CDP / Live View 和 QAP 下载链接仍包含访问浏览器所必需的会话凭据，延续原有连接语义；不返回 Hosted 平台 API Key。

未修改 Browser Web Panel、原管理 API、services/browser 或数据库。Hosted 浏览器不会出现在原 Web Panel。真实 Hosted tag 行为、Live View、CDP 和下载尚需配置服务后验收；本地单测不能替代外部验收。
