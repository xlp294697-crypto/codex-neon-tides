FROM node:26-alpine3.24@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine3.24@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3

# Patch the base OpenSSL libraries; package managers are not runtime dependencies.
RUN apk add --no-cache --upgrade 'libcrypto3>=3.5.8-r0' 'libssl3>=3.5.8-r0' \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg

LABEL org.opencontainers.image.title="Jiuyue Sports Website" \
      org.opencontainers.image.description="Production website, enquiry inbox and consent-based traffic dashboard"

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json server.mjs media-manifest.json ./
COPY src ./src
COPY public ./public
COPY deploy/healthcheck.mjs ./deploy/healthcheck.mjs
COPY tools/sqlite-operations.mjs tools/backup-sqlite.mjs tools/verify-backup.mjs tools/restore-sqlite.mjs tools/import-json-data.mjs ./tools/
COPY deploy/monitor-health.mjs ./deploy/monitor-health.mjs
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3002 \
    DATA_PATH=/app/data/site.db

USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=8s --start-period=10s --retries=3 \
  CMD ["node", "deploy/healthcheck.mjs", "readiness"]
CMD ["node", "server.mjs"]
