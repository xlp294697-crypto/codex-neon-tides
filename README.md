# 氿悦体育独立站生产部署程序

这是可放到独立服务器或自有硬件运行的完整网站程序，不是只能在 Codex 里打开的临时本机页面。程序包含：

- 奶白色与紫色响应式官网、课程介绍、企业资质、教练资质、赛事成果与 22 张已处理展示图；
- 联系电话 `18061736378` 与在线预约表单；
- 后台询盘列表、跟进状态、删除功能；
- 经访客单独同意后启用的站内流量与内容互动统计；
- 无默认密码的后台认证、登录限流、CSRF 防护、请求体限制和安全响应头；
- Docker 自动 HTTPS、既有反向代理接入、Windows/Linux 原生运行、开机自启和备份脚本。

运行数据保存在 SQLite（默认 `data/site.db`，可通过 `DATA_PATH` 指定）。交付包中的旧 `data/site-data.json` 仅是空迁移源示例，不包含制作电脑上的真实访问记录、询盘、日志、密码或会话密钥。原始证照资料也不会随包交付，网站只使用 `public/media/` 中的发布版图片。

## 工程文档

面向开发与维护人员的长期规则按关注点维护，避免在本部署说明中重复：

- [架构指南](docs/architecture.md)
- [开发指南](docs/development.md)
- [测试指南](docs/testing.md)
- [运维指南](docs/operations.md)

本 README 保留面向部署者的具体平台、初始化、备份和恢复操作；安全与隐私边界见 [SECURITY.md](SECURITY.md)，上线验收见 [DEPLOYMENT-CHECKLIST.md](DEPLOYMENT-CHECKLIST.md)。

## 先理解外网访问方式

`127.0.0.1:3002` 只代表服务器本机内部端口。正式访客应打开：

```text
https://你的域名/
```

正确链路是：

```text
访客浏览器 → 域名 DNS → 服务器 443/HTTPS → Caddy 或 Nginx → 网站程序 3002 内部端口
```

不要把 `3002` 端口直接暴露到公网，也不要把 `127.0.0.1` 发给客户。后台地址是 `https://你的域名/admin`，官网不公开展示后台入口。

## 推荐方案：Docker + 自动 HTTPS

适合已经安装 Docker Compose、拥有公网 IP 和域名的 Linux 服务器。镜像基于 Linux；Windows 10/11 只有在已配置受支持的 Linux 容器运行时后才能使用这条路径。Docker Desktop 官方不支持 Windows Server，标准 Windows Server Docker 运行时也不能直接运行本包的 Alpine Linux 镜像；Windows Server 请使用下文“Windows 原生运行”，或先建立受支持的 Linux 虚拟机。`compose.yaml` 会同时启动网站和 Caddy；Caddy 根据域名自动申请和续期 HTTPS 证书。

### 1. 解压并初始化安全配置

Linux：

```bash
cd /opt/jiuyue-sports
chmod +x start-linux.sh tools/*.sh
./tools/initialize-config.sh
```

Windows PowerShell：

```powershell
Set-Location C:\jiuyue-sports
powershell -ExecutionPolicy Bypass -File .\tools\Initialize-Config.ps1
```

初始化脚本会安全读取你设置的后台密码；密码必须为 16–250 位，并至少包含大写字母、小写字母、数字、符号中的三类，且不得包含常见弱口令、品牌词或手机号码。脚本只把不可逆的 scrypt 哈希和随机会话密钥写入 `.env`；程序没有默认后台密码。机器只有 Docker、没有 Node.js 时，初始化脚本会使用一次性 Node 容器生成配置。

### 2. 填写真实域名

编辑 `.env`，把：

```text
SITE_DOMAIN=replace.example.com
```

改为实际域名，例如：

```text
SITE_DOMAIN=sports.example.cn
```

不要加 `http://`、`https://`、路径或端口。

若已经取得 ICP 备案号，同时填写：

```text
ICP_NUMBER=苏ICP备XXXXXXXX号-X
```

程序会在首页底部居中显示并链接工信部备案系统。没有取得备案号时保持空值，不能填写虚构编号。

