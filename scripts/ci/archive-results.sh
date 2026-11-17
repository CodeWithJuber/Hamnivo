#!/usr/bin/env bash
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

[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
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
  -regex '.*/ci-results-[0-9]+-[0-9]+\.tar\.gz' -mmin +20160 -delete
printf '\nFull results on the compute runner: `%s/%s` (14 days).\n' "$archive_dir" "$archive" >> "$GITHUB_STEP_SUMMARY"
