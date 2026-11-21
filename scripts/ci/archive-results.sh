#!/usr/bin/env bash
# Keeps a run's test-results/ as a file on the runner's own disk, never as a GitHub artifact (ADR
# 0020). The run summary shows the report and where the file is. deploy/ci-runner mounts the folder
# from the server (/opt/hamnivo-ci-runner/results) and names it in HAMNIVO_CI_RESULTS_LOCATION.
# Archives older than HAMNIVO_CI_RESULTS_DAYS (14) are deleted.
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
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ && "$days" =~ ^[0-9]+$ ]]
umask 077
archive_dir="${XDG_CACHE_HOME:-$HOME/.cache}/hamnivo-ci-results"
mkdir -p -- "$archive_dir"
archive="ci-results-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.tar.gz"
temporary=$(mktemp "$archive_dir/.incoming.XXXXXXXX")
trap 'rm -f -- "$temporary"' EXIT
# Include only regular, visible files, as with the previous artifact upload.
(cd test-results && find . -name '.*' ! -name . -prune -o -type f -print0) |
  tar --directory=test-results --null --files-from=- --create --gzip --file="$temporary"
mv -- "$temporary" "$archive_dir/$archive"
find "$archive_dir" -regextype posix-extended -maxdepth 1 -type f \
  -regex '.*/ci-results-[0-9]+-[0-9]+\.tar\.gz' -mmin +$((days * 1440)) -delete
printf '\nFull results on the CI server: %s/%s (kept %s days).\n' \
  "${HAMNIVO_CI_RESULTS_LOCATION:-$archive_dir}" "$archive" "$days" >> "$GITHUB_STEP_SUMMARY"
