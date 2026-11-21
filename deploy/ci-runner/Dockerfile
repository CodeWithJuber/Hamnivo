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
# gitleaks for ci:local's secret scan, pinned and checked against its release's checksum.
RUN curl -fsSL -o /tmp/gitleaks.tgz \
      https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
 && echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  /tmp/gitleaks.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks \
 && rm /tmp/gitleaks.tgz
USER runner
