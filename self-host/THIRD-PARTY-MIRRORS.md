# QAP 第三方镜像同步

本清单覆盖 self-host 基础依赖、离线 registry bootstrap 和可选 OpenSandbox 参考版本。镜像仍归其上游项目所有，原始镜像内容、许可和通知不修改；发布前维护者必须确认再分发许可。AFS 与 chromium-headful 已有独立发布机制，不重复同步。用户自选 Sandbox 镜像、集群 CNI/K3s 等不属于此清单。

| ID | 上游 | QAP GHCR |
| --- | --- | --- |
| gotenberg | `docker.io/gotenberg/gotenberg:8` | `ghcr.io/xuyooo/qap/gotenberg:8` |
| coturn | `docker.io/coturn/coturn:4.6` | `ghcr.io/xuyooo/qap/coturn:4.6` |
| postgresql | `ghcr.io/cloudnative-pg/postgresql:16` | `ghcr.io/xuyooo/qap/cloudnative-pg-postgresql:16` |
| cnpg-operator | `ghcr.io/cloudnative-pg/cloudnative-pg:1.28.1` | `ghcr.io/xuyooo/qap/cloudnative-pg:1.28.1` |
| nfs-server | `ghcr.io/obeone/nfs-server:2.2.3` | `ghcr.io/xuyooo/qap/nfs-server:2.2.3` |
| nfs-provisioner | `registry.k8s.io/sig-storage/nfs-subdir-external-provisioner:v4.0.2` | `ghcr.io/xuyooo/qap/nfs-subdir-external-provisioner:v4.0.2` |
| node | `docker.io/library/node:22-bookworm` | `ghcr.io/xuyooo/qap/node:22-bookworm` |
| python | `docker.io/library/python:3.12-bookworm` | `ghcr.io/xuyooo/qap/python:3.12-bookworm` |
| golang | `docker.io/library/golang:1.23` | `ghcr.io/xuyooo/qap/golang:1.23` |
| pause | `registry.k8s.io/pause:3.9` | `ghcr.io/xuyooo/qap/pause:3.9` |
| registry | `docker.io/library/registry:2` | `ghcr.io/xuyooo/qap/registry:2` |
| opensandbox-controller | `docker.io/opensandbox/controller:v0.2.0` | `ghcr.io/xuyooo/qap/opensandbox-controller:v0.2.0` |
| opensandbox-server | `docker.io/opensandbox/server:v0.1.14` | `ghcr.io/xuyooo/qap/opensandbox-server:v0.1.14` |
| opensandbox-execd | `docker.io/opensandbox/execd:v1.0.16` | `ghcr.io/xuyooo/qap/opensandbox-execd:v1.0.16` |

## 发布步骤

1. 合并工作流后，在 Actions → Mirror third-party images → Run workflow 选择 all 或单个 ID。需要仓库 Actions 写包权限；现有包如不允许该仓库写入需先配置包访问。首次创建包后检查可见性，按需公开或配置 pull 凭证。
2. 工作流以源 tag 解析 manifest digest，按 digest 复制全部平台，要求目标 digest 完全一致；任何镜像失败即停止，不以单架构重新打包替代。下载 third-party-image-digests 工件追踪发布证据。上游 release tag 可能移动；生产建议使用报告中的目标 digest 固定版本。
3. 镜像均验证可拉取后，按需将 values.env.ghcr-mirrors.example 的变量合入现有 values.env。此 PR 不更改默认 REGISTRY/PLATFORM_IMAGE_PREFIX、不改已发布的一方镜像、不自动部署。

## 使用范围和后续切换

- 上述 env 示例覆盖现有安装器支持的 8 个第三方镜像变量。OpenSandbox 可在单独 Helm values 中设置 controller/server image.repository 与 execd_image（保留原 tag）。
- CNPG operator 和 NFS provisioner 的 connected 安装路径仍使用上游 manifest/chart；离线模式原有 re-tag 路径保留。registry:2 仍作为本地 bootstrap 镜像。它们已纳入发布清单，但要让安装器完整默认使用 GHCR，还需单独验证 prereq 安装和离线加载路径再切换；不要将已镜像成功等同于已替换全部部署引用。
- 使用官方镜像名创建的动态 sandbox 任务不会自动改写镜像地址。需要时由调用方显式指定对应 GHCR 地址。
- 在默认切换前验证 AMD64/ARM64（以每个上游实际支持的平台为准）、匿名拉取或鉴权、render-only、CNPG/NFS/registry bootstrap、OpenSandbox 和离线打包恢复。当前 PR 不声明这些运行验证已完成。
