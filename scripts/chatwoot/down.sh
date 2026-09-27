#!/usr/bin/env bash
# Stops the local Chatwoot stack. Data stays in its volumes; add --volumes to delete it.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
docker compose --env-file "$root/.env.local" -f "$root/deploy/compose/chatwoot.yml" down "$@"
