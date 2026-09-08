# 上线核对清单

## 主体与内容

- [ ] 公司名称、联系电话 `18061736378`、课程范围与对外口径已由负责人确认。
- [ ] 22 张证照、教练员与成果图片均拥有公开展示授权；发布版之外的敏感信息已遮挡。
- [ ] 不宣传无法证明的资质、荣誉、升学结果、训练效果或绝对化承诺。
- [ ] `public/privacy.html` 已根据真实托管方、内部人员、委托处理方和线下流程复核。
- [ ] 涉及未成年人预约时，线下人员会核验监护人身份或授权，并遵循最小必要原则。
- [ ] 预约信息不会直接用于与本次请求无关的营销；促销短信、电话广告等另行完成合规评估。
- [ ] 若服务器位于中国大陆，已按接入商和主管部门的最新要求完成必要的备案、主体信息展示或其他手续。
- [ ] 已取得 ICP 备案号时，`.env` 的 `ICP_NUMBER` 已填写真实编号，首页底部可见且正确链接工信部备案系统；未取得时保持空值。

## 域名、网络与 HTTPS

- [ ] `.env` 中 `SITE_DOMAIN` 已从 `replace.example.com` 改为真实域名。
- [ ] Docker 方案运行在 Linux 或受支持的 Linux 容器环境；没有把 Alpine 镜像方案误当作标准 Windows Server 容器部署。
- [ ] 域名 A/AAAA 记录只指向正确服务器，旧记录已清理。
- [ ] 公网只开放必要的 TCP 80、TCP 443；需要 HTTP/3 时才开放 UDP 443。
- [ ] 同机反向代理保持 Docker `APP_BIND_IP=127.0.0.1` 或原生 `HOST=127.0.0.1`；独立硬件代理按运行方式把对应变量设为服务器固定私网 IP，且主机防火墙只允许该代理源 IP 访问 3002。
- [ ] HTTPS 证书有效、自动续期已验证，HTTP 会跳转 HTTPS。
- [ ] 管理后台只能通过 HTTPS 正常登录；Cookie 带 Secure、HttpOnly、SameSite 属性。
- [ ] 反向代理覆盖 `X-Forwarded-For`，不会信任访客自行伪造的地址头。

## 凭据与权限

- [ ] 已通过初始化工具生成 `.env`，后台密码为 16–250 位且至少包含三类字符，没有使用示例域名、弱密码、品牌词、手机号或默认密码。
- [ ] `.env` 不在公开仓库、共享盘、聊天记录或截图中。
- [ ] Windows 自启使用普通账户的 S4U、Limited 任务并固定 Node.js 24+ 绝对路径，没有使用 SYSTEM；`.env`、`data`、`backups` ACL 已复核。
- [ ] Linux 代码和 unit 由 root 持有，`jiuyue` 只能写 `data`；只有备份 unit 能写 `backups`。
- [ ] 只有确需处理询盘的人员能访问后台，人员变动时立即更换密码。
- [ ] 服务器、Docker、Node.js、Caddy/Nginx 和操作系统已安装安全更新。
- [ ] 服务器时间和时区正确，并启用可靠的时间同步。

## 功能验收

- [ ] 首页、课程、解决方案、资质、教练、成果、预约和隐私页面均可访问。
- [ ] 手机与桌面浏览器布局正常，22 张图片均可打开和切换。
- [ ] 拒绝去标识化统计后仍能正常浏览和预约，且浏览器不保留访客标识，具名预约也不保存来源归因字段。
- [ ] 同意去标识化统计后，后台能看到页面访问和互动数据；告知版本变化后会重新要求访客选择。
- [ ] 缺少预约同意、无效电话、超大请求和频繁提交会被拒绝。
- [ ] 正常预约可进入后台，状态可更新，删除操作有确认并能生效。
- [ ] 管理接口未登录时返回 401，修改与删除在缺少 CSRF 令牌时返回 403。
- [ ] `/api/health` 返回正常，重启服务器后网站可自动恢复。
- [ ] 干净检出已执行 `npm ci` 和完整质量门禁；交付镜像已构建、扫描并记录摘要。目标主机仅拉取该摘要，通过 `docker compose config --quiet`、`up -d --wait` 和容器健康检查，不在生产现场构建。

## 数据与恢复

