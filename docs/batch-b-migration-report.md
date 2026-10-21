# Batch B 数据迁移与版本契约

## 范围

基线为 Batch A 877134736d42b70dbfde5b8b493dc3e69d35f9c8。新增 control-plane/migrations/148_agent_calls.sql，创建 agent_calls 和三个部分索引；不修改已有 Session / Workspace / Teamwork 数据，不回填历史调用。没有 Kanban Task / Board 字段。

表保存调用双方的 Session / Workspace、原调用用户、执行结果、结果快照、提问通知状态、投递状态、重试次数、租约令牌与期限、最后完成时间。故意不设置 Session 外键：删除会话后仍需保留调用记录并明确失败或停止投递。结果快照属于会话数据，数据库备份、访问权限与保留策略必须覆盖此表。

## 部署入口

control-plane/src/services/db/pool.ts 的 initDb 顺序读取 migrations，通过事务与 schema_migrations 记录执行。src/index.ts 在启动服务前等待 initDb。control-plane/Dockerfile 第 129 行复制整个 migrations 目录，因此新控制面镜像启动时会自动执行 148，无需另加 install.sh 命令。迁移失败不能当作部署成功。

正式发布使用单一迁移执行实例先完成初始化，再扩容其余控制面副本；本轮没有为现有迁移器引入跨副本迁移锁。不要在未验证环境中同时首次启动多个迁移实例。

本轮只在嵌入式 PostgreSQL 测试中执行该 SQL，未连接生产数据库。测试覆盖事务回滚、重复执行、状态约束、索引相关查询和租约竞争。没有执行完整生产数据规模迁移，也没有把单连接模拟当作多副本验收。

## 当前版本契约

- AgentCall 执行状态为 running / ended / failed；投递状态为 pending / delivered / consumed / dropped。
- Session 列表、详情和同步 Chat 响应新增必需 pending_agent_calls。Web 与 API Skill 同步更新，不添加旧版本字段缺失回退。
- pending_agent_calls 为零表示没有待自动推进的工作，不能单独证明任务成功。失败结果及 needs_input 仍须处理；进入人工提问状态的调用会暂停自动推进。
- 自动投递适用 api / web 会话及受追踪的嵌套 agent 会话；定时任务和聊天连接器不新增自动投递。
- 保留 QAP 原有权限检查和消息封装，自动投递前重新检查原调用者对父工作区的权限。没有增加通用工作流或事件总线。
- 仅从指定 Batch A 升级到最终 Batch B 支持本次发布。前两个开发提交不是可独立部署版本，不能先部署其中的早期 148 再覆盖 SQL；如已使用开发版本建表，须先单独核对表结构。

## 镜像与构建

必须重建并同步发布控制面镜像（内含 Web 静态文件及迁移）。本批未改 agentcore、scheduler、memory-fuse 运行代码，不要求因 B 单独重建它们；仍需保留 Batch A 要求的镜像版本。UI SDK 的 AgentCall 结果展示已更新，其他消费方需构建并升级相应包。本轮仅本地构建，没有发布 npm、构建云端镜像或部署。
