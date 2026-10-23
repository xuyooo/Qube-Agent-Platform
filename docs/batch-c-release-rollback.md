# Batch C 发布与回滚

## 范围与状态

本批只实施源码、自动化测试与源码 PR；没有发布 SDK 到 npm，没有创建 Release Tag、推送镜像、部署或合并 main。数据库没有新增 SQL Migration，Batch B AgentCall 结构及 Core 投递逻辑保持不变。

需要重建的镜像仅 `ghcr.io/xuyooo/qap/qap-cp`，它包括 Control Plane 与 Web。新增 `neu-browser-mcp@0.2.3` 属于 CP 运行依赖；SDK 从源码编入 Web。无需重建 Claude Code/Codex/Goose/DSH Agent 镜像。未改这些 Agent 的源码与依赖。

## 正式发布步骤（另行授权执行）

1. 确认源码 PR 的所有 CI 通过，审阅报告中的外部验收项后合并。
2. 记录实际 main HEAD；通过现有 Build & push images 手动工作流选择 `service=qap-cp`，构建该提交。
3. 验证 AMD64、ARM64 与 Manifest Merge；核对产物标签 `latest` 和 Git SHA 前 12 位及其 digest。
4. 若正式版本计划使用 Tag，单独创建实际版本 `qap-cp-vX.Y.Z`；不使用示例值作为发布版本。
5. 保存部署前 CP digest；仅更新 CP 镜像，检查鉴权、Browser MCP、提问/图片/语音、会话切换及 Batch B 异步结果续跑。
6. 记录部署、实例健康和外部验收结果后再宣布正式发布完成。

自托管 `IMAGE_TAG` 被多个平台服务共用。仅构建 CP 的 SHA 镜像后，不能把全部服务的公共 IMAGE_TAG 改成这个 SHA。需要按部署方式仅更新 CP 镜像；本批不新增 CP_IMAGE_TAG 或重构安装脚本。

## 回滚

- C1：先恢复 `BROWSER_BACKEND=qap` 及原 URL/凭据配置；必要时回滚 CP 镜像。Hosted 已创建浏览器需要在对应服务核对并释放；切换配置不会自动迁移或删除外部浏览器。
- C2/C3：恢复上一版 CP（内含 Web）及对应源码构建。API 与已有草稿存储格式不变；页面刷新前保存尚未发送内容。
- C4：恢复基线 `bc0393f0101a2d5a55069474d1ffd5a79ef7ff4a` 对应 CP/Web 构建或反向回滚 Batch C 的客户端提交。旧路径只是同一 SDK 实现的重导出，不能同时运行第二套 Store。
- 不删除或回滚 AgentCall 数据、不停用 Core 异步投递、不运行 SQL 逆迁移。可变 latest 不足以可靠回滚，必须使用已记录 digest 或稳定版本标签。

## 发布前仍需真实环境验证

Hosted API Key、服务端 metadata/tags 隔离、CDP/Live View/文件操作；真实麦克风与 ASR、浏览器视觉表现；跨用户权限和真实 AgentCall/Turn Lock/重启断网场景；双架构镜像、镜像拉取和数据库连接。Batch A 报告中尚未完成的真实环境故障注入同样属于发布前门禁。本地单测、JSDOM 或构建成功都不等同于这些验收完成。
