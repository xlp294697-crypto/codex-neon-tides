# 运维指南

## 环境与拓扑

生产和预发布均使用 Linux、Docker Compose、Caddy、一个 Node.js 应用实例和各自独立的 SQLite 数据卷、域名、容器及密钥。应用端口只在内部网络提供给 Caddy，禁止直接暴露公网。预发布只使用虚构测试数据，严禁复制生产预约或其他个人数据。

服务器只拉取已构建的镜像，不在服务器拉取源码或现场构建。镜像以 Git commit SHA 标记版本，以摘要固定不可变内容；预发布和生产必须运行同一镜像摘要。部署凭据分别保存在 GitHub `staging` 和 `production` Environments，生产环境必须人工批准。

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

仓库的 `.github/workflows/release.yml` 在本仓库 `main` 的 push CI 成功后触发，也可从 `main` 手动触发。验证作业要求待发布 SHA 仍为当前 `main` 且存在同 SHA 的成功 push CI；分支、失败 CI、fork/PR 运行不能发布。`workflow_run` 的 `github.sha` 是默认分支当时的 SHA，因此自动发布明确采用经验证的 `workflow_run.head_sha`，checkout、镜像标签和两个环境使用同一个提交。参见 [GitHub workflow_run 语义](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)。

发布作业构建一次 `ghcr.io/<owner>/<repository>:<verified-sha>`（仓库名转小写），扫描这次构建，再推送并获取 `sha256` 摘要；部署只使用 `ghcr.io/<owner>/<repository>@sha256:...`。CI 的本地构建不是发布镜像；发布重新扫描可避免基础包仓库更新导致构建与 CI 扫描对象不同。SHA 标签可被同 SHA 的重跑更新，不能当作不可变标识；摘要才是恢复和晋级依据。build 作业仅有 `contents: read` 与 `packages: write`；CI 验证独享所需 `actions: read`；部署作业只有 `contents: read`。所有 Action 固定完整提交 SHA。

staging 成功后，production 作业等待 GitHub `production` Environment 的 required reviewers 审批，再部署 build 输出的相同摘要。发布链使用同一 concurrency 组且不取消正在运行的发布；主机同时使用 `flock` 防止重叠。审批期间该发布仍占用串行链，新提交可能取代排队中的旧提交。不得绕过 staging 单独启动生产脚本。

应用启动及发布阶段执行版本与校验和受控的迁移，失败则阻止上线。发布顺序如下：

1. 创建一致的 SQLite 备份并保存校验结果。
2. 保存运行容器的前一摘要并拉取候选摘要；停止旧应用写入。
3. 执行允许的迁移，启动候选镜像并等待就绪，然后检查公开域名与身份验证。
4. 记录 commit SHA、镜像摘要、迁移版本、部署时间、审批人、检查结果和回滚目标。

`deploy/deploy-release.sh staging|production` 记录 `.release-state/<environment>/previous-image`、`candidate-image`、成功或回滚后的 `current-image`，以及对应的 `previous-bundle`、`candidate-bundle`、`current-bundle`、`backup-path`、`migration-result` 和 `result`。目录权限为 0700，文件为 0600；GitHub summary 记录提交和最终镜像，Environment 审批记录由 GitHub 保留。失败输出报告失败阶段、已验证备份路径和前后发布包路径，不打印应用日志、环境展开值或业务响应。每次发布的这些主机记录会被下一次更新，应将不含个人信息的发布元数据归档到受控审计系统。

前一摘要从实际运行容器读取，不能用猜测标签代替。前一发布包从 app/Caddy 容器的 Compose working_dir 与 config_files 标签核实；两者必须对应同一仍保留的发布包及单一环境 Compose 文件，且旧包不能与候选包为同一目录。旧 Compose 与 Caddyfile 必须保留原样；缺失、混用或覆盖旧包时在停止服务前拒绝发布，不能把候选配置当作恢复配置。备份失败时旧应用保持运行。

