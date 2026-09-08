# 运维指南

## 环境与拓扑

生产和预发布均使用 Linux、Docker Compose、Caddy、一个 Node.js 应用实例和各自独立的 SQLite 数据卷、域名、容器及密钥。应用端口只在内部网络提供给 Caddy，禁止直接暴露公网。预发布只使用虚构测试数据，严禁复制生产预约或其他个人数据。

服务器只拉取已构建的镜像，不在服务器拉取源码或现场构建。镜像以 Git commit SHA 标记为不可变版本；预发布和生产必须运行同一镜像摘要。部署凭据分别保存在 GitHub `staging` 和 `production` Environments，生产环境必须人工批准。

容器交付入口分别为 `compose.staging.yaml` 和 `compose.production.yaml`，项目名为 `jiuyue-staging` 和 `jiuyue-production`。各自拥有带项目名前缀的 `staging_data` / `production_data`、Caddy data/config 卷和默认网络；禁止用 `-p` 改成相同项目名。两套配置均由各自 Caddy 占用主机 TCP 80/443 和 UDP 443，因此应部署到独立主机/IP，不能在同一主机默认地址同时启动。应用无主机端口映射。

分别复制 `deploy/staging.env.example` 为 `.env.staging`、`deploy/production.env.example` 为 `.env.production`（权限 0600），配置独立的密码哈希、随机会话密钥和 `STAGING_DOMAIN` / `PRODUCTION_DOMAIN`。两份 `APP_IMAGE` 填写同一已验证的 `registry/repository@sha256:...`，示例摘要与域名不能用于上线。环境文件属于敏感数据，不得提交；不要将展开后的 `compose config` 输出放入共享日志。使用明确的文件参数，避免默认读取旧 `.env`：

```bash
docker compose --env-file .env.staging -f compose.staging.yaml config --quiet
docker compose --env-file .env.staging -f compose.staging.yaml pull
docker compose --env-file .env.staging -f compose.staging.yaml up -d --wait
docker compose --env-file .env.production -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.production.yaml pull
docker compose --env-file .env.production -f compose.production.yaml up -d --wait
```

`STAGING_ENV_FILE` / `PRODUCTION_ENV_FILE` 仅用于显式选择对应服务环境文件，默认分别为 `.env.staging` / `.env.production`；`--env-file` 负责 Compose 变量展开。生产操作仍须经过下述备份与审批流程。旧 `compose.yaml` 和 `compose.app-only.yaml` 是兼容入口，不具备这两套环境隔离约束。

镜像固定 Node.js 24 Alpine 基础摘要，用锁文件执行 `npm ci --omit=dev --ignore-scripts`，只复制运行时源码（包括 SQLite SQL 迁移）、生产依赖、公共资源和健康脚本。构建时将 OpenSSL 库升级到至少 3.5.8-r0，最终镜像移除 npm/npx/Yarn；不在运行容器安装依赖。Alpine 修复包来自构建时仓库，因此重建结果需重新扫描并记录最终摘要，不能仅凭基础摘要推定完整镜像相同。应用以 `node`、Caddy 以 UID/GID 1000 运行；两者根文件系统只读、先删除全部 capabilities、禁止提权，仅数据卷和有大小限制的 `/tmp` 可写。应用保持零 capabilities；Caddy 唯一加回 `NET_BIND_SERVICE`，用于官方二进制的文件 capability 和绑定 80/443，不能扩展该例外到应用。既有卷升级前需核对应用数据和 Caddy 子目录对 UID 1000 可写，不能靠放宽整个根文件系统权限解决。

## 发布、迁移与回滚

目标发布流程是合并 `main` 后构建镜像并部署 staging，执行迁移和线上冒烟测试。当前 CI 只构建和扫描镜像；自动部署、外部 staging 演练及生产发布尚未由本任务实现或验证。应用启动时自动执行版本与校验和受控的迁移，失败则阻止启动。预发布验证通过、生产审批完成后，按以下顺序发布：

1. 创建一致的 SQLite 备份并保存校验结果。
2. 部署已验证的同一 SHA 镜像。
3. 执行允许的迁移，检查健康与生产烟测。
4. 记录 commit SHA、镜像摘要、迁移版本、部署时间、审批人、检查结果和回滚目标。

应用、迁移或健康检查失败时停止发布并切回上一镜像。迁移须向前兼容；破坏性改动以扩展—迁移—收缩分次交付，确保回滚版本能读取数据库。

## 备份与恢复

当前仓储已切换到 SQLite。旧 JSON 备份/恢复脚本尚待后续运维任务替换，不能用于 `site.db`；不得用旧 JSON 文件覆盖 SQLite。正式切换仍需完成 SQLite 备份恢复验证。

