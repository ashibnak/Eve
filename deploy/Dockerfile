# syntax=docker/dockerfile:1
# One build, two runtime targets: `api` (server + worker) and `web` (Caddy serving the SPA).
ARG IMAGE_REGISTRY=
ARG NODE_IMAGE=node:24.15.0-bookworm-slim
ARG CADDY_IMAGE=caddy:2.10.2-alpine

FROM ${IMAGE_REGISTRY}${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable pnpm
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/prisma.config.ts apps/api/tsconfig.json apps/api/
COPY apps/api/prisma apps/api/prisma
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/jurisdictions/ir/package.json packages/jurisdictions/ir/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @eve/contracts --filter @eve/jurisdiction-ir build \
 && pnpm --filter @eve/api build \
 && pnpm --filter @eve/web build \
 && pnpm --filter @eve/api deploy --prod --legacy /out/api \
 && cp -r apps/api/prisma apps/api/prisma.config.ts /out/api/

FROM ${IMAGE_REGISTRY}${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api ./
COPY --from=build /repo/apps/api/dist ./dist
# Headless Chromium for document rendering (S11), pinned by the playwright-core version in the
# lockfile, with its system libraries; readable by the runtime user.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /ms-playwright
# Uploaded import files (volume eve_files); owned by the runtime user.
RUN mkdir -p /var/lib/eve/files && chown node:node /var/lib/eve/files
ENV EVE_FILES_DIR=/var/lib/eve/files
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations run with the owner role, then the server starts with the app role.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node dist/main.js"]

FROM ${IMAGE_REGISTRY}${CADDY_IMAGE} AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