停止后的迁移、就绪或冒烟失败会切回旧发布包中的 Compose/Caddy 配置及固定的 Caddy 镜像，并使用前一 app 摘要强制重新创建 app 与 Caddy 两个服务。容器就绪后，通过公开 origin 执行健康、页面、资源和登录/会话/退出验证，成功才记录 `rollback=restored` 与恢复后的 current-image/current-bundle；包括 staging 回滚在内，恢复检查始终使用 production 模式，不新增询盘。仅应用健康不能证明代理已经恢复。如果任一服务启动或公开路径恢复检查失败，记录 `rollback=rollback-failed`、保留备份和前后发布包路径并要求人工恢复；发布自身始终非零退出。current 字段表示最后验证成功的部署，不应脱离本次 result 判断当前状态。

首次 staging 没有旧容器时可以初始化，失败则停止候选 app 与 Caddy；如果只有既存代理而没有应用，则拒绝自动接管。production 必须已有使用摘要的应用、可恢复的代理发布包和可验证的数据库，首次生产初始化属于单独审批的切换。脚本不删除数据卷、不恢复数据库备份、不逆向修改迁移历史。检查失败后的人工恢复须评估备份时间之后的新数据。

`deploy/release-db.mjs` 只允许保守的扩展 SQL：新建表、普通索引、为已有表增加无约束的可空 TEXT/INTEGER/REAL/BLOB 列。数据改写、删除、重命名、触发器、唯一索引及现有表的新约束都会拒绝；更复杂但可能安全的 SQL 也可能被拒绝，须单独设计审查，不能扩大匹配规则来绕过审批。整个迁移事务在失败时回滚。应用迁移器允许数据库含有高于当前镜像最高版本的历史，但当前镜像携带的迁移必须全部存在并匹配校验和，历史中缺失的中间版本仍拒绝，绝不自动 down-migrate。实际可回滚性仍依赖旧程序与新表结构兼容。

旧镜像还必须导出 `supportsForwardSchema = true` 才允许在已有数据库上自动添加迁移；首次从旧版迁移器升级应先发布没有新增 SQL 的兼容版本，再发布扩展迁移。破坏性收缩只能在旧版本退役后，安排后续单独批准的发布，不能进入这条自动回滚链。

### 环境配置与主机前提

在 GitHub 手动创建 `staging` 与 `production` Environments；将生产 required reviewers、禁止自行审批、禁止管理员绕过（组织策略允许时）和仅 main 部署分支规则配置妥当，再配置生产 secrets。工作流中的 `environment: production` 本身不会创建审批保护。功能是否可用取决于仓库可见性与 GitHub 套餐；不支持保护规则时不得宣称有人审门禁或启用生产自动发布。参见 [GitHub Environment 保护规则](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)。

两套 Environment 分别配置以下同名 secrets，值必须相互隔离：

| Secret | 用途 |
| --- | --- |
| `DEPLOY_HOST` | SSH 主机 DNS 名或 IPv4，TCP 22；不接受带命令的地址 |
| `DEPLOY_USER` | 专用部署账户；Docker 权限具有主机高权限，应限制其余用途 |
| `DEPLOY_PATH` | 已准备的绝对部署目录，如 `/srv/jiuyue`；不含空格、点或 shell 字符 |
| `DEPLOY_SSH_KEY` | 专用 SSH 私钥，使用主机端来源/账户限制并按政策轮换 |
| `DEPLOY_KNOWN_HOSTS` | 经独立渠道验证的完整 known_hosts 主机密钥记录；不临时信任 ssh-keyscan 输出 |
| `SMOKE_BASE_URL` | 对应公开 HTTPS origin，例如 `https://staging.your-domain.tld`；生产必须是生产域名 |
| `SMOKE_ADMIN_PASSWORD` | 对应环境管理员口令，用于登录/会话/退出；不放在命令行参数或传输包 |

