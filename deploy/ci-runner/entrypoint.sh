#!/usr/bin/env bash
# Registers the runner the first time, keeps its credentials in /state, then runs it.
set -euo pipefail
sudo chown runner:docker /home/runner/_work /home/runner/.cache /home/runner/.cache/hamnivo-ci-results
mkdir -p "$TMPDIR"
cd /home/runner
files=(.runner .credentials .credentials_rsaparams)
if [[ -f /state/.runner ]]; then
  for f in "${files[@]}"; do cp "/state/$f" "./$f"; done
else
  ./config.sh --unattended --replace --url "$REPO_URL" --token "$(cat /state/token)" --name "$RUNNER_NAME" --labels "$RUNNER_LABELS" --work /home/runner/_work
  for f in "${files[@]}"; do cp "./$f" "/state/$f"; done
  : > /state/token
fi
exec ./run.sh
