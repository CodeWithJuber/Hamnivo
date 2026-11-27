#!/usr/bin/env bash
# Puts a CI run's test-results/ report into the run summary, and packs the folder into one file
# that the workflow uploads as an artifact (ADR 0021). The file goes to CI_RESULTS_DIR when that is
# set (a runner of your own that keeps results on its disk), else to the runner's temporary folder.
# Its path is the step's `archive` output. In CI_RESULTS_DIR, archives older than
# HAMNIVO_CI_RESULTS_DAYS (14) are deleted.
set -euo pipefail

if [[ ! -d test-results ]]; then
  exit 0
fi

if [[ -f test-results/ci-local.md && ! -L test-results/ci-local.md ]]; then
  if (( $(wc -c < test-results/ci-local.md) <= 512 * 1024 )); then
    cat test-results/ci-local.md >> "$GITHUB_STEP_SUMMARY"
    printf '\n' >> "$GITHUB_STEP_SUMMARY"
  fi
fi

days="${HAMNIVO_CI_RESULTS_DAYS:-14}"
# The run's jobs run side by side and share the results folder, so each archive carries its suite.
suite="${HAMNIVO_CI_SUITE:-}"
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ && "$days" =~ ^[0-9]+$ && "$suite" =~ ^[a-z0-9-]*$ ]]
umask 077
archive_dir="${CI_RESULTS_DIR:-${RUNNER_TEMP:-${XDG_CACHE_HOME:-$HOME/.cache}}/hamnivo-ci-results}"
mkdir -p -- "$archive_dir"
archive="ci-results-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT${suite:+-$suite}.tar.gz"
temporary=$(mktemp "$archive_dir/.incoming.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT
# Include only regular, visible files, as with the previous artifact upload.
(cd test-results && find . -name '.*' ! -name . -prune -o -type f -print0) |
  tar --directory=test-results --null --files-from=- --create --gzip --file="$temporary"
mv -- "$temporary" "$archive_dir/$archive"
if [[ -n "${CI_RESULTS_DIR:-}" ]]; then
  find "$archive_dir" -regextype posix-extended -maxdepth 1 -type f \
    -regex '.*/ci-results-[0-9]+-[0-9]+(-[a-z0-9-]+)?\.tar\.gz' -mmin +$((days * 1440)) -delete
  printf '\nFull results on the CI server: %s/%s (kept %s days).\n' \
    "${HAMNIVO_CI_RESULTS_LOCATION:-$archive_dir}" "$archive" "$days" >> "$GITHUB_STEP_SUMMARY"
else
  printf '\nFull results: the artifact ci-results-%s of this run (kept %s days).\n' \
    "${suite:-all}" "$days" >> "$GITHUB_STEP_SUMMARY"
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "archive=$archive_dir/$archive" >> "$GITHUB_OUTPUT"
fi