目标主机需 Linux、Docker Engine、支持 `up --wait --wait-timeout` 的 Compose v2、Node.js 24+、OpenSSH、tar、grep 和 util-linux `flock`；部署账户须可创建发布目录、读 `.env.<environment>` 并操作本环境 Docker 项目。`DEPLOY_PATH/.env.staging` 或 `.env.production` 按前文先配置，Caddy 的 DNS/80/443/证书前提也须已就绪。私有 GHCR 镜像需要主机预先使用仅 `read:packages` 的受限凭据登录；工作流不会把写 registry 的 GitHub token 发送到主机。SSH 凭据严格验证 known_hosts，不开启 agent forwarding。

工作流只传输两份 Compose 文件、Caddy 配置及发布/备份/冒烟脚本，保存至 `releases/<sha>-<run-id>-<attempt>`，不传源码、`.env` 或数据库。服务器只拉取镜像，不构建。发布目录属于部署账户；挂载进只读非 root 容器的脚本和 Caddy 配置具有只读访问权限。环境数据卷仍由原 Compose 项目名固定，绝不能更改项目名。保留上一版本的发布目录供恢复；目录清理需另行按保留规则处理。Docker 重启按现有容器摘要恢复；手动 Compose 操作前必须显式导出记录的 `current-image` 为 `APP_IMAGE`，因为服务器 `.env` 内的初始标签不会被脚本重写。

### 冒烟与备份边界

`node deploy/smoke-test.mjs https://<domain> staging` 检查存活、数据库就绪、首页、隐私页、后台入口、CSS/JS、登录、会话，以及虚构询盘的创建、状态修改和删除；finally 中删除本次返回 ID 并注销会话。它不读取预约列表，不发送统计同意，不打印响应体、电话、Cookie 或凭据。只使用明确虚构内容与保留的示例电话号码。删除审计中允许保留非个人 ID 与动作。请求在服务器提交后断线、进程被强制终止或清理接口失败时可能遗留 staging 测试数据，必须在 staging 后台清理标有 Synthetic smoke 的记录；清理失败使发布失败，不会静默放行。

`node deploy/smoke-test.mjs https://<domain> production` 仅检查公开页面、健康及登录/会话/退出，禁止创建或修改询盘；必须明确给出环境参数，缺失或未知值立即失败。生产不运行写入式询盘测试，因为正常询盘插入会触发容量/留存淘汰，虚构记录也可能删除旧的真实记录。完整预约链路在同摘要 staging 上验证。生产登录会短暂创建会话，退出时删除；不是零写入数据库探测。

发布备份保存在各环境数据卷 `/app/data/release-backups/<UTC>-<pid>.db`，使用 SQLite online backup API 获取包括 WAL 已提交事务的一致副本，检查完整性/外键和迁移表，生成并复核 SHA-256，拒绝覆盖已有恢复点；production 在停止旧应用前必须完成这些检查。备份及校验和为 0600、备份目录 0700，包含真实数据，禁止复制到 Actions artifact 或公共日志。这是主机内发布恢复点，并非加密异地备份或实际恢复演练；仍须完成下一节的独立备份恢复体系。

本任务仅实现并在本地验证仓库自动化。未连接外部部署主机、推送 GHCR、配置 GitHub Environments、演练公网 HTTPS 或实际部署 staging/production；托管 runner、SSH、GHCR 授权、审批规则、服务器磁盘与容器启动等仍需在授权的 staging 演练中核实。本地 shell 模拟用替身代替 Docker 与冒烟子进程；真实 Node/SQLite/HTTP 冒烟另由临时数据库集成测试验证。Windows 的 Git Bash 缺少 `flock`，测试替身仅允许脚本继续执行，不代表验证了 Linux 锁语义；Linux CI 使用真实 `flock`。主机断电、SIGKILL 或 SSH/runner 被强制终止不保证执行 shell trap，仍需监控与人工恢复。

## 备份与恢复

