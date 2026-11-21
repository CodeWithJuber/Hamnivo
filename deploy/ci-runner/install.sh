#!/usr/bin/env bash
# Sets up the Hamnivo CI runner on a server of its own, or updates one set up before (ADR 0020).
# Run it as root on that server, from a copy of deploy/ci-runner. From a checkout of the repository:
#
#   scp -r deploy/ci-runner root@CI_SERVER:/root/hamnivo-ci-runner-setup
#   ssh -t root@CI_SERVER bash /root/hamnivo-ci-runner-setup/install.sh
#
# The first time, it asks for a registration token. On GitHub, open the repository's Settings →
# Actions → Runners → New self-hosted runner, and copy the value after --token. It works once,
# within an hour. Nothing else is asked for, and the token is cleared once the runner has
# registered.
#
# Each run:
#   1. installs Docker Engine and its compose plugin from Docker's own apt repository, if Docker is
#      missing (Ubuntu or Debian);
#   2. copies compose.yaml, Dockerfile, entrypoint.sh, the slice and this script to
#      /opt/hamnivo-ci-runner;
#   3. installs hamnivo-ci.slice with a drop-in sized to this machine: every core, and all the
#      memory but a tenth (at least 1 GB), which stays for ssh and Docker when the checks use the
#      rest;
#   4. writes /opt/hamnivo-ci-runner/.env: those cores, how many turbo tasks fit in that memory, the
#      runner's name and its repository;
#   5. registers the runner once, with the labels self-hosted, linux, x64 and hamnivo, then builds
#      its image, starts it and waits until it listens for jobs.
#
# It works the sizes out again each time. To choose them, set any of these whenever you run it:
#   HAMNIVO_CI_CPUS  HAMNIVO_CI_MEMORY_GB  HAMNIVO_CI_CONCURRENCY  HAMNIVO_CI_HEAVY_CONCURRENCY
#   HAMNIVO_CI_RUNNER_NAME  HAMNIVO_CI_REPO_URL  HAMNIVO_CI_RESULTS_DAYS
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target=/opt/hamnivo-ci-runner
runner_uid=1001 # the runner's user in GitHub's image

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() {
  printf '\n\033[1;31m%s\033[0m\n' "$*" >&2
  exit 1
}
clamp() { # clamp VALUE LOW HIGH
  local value=$1
  ((value < $2)) && value=$2
  ((value > $3)) && value=$3
  echo "$value"
}

((EUID == 0)) || fail 'Run this as root.'
[[ -d /run/systemd/system ]] || fail 'This server does not run systemd, which the CPU and memory caps need.'
[[ "$(uname -m)" == x86_64 ]] || fail "The workflows ask for an x64 runner, and this server is $(uname -m)."
for file in compose.yaml Dockerfile entrypoint.sh hamnivo-ci.slice install.sh; do
  [[ -f "$here/$file" ]] || fail "$here/$file is missing: copy the whole deploy/ci-runner folder."
done

# --- 1. Docker ----------------------------------------------------------------------------------
install_docker() { # The steps of https://docs.docker.com/engine/install/ubuntu/ (and /debian/).
  # shellcheck source=/dev/null
  . /etc/os-release
  case "${ID:-}" in
    ubuntu | debian) ;;
    *) fail "Install Docker Engine and its compose plugin first (https://docs.docker.com/engine/install/). This script installs them only on Ubuntu and Debian." ;;
  esac
  say "Installing Docker Engine from Docker's apt repository"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$ID" "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}
if ! command -v docker >/dev/null; then
  install_docker
fi
docker compose version >/dev/null 2>&1 ||
  fail "Docker is installed without its compose plugin. Install docker-compose-plugin (Docker's repository) or docker-compose-v2 (Ubuntu's), then run this again."
driver="$(docker info --format '{{.CgroupDriver}}')"
[[ "$driver" == systemd ]] ||
  fail "Docker uses the $driver cgroup driver, and the caps need systemd's (cgroup v2: Ubuntu 22.04 or Debian 12 and later)."

# --- 2. Files -----------------------------------------------------------------------------------
say "Copying the runner's files to $target"
install -d -m 700 "$target"
install -d -m 700 -o "$runner_uid" -g "$runner_uid" "$target/state"
install -d -m 750 -o "$runner_uid" -g "$runner_uid" "$target/results"
if [[ "$here" != "$target" ]]; then
  install -m 644 "$here/compose.yaml" "$here/Dockerfile" "$here/hamnivo-ci.slice" "$target/"
  install -m 755 "$here/entrypoint.sh" "$here/install.sh" "$target/"
fi

# --- 3. Size ------------------------------------------------------------------------------------
cores="$(nproc)"
memory_mb="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
reserve_mb=$((memory_mb / 10 > 1024 ? memory_mb / 10 : 1024))
cpus="${HAMNIVO_CI_CPUS:-$cores}"
memory_gb="${HAMNIVO_CI_MEMORY_GB:-$(((memory_mb - reserve_mb) / 1024))}"
days="${HAMNIVO_CI_RESULTS_DAYS:-14}"
for setting in "cpus=$cpus" "memory_gb=$memory_gb" "days=$days"; do
  [[ "${setting#*=}" =~ ^[1-9][0-9]*$ ]] || fail "${setting%%=*} must be a whole number above 0, not '${setting#*=}'."