后台日/小时报表默认按北京时间统计：

```text
REPORT_TIME_ZONE=Asia/Shanghai
```

如果实际运营地不使用北京时间，可改成服务器 Node.js 支持的 IANA 时区名称；修改后重启应用。不要使用 `UTC+8` 这类非 IANA 别名。

### 3. 配置 DNS 和防火墙

- 域名 `A` 记录指向服务器公网 IPv4；使用 IPv6 时再添加正确的 `AAAA` 记录。
- 路由器或云安全组向服务器开放 TCP `80`、TCP `443`，如使用 HTTP/3 可同时开放 UDP `443`。
- 不对公网开放 `3002`。
- 若服务器位于中国大陆，按接入商和主管部门的现行要求完成网站备案、主体信息展示等上线手续。

### 4. 启动

```bash
docker compose config >/dev/null
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app caddy
```

验证：

```bash
curl -fsS https://你的域名/api/health
```

成功时返回包含 `"ok":true` 的 JSON。随后检查：

- `https://你的域名/`
- `https://你的域名/privacy`
- `https://你的域名/admin`

Compose 已配置 `restart: unless-stopped`，正常重启或断电恢复后 Docker 会自动拉起服务；仍需确认 Docker 服务本身已设为开机启动。

## 已有 Nginx、Caddy 或硬件反向代理

如果硬件层已经负责域名和 HTTPS，只启动应用：

```bash
docker compose -f compose.app-only.yaml config >/dev/null
docker compose -f compose.app-only.yaml up -d --build
```

默认 `APP_BIND_IP=127.0.0.1`，因此应用只在服务器回环地址监听 `127.0.0.1:3002`，适合同一台服务器上的代理。把同机代理上游指向该地址。示例位于：

- `deploy/Caddyfile.example`
- `deploy/nginx-site.conf.example`

替换示例域名和证书路径后再启用。代理必须覆盖客户端传入的 `X-Forwarded-For`，不能原样信任公网请求头；随包 Nginx 示例已使用真实连接地址覆盖。

如果反向代理是另一台硬件设备，回环地址无法跨机器访问。把 `.env` 的 `APP_BIND_IP` 改成网站服务器的固定私网 IP，再重新启动 `compose.app-only.yaml`，并在主机防火墙中只允许该代理设备的源 IP 访问端口 3002。例如：

```text
APP_BIND_IP=192.168.10.20
```

不要为了省事直接设为 `0.0.0.0` 并向整个公网开放 3002；代理与网站服务器不在可信内网时，还应在二者之间使用 VPN、受控专线或加密上游。

## Windows 原生运行

要求安装 Node.js 24 或更高版本，建议系统级安装到 `Program Files`。程序和数据必须放在服务器本地磁盘，不要放在 S4U 任务无法访问的网络共享中。

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Initialize-Config.ps1
.\Start-Windows.ps1
```

也可双击 `启动网站.cmd` 进行前台运行。正式服务仍应由 Caddy/Nginx 提供 HTTPS，`.env` 中保持：

```text
HOST=127.0.0.1
COOKIE_SECURE=true
TRUST_PROXY=true
```

以管理员身份安装开机自启任务。默认使用当前账户的 S4U、Limited 令牌，不保存账户密码；安装脚本会固定并验证 Node.js 的绝对路径，拒绝 SYSTEM/LOCAL SERVICE/NETWORK SERVICE：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Install-Windows-Autostart.ps1
Get-ScheduledTask -TaskName JiuyueSportsWebsite
Get-ScheduledTaskInfo -TaskName JiuyueSportsWebsite
```

若已经建立专用的普通本地账户，可显式指定（账户必须能读取程序目录；脚本会自动收紧 `.env`、`data` 和 `backups` 的 ACL）：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Install-Windows-Autostart.ps1 `
  -RunAsUser 'SERVER\JiuyueWeb' `
  -NodePath 'C:\Program Files\nodejs\node.exe'
```

移除任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\Uninstall-Windows-Autostart.ps1
```

