# syntax=docker/dockerfile:1

# Hamnivo images, built from this repository (the build context is the repository root).
#   gateway  API, background worker and database migrations: one image, three commands
#   edge     Caddy with the static apps (Studio, chat widget and loader, website) and HTTPS
#   verify   lint, type checks and unit tests; automatic deploys build it first (nothing ships)
#
# deploy/production/compose.yml builds both with your settings. To build one by hand:
#   docker build -f deploy/docker/Dockerfile --target gateway -t hamnivo/gateway:local .
# Behind a proxy that inspects TLS, pass its CA certificate:
#   docker build ... --secret id=extra_ca,src=/path/to/ca.pem
# HAMNIVO_RELEASE (the git commit) labels the images; deploy/production/deploy.sh passes it.
# Turbo's cache lives in a build cache, so a rebuild redoes only the packages that changed.

ARG NODE_VERSION=24.21.0
ARG CADDY_VERSION=2.11.4

# ---- Tooling ------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-trixie-slim AS tooling
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    TURBO_CACHE_DIR=/turbo-cache \
    ASTRO_TELEMETRY_DISABLED=1
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm install --global --no-fund --no-audit pnpm@10.33.0
WORKDIR /src

# ---- Dependencies, then source -------------------------------------------------------------------
# Only the package manifests decide what is installed, so the installed dependencies (the biggest
# layer) are reused until a manifest or the lockfile changes, and a code change costs one small
# COPY. Dependencies' install scripts are skipped: the native ones ship prebuilt platform packages.
# The package store is a build cache, so a new install downloads only what is new.
FROM tooling AS manifests
RUN --mount=type=bind,target=/context \
    mkdir -p /manifests && cd /context \
 && cp .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json /manifests/ \
 && find . -name package.json -not -path '*/node_modules/*' -exec cp --parents {} /manifests/ \;

FROM tooling AS deps
COPY --from=manifests /manifests/ ./
RUN --mount=type=cache,id=hamnivo-pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --prefer-offline --ignore-scripts --store-dir /pnpm/store

FROM deps AS source
COPY . .

# ---- Checks -------------------------------------------------------------------------------------
# What must pass before a version goes live: Biome, type checks and unit tests (no services).
FROM source AS checks
RUN --mount=type=cache,id=hamnivo-turbo,target=/turbo-cache,sharing=locked \
    pnpm exec biome check . && pnpm exec turbo run typecheck test && touch /checks-passed

# The target a deploy builds: a marker only, so the source tree is never exported as an image.
FROM scratch AS verify
COPY --from=checks /checks-passed /checks-passed

# ---- Gateway ------------------------------------------------------------------------------------
FROM source AS gateway-build
RUN --mount=type=cache,id=hamnivo-turbo,target=/turbo-cache,sharing=locked \
    pnpm exec turbo run build --filter=@hamnivo/gateway...
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
ARG HAMNIVO_RELEASE=unknown
LABEL org.opencontainers.image.title="Hamnivo gateway" \
      org.opencontainers.image.revision="$HAMNIVO_RELEASE"
ENV HAMNIVO_RELEASE=$HAMNIVO_RELEASE

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
RUN --mount=type=cache,id=hamnivo-turbo,target=/turbo-cache,sharing=locked \
    pnpm exec turbo run build \
      --filter=@hamnivo/widget^... --filter=@hamnivo/site^... --filter=@hamnivo/console^... \
      --filter=@hamnivo/widget-loader
RUN VITE_HAMNIVO_API="$HAMNIVO_API_ORIGIN" pnpm --filter @hamnivo/widget build
# Studio calls the API on its own origin and shows install code for the chat origin.
RUN VITE_HAMNIVO_API="$HAMNIVO_API_ORIGIN" VITE_HAMNIVO_WIDGET_ORIGIN="$HAMNIVO_CHAT_ORIGIN" \
    pnpm --filter @hamnivo/console build
RUN PUBLIC_SITE_URL="$HAMNIVO_SITE_URL" \
    PUBLIC_HAMNIVO_WIDGET_ID="$HAMNIVO_DEMO_WIDGET_ID" \
    PUBLIC_HAMNIVO_WIDGET_ORIGIN="${HAMNIVO_DEMO_WIDGET_ID:+$HAMNIVO_CHAT_ORIGIN}" \
    PUBLIC_HAMNIVO_API="${HAMNIVO_DEMO_WIDGET_ID:+$HAMNIVO_API_ORIGIN}" \
    pnpm --filter @hamnivo/site build
RUN mkdir -p /out/chat /out/site /out/studio \
 && cp -R apps/widget/dist/. /out/chat/ \
 && cp packages/widget-loader/dist/loader.js /out/chat/loader.js \
 && cp -R apps/site/dist/. /out/site/ \
 && cp -R apps/console/dist/. /out/studio/

# ---- Deploy webhook receiver (hamnivo.sh autodeploy) --------------------------------------------
# adnanh/webhook from Debian. It checks GitHub's signature and drops a file for the host's deploy
# service; see deploy/production/deploy-hook/hooks.yaml.
FROM debian:trixie-slim AS deploy-hook
RUN apt-get update \
 && apt-get install -y --no-install-recommends webhook \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/production/deploy-hook/hooks.yaml /etc/webhook/hooks.yaml
USER nobody
EXPOSE 9000
ENTRYPOINT ["/usr/bin/webhook", "-hooks", "/etc/webhook/hooks.yaml", "-template", "-port", "9000", "-verbose"]

FROM caddy:${CADDY_VERSION}-alpine AS edge
COPY --from=web-build /out/chat /srv/chat
COPY --from=web-build /out/site /srv/site
COPY --from=web-build /out/studio /srv/studio
COPY deploy/production/Caddyfile /etc/caddy/Caddyfile
ARG HAMNIVO_RELEASE=unknown
LABEL org.opencontainers.image.title="Hamnivo edge" \
      org.opencontainers.image.revision="$HAMNIVO_RELEASE"