SQLite 唯一日常恢复入口是下列 Node.js 24+ 工具。README 中旧 `backup-data.*`、`backup-docker-data.sh` 和旧恢复脚本仅适用于旧 JSON 交付，禁止用于 `site.db`。新工具已包含在生产镜像中，也可由主机上的对应版本代码运行：

```bash
node tools/backup-sqlite.mjs --database /opt/jiuyue-sports/data/site.db --directory /opt/jiuyue-sports/backups --retention-days 90
node tools/verify-backup.mjs --backup /opt/jiuyue-sports/backups/<generated-name>.db
```

工具通过 SQLite online backup API 读取包括已提交 WAL 的一致快照，先生成唯一 UTC 时间与随机后缀的 `.partial` 文件，再检查 `integrity_check`、`foreign_key_check`、已应用迁移/SQL 校验和及业务表，刷盘。先完整写入并刷盘 `.db.sha256.txt` 和目录，最后将已验证数据库原子重命名为 `.db` 作为发布点，再复核文件对；监控只枚举 `.db`，不会看到尚无完整校验文件的半成品。校验文件内容严格为 `SHA256摘要␠␠文件名` 加换行，不含绝对路径。移动时必须一起移动数据库和 sidecar，保留文件名。在 Linux 也可于备份目录执行 `sha256sum -c <generated-name>.db.sha256.txt`，但仍须运行 Node 验证工具检查 SQLite。只有双文件齐全且验证成功才算可用恢复点；中断留下的 partial、孤立 sidecar 或无 sidecar 文件须人工确认后清理，不能当作成功备份。sidecar 只能检测损坏，不能抵御能同时改写备份与校验和的攻击者。

迁移校验分三种用途：主库健康要求当前工具携带的迁移全部已应用且校验匹配，允许扩展迁移后的更高版本，以支持旧程序回滚；日常备份及保留备份验证允许只具有历史前缀，也允许兼容的更高版本，避免新版监控误报部署前恢复点；实际恢复仍要求与恢复工具完全匹配。所有用途均拒绝已知迁移校验不符、已应用历史中的已知中间版本缺失或未知中间版本；保留备份只允许尚未应用的尾部版本缺失。这些检查不自动执行迁移，也不能证明未知更高版本一定是安全扩展，发布兼容性审查仍必须完成。

新的发布备份同时保留旧 `.sha256` 和新增可移动 `.sha256.txt`，并转换为独立 DELETE journal 快照，可由相同验证/恢复工具读取。旧版本只生成 `.sha256` 的恢复点必须先在受控环境核对原摘要，再由操作员按受审流程转换 sidecar 或用当时的恢复程序；禁止用新计算摘要直接为未知来源文件背书。备份文件旁存在 WAL/SHM/journal 时新验证器拒绝，把整组文件保全并处理，不能默默忽略 sidecar。

日常备份和 sidecar 为 0600、目录为 0700。每次新备份验证成功后，只清理此目录中名称符合 `jiuyue-<UTC>-<random>.db` 且生成时间超过 90 天的文件对；不依赖拷贝后变化的 mtime，不清理任意命名的操作员文件。安全恢复点在独立的 `pre-restore-backups` 目录中保留，由操作员按 90 天政策逐一核实后清理；发布恢复点也单独按 90 天政策清理。灾难/调查期间暂停这些人工清理，记录延长期限。每日备份目标 RPO 为 24 小时，超过 36 小时告警；RTO 必须通过真实目标主机演练测量，不能由本地测试推定。

原生 Linux：核实 `/usr/bin/node` 是 Node 24+；部署 root 所有且不可由应用改写的代码和两个示例 unit，确保数据目录归 `jiuyue`，并运行：

```bash
sudo install -d -m 0700 -o jiuyue -g jiuyue /opt/jiuyue-sports/backups
sudo install -m 0644 deploy/jiuyue-backup.service.example /etc/systemd/system/jiuyue-backup.service
sudo install -m 0644 deploy/jiuyue-backup.timer.example /etc/systemd/system/jiuyue-backup.timer
sudo systemctl daemon-reload
sudo systemctl start jiuyue-backup.service
sudo systemctl enable --now jiuyue-backup.timer
systemctl list-timers jiuyue-backup.timer
systemctl status jiuyue-backup.service --no-pager
```

