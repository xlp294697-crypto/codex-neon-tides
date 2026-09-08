FROM node:24-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine3.24@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

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