done
((cpus <= cores)) || fail "HAMNIVO_CI_CPUS is $cpus, but this server has $cores cores."
((memory_gb >= 3)) ||
  fail "The checks need at least 3 GB of memory for themselves (8 or more is better). This server leaves them $memory_gb GB."
# The last cores, so a smaller count leaves the first ones to the system.
cpuset="$((cores - cpus))-$((cores - 1))"
# A type check or a build takes up to 1.7 GB (ADR 0019), so each gets 2 GB once 2 GB is left for
# everything else; other tasks take less. With 4 GB, as on the production server, that is 2 and 1.
concurrency="${HAMNIVO_CI_CONCURRENCY:-$(clamp $((memory_gb / 2)) $((cpus < 2 ? cpus : 2)) "$cpus")}"
heavy="${HAMNIVO_CI_HEAVY_CONCURRENCY:-$(clamp $(((memory_gb - 2) / 2)) 1 "$concurrency")}"
name="${HAMNIVO_CI_RUNNER_NAME:-$(hostname -s | tr -c 'A-Za-z0-9\n-' '-')-hamnivo-ci}"
repo="${HAMNIVO_CI_REPO_URL:-https://github.com/CodeWithJuber/Hamnivo}"

say "Capping the checks at $cpus of $cores cores and $memory_gb GB (hamnivo-ci.slice)"
install -m 644 "$here/hamnivo-ci.slice" /etc/systemd/system/hamnivo-ci.slice
install -d -m 755 /etc/systemd/system/hamnivo-ci.slice.d
cat >/etc/systemd/system/hamnivo-ci.slice.d/size.conf <<EOF
# Written by $target/install.sh for this machine: $cores cores, $((memory_mb / 1024)) GB.
[Slice]
CPUQuota=$((cpus * 100))%
MemoryMax=${memory_gb}G
EOF
systemctl daemon-reload
systemctl start hamnivo-ci.slice

# --- 4. Settings --------------------------------------------------------------------------------
(
  umask 077
  cat >"$target/.env" <<EOF
# Written by install.sh, which writes it again each time it runs (see its header).
HAMNIVO_CI_REPO_URL=$repo
HAMNIVO_CI_RUNNER_NAME=$name
HAMNIVO_CI_CPUSET=$cpuset
HAMNIVO_CI_CONCURRENCY=$concurrency
HAMNIVO_CI_HEAVY_CONCURRENCY=$heavy
HAMNIVO_CI_RESULTS_LOCATION=$target/results
HAMNIVO_CI_RESULTS_DAYS=$days
EOF
)
printf 'Cores %s, turbo tasks at once %s, type checks and builds at once %s, results kept %s days.\n' \
  "$cpuset" "$concurrency" "$heavy" "$days"

# --- 5. Register and start ----------------------------------------------------------------------
cd "$target"
if [[ ! -s state/.runner ]]; then
  token="${RUNNER_TOKEN:-}"
  if [[ -z "$token" && -t 0 ]]; then
    printf '\nOn GitHub: %s/settings/actions/runners/new\nCopy the value after --token and paste it here (it is not shown): ' "$repo"
    read -rs token
    echo
  fi
  if [[ -z "$token" ]]; then
    printf '\nEverything is in place but the registration. Run this again in a terminal, so it can ask\nfor the token:\n\n  ssh -t root@THIS_SERVER bash %s/install.sh\n' "$target"
    exit 0
  fi
  [[ "$token" =~ ^[A-Za-z0-9]+$ ]] || fail 'That is not a registration token: it should be letters and digits only.'
  (
    umask 077
    printf '%s\n' "$token" >state/token
  )
  chown "$runner_uid:$runner_uid" state/token
fi

say 'Building the runner image and starting it'
docker compose up -d --build

say 'Waiting for the runner to connect to GitHub'
connected=0
for _ in $(seq 1 90); do
  if docker compose logs runner 2>&1 | grep -q 'Listening for Jobs'; then
    connected=1
    break
  fi
  sleep 2
done
if ((connected == 0)); then
  docker compose logs --tail 40 runner >&2 || true
  fail 'The runner has not connected. Its last lines are above. If the token was refused, get a new one and run this again.'
fi

cat <<EOF

The runner $name is online, with the labels self-hosted, linux, x64 and hamnivo. GitHub lists it
under Settings → Actions → Runners: $repo/settings/actions/runners

  Its files and settings  $target (.env is written by this script)
  Each run's results      $target/results/ci-results-RUN_ID-ATTEMPT-SUITE.tar.gz, for $days days
  Its logs                cd $target && docker compose logs -f runner
  Stop it                 cd $target && docker compose down

GitHub bills nothing for it: self-hosted runners are free, and the checks keep their caches and
results here, never in GitHub's storage (ADR 0020).
EOF