每日主机时间 03:30（随机延迟最多 10 分钟）、关机错过后补跑，30 分钟超时；以普通 `jiuyue` 账户执行。WAL 只读连接仍可能需要共享内存访问，因此 unit 必须允许写 data 及 backups；不能把 data 强制只读。不要读取应用 `.env`，备份不需要后台密码。Compose 主机需将 unit 中数据库路径和 `ReadWritePaths` 改为明确核实的对应环境数据卷挂载路径、独立备份目录，并使服务账户的 UID/GID 与卷的 1000:1000 一致；由已授权 Docker 操作员用 `docker volume inspect --format '{{.Mountpoint}}' jiuyue-staging_staging_data`（生产用 `jiuyue-production_production_data`）读取路径。不要给备份账户 Docker socket 权限。Docker Desktop 的 VM 卷无法直接供 Windows 原生 Node 访问；使用下列镜像内命令做人工备份，正式日程在 Linux 主机配置。

```bash
docker compose --env-file .env.staging -f compose.staging.yaml exec -T app node tools/backup-sqlite.mjs --database /app/data/site.db --directory /app/data/backups
```

至少一份每日复制至不同故障域的加密存储。部署者须配置目的地、加密密钥、最小权限上传凭据、90 天生命周期及删除权限隔离；凭据仅放受控部署 secret/0600 凭据文件，禁止作为 URL、命令参数或日志内容。完成上传后从远端取回、解密并运行相同验证工具，每月实际恢复一次，并向告警系统提供复制完成时间与失败状态。仓库没有配置任何异地目的地或凭据，也没有冒充上传成功；本机备份成功不能满足此项验收。

恢复时先封锁写流量并停止所有 app、备份定时器、迁移和导入进程，保持停止至替换完成。`--app-stopped` 是操作员对已停止状态的明确声明，工具不能发现所有空闲进程；`--confirm-target` 必须是目标的精确绝对路径。脚本额外拒绝 WAL/SHM/journal 残留、链接文件、非本账户目标、重复恢复锁、源等于目标、缺失/错误哈希或不匹配迁移版本。恢复所用镜像必须与备份迁移完全匹配；不自动迁移或降级，不自动修复损坏的现有库。先验证源，再为现有目标创建验证过的 `pre-restore-backups` 安全副本，最后复制到同目录临时文件、再次验证实际待替换字节、刷盘并原子替换。文件归当前服务账户、0600；目录 0700。Windows chmod 不代表 ACL 收紧，必须先按普通服务账户限制目录 ACL 并复核继承权限。

```bash
sudo systemctl stop jiuyue-backup.timer jiuyue-backup.service
sudo systemctl stop jiuyue-sports.service
systemctl is-active jiuyue-sports.service  # 必须 inactive
sudo -u jiuyue /usr/bin/node /opt/jiuyue-sports/tools/restore-sqlite.mjs --backup /opt/jiuyue-sports/backups/<generated-name>.db --database /opt/jiuyue-sports/data/site.db --app-stopped --confirm-target /opt/jiuyue-sports/data/site.db
# 核实成功代码 DATABASE_RESTORED 后，按删除清单重做删除并评估恢复后会话。
sudo systemctl start jiuyue-sports.service
node deploy/smoke-test.mjs https://<real-domain> production
sudo systemctl start jiuyue-backup.timer
```

Compose 恢复（已停止主机备份日程；设置好对应环境及恢复镜像摘要）：

