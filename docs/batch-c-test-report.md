# Batch C 测试与验证报告

验证日期：2026-10-23（Asia/Shanghai）。源码基线 bc0393f；实施分支 codex/qap-batch-c。运行环境为 Windows / Node 24，本地结果不代替 Ubuntu / Node 22 的 GitHub CI 或生产验收。

## 自动化测试

| 范围 | 结果 | 数量 |
| --- | --- | --- |
| Control Plane 单元测试 | PASS | 63 文件 / 723 测试，含 Browser 8 项及 Batch A/B 回归 |
| Web 单元与 JSDOM 交互测试 | PASS | 22 文件 / 273 测试，含原 Store 回归、SDK 实例隔离与 Composer 边界 |
| Scheduler | PASS | 1 文件 / 7 测试 |
| Skills Content Service | PASS | 6 文件 / 87 测试 |
| Claude Code Agent | PASS | 1 文件 / 5 测试 |
| ACP Adapter（Codex 对应 CI 项） | PASS | 3 文件 / 16 测试 |
| 合计 | PASS | 1111 测试 |

## 质量门禁与构建

- 11 个 CI 工作区 TypeScript --noEmit 通过：control-plane、web、channel-gateway、scheduler、sandbox-service、browser-service、skills-content-service、agents/claude-code、agents/codex、agents/goose、agents/dsh。
- 变更文件 Biome 通过：Control Plane、Web、UI SDK；未对全仓库历史文件做无关格式化。
- Knip 通过，SDK 公开入口纳入分析；保留的 configuration hints 是原有或冗余配置提示，不是检查失败。
- Skills 从 API 重新生成，提交前确认 skills/ 无差异。
- Control Plane、Web、SDK ESM/声明/CSS 构建通过。Web 的大 chunk 提示和依赖 PURE annotation 提示不阻止构建；没有宣称已完成包体积优化。
- SDK npm pack 后复制测试宿主到系统临时目录，安装 tarball，执行类型检查、Vite 生产构建与 JSDOM smoke，通过。宿主只导入 @qap/ui-sdk 公共入口及 styles.css，不包含 Web alias；验证 Transcript、Question、Composer、Store、SSE 往返和 CSS token 产物。
- GitHub CI 的权威结果见 PR #4 / 对应 HEAD Checks。此报告中的本地 PASS 不自动代表远端 CI PASS；CI 已增加打包宿主、SDK Diff Biome 与 SDK Knip 范围。

## 回归与模拟故障覆盖

| 场景 | 证据 |
| --- | --- |
| Browser 默认后端、参数/返回包装、超时、配置拒绝、Workspace 隔离与能力拒绝 | control-plane/src/mcp/tools/browser.test.ts，使用 Provider mock；未调用真实 Hosted 服务 |
| 问题单选/多选/自定义答案与等待/错误展示 | sdk-interactions.test.ts、sdk-composer.test.ts 与独立宿主；保持问题全文作为 key、多选逗号连接 |
| Composer 图片、排队、停止、IME、插入和命令 | sdk-composer.test.ts、composer/keys.test.ts、text.test.ts、FileMention.test.ts |
| 多实例语言、禁用命令、纯图片队列按钮、晚到麦克风授权 | sdk-composer.test.ts；JSDOM/mock mediaDevices，确认授权重复调用抑制、卸载后释放音轨 |
| Session 切换、旧回调、停止、排队、历史、提问 | 保留的 agent-session-store.test.ts 回归；Web 旧路径实际指向 SDK 实现 |
| 独立 Store/SSE、端点/认证隔离、Abort 后迟到错误、服务端续跑 | sdk-session.test.ts；注入响应/回调进行故障模拟 |
| Batch B 自动投递/恢复与锁行为 | 现有 Control Plane AgentCall、dispatchChatTurn 等全量单测；不修改 Core 实现 |

## 本轮修复与重跑

独立宿主曾暴露 i18n peer 版本冲突与打包 JSX runtime 未显式配置；均已修正后重跑成功。Web getSession 类型缺少现有 pending_agent_calls 字段已补齐。新增事件测试修正了输入事件 target 与麦克风按钮定位。初次部分服务检查因本地依赖未安装无法执行，补齐后完整重跑；这些初始失败没有计入 PASS。

## 云端 CI 锁文件修复

首轮云端 CI 中，Web、独立 SDK 宿主及其余服务检查通过；CP/Skills/Knip 在安装 CP 依赖时因锁文件缺失 6 个 @emnapi 可选依赖条目失败。在无 node_modules 的独立临时目录使用与 CI 相同的 npm 10.9.9 补全锁文件；没有删除锁条目，也没有改变已有依赖版本。修复后的最新 HEAD 云端结果以 PR Checks 为准。

## 尚未验证

真实 Hosted Provider 凭据、metadata/tags 权限、CDP/Live View、真实文件下载；浏览器视觉、真实录音/ASR及网络异常；多用户/团队权限与真实 AgentCall 进程重启、断网和数据库故障注入；双架构 Docker、镜像拉取和部署健康。Batch A 未完成的真实故障注入必须在正式发布前合并评估。没有执行生产数据迁移或生产压力测试。

本地详细日志位于 .git/batch-c-final-*.log、batch-c-validation.json、batch-c-sdk-release-*.log 和 batch-c-lint-*.log；这些是本地诊断文件，不作为仓库交付内容。可复现命令为各工作区现有 tsc/test/build 脚本，以及 internal/ui-sdk 的 build、test:host；远端日志由 PR Checks 保留。
