# The official GitHub runner image plus what pnpm ci:local needs that it lacks.
FROM ghcr.io/actions/actions-runner:2.338.2
USER root
COPY --from=docker:29.8.1-dind /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
# shellcheck for ci:local; libatomic1 for the standalone pnpm that pnpm/action-setup installs;
# the system libraries of Chromium and WebKit (the widget's journeys in Safari's engine) for the
# Playwright version the repo pins.
RUN apt-get update \
 && apt-get install -y --no-install-recommends shellcheck libatomic1 \
 && PATH=/home/runner/externals/node24/bin:$PATH npx --yes playwright@1.63.0 install-deps chromium webkit \
 && apt-get clean
USER runner
