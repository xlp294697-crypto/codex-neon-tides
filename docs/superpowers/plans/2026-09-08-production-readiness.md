# Production Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current delivery bundle into a maintainable, tested, SQLite-backed single-store website with automated staging and approval-gated production releases.

**Architecture:** Keep one Node.js application behind Caddy and preserve the native HTML/CSS/JavaScript frontend. Split the server into focused modules, use the Node.js built-in SQLite API for durable storage, and ship the same immutable container image through staging to production.

**Tech Stack:** Node.js 24, ECMAScript modules, `node:http`, `node:sqlite`, Ajv 8, SQLite WAL, Node test runner, Playwright, ESLint, Prettier, Docker Compose, Caddy, GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-09-08-production-development-design.md`

## Global Constraints

- The product remains a single-store website with one application instance.
- Keep the public frontend in native HTML, CSS, and JavaScript without a frontend build system.
- Run production on Linux with Docker Compose and Caddy; do not expose the application port publicly.
- Store application data in SQLite with WAL, foreign keys, versioned migrations, and verified backups.
- Keep staging and production data, secrets, domains, containers, and volumes separate.
- Deploy one immutable image to staging first and require GitHub Environment approval before production.
- Never commit secrets, environment files, databases, backups, logs, or real inquiry data.
- Use test-first changes, focused commits, and verification evidence before completion claims.

---

## Phase 1: Establish a clean repository baseline

### Task 1: Restore release metadata and a green baseline

**Files:**
- Create: `.gitignore`
- Create: `.gitattributes`
- Create: `.env.example`
- Modify: `package.json`
- Create: `package-lock.json`
- Test: `tests/content.test.mjs`
- Test: `tests/package.test.mjs`

**Interfaces:**
- Consumes: Existing `npm run check` and `npm test` scripts.
- Produces: A repository where the current six tests pass and local secrets/data are ignored.

- [ ] **Step 1: Capture the existing failures**

Run: `npm test`

Expected: two failures identifying the missing `.gitignore` and `.env.example` files.

- [ ] **Step 2: Restore the ignored-file policy**

Create `.gitignore` with:

```gitignore
.env
.env.*
!.env.example
node_modules/
data/*.json
data/*.db
data/*.db-*
backups/
logs/
playwright-report/
test-results/
.cache/
.codex-log/
```

- [ ] **Step 3: Normalize text files**

Create `.gitattributes` with:

```gitattributes
* text=auto
*.mjs text eol=lf
*.js text eol=lf
*.json text eol=lf
*.md text eol=lf
*.sh text eol=lf
*.ps1 text eol=crlf
*.cmd text eol=crlf
*.jpg binary
```

- [ ] **Step 4: Restore the safe configuration template**

Create `.env.example` with non-secret values and explicit secret markers:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3002
DATA_PATH=./data/site.db
SITE_DOMAIN=replace.example.com
REPORT_TIME_ZONE=Asia/Shanghai
TRUST_PROXY=false
COOKIE_SECURE=true
ENABLE_HSTS=false
ADMIN_PASSWORD_HASH=请使用初始化工具生成
SESSION_SECRET=请使用初始化工具生成
EVENT_RETENTION_DAYS=180
MAX_EVENT_RECORDS=25000
MAX_INQUIRY_RECORDS=10000
SESSION_HOURS=8
BACKUP_RETENTION_DAYS=90
```

- [ ] **Step 5: Generate the lockfile without adding packages**

Run: `npm install --package-lock-only --ignore-scripts`

Expected: `package-lock.json` is created and `npm audit` reports no runtime dependency findings.

- [ ] **Step 6: Verify the repaired baseline**

Run: `npm run check && npm test`

Expected: syntax checks pass and all six tests pass.

- [ ] **Step 7: Commit the baseline repair**

```bash
git add .gitignore .gitattributes .env.example package.json package-lock.json tests
git commit -m "chore: restore repository baseline"
```

### Task 2: Split durable project documentation by concern

**Files:**
- Create: `docs/architecture.md`
- Create: `docs/development.md`
- Create: `docs/testing.md`
- Create: `docs/operations.md`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: The approved design spec and existing deployment/security documents.
- Produces: Stable documentation destinations referenced by `AGENTS.md` and future changes.

- [ ] **Step 1: Write the architecture document**

Create `docs/architecture.md` with the system context, component boundaries, request/data flows, SQLite ownership, and explicit single-instance constraint from sections 3–5 of the spec.

- [ ] **Step 2: Write the development document**

Create `docs/development.md` with prerequisites, environment initialization, local commands, branch workflow, dependency policy, migration workflow, and commit expectations from section 6 of the spec.

- [ ] **Step 3: Write the testing document**

Create `docs/testing.md` with the four test layers, fixture rules, command matrix, CI gates, and the rule that production personal data must never be used in tests.

- [ ] **Step 4: Write the operations document**

Create `docs/operations.md` with staging/production topology, deployment, migration, rollback, backup, restore, monitoring, logging, incident response, and cutover procedures.

- [ ] **Step 5: Turn root documentation into navigation**

Update `AGENTS.md` to link the four documents. Update `README.md` so onboarding links to them instead of duplicating their detailed content.

- [ ] **Step 6: Check links and package tests**

Run: `npm test`

Run: `rg -n "docs/(architecture|development|testing|operations)\.md" AGENTS.md README.md`

Expected: tests pass and both root documents link to the four durable guides.

- [ ] **Step 7: Commit the documentation structure**

```bash
git add AGENTS.md README.md docs
git commit -m "docs: separate engineering guides"
```

## Phase 2: Modularize the application without changing behavior

### Task 3: Introduce configuration and HTTP application boundaries

**Files:**
- Create: `src/config.mjs`
- Create: `src/http/errors.mjs`
- Create: `src/http/responses.mjs`
- Create: `src/app.mjs`
- Create: `src/server.mjs`
- Modify: `server.mjs`
- Create: `tests/unit/config.test.mjs`
- Modify: `tests/server.test.mjs`

**Interfaces:**
- Consumes: Current environment variables and HTTP behavior.
- Produces: `loadConfig(env, root) -> Config`, `createApp(config) -> requestListener`, and `startServer(config) -> http.Server`.

- [ ] **Step 1: Add failing configuration tests**

Create `tests/unit/config.test.mjs` asserting that `loadConfig()` rejects missing secrets, rejects a data path inside `public`, accepts an IANA time zone, and returns numeric limits with the current defaults.

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../src/config.mjs';

const valid = {
  NODE_ENV: 'test', ADMIN_PASSWORD: 'Valid-Testing-Key-4937!', SESSION_SECRET: 's'.repeat(48),
};

test('loadConfig rejects data stored under public', () => {
  assert.throws(() => loadConfig({ ...valid, DATA_PATH: './public/site.db' }, process.cwd()), /public/);
});

test('loadConfig applies bounded defaults', () => {
  const config = loadConfig(valid, process.cwd());
  assert.equal(config.port, 3002);
  assert.equal(config.reportTimeZone, 'Asia/Shanghai');
  assert.equal(config.eventRetentionDays, 180);
});
```

- [ ] **Step 2: Run the configuration test and observe the missing module failure**

Run: `node --test tests/unit/config.test.mjs`

Expected: failure because `src/config.mjs` does not exist.

- [ ] **Step 3: Extract configuration without changing names or defaults**

Move parsing and validation from `server.mjs` into `src/config.mjs`. Return a frozen camel-case configuration object; do not read `process.env` outside `src/server.mjs`.

- [ ] **Step 4: Extract response and error primitives**

Move `HttpError`, security headers, JSON/body response helpers, and request JSON parsing into `src/http/errors.mjs` and `src/http/responses.mjs`. Keep response status codes and Chinese messages unchanged.

- [ ] **Step 5: Establish app and process entry points**

Make `src/app.mjs` export the request listener and make `src/server.mjs` own listen, timers, signals, and graceful shutdown. Keep root `server.mjs` as a compatibility shim:

```js
import './src/server.mjs';
```

- [ ] **Step 6: Run focused and full regression checks**

Run: `node --test tests/unit/config.test.mjs tests/server.test.mjs`

Run: `npm run check && npm test`

Expected: the new tests and all existing behavior tests pass.

- [ ] **Step 7: Commit the application boundary**

```bash
git add server.mjs src tests package.json
git commit -m "refactor: separate config and HTTP application"
```

### Task 4: Extract authentication, validation, and business services

**Files:**
- Create: `src/middleware/auth.mjs`
- Create: `src/middleware/csrf.mjs`
- Create: `src/middleware/rate-limit.mjs`
- Create: `src/validation/inquiries.mjs`
- Create: `src/validation/events.mjs`
- Create: `src/services/dashboard-service.mjs`
- Create: `src/services/inquiry-service.mjs`
- Create: `src/services/analytics-service.mjs`
- Create: `tests/unit/dashboard-service.test.mjs`
- Create: `tests/unit/validation.test.mjs`
- Modify: `src/app.mjs`

**Interfaces:**
- Consumes: `Config` and repository interfaces supplied by `createApp`.
- Produces: `validateInquiry(input)`, `validateEvent(input)`, `createDashboard(data, timeZone)`, `createInquiryService(repository)`, and `createAnalyticsService(repository)`.

- [ ] **Step 1: Add failing pure-logic tests**

Test exact validation outcomes for a missing phone, missing privacy consent, invalid analytics notice version, future consent time, and a valid inquiry. Test dashboard visitor deduplication and conversion calculation using fixed timestamps.

- [ ] **Step 2: Run the new tests and observe missing exports**

Run: `node --test tests/unit/validation.test.mjs tests/unit/dashboard-service.test.mjs`

Expected: failures because the service and validation modules do not exist.

- [ ] **Step 3: Extract validation and dashboard aggregation**

Move current behavior into the named modules. Use explicit result objects:

```js
// success
{ ok: true, value: normalizedValue }
// failure
{ ok: false, code: 'INVALID_PHONE', message: '请填写有效电话。' }
```

- [ ] **Step 4: Extract security middleware**

Move signed-cookie handling, CSRF validation, and in-memory rate-limit buckets into focused modules. Keep current cookie flags and limits unchanged during this behavior-preserving step.

- [ ] **Step 5: Extract inquiry and analytics services**

Services accept repositories as constructor arguments and contain no file-system calls. `src/app.mjs` wires services to routes.

- [ ] **Step 6: Run unit and regression tests**

Run: `node --test tests/unit tests/server.test.mjs`

Run: `npm test`

Expected: all tests pass with unchanged external behavior.

- [ ] **Step 7: Commit the service split**

```bash
git add src tests
git commit -m "refactor: isolate application services"
```

## Phase 3: Replace JSON persistence with SQLite

### Task 5: Add the SQLite connection and migration system

**Files:**
- Create: `src/db/database.mjs`
- Create: `src/db/migrate.mjs`
- Create: `src/db/migrations/001-initial-schema.sql`
- Create: `tests/integration/migrations.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `config.dataPath`.
- Produces: `openDatabase(path) -> DatabaseSync`, `migrate(db) -> number`, and `closeDatabase(db) -> void`.

- [ ] **Step 1: Add a failing migration test**

Create a temporary database, call `migrate`, and assert that these tables exist: `schema_migrations`, `inquiries`, `analytics_events`, `admin_sessions`, and `audit_logs`. Re-run `migrate` and assert it remains at version 1.

- [ ] **Step 2: Run the migration test and observe the missing module failure**

Run: `node --test tests/integration/migrations.test.mjs`

Expected: failure because `src/db/database.mjs` does not exist.

- [ ] **Step 3: Implement the database factory**

`openDatabase` must create the parent directory and execute:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

- [ ] **Step 4: Add the initial migration**

Define typed columns, checks for inquiry status and event type, indexes on timestamps and status, hashed session tokens, expiry timestamps, and an audit payload that excludes personal-information fields.

- [ ] **Step 5: Make migrations transactional and immutable**

`migrate` reads numbered SQL files in lexical order, calculates a SHA-256 checksum, and rejects an already-recorded version whose checksum differs.

- [ ] **Step 6: Run migration and complete test suites**

Run: `node --test tests/integration/migrations.test.mjs`

Run: `npm test`

Expected: repeated migration succeeds and all tests pass.

- [ ] **Step 7: Commit the database foundation**

```bash
git add src/db tests/integration package.json package-lock.json
git commit -m "feat: add SQLite migration foundation"
```

### Task 6: Implement SQLite repositories and JSON import

**Files:**
- Create: `src/repositories/inquiry-repository.mjs`
- Create: `src/repositories/analytics-repository.mjs`
- Create: `src/repositories/session-repository.mjs`
- Create: `src/repositories/audit-repository.mjs`
- Create: `tools/import-json-data.mjs`
- Create: `tests/integration/repositories.test.mjs`
- Create: `tests/integration/import-json-data.test.mjs`
- Modify: `src/app.mjs`

**Interfaces:**
- Consumes: an open migrated `DatabaseSync` connection.
- Produces: repository methods `create`, `findAll`, `updateStatus`, `remove`, `insertBatch`, `prune`, `findSession`, `saveSession`, and `deleteSession`.

- [ ] **Step 1: Add failing repository tests**

Test inquiry creation and ordering, allowed status transitions, deletion plus audit record, event batch rollback on invalid input, event retention, and expired-session cleanup against a temporary database.

- [ ] **Step 2: Run repository tests and observe missing modules**

Run: `node --test tests/integration/repositories.test.mjs`

Expected: missing-module failures.

- [ ] **Step 3: Implement prepared statements and transactions**

Keep all SQL inside repositories. Use a single transaction for inquiry deletion plus its non-personal audit entry and a single transaction for each analytics batch.

- [ ] **Step 4: Wire repositories into application services**

Remove JSON file mutation calls from the runtime path. Preserve current API shapes while mapping SQLite rows to the existing response objects.

- [ ] **Step 5: Add a failing JSON import test**

Import a fixture containing two inquiries and three events, run the importer twice, and assert that the database still contains two inquiries and three events.

- [ ] **Step 6: Implement idempotent JSON import**

The tool accepts `--source`, `--database`, and `--dry-run`; it verifies source structure, imports in one transaction, uses record IDs for idempotency, and prints source/imported/skipped counts without printing personal fields.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test tests/integration/repositories.test.mjs tests/integration/import-json-data.test.mjs`

Run: `npm test`

Expected: repository, import, and regression tests pass.

- [ ] **Step 8: Commit SQLite persistence**

```bash
git add src tools tests package.json package-lock.json
git commit -m "feat: migrate application storage to SQLite"
```

### Task 7: Persist sessions and standardize safe API errors

**Files:**
- Modify: `src/middleware/auth.mjs`
- Modify: `src/http/errors.mjs`
- Modify: `src/http/responses.mjs`
- Modify: `src/app.mjs`
- Modify: `public/app.js`
- Modify: `public/admin.js`
- Create: `tests/integration/session-persistence.test.mjs`
- Create: `tests/integration/error-contract.test.mjs`

**Interfaces:**
- Consumes: `sessionRepository` and normalized validation errors.
- Produces: persistent sessions and `{ error: { code, message, requestId } }` failure responses.

- [ ] **Step 1: Add a failing restart-session test**

Log in, retain the cookie, stop the server, start a new server process against the same database, and assert that `GET /api/session` returns 200 until expiry.

- [ ] **Step 2: Add failing error-contract tests**

Assert stable codes for invalid JSON, invalid phone, missing consent, failed CSRF, unauthenticated access, rate limiting, and unexpected internal errors. Assert that responses contain no stack, SQL, local path, password, or cookie.

- [ ] **Step 3: Persist only session-token hashes**

Store `HMAC-SHA256(sessionSecret, rawToken)` as the lookup key. Keep the raw token only in the signed, secure cookie; delete expired sessions during reads and periodic maintenance.

- [ ] **Step 4: Implement the error envelope and request IDs**

Generate one request ID per request, send it in `X-Request-Id`, include it in safe error responses, and log it with the internal error category.

- [ ] **Step 5: Update browser clients**

Make both clients read `body.error.message`, prevent duplicate form submissions while requests are pending, and display explicit timeout/network messages.

- [ ] **Step 6: Run session, error, and browser-script checks**

Run: `node --test tests/integration/session-persistence.test.mjs tests/integration/error-contract.test.mjs`

Run: `npm run check && npm test`

Expected: sessions survive restart, error contracts pass, and all regression tests pass.

- [ ] **Step 7: Commit durable authentication and errors**

```bash
git add src public tests
git commit -m "feat: persist sessions and standardize API errors"
```

## Phase 4: Complete automated quality gates

### Task 8: Add linting, formatting, and browser tests

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `playwright.config.mjs`
- Create: `tests/e2e/site.spec.mjs`
- Create: `tests/e2e/admin.spec.mjs`

**Interfaces:**
- Consumes: the modular application and temporary SQLite database.
- Produces: `npm run lint`, `npm run format:check`, `npm run test:unit`, `npm run test:integration`, and `npm run test:e2e`.

- [ ] **Step 1: Install exact development dependencies**

Run: `npm install --save-dev --save-exact eslint prettier @playwright/test`

Run: `npx playwright install chromium`

- [ ] **Step 2: Add scripts and focused test commands**

Configure package scripts so unit and integration directories can run independently and `npm test` runs unit plus integration tests. Keep E2E separate for local and CI diagnostics.

- [ ] **Step 3: Configure lint and format checks**

Enable recommended ECMAScript rules, Node globals for server files, browser globals for `public/*.js`, and exclusions for data, backups, reports, and generated coverage.

- [ ] **Step 4: Add public-site E2E coverage**

Test desktop and mobile navigation, statistics refusal, statistics acceptance, media dialog, valid inquiry submission, invalid phone feedback, privacy page, console errors, failed requests, and resource 404s.

- [ ] **Step 5: Add admin E2E coverage**

Seed a synthetic inquiry, log in with a test password, update its status, refresh, verify persistence, delete it, log out, and verify protected APIs return 401.

- [ ] **Step 6: Run all local quality gates**

Run: `npm run format:check && npm run lint && npm run check && npm test && npm run test:e2e`

Expected: every command exits zero with no skipped critical scenario.

- [ ] **Step 7: Commit the test toolchain**

```bash
git add package.json package-lock.json eslint.config.mjs .prettierrc.json .prettierignore playwright.config.mjs tests
git commit -m "test: add complete local quality gates"
```

### Task 9: Add pull-request continuous integration

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/dependabot.yml`
- Modify: `docs/testing.md`

**Interfaces:**
- Consumes: package scripts from Task 8 and `Dockerfile`.
- Produces: required PR checks for quality, E2E, container build, and vulnerability scanning.

- [ ] **Step 1: Add a CI workflow with least permissions**

Use `permissions: contents: read`, Node.js 24, `npm ci`, cached npm downloads, Playwright Chromium, and job timeouts. Run formatting, lint, syntax, unit, integration, E2E, and `docker build` jobs.

- [ ] **Step 2: Add dependency and container scanning**

Run `npm audit --omit=dev --audit-level=high` and scan the built image with a pinned Trivy action. Fail on fixable HIGH or CRITICAL production findings; upload the SARIF report with security-events write permission only in the scan job.

- [ ] **Step 3: Add dependency update policy**

Configure weekly npm, GitHub Actions, and Docker updates with grouped non-major development updates and separate production updates.

- [ ] **Step 4: Validate the workflow locally**

Run: `npm run format:check && npm run lint && npm run check && npm test && npm run test:e2e && docker build -t jiuyue-sports:ci .`

Expected: all commands pass and the container image builds.

- [ ] **Step 5: Commit continuous integration**

```bash
git add .github docs/testing.md
git commit -m "ci: enforce pull request quality gates"
```

## Phase 5: Build immutable staging and production delivery

### Task 10: Harden the runtime image and Compose topology

**Files:**
- Modify: `Dockerfile`
- Create: `compose.staging.yaml`
- Create: `compose.production.yaml`
- Modify: `deploy/Caddyfile.docker`
- Create: `deploy/healthcheck.mjs`
- Modify: `docs/operations.md`
- Create: `tests/package.test.mjs`

**Interfaces:**
- Consumes: `src/server.mjs`, SQLite migrations, and environment validation.
- Produces: one immutable application image usable by both environments.

- [ ] **Step 1: Extend package tests for container invariants**

Assert that the Dockerfile runs as a non-root user, copies only runtime files, has a health check, and that both Compose files use separate named volumes, read-only root filesystems, dropped capabilities, and no public application-port binding.

- [ ] **Step 2: Run package tests and observe failures**

Run: `node --test tests/package.test.mjs`

Expected: failure until the new Compose topology exists.

- [ ] **Step 3: Build the production image**

Use a pinned Node.js 24 Alpine digest, `npm ci --omit=dev`, copy `src`, `public`, and migrations, run as `node`, and call `deploy/healthcheck.mjs` for liveness/readiness.

- [ ] **Step 4: Separate staging and production Compose projects**

Give each environment unique project names, application-data volumes, Caddy data/config volumes, domains, and environment files. Expose only TCP 80/443 and UDP 443 from Caddy.

- [ ] **Step 5: Verify configuration and runtime behavior**

Run: `docker compose -f compose.staging.yaml config`

Run: `docker compose -f compose.production.yaml config`

Run: `docker build -t jiuyue-sports:local .`

Run the image with test secrets and verify `/api/health` reports both process and database readiness.

- [ ] **Step 6: Run package and full tests**

Run: `npm test`

Expected: all package and application tests pass.

- [ ] **Step 7: Commit runtime delivery files**

```bash
git add Dockerfile compose.staging.yaml compose.production.yaml deploy docs/operations.md tests/package.test.mjs
git commit -m "build: add hardened environment topology"
```

### Task 11: Implement GHCR publishing and approval-gated deployment

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `deploy/deploy-release.sh`
- Create: `deploy/smoke-test.mjs`
- Modify: `docs/operations.md`

**Interfaces:**
- Consumes: successful CI, GHCR, GitHub `staging` and `production` Environments, and configured SSH secrets.
- Produces: automatic staging deployment and manually approved production deployment of the identical image digest.

- [ ] **Step 1: Add the release workflow trigger and permissions**

Trigger on successful `main` CI and manual dispatch. Grant only `contents: read` and `packages: write` to the build job. Build `ghcr.io/${{ github.repository }}:${{ github.sha }}`, push it once, and record its digest as a job output.

- [ ] **Step 2: Deploy the digest to staging**

Use the `staging` GitHub Environment. Connect through SSH, set `APP_IMAGE` to the digest-qualified image, run `deploy/deploy-release.sh staging`, then execute `deploy/smoke-test.mjs` against the staging domain.

- [ ] **Step 3: Gate production with a GitHub Environment**

Make the production job depend on the successful staging job and use the `production` Environment. GitHub Environment required reviewers provide the human approval gate.

- [ ] **Step 4: Deploy the identical digest to production**

Before replacement, create and verify a SQLite backup. Deploy the digest from the build job, run migrations, wait for readiness, and execute health, homepage, privacy, static asset, login, and synthetic inquiry smoke checks.

- [ ] **Step 5: Implement automatic application rollback**

`deploy-release.sh` records the current digest before replacement. If migration, readiness, or smoke checks fail, it restores the previous digest and reports the backup path and failed stage. Destructive schema contraction is excluded from automated releases.

- [ ] **Step 6: Validate scripts without production access**

Run: `sh -n deploy/deploy-release.sh`

Run: `node --check deploy/smoke-test.mjs`

Run: `npm test`

Expected: script syntax and all tests pass.

- [ ] **Step 7: Commit release automation**

```bash
git add .github/workflows/release.yml deploy docs/operations.md
git commit -m "ci: add staged production releases"
```

### Task 12: Complete backup, restore, monitoring, and cutover readiness

**Files:**
- Create: `tools/backup-sqlite.mjs`
- Create: `tools/restore-sqlite.mjs`
- Create: `tools/verify-backup.mjs`
- Modify: `deploy/jiuyue-backup.service.example`
- Modify: `deploy/jiuyue-backup.timer.example`
- Create: `deploy/monitor-health.mjs`
- Modify: `docs/operations.md`
- Modify: `SECURITY.md`
- Modify: `DEPLOYMENT-CHECKLIST.md`
- Create: `tests/integration/backup-restore.test.mjs`

**Interfaces:**
- Consumes: the production SQLite schema and health endpoints.
- Produces: consistent backups, verified restoration, actionable monitoring, and a rehearsed production cutover checklist.

- [ ] **Step 1: Add a failing backup/restore integration test**

Create a temporary populated database, back it up, verify its SHA-256 and `PRAGMA integrity_check`, restore to a new path, and assert that inquiries, events, sessions, migration versions, and audit rows match.

- [ ] **Step 2: Run the test and observe missing tools**

Run: `node --test tests/integration/backup-restore.test.mjs`

Expected: failure because the SQLite backup tools do not exist.

- [ ] **Step 3: Implement online backup and verification**

Use SQLite's backup API or `VACUUM INTO` against the live connection, write to a timestamped temporary destination, run integrity checks, atomically rename the finished backup, and create a sibling `.sha256.txt` containing only the portable filename and digest.

- [ ] **Step 4: Implement guarded restoration**

Require a matching hash by default, verify integrity and migration compatibility, create a safety backup of the current database, restore while the application is stopped, preserve restrictive permissions, and fail before replacement on any verification error.

- [ ] **Step 5: Update scheduled backup units**

Run daily under the unprivileged application account, retain 90 days locally, verify every new backup, and leave off-server copying as an explicitly configured deployment secret and destination.

- [ ] **Step 6: Add actionable monitoring**

Check public homepage, readiness, disk free space, container restart count, certificate expiry, last verified backup age, and SQLite integrity status. Exit non-zero with a machine-readable error code only when action is required.

- [ ] **Step 7: Run the recovery test and full quality gates**

Run: `node --test tests/integration/backup-restore.test.mjs`

Run: `npm run format:check && npm run lint && npm run check && npm test && npm run test:e2e`

Expected: backup restoration preserves all test records and every quality gate passes.

- [ ] **Step 8: Perform the staging recovery rehearsal**

Create synthetic staging data, back it up, delete the staging database through the documented guarded procedure, restore it, and verify the complete public and admin smoke suite.

- [ ] **Step 9: Perform the production cutover rehearsal checklist**

Verify DNS, firewall, GitHub Environment approval, secrets, off-server backup destination, rollback digest, data-import counts, monitoring destination, Caddy certificate issuance, and operator access without changing production traffic.

- [ ] **Step 10: Commit operational readiness**

```bash
git add tools deploy docs/operations.md SECURITY.md DEPLOYMENT-CHECKLIST.md tests/integration/backup-restore.test.mjs
git commit -m "ops: add verified recovery and monitoring"
```

## Final acceptance gate

- [ ] Run `npm ci` from a clean checkout.
- [ ] Run `npm run format:check && npm run lint && npm run check && npm test && npm run test:e2e`.
- [ ] Build the production image and record its digest.
- [ ] Deploy that digest to staging and complete the full smoke suite.
- [ ] Import a synthetic legacy JSON file and reconcile record counts.
- [ ] Complete a staging backup-and-restore rehearsal.
- [ ] Confirm staging contains no production personal information.
- [ ] Confirm secrets are absent from Git history, image layers, logs, and test artifacts.
- [ ] Confirm production requires a GitHub Environment reviewer.
- [ ] Confirm rollback restores the previous image digest without schema incompatibility.
- [ ] Review `docs/architecture.md`, `docs/development.md`, `docs/testing.md`, `docs/operations.md`, `SECURITY.md`, and `DEPLOYMENT-CHECKLIST.md` for consistency.
- [ ] Record all acceptance evidence in the release run summary before approving production.
