# 测试指南

测试使用虚构、最小化的夹具和独立临时数据目录。生产预约、访问记录、日志、电话、会话或其他个人数据绝不得进入测试、夹具、截图或错误输出。

恢复专项：`node --test tests/integration/backup-restore.test.mjs tests/integration/monitor-health.test.mjs` 验证 WAL 快照、可移动 SHA-256、完整性/外键、迁移兼容、安全备份、停止声明、留存以及监控失败代码。实际本地容器演练先 `docker build -t jiuyue-sports:recovery .`，再设置 `RECOVERY_IMAGE=jiuyue-sports:recovery` 运行 `node --test tests/deployment/recovery-compose.test.mjs`（PowerShell 用 `$env:RECOVERY_IMAGE`）。此测试显式创建并清理它自己的 Compose 项目及虚构数据卷，经 Caddy 回环 HTTP 执行恢复前后的 staging 冒烟，不读取用户 `.env`、不连接生产。独立运行且没有镜像变量时跳过；不能将跳过记为恢复验证，也不替代公网 TLS、真实 staging 或异地恢复。完整过程和限制见运维指南。

## 四个测试层

1. **单元测试**：覆盖配置校验、输入规范化、密码校验、统计聚合、时区换算、保留策略和错误映射等纯逻辑；必须快速且互不共享状态。
2. **集成测试**：以临时 SQLite 数据库启动真实应用，覆盖预约生命周期、事务/约束/迁移、会话、CSRF、请求体限制、限流、统计同意边界，以及数据库不可写、损坏或迁移失败。
3. **端到端测试**：以 Playwright 在桌面和移动视口覆盖官网、隐私页、导航、媒体、同意选择、画廊、预约、后台处理与删除；检查 JavaScript 错误、失败请求、资源 404、基本可访问性和关键截图。
4. **部署与恢复测试**：验证最终 Docker 镜像健康检查、全新数据库初始化、旧数据库迁移、备份与恢复、Caddy 反向代理以及预发布线上冒烟流程。

## 夹具规则

- 每个测试自行建立和清理临时状态；禁止依赖执行顺序或共享数据库。
- 使用清晰的虚构姓名、电话、内容与凭据；不得从生产副本、备份或日志复制数据。
- 覆盖同意、拒绝、失败和恢复边界，尤其是个人信息与统计归因的隔离。
- 测试输出、截图和断言失败信息不得泄露密码、令牌、Cookie、完整电话或预约正文。

## 命令矩阵与质量门禁

| 场景                         | 命令或检查                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| 快速语法检查                 | `npm run check`                                                                                        |
| 格式与静态检查               | `npm run format:check`、`npm run lint`                                                                 |
| 单元测试                     | `npm run test:unit`                                                                                    |
| 集成与交付回归               | `npm run test:integration`                                                                             |
| 单元和集成测试（不发现 E2E） | `npm test`                                                                                             |
| Chromium 桌面和移动浏览器    | `npm run test:e2e`                                                                                     |
| 仓储与 JSON 导入             | `node --test tests/integration/repositories.test.mjs tests/integration/import-json-data.test.mjs`      |
| 会话与错误契约               | `node --test tests/integration/session-persistence.test.mjs tests/integration/error-contract.test.mjs` |
| 浏览器脚本请求与提交         | `node --test tests/unit/browser-requests.test.mjs`                                                     |
| Pull Request / `main`        | 并行运行格式、lint、语法、单元、集成、Chromium E2E、生产依赖审计和 Docker 构建；构建后扫描同一镜像     |
| 后续部署与恢复验收           | staging 部署/迁移/烟测 → 人工批准 → production 备份、部署、迁移、健康检查与烟测（不由当前 CI 部署）    |

既有失败先归类为基线问题或本次回归，不能通过删除、跳过或弱化测试获得通过。所有 Pull Request 必须通过适用门禁后才能合并。

首次运行浏览器测试先执行 `npm ci` 和 `npx playwright install chromium`；Linux CI 可用 `npx playwright install --with-deps chromium` 安装系统依赖。完整本地门禁为 `npm run format:check && npm run lint && npm run check && npm test && npm run test:e2e`。格式化分阶段采用：`npm run format` 与 `format:check` 当前覆盖维护中的 JS/MJS 和工具配置文件；既有静态 HTML/CSS、Markdown 长文、媒体清单、已应用 SQL 迁移、运行时数据与生成报告排除在外，避免格式变更掩盖行为变更。

Playwright 的每个测试通过真实 `createApp` 启动仅监听回环地址的临时端口，创建和清理独立临时 SQLite 数据库；不读取 shell 中的 `DATA_PATH`、`.env` 或已有服务。桌面 Chromium 与 Pixel 7 移动视口运行相同关键流程，后台额外重启应用并重新读取会话、预约状态和删除结果。自动浏览器检查捕获页面异常、控制台错误、失败请求及所有意外 HTTP 错误（包括资源 404）；只有用例明确声明并验证次数的 401、422 响应允许出现。

