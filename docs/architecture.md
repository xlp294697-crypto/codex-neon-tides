# 架构指南

## 系统范围

氿悦体育是单店官网单体应用，提供公开内容、预约询盘、经访客同意的访问统计和单管理员后台。系统以单实例、低到中等访问量、低维护成本为设计前提；不引入微服务、Kubernetes、多租户或多角色权限。

目标生产拓扑为浏览器经 HTTPS 访问 Caddy；Caddy 负责证书、安全响应头和反向代理；一个 Node.js 应用容器提供业务与静态资源；SQLite 保存业务数据。应用端口不得直接暴露公网，只能由 Caddy 访问。SQLite 与此业务规模要求 Node.js 应用始终只运行一个实例。

```text
浏览器 → HTTPS → Caddy → Node.js 单体应用 → SQLite
```

## 组件边界

```text
src/
├─ server.mjs       启动 HTTP 服务、监听和优雅退出
├─ app.mjs          组合路由、中间件与依赖，供集成测试启动
├─ config/          环境配置与启动检查
├─ routes/          HTTP 请求解析和响应适配
├─ services/        预约、统计、认证和保留期业务规则
├─ repositories/    SQL 与事务封装
├─ middleware/      认证、CSRF、请求 ID、限流、校验和错误转换
└─ db/              SQLite 连接、迁移、事务、健康检查与备份协调
   ├─ migrations/
   └─ migrate.mjs
public/             无构建步骤的原生前端资源
tests/              unit、integration、e2e 与 fixtures
```

路由层不得包含 SQL 或表结构细节；服务层不应依赖 HTTP 表达；仓储层是业务层访问 SQLite 的唯一入口。`app.mjs` 保持可独立组合，`server.mjs` 仅承载进程生命周期。

当前模块拆分已落实到 `config.mjs`、`http/`、`middleware/`、`validation/` 和 `services/`。认证、CSRF、限流状态独立于路由；请求先沿用现有文本规范化规则，再通过固定版本 Ajv 的应用内 Schema 校验，返回明确的成功值或错误码与中文消息。未启用 Ajv 的 `$data` 动态引用选项。拒绝统计或无效统计同意不阻止有效预约，只移除预约归因；事件必须具有有效统计同意。

`createInquiryService(repository)` 接收 `create(record)`、`findAll()`、`updateStatus(id, status, updatedAt)` 和 `remove(id)`；更新和删除返回记录是否存在。`createAnalyticsService(repository)` 接收原子批量写入方法 `insertBatch(events)`，负责队列、批量与重试；定时器仍由 `server.mjs` 管理。服务不调用文件系统，也不决定 HTTP 状态码。当前 `app.mjs` 提供串行 JSON 仓储适配器，后续 SQLite 仓储替换这些依赖。纯函数 `createDashboard(data, timeZone, now?)` 保持现有去重、转化率及报表时区口径。

## 请求与数据流

- 预约：路由校验输入 → 服务执行业务规则 → 仓储在 SQLite 事务中写入 → 仅事务成功后返回成功。失败时必须明确失败，不能伪造成功。
- 统计：仅在访客同意后产生事件；事件可批量写入，写入失败不得阻断官网或预约，但必须留下可监控的记录。拒绝统计时不创建或保存统计访客标识。
- 管理后台：认证中间件验证会话，所有写操作同时验证 CSRF；服务记录必要的、无个人信息正文的审计事件。
- 启动：配置检查 → SQLite 连接与迁移检查/执行 → 应用开始接收流量。迁移失败时拒绝启动。

## SQLite 所有权与迁移

SQLite 启用 WAL、外键约束和合理的 busy timeout。`db/` 负责连接选项、事务入口、迁移、健康检查和备份协调；其他层不得直接管理连接或绕过迁移。

数据库基础接口为 `openDatabase(path)`、`migrate(db)` 和 `closeDatabase(db)`，使用 Node.js 24 内置 `node:sqlite`。连接启用 WAL、外键、5000ms busy timeout 和 NORMAL synchronous；`migrate` 返回当前版本，使用单个事务执行待应用迁移并记录 SHA-256 校验值。已应用迁移缺失或校验不符时拒绝继续；SQL 文件固定 LF 换行，禁止修改已应用迁移。此阶段运行时仍使用 JSON，仓储切换在后续任务完成。

业务时间使用 UTC ISO 8601 文本，会话创建和过期时间使用毫秒时间戳。会话仅存储令牌和 CSRF 令牌的 SHA-256 小写十六进制摘要。审计动作限定为 `inquiry_status_changed` 和 `inquiry_deleted`，JSON `payload` 仅允许枚举状态字段 `fromStatus`、`toStatus`；`inquiry_id` 不设外键，以便删除预约后保留不含个人信息正文的审计记录。

主要表为：

- `inquiries`：预约内容、状态、时间、隐私告知版本和统计归因许可；
- `analytics_events`：经同意产生的页面访问和内容互动；
- `admin_sessions`：会话令牌摘要、CSRF 信息、创建和过期时间；
- `schema_migrations`：已执行迁移版本和时间；
- `audit_logs`：后台状态变化与删除动作，且不保存已删除个人信息正文。

所有结构变化必须使用版本化迁移。破坏性变化遵循“扩展—迁移—收缩”，以便回滚期间旧应用仍可读取数据库。旧 JSON 数据导入工具必须一次性、可重复验证：导入前备份，导入后核对数量和关键字段；切换验证后只保留受保护的迁移备份，禁止双写。
