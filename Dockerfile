# syntax=docker/dockerfile:1
# One image, three roles: API+UI (default), worker, and one-off CLIs (migrate, create-admin, preflight).
# Node >= 22.18 runs the TypeScript sources directly (type stripping), so there is no server build step.
ARG NODE_IMAGE=node:22-bookworm-slim

# Building behind a TLS-intercepting proxy? Pass its CA without weakening verification:
#   docker build --secret id=extra_ca,src=/path/to/ca.pem .
# ---- production dependencies only (no vite, typescript, playwright) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- web UI build (needs dev dependencies) ----
FROM ${NODE_IMAGE} AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
    npm ci --ignore-scripts
COPY web ./web
RUN npx vite build web

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 FILE_STORE_DIR=/data/files TZ=UTC
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
COPY --from=web /app/web/dist ./web/dist
# /data is the only writable location (receipts + archived statements when FILE_STORE=local).
RUN mkdir -p /data/files && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server/main.ts"]
