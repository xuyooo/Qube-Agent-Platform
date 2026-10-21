# QAP Batch A 实施与验证报告

日期：2026-10-21。工作分支：`codex/qap-batch-a`。

## 范围与版本

- QAP 固定基线：`0758e7e42782da045b3c59e1a7cdeb915e4a6224`。
- NAP 固定参考：`81c81e575e5997089c0a21b5b0843186ee0d76fd`。
- 开始时原分支为 `tw2/docs-2.2.10-baseline-sync`，HEAD `701c444`，比指定基线多两个文档提交；原分支保留，独立分支从指定基线创建。
- 阅读指定 NAP 提交并按 QAP 路径适配，没有跨仓库 cherry-pick。
- 本批八项代码均已实现。生产验收尚未完成：真实 Linux、模型、远程 K8s、AFS 和 PostgreSQL 故障注入未执行。
- 未 push、合并、构建云端镜像或部署。用户原有未跟踪文件没有纳入提交。
- 未引入 Memory Reflect、AgentCall、148 migration、Browser provider、UI SDK Store/Composer 迁移或新 Agent Core。

## Change Report

| 项目 | NAP 参考 | QAP 实现文件及行为 | 与 NAP 的差异 |
| --- | --- | --- | --- |
| A1 SSE | `18f5a4614`、`650b1f2e9` | `internal/sse-consumer/src/read-sse.ts` 按片段扫描和拼接，处理 CR/LF/CRLF、BOM、跨块 UTF-8；`control-plane/src/lib/truncate-tool-output.ts` 和 `sse.ts` 在广播 completed tool_result 前应用截断，复用持久化截断语义 | 补充 UTF-8 边界回退，防止截断生成替换字符；小事件保留原始 JSON；Parser 测试加入 CP 常规测试入口 |
| A2 Claude | `117ec78bc` | `agents/claude-code/src/agent.ts` 保持 prompt 输入流，启用 session state 事件，首个 result 后的 idle 才释放，finally 清理 | 增加 abort 监听释放输入，避免中断时等待输入与 finally 互锁；保留 QAP turn 身份保护 |
| A3 ACP | `3c671b9a8` | `internal/acp-adapter/acp-bridge.ts`、`acp-server.ts`、`agents/codex/src/index.ts`：Codex 按需检查 worker，连续两次丢失结束轮次；取消超时后终止旧桥接，下一轮重建 | `/proc` 不可读时保守处理；确认丢失后调用 destroy 清理；公共取消行为供 Codex/Goose/DSH 使用，worker 检查仅 Codex 开启 |
| A4 Remote Static | `13edc4c5a` | `control-plane/src/lib/workspace-address.ts`、`services/db/environments.ts`、`services/env-projection.ts`：传播 runtime_mode，Static 使用无 ordinal Service 代理地址 | 保留 QAP 现有代理架构；不修改 Autoscale 的地址选择 |
| A5 AFS | `9ac9e876d` | `control-plane/src/routes/workspaces/afs-shares.ts`：已有 share 缺少 owner member 时复用目录/密钥，重新挂载并补 owner membership | 增补失败/并发状态测试及只读诊断 SQL；不重置其他成员权限，不删除共享目录 |
| A6 文件名称 | `81c81e575` | `web/src/hooks/file-instance-label.ts`、`useWsApps.ts`：解码异常时显示原文件名，保存的 viewingPath 保持不变 | 提取纯函数便于测试，未重构窗口生命周期 |
| A7 纯图片 | `6d5110c5b` | `web/src/stores/agent-session-store.ts`：允许有图片无文字，界面不构造空文本块，API 使用空格占位满足当前接口 | 适配 QAP Web store，未迁往 UI SDK；同步覆盖非当前会话发送、排队、session_busy 草稿重发 |
| A8 丢失任务 | `4e8b8e1a3` | `scheduler/src/lost-job.ts`、`handler.ts`、`index.ts`：专用 DLQ，启动创建并更新既有队列，仅 monitor heartbeat/expiry 失败通知原渠道 | 不吞队列配置错误；发送 HTTP 错误返回失败，30 秒发送超时；重试错误保留 monitor 原因，防止 pg-boss 覆盖 output 后跳过重试；不记录通知错误响应正文或原任务载荷 |

