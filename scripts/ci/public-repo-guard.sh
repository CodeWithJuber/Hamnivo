#!/usr/bin/env bash
# Fails when a workflow is unsafe for a public repository (ADR 0021). A line that breaks a rule is
# printed as FILE:LINE: why.
#
#   bash scripts/ci/public-repo-guard.sh [FILE...]   (default: every YAML file under .github)
#
# The rules:
#   - Every job runs on one standard GitHub-hosted runner, named literally: ubuntu-, windows- or
#     macos- with a version or "latest" (ubuntu-24.04, windows-2025, macos-15, ubuntu-24.04-arm...).
#     A self-hosted runner would run code from anyone's pull request on a machine of ours. A larger
#     runner (a custom label, or -large and -xlarge on macOS) is billed even for a public
#     repository. An expression, a variable or a runner group could pick either.
#   - A workflow that pull_request_target starts never checks code out and never reads the pull
#     request's head. That event runs with a token that can write and with the repository's
#     secrets, so a pull request's own code must never run in it.
set -euo pipefail

files=()
if (($#)); then
  files=("$@")
else
  cd "$(dirname "${BASH_SOURCE[0]}")/../.."
  while IFS= read -r -d '' file; do files+=("$file"); done \
    < <(git ls-files -z -- '.github/*.yml' '.github/*.yaml')
fi
((${#files[@]})) || exit 0

# POSIX awk, so it runs the same with mawk, gawk and the BSD awk on macOS.
program=$(
  cat <<'AWK'
function report(line, why) { printf "%s:%d: %s\n", file, line, why; failed = 1 }
function trim(text) { gsub(/^[ \t]+|[ \t]+$/, "", text); return text }
function unquote(text) { text = trim(text); gsub(/^["']|["']$/, "", text); return text }
function indent(text) { return match(text, /[^ \t]/) - 1 }
function check_label(line, label) {
  label = unquote(label)
  if (label !~ /^(ubuntu-(latest|[0-9][0-9]\.[0-9][0-9])(-arm)?|windows-(latest|[0-9][0-9][0-9][0-9]|11-arm)|macos-(latest|[0-9][0-9])(-intel)?)$/)
    report(line, "runs-on: '" label "' is not a standard GitHub-hosted runner. Self-hosted runners would run anyone's pull request on our machines, and larger runners are billed.")
}
function finish_runs_on() {
  if (!pending) return
  pending = 0
  if (labels == 0 && !mapping)
    report(runs_on_line, "runs-on names no runner.")
}
function finish_file() {
  finish_runs_on()
  if (file == "" || !target) return
  for (i = 1; i <= checkouts; i++)
    report(checkout_line[i], "A pull_request_target workflow must not check out code: it would run a pull request's code with write access and the repository's secrets.")
  for (i = 1; i <= heads; i++)
    report(head_line[i], "A pull_request_target workflow must not read the pull request's head: its code must not run with write access and the repository's secrets.")
}
FNR == 1 { finish_file(); file = FILENAME; target = 0; checkouts = 0; heads = 0; pending = 0 }
/^[ \t]*#/ { next }
{ line = $0; sub(/[ \t]+#.*$/, "", line) }
pending {
  if (line ~ /^[ \t]*$/) next
  if (indent(line) > runs_on_indent) {
    item = trim(line)
    if (item ~ /^-[ \t]/) {
      sub(/^-[ \t]+/, "", item)
      if (++labels == 2) report(FNR, "runs-on must name one runner label.")
      check_label(FNR, item)
    } else if (!mapping) {
      mapping = 1
      report(runs_on_line, "runs-on must name a GitHub-hosted runner, not a runner group or a set of labels.")
    }
    next
  }
  finish_runs_on()
}
line ~ /^[ \t]*runs-on:/ {
  value = line
  sub(/^[ \t]*runs-on:/, "", value)
  value = trim(value)
  if (value ~ /\$\{\{/)
    report(FNR, "runs-on must name the runner itself. An expression or a variable could pick a self-hosted or larger runner.")
  else if (value == "") {
    pending = 1; runs_on_line = FNR; runs_on_indent = indent(line); labels = 0; mapping = 0
  } else if (value ~ /^\[/) {
    gsub(/^\[|\]$/, "", value)
    count = split(value, parts, ",")
    if (count != 1) report(FNR, "runs-on must name one runner label.")
    for (i = 1; i <= count; i++) check_label(FNR, parts[i])
  } else if (value ~ /^\{/)
    report(FNR, "runs-on must name a GitHub-hosted runner, not a runner group or a set of labels.")
  else
    check_label(FNR, value)
}
line ~ /(^|[^A-Za-z0-9_.])pull_request_target([^A-Za-z0-9_]|$)/ { target = 1 }
line ~ /uses:[ \t]*["']?actions\/checkout@/ { checkout_line[++checkouts] = FNR }
line ~ /github\.event\.pull_request\.head|github\.head_ref|refs\/pull\// { head_line[++heads] = FNR }
END { finish_file(); exit failed }
AWK
)

if ! awk "$program" "${files[@]}"; then
  echo 'A workflow above is unsafe for a public repository (ADR 0021).' >&2
  exit 1
fi
