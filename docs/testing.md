# 测试指南

测试使用虚构、最小化的夹具和独立临时数据目录。生产预约、访问记录、日志、电话、会话或其他个人数据绝不得进入测试、夹具、截图或错误输出。

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
| Pull Request                 | 格式与静态检查 → 单元 → 集成 → Playwright E2E → Docker 构建 → 镜像安全扫描                             |
| 合并 `main`                  | 构建 SHA 镜像 → staging 部署/迁移/烟测 → 人工批准 → production 备份、部署、迁移、健康检查与烟测        |

既有失败先归类为基线问题或本次回归，不能通过删除、跳过或弱化测试获得通过。所有 Pull Request 必须通过适用门禁后才能合并。

首次运行浏览器测试先执行 `npm ci` 和 `npx playwright install chromium`；Linux CI 可用 `npx playwright install --with-deps chromium` 安装系统依赖。完整本地门禁为 `npm run format:check && npm run lint && npm run check && npm test && npm run test:e2e`。格式化分阶段采用：`npm run format` 与 `format:check` 当前覆盖维护中的 JS/MJS 和工具配置文件；既有静态 HTML/CSS、Markdown 长文、媒体清单、已应用 SQL 迁移、运行时数据与生成报告排除在外，避免格式变更掩盖行为变更。

Playwright 的每个测试通过真实 `createApp` 启动仅监听回环地址的临时端口，创建和清理独立临时 SQLite 数据库；不读取 shell 中的 `DATA_PATH`、`.env` 或已有服务。桌面 Chromium 与 Pixel 7 移动视口运行相同关键流程，后台额外重启应用并重新读取会话、预约状态和删除结果。自动浏览器检查捕获页面异常、控制台错误、失败请求及所有意外 HTTP 错误（包括资源 404）；只有用例明确声明并验证次数的 401、422 响应允许出现。

`playwright-report/` 和 `test-results/` 保存本地诊断与官网/媒体截图并被 Git 忽略。自动 trace、视频和失败截图关闭，避免表单、凭据或会话进入诊断；主动截图只在公开页面且尚未填写预约时生成。交付包检查排除本机依赖和这些生成诊断目录，同时继续扫描实际源码、部署文件和静态资源。

仓储集成测试使用临时 SQLite 文件验证 API 字段映射、排序、状态和删除审计的原子性、统计批次回滚、留存及到期会话清理。导入测试只使用虚构记录，验证重复导入、数量核对、只读预检、源文件不变、隐私字段过滤及跨表回滚。现有服务接口回归同样直接使用 SQLite 种子与持久化结果。

会话测试启动不同 Node.js 进程访问同一临时数据库，验证 Cookie 重启恢复、到期读取删除、摘要存储及退出后的持续失效。错误契约测试覆盖输入、认证、CSRF、限流、实际 SQLite 触发器写入失败与请求 ID，确保响应及请求错误日志不泄露内部信息。浏览器脚本在最小 DOM 测试环境执行，覆盖错误消息、网络失败、超时、重复提交及异步完成后的表单重置；这不替代 Playwright 真浏览器验证。
