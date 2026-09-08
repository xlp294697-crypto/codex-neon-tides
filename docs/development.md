# 开发指南

## 前提与初始化

数据库模块使用 Node.js 24 内置 `node:sqlite`，本地开发和测试要求 Node.js 24 或更高版本；CI 与容器均使用 Node.js 24。`npm start` 与 `npm run dev` 会先检查 Node 主版本，并由 Node 的 `--env-file-if-exists=.env` 实际载入项目根目录配置。先运行初始化工具生成有效的 `.env`；不要把 `.env.example` 中的占位密钥直接用于启动。绝不提交 `.env`、数据库、备份、日志或真实预约数据。

本地开发的目标运行方式是 Docker Compose 加独立 SQLite 数据库。后端使用 `node --watch` 自动重启；前端继续直接加载 `public/` 中的原生静态文件，不引入前端打包链。具体用户部署和平台命令见 [README](../README.md)。

## 常用命令

```bash
npm ci
./tools/initialize-config.sh # Windows 使用 tools/Initialize-Config.ps1
npm run format:check
npm run lint
npm run check
npm test
npx playwright install chromium
npm run test:e2e
npm run test:migrations
npm run dev
```

`npm run dev` 使用 `node --watch` 自动重启，`npm start` 用于不需要监听文件变化的本地运行。Ajv 是运行时输入 Schema 校验依赖，已以精确版本记录在 `dependencies` 和 `package-lock.json` 中；使用 `npm ci` 即会安装，不要全局安装或绕过锁文件单独升级。若要升级 Ajv，使用 `npm install --save-exact ajv@<已审计版本>`，提交锁文件并运行完整质量门禁。

新增或调整脚本时，应同时覆盖开发、检查、测试、迁移和启动用途，并保持本地、CI 和容器的 Node.js 主版本一致。

## 分支与提交

1. `main` 必须始终可发布。
2. 从 `main` 创建短期功能或修复分支。
3. 功能或缺陷修复先编写会失败的测试，再实现。
4. 提交 Pull Request，等待自动质量门禁和审查。
5. 通过后合并 `main`；合并会部署预发布，预发布验证后才可人工批准生产发布。

提交应聚焦单一可审查目标，说明行为、配置、数据结构或运维流程的变更；不得混入无关重构或敏感文件。提交前运行与改动相符的检查，如实报告未运行或失败的验证。

## 依赖与代码治理

保持 `package-lock.json` 锁定依赖版本。新增生产依赖前，说明其必要性、维护状态、安全影响及更简单替代方案；不为单店规模引入重量级框架或基础设施。使用 Prettier 和 ESLint 做格式化与基础静态检查，但不增加不匹配当前规模的工具链。

## 迁移工作流

数据库结构只能通过 `db/migrations/` 中的版本化迁移变更。迁移要能在独立开发数据库和自动测试中执行，并在部署前经过备份与恢复验证。应用启动时只执行允许的迁移；迁移失败必须阻止启动。

对破坏性变更采用扩展—迁移—收缩的多次发布方式。导入旧 JSON 时先创建备份，运行可重复验证的导入并核对记录数量和关键字段；完成生产切换验证后停止双写。