```bash
docker compose --env-file .env.staging -f compose.staging.yaml stop app
docker compose --env-file .env.staging -f compose.staging.yaml ps --status running --services  # 不得出现 app
docker compose --env-file .env.staging -f compose.staging.yaml run --rm --no-deps app node tools/restore-sqlite.mjs --backup /app/data/backups/<generated-name>.db --database /app/data/site.db --app-stopped --confirm-target /app/data/site.db
docker compose --env-file .env.staging -f compose.staging.yaml up -d --wait app
node deploy/smoke-test.mjs https://<staging-domain> staging
```

生产替换所有 staging 参数并使用 production 冒烟模式。哈希或迁移验证失败时停止并选择正确备份/镜像；不得绕过验证。若断电留下 WAL/SHM/journal，先保持服务停止，在受控独立位置保全整个库及所有 sidecar，按 SQLite 故障恢复程序用匹配镜像打开并正常关闭以恢复/检查点；不要手工删 WAL，里面可能有已提交数据。若现有库损坏使安全备份失败，保全整组文件并经过人工事件处置，将已确认的损坏文件移至隔离目录，再对空目标执行恢复。`.restore-lock` 残留也只能在确认无恢复进程且已保全临时/安全文件后移走。禁止 `down -v` 或清理数据卷；日志不得包含记录或凭据。

## 监控、日志与事件

监控首页、健康接口、数据库读写、磁盘空间、容器重启、证书期限和备份结果。健康检查区分进程存活和依赖就绪；数据库无法读写时，就绪检查必须失败，避免继续接收生产流量。系统正常时保持安静，仅在故障或需人工处理时告警。

`GET /api/health/live` 返回 `live: true` 只说明 HTTP 进程能响应，不依赖数据库。`GET /api/health` 是就绪检查：成功响应含 `live: true`、`ready: true`、`database: "ready"`；它执行 SQLite 读取及 SAVEPOINT 内真实更新，随后回滚，不改变迁移记录。关闭、锁定、只读或写入失败时返回安全的 503 错误封装，不泄露数据库细节。业务存储失败后，就绪检查最多每 5 秒尝试一次固定的恢复探测，在同一个回滚 SAVEPOINT 中对预约、统计、会话和审计表执行最小合法的虚构写入；仍有表级写入故障则继续返回 503。探测成功并完整回滚后清除故障标记，无需普通请求或后台清理恢复服务。无关业务操作成功不会清除故障标记；探测不保留用户数据、不重试失败的用户请求、不提交测试行。

镜像默认执行 `node deploy/healthcheck.mjs readiness`；需要单独检查进程时执行 `node deploy/healthcheck.mjs liveness`。脚本读取容器 `PORT`，超时或无效响应返回非零，不打印响应和秘密。Docker 每 30 秒检查、连续 3 次失败标记 unhealthy；Compose 启动时等待应用健康。Caddy 每 10 秒检查就绪状态，失败后停用上游，恢复后重新接入；检查之间存在短暂延迟。单纯 unhealthy 不会触发 Docker 的 restart 策略，须配合监控与人工处置，禁止把重启策略当作数据库修复机制。

生产镜像同时携带显式白名单中的 SQLite 备份、验证、恢复、JSON 导入及监控脚本；不包含 systemd 安装、凭据生成或 Docker 客户端。监控的 Docker inspection 在授权主机执行，不能在应用容器中挂载 Docker socket。

使用带请求 ID 的结构化 JSON 日志。日志不得记录密码、会话 Cookie、完整电话、预约正文或其他不必要个人信息；为日志、统计事件、预约数据和备份分别制定保留期限。

主机健康采集入口（Node 24+，只读 Docker inspection 需由现有授权运维账户执行；不要给应用增加 socket 挂载）：

```bash
node deploy/monitor-health.mjs --origin https://<real-domain> --database <absolute-host-volume-path>/site.db --backup-directory <absolute-backup-directory> --container <verified-app-container-name>
```

