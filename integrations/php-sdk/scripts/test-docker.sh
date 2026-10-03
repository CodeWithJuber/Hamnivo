#!/usr/bin/env bash
# Runs the PHP SDK tests in Docker, for a machine without PHP.
#
#   integrations/php-sdk/scripts/test-docker.sh               # PHP 8.3, the php:8.3-cli image
#   PHP_VERSION=8.1 integrations/php-sdk/scripts/test-docker.sh   # the oldest PHP the SDK supports
#
# The SDK is mounted read-only and copied inside the container, so nothing is written to your
# folder. Composer picks the PHPUnit that fits the PHP version.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

version=${PHP_VERSION:-8.3}
image="hamnivo-php-sdk-tests:php${version}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed." >&2
  exit 2
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed, but its daemon is not running or not reachable." >&2
  exit 2
fi

docker build --quiet --tag "$image" --build-arg "PHP_VERSION=${version}" - <<'DOCKERFILE'
ARG PHP_VERSION=8.3
FROM php:${PHP_VERSION}-cli
RUN apt-get update \
 && apt-get install -y --no-install-recommends git unzip \
 && rm -rf /var/lib/apt/lists/*
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
DOCKERFILE

docker run --rm \
  --volume "$PWD":/sdk:ro \
  --env COMPOSER_ALLOW_SUPERUSER=1 \
  "$image" \
  sh -c 'mkdir /work && cd /sdk \
    && tar --exclude=./vendor --exclude=./composer.lock --exclude=./.phpunit.cache -cf - . | tar -xf - -C /work \
    && cd /work \
    && composer install --no-interaction --prefer-dist --no-progress \
    && vendor/bin/phpunit --no-progress'