- 每日执行 SQLite 在线备份并生成 SHA-256；至少一份复制到服务器外受控存储。
- 自动验证备份完整性，每月进行实际恢复演练。
- 恢复前确认备份、目标和服务状态；恢复后执行健康检查、数据核对和必要的删除清单。
- 备份、恢复与现有交付脚本的操作细节见 [README](../README.md)；上线核对见 [DEPLOYMENT-CHECKLIST.md](../DEPLOYMENT-CHECKLIST.md)。

备份包含个人信息，必须加密、限制访问并按保留政策清理。不得在应用仍写入时手工覆盖数据；没有已验证备份时禁止清理数据卷或使用会删除卷的命令。

## 监控、日志与事件

监控首页、健康接口、数据库读写、磁盘空间、容器重启、证书期限和备份结果。健康检查区分进程存活和依赖就绪；数据库无法读写时，就绪检查必须失败，避免继续接收生产流量。系统正常时保持安静，仅在故障或需人工处理时告警。

`GET /api/health/live` 返回 `live: true` 只说明 HTTP 进程能响应，不依赖数据库。`GET /api/health` 是就绪检查：成功响应含 `live: true`、`ready: true`、`database: "ready"`；它执行 SQLite 读取及 SAVEPOINT 内真实更新，随后回滚，不改变迁移记录。关闭、锁定、只读或写入失败时返回安全的 503 错误封装，不泄露数据库细节。业务存储失败后，就绪检查最多每 5 秒尝试一次固定的恢复探测，在同一个回滚 SAVEPOINT 中对预约、统计、会话和审计表执行最小合法的虚构写入；仍有表级写入故障则继续返回 503。探测成功并完整回滚后清除故障标记，无需普通请求或后台清理恢复服务。无关业务操作成功不会清除故障标记；探测不保留用户数据、不重试失败的用户请求、不提交测试行。

镜像默认执行 `node deploy/healthcheck.mjs readiness`；需要单独检查进程时执行 `node deploy/healthcheck.mjs liveness`。脚本读取容器 `PORT`，超时或无效响应返回非零，不打印响应和秘密。Docker 每 30 秒检查、连续 3 次失败标记 unhealthy；Compose 启动时等待应用健康。Caddy 每 10 秒检查就绪状态，失败后停用上游，恢复后重新接入；检查之间存在短暂延迟。单纯 unhealthy 不会触发 Docker 的 restart 策略，须配合监控与人工处置，禁止把重启策略当作数据库修复机制。

使用带请求 ID 的结构化 JSON 日志。日志不得记录密码、会话 Cookie、完整电话、预约正文或其他不必要个人信息；为日志、统计事件、预约数据和备份分别制定保留期限。

事件响应时：限制受影响功能或流量，保留不含敏感信息的证据，确认最近备份与回滚版本，恢复服务后验证健康、数据与删除清单，并记录原因、影响和后续修复。安全边界和凭据处理见 [SECURITY.md](../SECURITY.md)。

## 生产切换

旧 JSON 导入使用 Node.js 24+。先停止旧实例写入并为源文件生成受控备份；在独立位置指定新的数据库路径，禁止原位覆盖源文件。先预检，再导入，再重复预检核对：

```bash
node tools/import-json-data.mjs --source ./protected/site-data.json --database ./data/site.db --dry-run
node tools/import-json-data.mjs --source ./protected/site-data.json --database ./data/site.db
node tools/import-json-data.mjs --source ./protected/site-data.json --database ./data/site.db --dry-run
```

源文件必须是 `version: 1`、含 `inquiries` 和 `events` 数组的对象；记录需要 ID、有效时间和对应隐私/统计同意记录。工具不补造同意信息；结构或记录无效时整次失败。来源字段在未允许归因的预约中清空，未知个人标识字段丢弃，referrer 仅保留来源站点。正常输出仅有两类记录各自的 `source`、`imported`、`skipped` 数量及 `dryRun`，每类应满足 `source = imported + skipped`。已有同 ID 记录和同一源中的重复 ID 均跳过，不覆盖已跟进的数据。

`--dry-run` 在内存中验证并用只读连接查询已有目标，不创建目标文件；其 `imported` 表示预计新增数。真实导入的全部业务记录处于同一个事务，任意失败统一回滚；首次建库/迁移可能已完成，空数据库可保留。导入不执行保留期淘汰，便于先核对全部记录；应用启动后按既有保留期与容量配置清理。源文件始终保持原样。验证关键字段时仅在受控后台查看，禁止把个人字段打印到日志。

切换时把 `DATA_PATH` 指向新 `site.db`，保留受保护的源备份；运行时不会自动导入或双写。回滚前确认旧源备份与新数据库的差异，新产生的 SQLite 数据不会自动同步回旧版本。

生产切换前必须完成 staging 全链路演练、旧数据导入核对以及备份恢复演练。确认 DNS、HTTPS、反向代理、密钥、监控与告警、回滚镜像和负责人可用；按发布流程切换后执行生产烟测。任何前置验证失败都应停止切换，修复并重新验证，而不是绕过检查。