每 5 分钟由主机监控系统调用。成功输出 `{"ok":true,"codes":[]}`、退出 0；失败输出固定代码数组、退出 1，无域名、路径、响应正文、证书主体、SQL 内容或 Docker 原始输出。监控平台只在新故障、恢复或需操作时通知，重复告警去重；每 5 分钟保留心跳，超过 15 分钟无采集也告警，以覆盖进程挂起/未执行。HTTP/TLS/Docker 探测限时 10 秒，外层作业加 60 秒超时；大库完整性检查时间随数据量变化。首次部署发送测试告警并确认值班人收到，随后撤销测试。

| 代码 | 操作 |
| --- | --- |
| `HOMEPAGE_FAILED` / `READINESS_FAILED` | 检查代理、镜像健康和数据库权限/锁；不要把重启当作修复 |
| `DISK_LOW` / `DISK_CHECK_FAILED` | 数据盘可用空间小于 1 GiB 或采集失败，扩容/核实挂载；禁止先删未经验证的数据 |
| `CONTAINER_DOWN` / `CONTAINER_CHECK_FAILED` | 核实目标容器正在运行、未 restarting 以及采集权限 |
| `CONTAINER_RESTARTS` | 当前容器自创建累计重启至少 3 次；调查原因，记录后可重新创建容器重置计数 |
| `CERTIFICATE_EXPIRING` / `CERTIFICATE_CHECK_FAILED` | 剩余不超过 14 天或握手/信任/域名检查失败，修复 Caddy 续期、DNS 和网络 |
| `BACKUP_STALE` / `BACKUP_UNVERIFIED` | 最新生成备份超过 36 小时、时间在未来、缺失或验证失败；检查 timer/磁盘，重新备份并核实异地副本 |
| `SQLITE_FAILED` | 主库完整性、外键、迁移或读取失败，停止写入并进入恢复程序 |
| `MONITOR_CONFIGURATION` | 修正缺失参数/非法 origin；不可将配置错误当作健康 |

SQLite 与最新备份均实际验证，不凭 marker 文件宣告正常。检测失败可能同时报告采集错误及其对应不满足的阈值。生产强制 HTTPS 信任验证；只有显式 `--allow-local-http` 才允许回环 HTTP 演练并跳过证书项，这不构成 HTTPS 验收。监控只验证本地备份，异地复制须由外部作业另行监控。默认应用/安全日志保留 30 天、仅含固定代码的健康指标保留 30 天、发布/演练非个人元数据保留 180 天；事故保全延长须记录理由与删除日期。不要把原始日志、数据库或备份上传为 CI artifact。

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

本地替代演练（仅有 Docker 时）：构建后执行 `RECOVERY_IMAGE=jiuyue-sports:recovery node --test tests/deployment/recovery-compose.test.mjs`，镜像先用 `docker build -t jiuyue-sports:recovery .` 构建。PowerShell 使用 `$env:RECOVERY_IMAGE='jiuyue-sports:recovery'` 后执行同一 Node 命令。测试把输入镜像解析成不可变本机 image ID，创建唯一 `jy-recovery-<random>` Compose 项目、Caddy 回环 HTTP 代理及临时合成数据卷；导入 2 条询盘、3 条事件，加入虚构会话/审计，执行全套 staging HTTP 冒烟，在线备份，停止应用并保全移走原数据库，恢复至空目标，逐表比较计数/摘要，重启后再次执行同套公开/管理烟测，再验证替换已有库的安全备份和 Linux 0600/UID 1000。测试结束只移除它自己创建的项目及合成数据卷，不读取现有 `.env` 或生产卷。未设置 `RECOVERY_IMAGE` 时此独立测试跳过，不算验收成功；它不在默认 `npm test` 中自动运行。

真实 staging/production 未配置时，只能记录本地演练和 [只读切换预检](../DEPLOYMENT-CHECKLIST.md#切换前只读预检及证据)；DNS、防火墙、GitHub 审批、部署 secrets、异地复制、公网证书、监控收件与运维访问必须保留为未验证。不能把本地 HTTP 或本机 image ID 当作已推送的 registry digest、公网 HTTPS 或真实 staging 发布证据。
