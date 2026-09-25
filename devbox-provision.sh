#!/bin/bash
# Phase 1: everything that needs no secret. The toolchain of images/dev/build.sh plus the
# upper half of profiles/full.sh — both on the kubevirt branch — transposed: same packages,
# same order, same reasons.
#
# THIS FILE IS DEPOSITED, NOT RUN IN PLACE. cloud-init writes it to
# /usr/local/bin/devbox-provision.sh and runs it once, exactly as it deposits prelude.sh
# beside it. It lived INSIDE cloud-init.yaml.tftpl and was lifted out, because a phase 1
# written into one substrate has to be COPIED to reach any other — and a phase 1 that exists
# twice is a phase 1 that will disagree with itself, the same class of drift as devbox-core
# against dashboard/engine/devbox.
#
# Being a file rather than a here-doc inside YAML inside a Terraform template also buys
# what the old comment already promised and could not deliver: it is re-runnable and
# testable by hand, `bash -n` covers it, and no layer above has an opinion about its
# quoting.
#
#   ssh <machine> 'sudo /usr/local/bin/devbox-provision.sh'
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

USER_NAME=dev
HOME_DIR=/home/dev

# apt races unattended-upgrades for the dpkg lock on a fresh cloud image, and
# losing that race at boot reads like a broken mirror. Wait for the lock instead
# of dying on it.
APT="apt-get -o DPkg::Lock::Timeout=600 -qq"

$APT update
$APT install -y curl ca-certificates gnupg jq git make unzip ripgrep

# --- docker's MTU ------------------------------------------------------
# Docker's bridge defaults to 1500. GCP's VPC is 1460, which reproduces there
# exactly the per-destination black hole diagnosed under KubeVirt: oversized
# packets need path MTU discovery to shrink, and where the ICMP "fragmentation
# needed" never comes back the connection simply hangs. Measured while building
# the dev image: a container pulled 56 MB from dl.k8s.io without trouble and hung
# 120 s on get.helm.sh, in the same RUN of the same build.
#
# The MTU is read at boot rather than pinned, so this same file covers Hetzner,
# Scaleway and GCP without being parameterised.
cat > /usr/local/sbin/devbox-docker-mtu <<'MTUSCRIPT'
#!/bin/sh
set -eu
iface=$(ip -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
[ -n "$iface" ] || exit 0
mtu=$(cat "/sys/class/net/$iface/mtu" 2>/dev/null || true)
[ -n "$mtu" ] || exit 0
mkdir -p /etc/docker
if [ -s /etc/docker/daemon.json ]; then
  tmp=$(mktemp)
  jq --argjson m "$mtu" '.mtu = $m' /etc/docker/daemon.json > "$tmp" && mv "$tmp" /etc/docker/daemon.json
else
  printf '{"mtu": %s}\n' "$mtu" > /etc/docker/daemon.json
fi
MTUSCRIPT
chmod 755 /usr/local/sbin/devbox-docker-mtu

cat > /etc/systemd/system/devbox-docker-mtu.service <<'MTUUNIT'
[Unit]
Description=Align Docker's MTU with the machine's primary interface
After=network-online.target
Wants=network-online.target
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/devbox-docker-mtu

[Install]
WantedBy=multi-user.target
MTUUNIT
systemctl daemon-reload
systemctl enable devbox-docker-mtu.service
# Run it NOW, before docker exists: installing docker.io starts the daemon, and a
# daemon started once with the wrong MTU keeps its bridge until it is restarted.
/usr/local/sbin/devbox-docker-mtu

# --- toolchain ---------------------------------------------------------
# docker-buildx is not a nicety. Ubuntu's docker.io ships only the legacy builder,
# which is stricter than the BuildKit every Docker Desktop enables by default: a
# COPY that builds fine on the author's laptop dies here with "the destination
# must be a directory and end with a /".
$APT install -y docker.io docker-buildx
systemctl enable --now docker
usermod -aG docker $USER_NAME

# --- environment -------------------------------------------------------
install -d -o $USER_NAME -g $USER_NAME /workspace

touch /var/log/devbox-provision-done
echo "phase 1 done — now run: devbox seed"

