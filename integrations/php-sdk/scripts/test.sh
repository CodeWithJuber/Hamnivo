#!/usr/bin/env bash
# Runs the PHP SDK tests on this machine.
#
#   integrations/php-sdk/scripts/test.sh
#
# 1. PHPUnit, with the fixtures that @hamnivo/server generated. It needs php and composer.
# 2. When node and pnpm are installed too, the same cross tests the other way round: the fixtures
#    still match the Node SDK, and what PHP signs verifies with jose and the gateway's options.
#
# No php here? Run scripts/test-docker.sh, which uses the php:8.3-cli image.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
sdk=$PWD
root=$(cd ../.. && pwd)

if ! command -v php >/dev/null 2>&1; then
  echo "php is not installed. Run integrations/php-sdk/scripts/test-docker.sh to test in Docker." >&2
  exit 2
fi
if ! command -v composer >/dev/null 2>&1; then
  echo "composer is not installed (https://getcomposer.org/download/)." >&2
  exit 2
fi

if [ "$(id -u)" = 0 ]; then
  export COMPOSER_ALLOW_SUPERUSER=1
fi
if [ ! -x vendor/bin/phpunit ]; then
  composer install --no-interaction --prefer-dist --no-progress
fi

echo "== PHPUnit (PHP $(php -r 'echo PHP_VERSION;'))"
vendor/bin/phpunit --no-progress "$@"

if command -v pnpm >/dev/null 2>&1 && [ -d "$root/node_modules" ]; then
  echo "== The fixtures still match @hamnivo/server"
  (cd "$root" && pnpm exec tsx integrations/php-sdk/tests/fixtures/generate.ts --check)
  echo "== What PHP signs verifies on the Node side"
  (cd "$root" && pnpm exec tsx integrations/php-sdk/tests/cross-check.ts)
else
  echo "== Skipped the Node cross checks: run pnpm install at the repository root first (${sdk})."
fi