该任务使用 S4U 在开机时启动，不依赖用户交互登录，也不授予 SYSTEM 权限，因此解决了“关机或长时间不打开后 127.0.0.1 拒绝连接”的原型问题。S4U 账户不能依赖网络盘或需要用户解锁的加密文件。反向代理也必须单独配置成系统服务。Windows 原生方式对接另一台硬件代理时，应把 `.env` 的 `HOST`（不是 `APP_BIND_IP`）改为网站服务器固定私网 IP，并只在防火墙中放行该代理源 IP。

## Linux 原生运行

要求 Node.js 24 或更高版本。示例安装位置为 `/opt/jiuyue-sports`：

```bash
id -u jiuyue >/dev/null 2>&1 || sudo useradd --system --home /opt/jiuyue-sports --shell /usr/sbin/nologin jiuyue
sudo chown -R root:root /opt/jiuyue-sports
sudo chmod 755 /opt/jiuyue-sports/start-linux.sh /opt/jiuyue-sports/tools/*.sh
sudo /bin/sh /opt/jiuyue-sports/tools/initialize-config.sh
sudo chown root:jiuyue /opt/jiuyue-sports/.env
sudo chmod 640 /opt/jiuyue-sports/.env
sudo chown -R jiuyue:jiuyue /opt/jiuyue-sports/data /opt/jiuyue-sports/backups
sudo chmod 700 /opt/jiuyue-sports/data /opt/jiuyue-sports/backups
sudo cp /opt/jiuyue-sports/deploy/jiuyue-sports.service.example /etc/systemd/system/jiuyue-sports.service
sudo systemctl daemon-reload
sudo systemctl enable --now jiuyue-sports
sudo systemctl status jiuyue-sports
```

代码由 root 持有且对服务账户只读；只有 `data` 和 `backups` 归 `jiuyue` 所有。先确认 Node.js 的实际路径是 unit 中的 `/usr/bin/node`，否则先修改 `ExecStart`。然后安装 Caddy 或 Nginx，使用 `deploy/` 中的反向代理示例。默认应用服务只监听回环地址；若 Linux 原生方式对接另一台硬件代理，同样把 `.env` 的 `HOST` 改成服务器固定私网 IP，并设置来源白名单。

启用每日备份定时器：

```bash
sudo cp /opt/jiuyue-sports/deploy/jiuyue-backup.service.example /etc/systemd/system/jiuyue-backup.service
sudo cp /opt/jiuyue-sports/deploy/jiuyue-backup.timer.example /etc/systemd/system/jiuyue-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now jiuyue-backup.timer
systemctl list-timers jiuyue-backup.timer
```

## 管理后台

地址：`https://你的域名/admin`

后台支持：

- 查看访问量、随机标识访客数、总预约量和同口径统计转化率；
- 查看资质区、成果区和图片互动；
- 查看家长联系电话、年级、课程和需求；仅对另行同意统计的预约显示来源归因；
- 把预约标记为新线索、已联系、已到店、已报名或无效；
- 响应个人信息删除请求时永久删除对应预约。

流量统计只有在访客点击“同意统计”后才启动。拒绝统计不影响网站和预约表单，也不会把页面、来源或活动参数写入具名预约。随机访客标识只用于去标识化事件统计，不会保存到具名预约；告知版本变化时会重新征求选择。后台“预约量”是全部预约，“转化率”是触发预约成功事件的去重随机标识访客数除以去重随机标识访客数，二者口径不同，不能用总预约量反推该比例。预约同意也不等于同意任意营销：如果以后要发促销短信、加入第三方广告平台或做与本次咨询无关的推广，应在实际业务流程中另行评估合法依据、告知和同意要求。

## 数据与备份

原生运行的 SQLite 数据库：

```text
data/site.db
```