没有额外架构重构。Claude 与 Scheduler 增加 Vitest 开发依赖和测试脚本；逐项比较两份 lockfile，已有依赖版本未改变。CI 增加 Claude、共享 ACP、Scheduler 回归执行。SSE Parser 通过 CP 测试配置执行。

### 功能提交

1. `38eb1ea` SSE 线性解析与工具结果广播截断
2. `c16df19` Agent 输入流生命周期与异常轮次恢复
3. `151668e` 远程静态工作区 Service 代理寻址
4. `9eddd7e` AFS 半完成共享创建恢复
5. `83222ef` 文件窗口名称解码与纯图片消息发送
6. `a32d9fd` Scheduler 丢失任务通知与失败重试

另有交付收尾提交：整理测试格式、把 Parser 加入常规测试、性能复现脚本、AFS 诊断 SQL 与本报告。

## Test Report

测试在 Windows 本机执行，模拟测试不等价于真实环境故障注入。

| 命令（仓库根目录执行） | 结果 |
| --- | --- |
| `npm --prefix control-plane test` | 53 个文件、613 项通过；执行时尚未加入独立 Parser 文件 |
| `npm --prefix control-plane test -- read-sse.test.ts truncate-tool-output.test.ts afs-shares.test.ts` | 最终版本 49 项通过：Parser 34、截断 8、AFS 7；后两项已包含在上述 613 项内 |
| `npm --prefix web test` | 16 个文件、227 项通过 |
| `npm --prefix web test -- src/stores/agent-session-store.test.ts src/hooks/file-instance-label.test.ts` | 格式整理后再次运行，68 项通过，包含于上述 227 项 |
| `npm --prefix agents/claude-code test` | 5 项通过 |
| `npm --prefix internal/acp-adapter test` | 16 项通过 |
| `npm --prefix scheduler test` | 7 项通过 |
| `npm --prefix control-plane run build` | PASS |
| `npm --prefix web run build` | PASS，包含 `tsc -b`；存在大 chunk、过期 Browserslist、第三方 PURE 注释警告 |
| `npm --prefix scheduler run build` | PASS |
| `npm --prefix agents/claude-code run build` | PASS |
| `npm --prefix agents/codex run build` | PASS |
| `npm --prefix agents/goose run build` | PASS |
| `npm --prefix agents/dsh run build` | PASS |
| `control-plane/node_modules/.bin/tsc --noEmit -p control-plane/tsconfig.json` | PASS |
| `scheduler/node_modules/.bin/tsc --noEmit -p scheduler/tsconfig.json` | PASS |

上述去重共 902 项通过。各项先建立失败用例再实现；Scheduler 初始缺少目标模块导致 suite 加载失败，属于接口缺失的红测，不是运行时重现。测试日志保留在本机 `.git/batch-a-*.log`，不提交日志。

### 覆盖及限制

- SSE：CR/LF/CRLF 各种跨块组合、BOM、多行、空数据、UTF-8、流错误与结束、5000 组确定性模糊输入、32 MB 单行；31/32/64 KB 和 10 MB tool_result，NUL、错误标志、多段内容、不修改原事件。现有 SSE replacement 回归通过。尚未对真实 CP→Web/Scheduler 长事件流做端到端负载压测。
- Claude：首个 result 后继续接收后台结果和权限请求、启动 idle 不结束、error/disconnect/interrupt 释放、旧轮次不清掉新控制器；使用 SDK mock，未调用真实模型或后台子 Agent。
- ACP：模拟连续 worker 缺失、恢复、idle 不误杀、不可读 `/proc`、取消不响应、取消抛错、正常取消、超时恢复、下一轮和同会话后续轮次隔离。Goose/DSH 通过共享逻辑测试及各自编译，未对三个真实 CLI 分别执行杀进程和跨 session 压测。
- Remote Static：地址与环境投影 33 项回归包含 ready 和零副本、Autoscale 保持原行为；尚未访问真实远程环境的文件、终端、reload。
- AFS：7 项包含 owner 缺失恢复、保留其他只读成员、挂载失败、重试、模拟并发唯一约束；没有真实 PostgreSQL/AFS 并发与断连测试。
- Web：名称解码与保存布局数据往返测试，不包含浏览器重新加载窗口实测；纯图片包含排队、草稿重发、非当前会话与已有文本行为，尚未真实模型识图。
- Scheduler：heartbeat/expiry 分类、正常错误/成功/manual/缺坐标跳过、Slack/WeCom 路由、HTTP 503 后重试及 worker 重注册、既有队列幂等配置；HTTP 与 queue 都是 mock，未杀真实 Scheduler 进程，没有真实渠道投递或 PostgreSQL DLQ 故障注入。