`playwright-report/` 和 `test-results/` 保存本地诊断与官网/媒体截图并被 Git 忽略。自动 trace、视频和失败截图关闭，避免表单、凭据或会话进入诊断；主动截图只在公开页面且尚未填写预约时生成。交付包检查排除本机依赖和这些生成诊断目录，同时继续扫描实际源码、部署文件和静态资源。

仓储集成测试使用临时 SQLite 文件验证 API 字段映射、排序、状态和删除审计的原子性、统计批次回滚、留存及到期会话清理。导入测试只使用虚构记录，验证重复导入、数量核对、只读预检、源文件不变、隐私字段过滤及跨表回滚。现有服务接口回归同样直接使用 SQLite 种子与持久化结果。

## Pull Request 自动检查

`.github/workflows/ci.yml` 在所有 PR、`main` 推送及手动触发时运行，不按路径跳过检查。同一 PR 或分支的新运行取消旧运行。Ubuntu 24.04 作业使用 Node.js 24、锁文件安装和 npm 下载缓存；不缓存 `node_modules`。全部 Action 固定到完整提交 SHA，版本注释用于更新审查。

可在 GitHub 分支保护或 ruleset 中设为必需的检查名称为 `quality (format)`、`quality (lint)`、`quality (syntax)`、`quality (unit)`、`quality (integration)`、`e2e (Chromium desktop and mobile)`、`dependency-audit (production)`、`container-build` 和 `container-scan (Trivy)`。提交工作流并不会自动启用仓库规则；维护者需在 GitHub 启用这些门禁。质量矩阵的一个失败不会取消其他质量检查。质量和依赖审计限时 10 分钟，E2E、构建和镜像扫描各限时 20 分钟。

E2E 安装 Playwright 锁定版本匹配的真实 Chromium 和 Linux 系统依赖，运行现有桌面及 Pixel 7 视口项目；CI 使用两个 worker、禁止 `test.only`、不重试失败。不上传浏览器 HTML 报告、截图或会话诊断。生产依赖使用 `npm ci --omit=dev --ignore-scripts` 后运行 `npm audit --omit=dev --audit-level=high`，任何 HIGH/CRITICAL 报告或审计服务错误均导致失败；该审计不区分是否已有修复。

Docker 作业执行 `docker build -t jiuyue-sports:ci .`，将镜像保存为保留 1 天的当前运行 artifact；扫描作业下载此镜像归档并直接扫描，不重新构建或发布镜像。固定版本 Trivy 检查镜像内 OS 与应用包漏洞，以可修复的 HIGH/CRITICAL 发现使作业失败，SARIF 限定相同严重等级。扫描禁用隐式仓库配置和忽略列表；Trivy 二进制版本需人工随 Action 更新一起评估。SARIF 在发现漏洞时仍上传 GitHub Code Scanning，并作为保留 7 天的 artifact 保存；扫描器在生成报告前出错则作业失败且没有可上传报告。

工作流默认只有 `contents: read`；仅扫描作业声明 `security-events: write`，并授予私有仓库 SARIF 上传所需的 `actions: read`，checkout 不保留凭据。没有 `pull_request_target`、部署凭据、镜像仓库写权限或发布步骤。GitHub 可能进一步收紧 fork/Dependabot 的令牌权限；PR 事件遵循 GitHub 对 SARIF 上传的授权规则。仓库必须支持并启用 Code Scanning（私有仓库还需对应功能授权），否则上传失败会显示为检查失败，不静默放行。权限依据见 [GitHub SARIF 上传文档](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file)。

复现门禁时运行 `npm ci`、`npx playwright install chromium`（Linux 加 `--with-deps`），然后依次运行 `npm run format:check`、`npm run lint`、`npm run check`、`npm test`、`npm run test:e2e`、`npm audit --omit=dev --audit-level=high`、`docker build -t jiuyue-sports:ci .`。镜像构建成功不代表容器启动、迁移、健康检查或恢复验证通过；这些属于部署测试层。Docker 引擎或镜像仓库不可达时须报告具体失败，不能将镜像检查标记为通过。

`.github/dependabot.yml` 每周一上海时间 09:00 检查 npm、GitHub Actions 和 Docker 更新。npm 开发依赖的 minor/patch 更新合并为一组，生产依赖和开发依赖 major 更新分别提 PR；Actions 与 Docker 各自分组非 major 更新，major 保持单独审查，不自动合并。参见 [Dependabot 配置说明](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference) 和 [Trivy Action 的 SARIF 配置](https://github.com/aquasecurity/trivy-action/blob/v0.36.0/README.md)。

会话测试启动不同 Node.js 进程访问同一临时数据库，验证 Cookie 重启恢复、到期读取删除、摘要存储及退出后的持续失效。错误契约测试覆盖输入、认证、CSRF、限流、实际 SQLite 触发器写入失败与请求 ID，确保响应及请求错误日志不泄露内部信息。浏览器脚本在最小 DOM 测试环境执行，覆盖错误消息、网络失败、超时、重复提交及异步完成后的表单重置；这不替代 Playwright 真浏览器验证。