旧 JSON 导入步骤、只读预检和数量核对见[运维指南](docs/operations.md#生产切换)。`DATA_PATH` 必须指向新的 SQLite 路径；旧实例数据需要显式导入，不能直接把 JSON 当数据库打开。

### SQLite 备份与恢复

当前运行数据必须使用 SQLite 专用工具处理。旧 JSON 脚本只供迁移旧版本数据时识别历史包，不能用于当前数据库。完整参数、停止应用要求和演练流程见[运维指南](docs/operations.md)。以下命令创建并立即验证在线备份，并默认保留 90 天：

```bash
node tools/backup-sqlite.mjs --database ./data/site.db --directory ./backups --retention-days 90
```

恢复前必须停止应用；恢复工具默认校验配套 SHA-256、SQLite 完整性、外键和迁移兼容性，并先在 `pre-restore-backups/` 创建当前数据库安全副本：

```bash
node tools/restore-sqlite.mjs --backup ./backups/jiuyue-时间戳-标识.db --database ./data/site.db --application-stopped
```

不要手工复制单个 WAL 模式数据库文件，也不要提交任何 `.db`、`-wal`、`-shm`、发布恢复点或恢复前快照。至少把一份已验证备份复制到服务器之外的受控加密存储，并按月实际演练恢复。

## 上线前测试

安装 Node.js 24+ 后，在程序目录执行：

```bash
npm run check
npm test
```

如果没有 npm，可直接运行：

```bash
node --check server.mjs
node --check public/app.js
node --check public/admin.js
node --test
```

测试会使用临时数据目录和测试凭据，不会修改正式 SQLite 或旧 JSON。

## 常见故障

### 浏览器显示“127.0.0.1 拒绝连接”

网站进程未运行，或只安装了前台启动方式。Docker 模式检查 `docker compose ps` 和日志；Windows 原生模式同时检查 `Get-ScheduledTask` 与 `Get-ScheduledTaskInfo` 的 `LastTaskResult`；Linux 检查 `systemctl status jiuyue-sports`。

### 服务器本机能打开，外部浏览器打不开

依次检查域名 DNS、公网 IP、路由/NAT、云安全组、防火墙、80/443 端口、反向代理和 HTTPS 证书。`127.0.0.1` 本来就只能由同一台机器访问；另一台硬件代理必须使用网站服务器私网 IP，并只对白名单代理开放 3002。

### 后台密码正确但仍返回登录页

正式配置的后台 Cookie 只允许通过 HTTPS 发送。请使用 `https://你的域名/admin`，不要从公网用明文 HTTP 或直接用 `http://服务器IP:3002/admin`。同时检查服务器时间是否准确。

### 图片不显示

确认 `public/media/` 中 22 张发布版 JPEG 全部存在，并且代理没有重写 `/assets/media/` 路径。不要用原始证照目录覆盖该文件夹。

### 端口被占用

修改 `.env` 的 `PORT`，并同步修改反向代理上游或 Compose 端口。Docker 全套模式内部固定使用 3002，一般无需修改。

## 能力边界

- 当前数据层是单实例 SQLite 事务写入，适合单企业官网、常规询盘与内容统计；按一个应用实例运行。
- 当前不发送短信、邮件或微信通知；新询盘在 `/admin` 查看。接入外部通知、CRM、支付、地图或第三方统计前，应单独配置凭据、最小权限、失败重试与隐私告知。
- `public/privacy.html` 是与当前程序行为一致的运营模板，不替代针对实际托管、人员权限、线下营销和未成年人业务流程的专业法律审查。
- 程序不会自行发布到你的服务器，也不包含任何服务器、域名、云平台或证书凭据。

完整上线核对见 [DEPLOYMENT-CHECKLIST.md](DEPLOYMENT-CHECKLIST.md)，安全运维见 [SECURITY.md](SECURITY.md)；工程规则见 [架构指南](docs/architecture.md)、[开发指南](docs/development.md)、[测试指南](docs/testing.md) 与 [运维指南](docs/operations.md)。

## 官方部署参考

- [Caddy 自动 HTTPS 的域名、端口与持久化要求](https://caddyserver.com/docs/automatic-https)
- [Node.js 官方 Docker 镜像与可用架构](https://github.com/nodejs/docker-node)
- [Node.js 容器安全最佳实践](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md)
- [Docker Desktop 的 Windows 支持边界（不支持 Windows Server）](https://docs.docker.com/desktop/setup/install/windows-install/)
- [工信部《非经营性互联网信息服务备案管理办法》](https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2024/art_84a0cfa0ebd049bbbe751dca9a008e56.html)
