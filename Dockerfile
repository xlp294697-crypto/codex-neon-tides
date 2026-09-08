FROM node:24-alpine3.24

LABEL org.opencontainers.image.title="Jiuyue Sports Website" \
      org.opencontainers.image.description="Production website, enquiry inbox and consent-based traffic dashboard"

WORKDIR /app
COPY --chown=node:node package.json server.mjs media-manifest.json ./
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3002 \
    DATA_PATH=/app/data/site.db

USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
