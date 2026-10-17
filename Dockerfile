# syntax=docker/dockerfile:1
# Akentros Gateway — containerized Node topology (ECO-SUPPLY-2).
# Full runbook: "Topology D" in docs/DEPLOYMENT.md.
#
# Produces two runnable targets:
#   gateway   Node >= 22.18 running the TypeScript sources directly (type
#             stripping — the same execution mode as `npm run dev:gateway`),
#             SQLite data volume at /data, non-root user, /healthz healthcheck.
#   console   nginx serving the built Vite app on / and proxying /api to the
#             gateway with SSE-safe settings and the identity headers the
#             README's AKENTROS_TRUST_PROXY contract requires.
#
#   docker build --target gateway -t akentros-gateway .
#   docker build --target console -t akentros-console .
#   docker compose up -d --build      # both, wired together

# ---------- Stage 1: build the console (Vite) ----------
FROM node:22-slim AS console-build
WORKDIR /repo
# Lockfile-accurate install first: all four workspace manifests must be
# present or `npm ci` refuses to run.
COPY package.json package-lock.json ./
COPY apps/console/package.json apps/console/
COPY apps/gateway/package.json apps/gateway/
COPY packages/core/package.json packages/core/
RUN npm ci
# Same-origin API base: the nginx console target proxies /api to the gateway,
# so the built app works behind any hostname without rebuilding. Override
# with --build-arg VITE_AKENTROS_API_BASE=https://api.example.com/api when
# the console is served from a different origin than the gateway.
ARG VITE_AKENTROS_API_BASE=/api
ENV VITE_AKENTROS_API_BASE=${VITE_AKENTROS_API_BASE}
COPY . .
RUN npm run build

# ---------- Stage 2 (target: gateway) — Node runtime ----------
FROM node:22-slim AS gateway
ENV NODE_ENV=production \
    # containers must bind all interfaces, unlike the loopback default of
    # the bare-metal Node topology (README: AKENTROS_HOST)
    AKENTROS_HOST=0.0.0.0 \
    AKENTROS_DB_PATH=/data/akentros.db
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/console/package.json apps/console/
COPY apps/gateway/package.json apps/gateway/
COPY packages/core/package.json packages/core/
# Production tree only. --ignore-scripts: the only workspace lifecycle hook
# (core's prepack dist build) is a publish-time step, not a runtime need —
# the gateway executes the TypeScript sources directly.
RUN npm ci --omit=dev --ignore-scripts
# App sources (see .dockerignore for what is excluded). Console sources ride
# along so the workspace manifest stays lockfile-valid and the operational
# scripts below keep working inside the container.
COPY . .
# SQLite volume owned by the unprivileged runtime user
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/gateway/src/nodeServer.ts"]

# ---------- Stage 3 (target: console) — nginx + built assets ----------
FROM nginx:1.27-alpine AS console
COPY deploy/nginx-console.conf /etc/nginx/conf.d/default.conf
COPY --from=console-build /repo/apps/console/dist /usr/share/nginx/html
EXPOSE 80
