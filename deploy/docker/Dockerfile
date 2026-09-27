# syntax=docker/dockerfile:1

# Hamnivo images, built from this repository (the build context is the repository root).
#   gateway  API, background worker and database migrations: one image, three commands
#   edge     Caddy with the static apps (chat widget and loader, website) and automatic HTTPS
#
# deploy/production/compose.yml builds both with your settings. To build one by hand:
#   docker build -f deploy/docker/Dockerfile --target gateway -t hamnivo/gateway:local .
# Behind a proxy that inspects TLS, pass its CA certificate:
#   docker build ... --secret id=extra_ca,src=/path/to/ca.pem

ARG NODE_VERSION=24.21.0
ARG CADDY_VERSION=2.11.4

# ---- Tooling ------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-trixie-slim AS tooling
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    ASTRO_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm install --global --no-fund --no-audit pnpm@10.33.0
WORKDIR /src

# ---- Source and dependencies --------------------------------------------------------------------
# The package store is a build cache, so a rebuild after a code change downloads nothing.
FROM tooling AS source
COPY . .
RUN --mount=type=cache,id=hamnivo-pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm/store

# ---- Gateway ------------------------------------------------------------------------------------
FROM source AS gateway-build
RUN pnpm exec turbo run build --filter=@hamnivo/gateway...
# A self-contained copy with production dependencies only.
RUN --mount=type=cache,id=hamnivo-pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm --filter @hamnivo/gateway deploy --prod --legacy --prefer-offline --store-dir /pnpm/store /out

FROM node:${NODE_VERSION}-trixie-slim AS gateway
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
# Owned by root and read-only for the service user.
COPY --from=gateway-build /out ./
USER node
EXPOSE 4000
# The API by default; the compose file runs dist/main.worker.js and dist/main.migrate.js too.
CMD ["node", "dist/main.api.js"]

# ---- Static apps --------------------------------------------------------------------------------
FROM source AS web-build
# Public addresses are compiled into the static apps.
ARG HAMNIVO_API_ORIGIN
ARG HAMNIVO_CHAT_ORIGIN
ARG HAMNIVO_SITE_URL
# Optional: a brand's widget ID turns on the live chat demo on the website.
ARG HAMNIVO_DEMO_WIDGET_ID=""
RUN test -n "$HAMNIVO_API_ORIGIN" && test -n "$HAMNIVO_CHAT_ORIGIN" && test -n "$HAMNIVO_SITE_URL" || \
    { echo 'Set the HAMNIVO_API_ORIGIN, HAMNIVO_CHAT_ORIGIN and HAMNIVO_SITE_URL build arguments' >&2; exit 1; }
RUN pnpm exec turbo run build \
      --filter=@hamnivo/widget^... --filter=@hamnivo/site^... --filter=@hamnivo/widget-loader
RUN VITE_HAMNIVO_API="$HAMNIVO_API_ORIGIN" pnpm --filter @hamnivo/widget build
RUN PUBLIC_SITE_URL="$HAMNIVO_SITE_URL" \
    PUBLIC_HAMNIVO_WIDGET_ID="$HAMNIVO_DEMO_WIDGET_ID" \
    PUBLIC_HAMNIVO_WIDGET_ORIGIN="${HAMNIVO_DEMO_WIDGET_ID:+$HAMNIVO_CHAT_ORIGIN}" \
    PUBLIC_HAMNIVO_API="${HAMNIVO_DEMO_WIDGET_ID:+$HAMNIVO_API_ORIGIN}" \
    pnpm --filter @hamnivo/site build
RUN mkdir -p /out/chat /out/site \
 && cp -R apps/widget/dist/. /out/chat/ \
 && cp packages/widget-loader/dist/loader.js /out/chat/loader.js \
 && cp -R apps/site/dist/. /out/site/

FROM caddy:${CADDY_VERSION}-alpine AS edge
COPY --from=web-build /out/chat /srv/chat
COPY --from=web-build /out/site /srv/site
COPY deploy/production/Caddyfile /etc/caddy/Caddyfile
