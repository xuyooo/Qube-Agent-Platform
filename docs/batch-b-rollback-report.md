# Batch B 回滚方案

目标代码版本：Batch A 877134736d42b70dbfde5b8b493dc3e69d35f9c8。回滚是操作方案，本轮没有操作线上服务。

1. 暂停新的请求和自动触发入口，等待可结束的调用收尾；导出 agent_calls 中 running / pending 记录以及对应 Session 消息，保留 delivery_note / error。备份数据库与当前镜像标识。
2. 停止所有 Batch B 控制面副本，确认旧 sweep 不再运行，再部署指定 Batch A 的控制面及其匹配 Web。不能用混合 A/B 副本代替回滚。
3. 保留 agent_calls 表和 schema_migrations 中的 148 记录，不执行 DROP、不重写历史消息。A 不读取该新增表；保留表是防止丢失审计数据，不是代码兼容层。
4. A 不会恢复 B 的异步结果自动投递。对导出的待处理调用人工检查结果，必要时通过正常会话入口恢复处理；不要直接把 delivery 改为 delivered，也不要批量重放可能有副作用的调用。
5. 检查登录、权限、普通聊天、会话读取与原有 Teamwork 路径，确认 A 基线镜像集合一致。再次升级 B 时，先处理遗留 pending 记录，避免恢复扫描带来意外续跑。

迁移 SQL 的事务回滚已在嵌入式 PostgreSQL 中测试。上述容器切换、真实数据库备份恢复及业务回滚尚未演练，必须在预发布环境验证。单纯回退 Git 不会自动处理已经发生的 Agent 外部副作用。