### 静态检查

- `git diff --check` 通过。
- 新增/扩展测试文件针对性 Biome 检查通过。
- 对全部改动 TS 使用 `biome check --config-path=biome.base.json` 未通过，含既有文件排版/CRLF 差异；关闭 formatter 后仍有 5 个既有 ACP lint 错误和 1 个无效 suppression 警告：ANSI 控制字符正则、错误文案模板拼接、未标注的 `let result`。这些代码在基线已经存在，本批未做无关清理。不能宣称 lint 全绿。
- 最初从根目录运行 Biome 未加载预期配置，产生无关排版；已备份并恢复此前已提交的实现文件，再按明确配置整理新增测试。没有丢弃本批功能改动。

### 性能对比

每次单独 Node 进程，合成单个 SSE data 行，立即供给所有 chunk；一次测量，无稳定性统计。timerDelay 是解析期间零延时定时器的实际延迟，不是线上事件循环 p99；maxRSS 包括输入分配和 tsx 运行时。

| 实现 | 数据/分块 | 耗时 | timerDelay | 进程峰值 RSS |
| --- | --- | --- | --- | --- |
| 基线 | 8 MiB / 4 KiB | 10584 ms | 10586 ms | 336804 KiB |
| 本批 | 8 MiB / 4 KiB | 47 ms | 47 ms | 120028 KiB |
| 本批 | 32 MiB / 16 KiB | 123 ms | 123 ms | 247764 KiB |

复现脚本：`internal/sse-consumer/benchmark.mjs`。它接收 parser 文件绝对路径、字节数、chunk 字节数，并检查收到的数据长度。例如：

```powershell
node --import ./control-plane/node_modules/tsx/dist/loader.mjs internal/sse-consumer/benchmark.mjs C:/workspace/agent-platform/internal/sse-consumer/src/read-sse.ts 8388608 4096
```

基线文件需从 `git show 0758e7e:internal/sse-consumer/src/read-sse.ts` 导出到临时 `.ts`，用同一脚本单独进程测量。不是将基线重新写回工作区。

## Migration & Deployment Report

- **不新增业务 SQL migration**。`control-plane/scripts/diagnose-afs-shares.sql` 仅 SELECT，未在数据库执行，不接入安装脚本自动修改数据。
- Scheduler 启动先创建并更新 `agent-session-dead-letter`（retryLimit=2，retention=7 天），再创建/更新 `agent-session` 的 deadLetter 指向；保留 retryLimit=0、12 小时过期、120 秒 heartbeat。启动配置失败直接失败，避免静默漏配。
- Queue 配置更新只保障新 job；已经入队的 job 是否带有 dead-letter 元数据取决于其创建时配置。本批不批量修改历史 job，也不补发旧失败记录。
- AFS 沿用现有表与唯一约束。旧半完成记录通过同名创建请求恢复，不批量清库，不轮换密钥。
- 需要统一固定版本构建六个镜像：`qap-cp`（含 Web）、`qap-scheduler`、`qap-agent-claude-code`、`qap-agent-codex`、`qap-agent-goose`、`qap-agent-dsh`。本次仅本地源码构建，不是镜像构建成功。
- 推荐：先审查本报告并完成阻塞验收，再固定同一 release SHA 构建六镜像；记录原镜像 digest、部署对象、队列配置；先 CP 小流量，随后四种 Agent，最后 Scheduler；观察真实会话、挂载和 DLQ 后扩容。发布时应安排在途任务与旧运行实例的排空/重建，不假设更新镜像会自动更新全部已有实例。