- [ ] 交付的正式实例从空数据开始，没有导入制作电脑的访问记录、询盘或日志。
- [ ] 已执行首次备份，移动备份后仍能用同名 sidecar 核对 SHA-256，恢复脚本默认拒绝缺失或不匹配的校验值。
- [ ] 备份另存到一处与服务器故障域不同、加密且限制访问的位置。
- [ ] 已实际演练“停止服务—恢复—启动—健康检查”，而不只确认备份文件存在。
- [ ] 有明确的数据删除、更正和撤回同意响应流程及负责人；恢复备份后会重新执行尚未完成的删除清单。
- [ ] 已复核默认 90 天备份轮换是否符合实际必要期限，并监控本机与异地副本清理结果。
- [ ] 运维人员知道禁止 `docker compose down -v`，且不会在没有已验证备份时清理命名卷。

## 运营监控

- [ ] Docker、Windows 计划任务或 systemd 已设置开机自启及失败重启。
- [ ] 有外部健康监测访问 `https://域名/api/health`，并把告警发送给负责人。
- [ ] 定期查看磁盘容量、备份结果、证书续期和异常登录情况。
- [ ] 上线后新增 CRM、短信、支付、地图或第三方统计前先更新数据流图、权限和隐私告知。

## 切换前只读预检及证据

以下检查不修改流量、DNS、主机规则或 GitHub 设置。只读失败或无证据即保持待办；不要把仓库中的示例配置当作实际已启用。操作命令中的占位符必须替换成已核实的目标；含个人信息的结果只在受控终端查看，发布记录只保留计数、摘要及通过/失败。

| 检查 | 只读命令/核实方式 | 必须附的证据 |
| --- | --- | --- |
| DNS | `dig +short A <domain>`、`dig +short AAAA <domain>`，对比审批的服务器 IP | 实际记录、TTL 与切换/回退责任人 |
| 防火墙 | Linux `sudo nft list ruleset`（已有 ufw 则 `sudo ufw status verbose`）、`ss -lnt` | 只开放审批端口，应用无公网映射 |
| GitHub 审批 | `gh api repos/<owner>/<repo>/environments/production --jq '{reviewers: .protection_rules, branches: .deployment_branch_policy}'` | required reviewers 非空、main 限制、审批人权限及演练记录 |
| Secrets | `gh secret list --env staging`、`gh secret list --env production`；主机仅 `stat` 权限，不 `cat .env` | 名称齐备、两环境隔离、有效性由 staging 实际部署证明 |
| 镜像/回滚 | `docker inspect --format '{{.Config.Image}}' <app-container>`，核对受控 `.release-state`、前一发布包 | 候选和前一摘要、SQL 校验和、扩展迁移兼容及回滚烟测 |
| 异地恢复 | 存储控制台只读检查已配置的加密、权限、生命周期和最新复制状态 | 远端取回并验证/实际恢复记录；仅本地副本不满足 |
| 导入计数 | `node tools/import-json-data.mjs --source <protected-source> --database <target> --dry-run` | 两表 `source = imported + skipped`、重复导入结果，禁止输出记录 |
| 监控目的地 | 监控平台只读查看探测与路由、值班安排 | 7 项探测、15 分钟失联报警、真实测试告警收件确认 |
| Caddy/HTTPS | `curl --silent --show-error --head https://<domain>/`、`openssl s_client -connect <domain>:443 -servername <domain> </dev/null 2>/dev/null \| openssl x509 -noout -dates` | 可信证书、域名匹配、续期证据、HTTP 跳转、剩余大于 14 天 |
| 运维访问 | `ssh <configured-host> 'id; command -v docker; command -v node'`（不得关闭主机密钥校验） | 两名授权人员、密钥轮换/应急访问和主机指纹 |

- [ ] staging 仅含明确虚构数据；同一候选摘要完成全部公共/管理冒烟和浏览器流程。
- [ ] 已按 [运维恢复程序](docs/operations.md#备份与恢复) 完成停止、备份、保全移走数据库、恢复、启动与逐表核对；记录耗时/RPO/RTO，无个人数据进入演练报告。
- [ ] 每日 timer 最近一次验证成功、90 天清理、异地恢复和每月演练责任人明确。
- [ ] 恢复后删除清单、会话处置、失败停切换和回滚责任人均已确认。
- [ ] Git 历史、最终镜像层、日志和测试产物未发现密钥/个人数据；记录扫描工具版本、范围与结果，不能仅凭 `.gitignore` 确认。
- [ ] release run summary 汇总上述实际证据后，才审批 production；本地 Compose 临时数据演练只能证明本地机制，不能勾选真实 staging、公网证书、GitHub Environment 或异地存储验收。
