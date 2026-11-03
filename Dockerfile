FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/gateway/package.json ./apps/gateway/package.json
COPY apps/contributor/package.json ./apps/contributor/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY apps/gateway ./apps/gateway
RUN npm run build:gateway && npm prune --omit=dev
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATABASE_PATH=/data/open-inference.sqlite
ENV MESHLLM_OWNER_KEY_PATH=/data/community-mesh-owner-key
USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/gateway/dist/index.js"]