### 回滚

1. 保存发布前的精确镜像 digest/部署 revision；将六个对应 Deployment/StatefulSet 恢复至记录的版本，按实际命名空间运行 `kubectl rollout undo deployment/<实际名称> --to-revision=<记录值> -n <实际命名空间>`，或通过现有 Helm/GitOps 回退同一 release。随后检查 rollout 状态；本报告不猜测集群名称。
2. AFS 已补齐的 owner membership 保留；无逆向 SQL，不删除新建或复用的目录，不回收其他成员权限。
3. Scheduler 旧代码不会主动清除已有 deadLetter 配置。最安全的短期回滚是保留专用队列与积压，不让共享 dead-letter logger 消费它（payload 含 token/图片），并明确暂时停止丢失通知。
4. 如果必须关闭后续新任务的 DLQ 路由，先停止新 Scheduler 实例并排空其 worker，在确认实际 pg-boss schema、备份队列配置后由运维执行下面受限语句。本地 pg-boss 默认 schema 为 `pgboss`；自定义 schema 必须替换。不要删除队列、历史 job 或批量改 job 数据。

```sql
BEGIN;
SELECT name, dead_letter FROM pgboss.queue
WHERE name = 'agent-session' FOR UPDATE;
UPDATE pgboss.queue SET dead_letter = NULL
WHERE name = 'agent-session'
  AND dead_letter = 'agent-session-dead-letter';
COMMIT;
```

此 SQL 是回滚操作示例，不是 migration，未执行。已创建 job 上的 dead-letter 元数据仍保留；重新启动新版本会重新配置队列。检查到当前 pg-boss 的 `updateQueue` 生成 deadLetter 字符串的实现，不使用未经验证的 `updateQueue({deadLetter:null})` 回滚写法。

## 剩余风险及最终状态

- AFS 首次并发创建时，外部目录创建发生在数据库唯一约束之前，可能遗留未关联外部目录。失败请求可重试收敛，已有共享与成员不会被删除；需要真实并发验收和运维核对，不能自动盲删。
- 通知是至少一次语义：渠道发送成功而数据库 ack 前崩溃可能重复通知；连续失败超过 2 次重试后仍可能未送达。没有新增去重表或恰好一次承诺。
- `/proc` 检查依赖 Linux 进程可见性，不可读时保守保留；真实模型 SDK 的 idle/background 行为必须实测。
- 所有外部验证标为 BLOCKED，不把单测替代真实故障注入。没有提供可用的测试集群、数据库与模型会话；本次也未获准部署或发送真实渠道消息。

| 项目 | 实现 | 本地功能测试 | 外部验收 | 整体 |
| --- | --- | --- | --- | --- |
| A1 SSE | 完成 | PASS | BLOCKED：端到端负载/故障流 | PARTIAL |
| A2 Claude | 完成 | PASS | BLOCKED：真实后台 Agent/权限 | PARTIAL |
| A3 ACP | 完成 | PASS | BLOCKED：Linux 三 CLI 故障注入 | PARTIAL |
| A4 Static | 完成 | PASS | BLOCKED：远程文件/终端/reload | PARTIAL |
| A5 AFS | 完成 | PASS | BLOCKED：真实 AFS/DB 并发 | PARTIAL |
| A6 文件名 | 完成 | PASS | BLOCKED：浏览器布局重载 | PARTIAL |
| A7 纯图片 | 完成 | PASS | BLOCKED：真实识图完整链路 | PARTIAL |
| A8 Scheduler | 完成 | PASS | BLOCKED：进程被杀、PG DLQ、渠道投递 | PARTIAL |
| 本地构建/类型检查 | 完成 | PASS | 镜像构建未执行 | PARTIAL |
| 全部改动 lint | 已执行 | FAIL：既有 ACP 规则及排版问题 | 不适用 | FAIL |

代码交付已完成；当前不满足方案的完整上线验收条件，不能标为整体 PASS。
