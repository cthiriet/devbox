#!/bin/bash
# What every profile can assume is already there. cloud-init deposits this at
# /usr/local/lib/devbox/prelude.sh in phase 1; a profile sources it as its first line.
#
# The split is on "does this need a token". Phase 1 builds a generic machine — the user,
# Docker and the MTU service — and knows nothing about what will run on it. The profile is
# phase 2: it arrives at `devbox seed` over the SSH channel, alongside the secrets it
# declared, and it is the only file that knows what this machine is for.
#
# Everything here is either used by more than one profile, or carries a trap that cost
# enough to be worth writing once.

USER_NAME=dev
HOME_DIR=/home/$USER_NAME
REPO_URL=${DEVBOX_REPO_URL:-}
REPO_DIR=${REPO_URL:+/workspace/$(basename "$REPO_URL" .git)}

# runuser starts a fresh login session, which matters twice: it picks up the docker group
# that phase 1 added after the user existed, and it sources /etc/profile.d — where the
# agent's token lives, because Ubuntu's ~/.bashrc returns before anything for a
# non-interactive shell.
as_user() { runuser -u "$USER_NAME" -- bash -lc "$*"; }

# apt races unattended-upgrades for the dpkg lock on a fresh cloud image, and losing that
# race reads like a broken mirror. Wait for the lock instead of dying on it.
APT="apt-get -o DPkg::Lock::Timeout=600 -qq"

# Where the time goes, printed as it goes. A profile that takes ten minutes should say
# which of its steps took nine — the alternative is guessing from a log with no clock in
# it, which is exactly how the cost of moving a step from phase 1 to phase 2 went
# unnoticed until someone compared two totals.
DEVBOX_T0=$(date +%s)
DEVBOX_TLAST=$DEVBOX_T0
step() {
  local now; now=$(date +%s)
  printf '\n=== [%3ds | +%3ds] %s\n' "$((now - DEVBOX_T0))" "$((now - DEVBOX_TLAST))" "$*"
  DEVBOX_TLAST=$now
}

# Left alone if it is already there. A re-run must never be able to throw away work that
# has not been pushed: the machine is disposable, but not while you are working in it.
#
# The secret holding the git token is an ARGUMENT, not the string "github". It used to be
# hardcoded in the .gitconfig that phase 1 wrote, which quietly undid the whole point of
# letting a profile declare its own secret names: one saying `devbox-secrets: gitlab` would
# have cloned with a helper reading a file nobody ever created.
#
# The helper is written as a file rather than composed through `git config`: it is shell
# inside a git value inside a shell argument, and three levels of quoting is how the first
# version died on "unexpected EOF while looking for `''". It reads the token at every call
# instead of storing it, so nothing lands in ~/.git-credentials — the token stays in tmpfs
# and dies with the machine.
# One [credential] section per HOST, never a bare one. A bare section offers the token to
# EVERY https git host the machine ever talks to: clone one repository from gitlab and the
# GitHub PAT is handed to gitlab. A profile pulling from two hosts calls this twice, with
# two secrets, and neither ever sees the other's.
#
# Written as a file rather than composed through `git config`: the helper is shell inside a
# git value inside a shell argument, and three levels of quoting is how the first version
# died on "unexpected EOF while looking for `''". It reads the token at every call instead
# of storing it, so nothing lands in ~/.git-credentials — the token stays in tmpfs and dies
# with the machine.
git_credentials() {
  local host=$1 secret=$2
  require_secrets "$secret"
  if [ ! -s "$HOME_DIR/.gitconfig" ]; then
    cat >"$HOME_DIR/.gitconfig" <<'GITCONFIG'
[user]
    name = dev
    email = dev@devbox.local
GITCONFIG
  fi
  # Appended once: a re-run of the profile must not stack duplicate sections.
  grep -q "credential \"https://$host\"" "$HOME_DIR/.gitconfig" || \
    cat >>"$HOME_DIR/.gitconfig" <<GITCONFIG
[credential "https://$host"]
    helper = "!f() { echo username=x-access-token; echo \"password=\$(cat /run/secrets/$secret)\"; }; f"
GITCONFIG
  chown "$USER_NAME:$USER_NAME" "$HOME_DIR/.gitconfig"
}

# Left alone if it is already there. A re-run must never be able to throw away work that
# has not been pushed: the machine is disposable, but not while you are working in it.
#
# The secret holding the git token is an ARGUMENT, not the string "github": a profile
# declaring `devbox-secrets: gitlab` would otherwise clone with a helper reading a file
# nobody ever created.
#
# Clones a SECOND repository too — `clone_repo <secret> <url> [dir]`. $REPO_DIR stays the
# one the header declared, because that is what the agent's trust gate and the note refer
# to; the extras are just checkouts.
clone_repo() {
  # `${1-github}` and not `${1:-github}`, and the colon is the whole difference: an argument
  # GIVEN and empty is how a caller says "this one is public, clone it with no credential",
  # and `:-` would read that as no argument at all and demand a secret the profile never
  # declared — a seed dying on `no /run/secrets/github` for a repository that needed none.
  # Measured on 12/09, on the first profile composed from the dashboard with a public
  # repository in it. No argument still means `github`, which is what every hand-written
  # profile here passes.
  local secret=${1-github}
  local url=${2:-$REPO_URL}
  [ -n "$url" ] || { echo "this profile declares no devbox-repo and called clone_repo"; exit 1; }
  local dir=${3:-/workspace/$(basename "$url" .git)}

  # An `if`, never `[ -n "$secret" ] && case …`: under `set -e` a test that fails as the
  # last command of a function is that function's exit status, and a public clone would
  # take the whole seed down at its last line.
  if [ -n "$secret" ]; then
    case "$url" in
      https://*) git_credentials "$(printf '%s' "$url" | cut -d/ -f3)" "$secret" ;;
    esac
  fi

  if [ -d "$dir/.git" ]; then
    echo "$dir is already cloned, left untouched"
  else
    as_user "git clone --depth 50 '$url' '$dir'"
  fi
}

require_secrets() {
  local s
  for s in "$@"; do
    test -r "/run/secrets/$s" || { echo "no /run/secrets/$s — declare it in devbox-secrets:"; exit 1; }
  done
}

# A script of the profile's own repository, run last: `run_setup scripts/devbox-setup.sh`.
#
# What a composed profile can say ends at the catalogue, and a machine as particular as a
# hand-written profile - a cluster installed, images built, a database seeded - was out of reach
# of anyone who could not deposit a file on the server. So the particular part lives where its
# owner already works, in the repository, and the dashboard renders ONE call naming its path.
#
# As dev, from the repository's root, in a login shell: what the owner would get by opening a
# terminal and typing it, docker group and /etc/profile.d included. Root is one `sudo` away,
# passwordless, which is the machine's trade and not this function's - running the script as
# root instead would leave every file it writes in the checkout owned by root. The secrets the
# profile declares are readable at /run/secrets/<name>, 0400 dev.
#
# The path is checked here as well as by the dashboard, for a profile written by hand: relative,
# a closed character set, no `..`. And it must RESOLVE inside the checkout, symlinks followed -
# not a guard against the owner, who has sudo, but a script path that quietly names a file of
# the machine is a profile nobody can read and predict.
#
# The script is the checkout's, not the remote's: clone_repo leaves an existing clone alone, so a
# seed replayed on a running machine runs what is on disk there. It must be re-enterable for the
# same reason every profile is. What it prints lands in the seed log the dashboard shows.
run_setup() {
  local rel=${1:-} root real
  [ -n "$REPO_DIR" ] || { echo "run_setup reads its script from the profile's repository, and this profile declares no devbox-repo"; exit 1; }
  case "$rel" in
    ''|/*|*[!a-zA-Z0-9._/-]*|..|../*|*/..|*/../*)
      echo "run_setup takes a path inside the repository, letters, digits, dot, dash, underscore and slash: '$rel'"; exit 1 ;;
  esac
  [ -f "$REPO_DIR/$rel" ] || { echo "no $rel in $REPO_DIR: the setup script is read from the clone"; exit 1; }
  root=$(realpath "$REPO_DIR")
  real=$(realpath "$REPO_DIR/$rel")
  case "$real" in
    "$root"/*) ;;
    *) echo "$rel resolves to $real, outside $REPO_DIR: refused"; exit 1 ;;
  esac
  # %q, because as_user hands one string to `bash -lc`. An executable script runs as itself,
  # interpreter and all; one without the bit is read by bash, which is what a .sh committed
  # without `chmod +x` means.
  if [ -x "$real" ]; then
    as_user "cd $(printf %q "$root") && exec $(printf %q "$real")"
  else
    as_user "cd $(printf %q "$root") && exec bash $(printf %q "$real")"
  fi
}

# --- Node and Chrome ------------------------------------------------------------
# Here because two profiles want them, which is the only reason anything is here.
# They lived inside one profile until 28/08, when a second one asked for a browser: the file
# below is that profile's verbatim, moved and not rewritten, so `git log -M` still shows
# where the 404 on node-v24.20.0-linux-amd64.tar.gz was paid for.
#
# DEFINED, never run. A prelude is sourced by every profile, and a profile that wants
# neither pays nothing for their presence — the 132 MB of Chrome arrive only when a profile
# writes install_chrome.

# Node, from nodejs.org and nowhere else.
#
# It came from NodeSource's setup_22.x until 20/08. nodejs.org/en/download says in so many
# words that third-party installers and package managers "are not maintained by the
# Node.js project", and NodeSource is exactly that. What that page offers instead is the
# prebuilt binary, which is what this installs.
#
# nvm and fnm, the other methods it lists, do not fit here: they live in a user's shell
# profile, and this machine runs node as root during the build and as dev afterwards,
# neither through an interactive login.
#
# The version is READ rather than pinned, so the machine tracks the current LTS instead of
# whatever was current the day this line was written. It is the same posture this
# repository already takes on prices and on architecture: ask, do not remember.
#
# The architecture is READ, not pinned. It was linux-x64 in so many words until 25/08,
# with a comment explaining that Chrome had no arm64 build for Linux — true when it was
# written, false since 30/07/2026, when Google shipped the arm64 Debian and RPM packages.
# The probe still orders x86 from the three clouds, but that is a price decision and not a
# promise, so these three lines had to stop guessing.
#
# dpkg's own name, not `uname -m`: the two disagree (aarch64 against arm64) and it is
# dpkg's spelling that dl.google.com and cli/cli publish under.
#
# NODEJS.ORG DOES NOT, and that is a 404 waiting for whoever assumes otherwise. Its
# tarballs are linux-x64 and linux-arm64: the two namings agree on arm64 and disagree on
# x86 — which is exactly how this shipped. These lines stopped guessing on 25/08, exercised
# on an arm64 machine where amd64 never came up.
# Measured today on a Scaleway DEV1-L, the first x86 machine to run this profile since:
# `curl: (22) The requested URL returned error: 404` on
# node-v24.20.0-linux-amd64.tar.gz, and a seed that died before Claude Code was installed.
node_arch() {
  case $(dpkg --print-architecture) in
    amd64) echo x64 ;;
    arm64) echo arm64 ;;
    # Loudly, and here rather than three downloads later: an architecture nobody has
    # tested must not build a URL that answers 404 in the middle of a ten-minute seed.
    *) echo "nodejs.org publishes no tarball for $(dpkg --print-architecture)" >&2; exit 1 ;;
  esac
}

install_node() {
  local version url arch
  arch=$(node_arch)
  version=$(curl -fsSL https://nodejs.org/dist/index.json \
    | jq -r '[.[] | select(.lts != false)] | .[0].version')
  [ -n "$version" ] || { echo "nodejs.org named no LTS release"; exit 1; }

  # Re-enterable, like everything else here: a seed replayed on a running machine must not
  # redownload sixty megabytes to arrive at what is already installed.
  if [ "$(node -v 2>/dev/null)" = "$version" ]; then
    echo "node $version is already installed"
    return 0
  fi

  # Kept under its published name, because sha256sum -c reads the name out of the sums
  # file and looks for it on disk: downloading to node.tar.gz makes the check fail on a
  # file that is not there, which reads exactly like a corrupted download.
  local archive=node-$version-linux-$arch.tar.gz
  url=https://nodejs.org/dist/$version/$archive
  curl -fsSLo "/tmp/$archive" "$url"
  curl -fsSLo /tmp/node-sums.txt "https://nodejs.org/dist/$version/SHASUMS256.txt"
  # Only the line for the file that was downloaded. SHASUMS256.txt covers every artifact
  # of the release, and checking the whole of it fails on the twenty that are not here.
  (cd /tmp && grep " $archive$" node-sums.txt | sha256sum -c -)

  # Into /usr/local, so node, npm and npx land on the default PATH for root and for dev
  # with no profile script to source. The three documentation files are left out rather
  # than dropped loose into /usr/local.
  tar -xzf "/tmp/$archive" -C /usr/local --strip-components=1 \
      --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE'
  rm -f "/tmp/$archive" /tmp/node-sums.txt
  node -v
}

# Chrome and what drives it. Leaving Node out would be arbitrary: it is here only for
# chrome-devtools-mcp.
install_chrome() {
  # Read, not pinned — see install_node. Google shipped arm64 on 30/07/2026, and the
  # package is served under the same URL shape: measured, 132 MB, HTTP 200.
  local arch; arch=$(dpkg --print-architecture)
  curl -fsSLo /tmp/chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_$arch.deb"
  $APT install -y /tmp/chrome.deb
  rm -f /tmp/chrome.deb

  npm install -g chrome-devtools-mcp

  # Chrome's own sandbox needs unprivileged user namespaces, which Ubuntu 24.04 restricts
  # by default. Lifting the restriction beats passing --no-sandbox: the browser keeps its
  # sandbox, and it applies to this machine alone. In sysctl.d so a reboot keeps it.
  #
  # The knob is UBUNTU'S, not Linux's — it comes from an AppArmor patch that Canonical
  # carries, and a mainline kernel never had that patch. So the file is written for a kernel
  # that may want it and the live write is allowed to find nothing.
  #
  # Absent knob means absent restriction, which is the state this line was trying to reach.
  # Measured on 26/08: `sysctl -w` died on "No such file or directory" and took a whole
  # seed with it, three minutes after Chrome had installed perfectly, on a machine where
  # there was nothing to lift.
  echo 'kernel.apparmor_restrict_unprivileged_userns=0' > /etc/sysctl.d/99-devbox-userns.conf
  if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
    sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  else
    echo "this kernel has no apparmor_restrict_unprivileged_userns: nothing to lift"
  fi
}

# --- The tools a profile installs, one function each -----------------------------
# Here for the reason everything else is here, and for one more since 12/09: a profile
# composed from the dashboard is RENDERED, and what it renders is a list of calls into this
# file. A recipe that stayed inside profiles/claude.sh could only ever be had by copying
# that profile whole.
#
# The three below arrived by `git mv`-in-spirit: install_gh and install_claude_code out of
# profiles/claude.sh, install_opencode out of profiles/opencode.sh, word for word, so
# `git log -M` still reaches the machine where each measurement in their comments was paid
# for. The two profiles now call what they used to define, and nothing they do changed.
#
# DEFINED, never run, like install_node above: a profile that wants none of them pays
# nothing for their presence.

# The GitHub CLI, so the agent can open a pull request from a machine that has no browser
# to click "Compare & pull request" in.
#
# From the release binaries, not from the apt repository at cli.github.com. Both are
# GitHub's own — this is not the NodeSource situation — but the apt route leaves a signing
# key and a source list behind on a machine that exists to be thrown away, and buys nothing
# in exchange: nothing here ever runs apt upgrade. The version is READ rather than pinned,
# same posture and same reasons as install_node.
#
# The call to api.github.com is deliberately anonymous, though a token is sitting right
# there in /run/secrets. `set -x` is on for the whole profile: a token passed on a command
# line is a token printed in the seed log, in clear, where the operator and the dashboard
# both read it. Anonymous api.github.com allows sixty calls an hour per address, this is
# one call per seed, and the machine has an address of its own.
install_gh() {
  local tag version archive

  tag=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r .tag_name)
  version=${tag#v}
  [ -n "$version" ] || { echo "github named no latest release of cli/cli"; exit 1; }

  # Re-enterable, like everything else here: a seed replayed on a running machine must not
  # redownload and reinstall to arrive at what is already there.
  if [ "$(gh --version 2>/dev/null | head -1 | cut -d' ' -f3)" = "$version" ]; then
    echo "gh $version is already installed"
  else
    # Kept under its published name, because sha256sum -c reads the name out of the sums
    # file and looks for it on disk: downloading to gh.deb makes the check fail on a file
    # that is not there, which reads exactly like a corrupted download.
    archive=gh_${version}_linux_$(dpkg --print-architecture).deb
    curl -fsSLo "/tmp/$archive" \
      "https://github.com/cli/cli/releases/download/$tag/$archive"
    curl -fsSLo /tmp/gh-sums.txt \
      "https://github.com/cli/cli/releases/download/$tag/gh_${version}_checksums.txt"
    # Only the line for the file that was downloaded. The sums file covers every artifact
    # of the release, and checking the whole of it fails on the thirty that are not here.
    (cd /tmp && grep " $archive$" gh-sums.txt | sha256sum -c -)
    $APT install -y "/tmp/$archive"
    rm -f "/tmp/$archive" /tmp/gh-sums.txt
  fi

  # GH_TOKEN, and NOT `gh auth login --with-token`. The login writes the token in clear
  # into ~/.config/gh/hosts.yml — on the disk, which is the one thing every other secret on
  # this machine is arranged to avoid. Read from the environment, gh needs no config file
  # at all, and the token stays in the tmpfs it arrived in.
  #
  # In /etc/profile.d, never at the end of ~/.bashrc: Ubuntu's stock .bashrc opens with
  # "if not running interactively, return", so anything appended there is invisible to
  # bash -lc and to `ssh host command`. Its own file rather than a line inside devbox.sh,
  # because install_claude_code writes that one with `>` and would silently truncate this
  # away on the next re-run.
  #
  # `gh auth setup-git` is deliberately not called: it would install gh's own credential
  # helper alongside the per-host one git_credentials already wrote, for a git that is
  # authenticated and working. gh has no git to configure here, only API calls to make.
  cat > /etc/profile.d/gh.sh <<'PROFILE'
[ -r /run/secrets/github ] && export GH_TOKEN=$(cat /run/secrets/github)
PROFILE
  chmod 644 /etc/profile.d/gh.sh

  # Who the commits belong to. git_credentials writes dev / dev@devbox.local, which is
  # nobody: a pull request whose commits are attributed to no account at all is a nuisance
  # to review and impossible to filter on. The token knows its own owner, so ask it — and
  # fall back to what was already there rather than fail, because an identity is not worth
  # losing a fifteen-minute seed over.
  #
  # The noreply address is the one GitHub itself issues, and it is what links a commit to
  # an account without publishing a real mailbox.
  cat >/tmp/devbox-gh-identity.sh <<'EOF'
set -eu
login=$(gh api user -q .login 2>/dev/null) || login=
id=$(gh api user -q .id 2>/dev/null) || id=
if [ -n "$login" ] && [ -n "$id" ]; then
  git config --global user.name "$login"
  git config --global user.email "$id+$login@users.noreply.github.com"
else
  echo "the token did not name its owner: commits stay dev@devbox.local"
fi
EOF
  as_user "bash /tmp/devbox-gh-identity.sh"
  rm -f /tmp/devbox-gh-identity.sh

  # Asserted, not hoped for. `gh auth status` exits non-zero when the token is absent,
  # expired or refused, and it masks the token in what it prints. Finding that out here,
  # with a name, beats finding it out twenty minutes later inside an agent session as a 403
  # on `gh pr create`.
  as_user "gh auth status"
}

# Claude Code, and the three traps that come with it. Each one was paid for on a live
# machine, so the comments below say what was measured rather than what the lines do.
#
# 1. The environment variable is NOT enough, whatever the headless test says.
#    CLAUDE_CODE_OAUTH_TOKEN carries `claude -p` perfectly while the interactive agent
#    answers every prompt with "Not logged in": the TUI reads ~/.claude/.credentials.json.
#    Measured by driving a real TTY, because -p stays green exactly when the interactive
#    path is broken.
# 2. Written into tmpfs and symlinked, so the token never lands on the disk.
# 3. The onboarding flags, without which the agent opens on its welcome screen despite a
#    valid token — and `claude mcp add` is what creates the ~/.claude.json they edit, so
#    the browser must be registered before the gates are set.
install_claude_code() {
  require_secrets claude

  # From its native installer, not npm. npm is the deprecated path and the documentation
  # is explicit that it must not be installed with sudo, which is exactly what this is:
  # the user then cannot write the npm prefix and every session opens on an auto-update
  # failure. Under /opt with a symlink in PATH, so the version belongs to the machine.
  mkdir -p /opt/claude
  curl -fsSL https://claude.ai/install.sh | HOME=/opt/claude CLAUDE_INSTALL_ALLOW_SUDO=1 bash
  ln -sfn /opt/claude/.local/bin/claude /usr/local/bin/claude
  rm -rf /opt/claude/.npm /opt/claude/.claude /opt/claude/.claude.json

  # In /etc/profile.d, never at the end of ~/.bashrc. Ubuntu's stock .bashrc opens with
  # "if not running interactively, return", so anything appended there is invisible to
  # bash -lc and to `ssh host command`: the agent answered "Not logged in" while its token
  # sat two lines below a guard that had already returned.
  cat > /etc/profile.d/devbox.sh <<'PROFILE'
[ -r /run/secrets/claude ] && export CLAUDE_CODE_OAUTH_TOKEN=$(cat /run/secrets/claude)
PROFILE
  chmod 644 /etc/profile.d/devbox.sh

  # Auto-updates off: the agent's version belongs to the machine, and a jettable box that
  # rewrites its own tooling at every boot is a box whose behaviour you cannot reproduce.
  #
  # theme auto, so the TUI follows the terminal it is displayed in rather than guessing. A
  # devbox is joined from a phone as often as from a workstation, and the two rarely agree
  # on light or dark.
  #
  # CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC turns off everything that is not the
  # conversation itself: telemetry, update checks, error reports. On a machine that exists
  # for a few hours and is then destroyed, none of it has a reader.
  #
  # effortLevel xhigh, because the reasoning default belongs to the machine too: this box
  # exists to be handed a long task and left alone, and an agent that thinks less to answer
  # faster is optimising for the one thing nobody is waiting on here.
  #
  # model opus, the alias and not a model's name: it follows each new Opus, where a name pinned
  # here (claude-opus-5 until 30/09) stayed on the old one once a newer shipped.
  #
  # defaultMode auto, and it is a statement about THIS machine rather than a preference: it
  # holds no production access, it is reached through one SSH key, and it is destroyed at
  # the end of the day. An agent that stops to ask is asking nobody. Change it in your copy
  # if you point this profile at something you care about.
  mkdir -p "$HOME_DIR/.claude"
  cat > "$HOME_DIR/.claude/settings.json" <<'JSON'
{
  "model": "opus",
  "effortLevel": "xhigh",
  "theme": "auto",
  "permissions": {
    "defaultMode": "auto"
  },
  "env": {
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "DISABLE_AUTOUPDATER": "1"
  }
}
JSON
  chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR/.claude"

  # Trap 1 and 2: the credentials file the TUI actually reads, into tmpfs and symlinked, so
  # the token never lands on the disk.
  install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" /run/claude
  cat >/tmp/devbox-creds.sh <<'EOF'
set -eu
umask 077
jq -n --arg t "$(cat /run/secrets/claude)" \
      --argjson exp "$(( ($(date +%s) + 31536000) * 1000 ))" \
      '{claudeAiOauth:{accessToken:$t, refreshToken:"", expiresAt:$exp,
        scopes:["user:inference","user:profile"], subscriptionType:"max"}}' \
  > /run/claude/credentials.json
ln -sfn /run/claude/credentials.json "$HOME/.claude/.credentials.json"
EOF
  as_user "bash /tmp/devbox-creds.sh"
  rm -f /tmp/devbox-creds.sh

  # chrome-devtools-mcp speaks the DevTools protocol to the headless Chrome on this
  # machine and returns screenshots the agent reads as images, so "look at the page" keeps
  # working from a machine with no screen. This call is also what creates the
  # ~/.claude.json that the gates below edit, so it has to come first.
  if ! as_user "claude mcp list 2>/dev/null | grep -q chrome-devtools"; then
    as_user "claude mcp add -s user chrome-devtools -- \
      chrome-devtools-mcp --headless --isolated --executablePath /usr/bin/google-chrome"
  fi

  # Trap 3. Without these the agent opens on its onboarding screen despite a valid token.
  #
  # The trust line is built in a variable first. Inlining it as
  # ${REPO_DIR:+| .projects["$REPO_DIR"]…} looks equivalent and is not: bash treats the
  # quotes INSIDE a ${var:+word} expansion as real quoting and removes them, so jq
  # received .projects[/home/dev/repo] unquoted and died on "unexpected '/'".
  local trust=''
  [ -n "$REPO_DIR" ] && trust="| .projects[\"$REPO_DIR\"].hasTrustDialogAccepted = true"
  cat >/tmp/devbox-claude-init.sh <<EOF
set -eu
test -f "\$HOME/.claude.json" || echo '{}' > "\$HOME/.claude.json"
jq '.hasCompletedOnboarding = true
    | .theme = "dark"
    $trust' \
  "\$HOME/.claude.json" > "\$HOME/.claude.json.new"
mv "\$HOME/.claude.json.new" "\$HOME/.claude.json"
EOF
  as_user "bash /tmp/devbox-claude-init.sh"
  rm -f /tmp/devbox-claude-init.sh
}

# opencode: its own installer, under /opt with a symlink in PATH, and the token in the
# environment and nowhere else. The same three decisions as claude.sh, made for the same
# reasons, on a different agent.
install_opencode() {
  require_secrets openrouter

  # HOME points into /opt because the installer writes $HOME/.opencode/bin: the version
  # then belongs to the machine and not to the `dev` account. --no-modify-path because the
  # shell files it would edit are in that same throwaway HOME and nobody reads them.
  #
  # Re-enterable for free: the installer compares the version already on PATH and exits
  # without downloading when it matches.
  mkdir -p /opt/opencode
  curl -fsSL https://opencode.ai/install | HOME=/opt/opencode bash -s -- --no-modify-path
  # Named before it is linked. `ln -sfn` onto nothing succeeds in silence, and the failure
  # then surfaces three steps later as an opencode that is on the PATH and is not there —
  # the installer moving its layout would read as a broken machine instead of a broken
  # assumption about where it puts things.
  [ -x /opt/opencode/.opencode/bin/opencode ] \
    || { echo "the installer did not leave a binary at /opt/opencode/.opencode/bin/opencode"; exit 1; }
  ln -sfn /opt/opencode/.opencode/bin/opencode /usr/local/bin/opencode
  # Readable by `dev`, who is not who installed it. Root's umask decides what the installer
  # leaves behind, and this profile does not get to assume it was 022.
  chmod -R a+rX /opt/opencode
  as_user "opencode --version"

  # OPENROUTER_API_KEY, and no auth.json. opencode enables a provider as soon as one of the
  # environment variables models.dev declares for it is set — for openrouter that is this
  # one — and `/connect` would instead write the key in clear into
  # ~/.local/share/opencode/auth.json, on the disk. Read from the environment, the key stays
  # in the tmpfs it arrived in and dies with the machine.
  #
  # In /etc/profile.d, never at the end of ~/.bashrc: Ubuntu's stock .bashrc returns before
  # anything for a non-interactive shell, so a line appended there is invisible to
  # `bash -lc` and to `ssh host command`.
  cat > /etc/profile.d/opencode.sh <<'PROFILE'
[ -r /run/secrets/openrouter ] && export OPENROUTER_API_KEY=$(cat /run/secrets/openrouter)
PROFILE
  chmod 644 /etc/profile.d/opencode.sh

  # No "model" key, deliberately. Pinning one here would be the posture this repository
  # rejects everywhere else — remembering instead of asking — and OpenRouter's catalogue
  # changes faster than a profile does. `/models` picks one, per machine, on the day.
  #
  # autoupdate off for the reason the agent's version belongs to the machine: a jettable box
  # that rewrites its own tooling at every start is a box whose behaviour cannot be
  # reproduced.
  #
  # The permissions are open because this machine IS the sandbox: it is reached through one
  # SSH key, it holds no production access, and it is destroyed at the end of the day. An
  # agent that stops to ask is asking nobody. Tighten it in your copy if you point this
  # profile at something you care about.
  #
  # Hence the string form, "permission": "allow", and not the three named keys it replaces.
  # opencode starts from permissive defaults of its own and merges the user config LAST, the
  # last matching rule winning — so a named key only lifts what it names, and edit/bash/webfetch
  # left standing every default that is NOT "allow": doom_loop, external_directory the moment a
  # path leaves the working directory, and read on a .env. The string normalises to
  # { "*": "allow" }, one rule matching every permission and every pattern, which is the only
  # spelling that covers what the defaults will grow into. Documented as "set all permissions
  # at once": https://opencode.ai/docs/permissions/
  install -d -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.config"
  install -d -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.config/opencode"
  cat > "$HOME_DIR/.config/opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "permission": "allow",
  "mcp": {
    "chrome-devtools": {
      "type": "local",
      "command": [
        "chrome-devtools-mcp",
        "--headless",
        "--isolated",
        "--executablePath",
        "/usr/bin/google-chrome"
      ],
      "enabled": true
    }
  }
}
JSON
  chown -R "$USER_NAME:$USER_NAME" "$HOME_DIR/.config/opencode"
}

# Python, through uv, and nothing through apt.
#
# The image already carries Ubuntu's python3, and that one is the SYSTEM's: PEP 668 marks it
# externally managed, pip refuses it, and a profile that forced past the refusal would be
# editing the interpreter apt's own tooling runs on. uv brings an interpreter of its own,
# resolves an environment per project, and is a single static binary with no Python to
# bootstrap itself with.
#
# Under /opt with a symlink in PATH, like opencode and claude above: the version belongs to
# the machine and not to the `dev` account. INSTALLER_NO_MODIFY_PATH because the shell files
# the installer would edit live in that same throwaway HOME and nobody reads them.
install_python() {
  if command -v uv >/dev/null 2>&1; then
    echo "uv is already installed: $(uv --version)"
  else
    mkdir -p /opt/uv
    curl -fsSL https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR=/opt/uv INSTALLER_NO_MODIFY_PATH=1 HOME=/opt/uv sh
    # Named before it is linked, for install_opencode's reason: `ln -sfn` onto nothing
    # succeeds in silence, and the failure would surface three steps later as a uv that is
    # on the PATH and is not there.
    [ -x /opt/uv/uv ] || { echo "the installer left no binary at /opt/uv/uv"; exit 1; }
    ln -sfn /opt/uv/uv /usr/local/bin/uv
    ln -sfn /opt/uv/uvx /usr/local/bin/uvx
  fi

  # A real interpreter, under the same roof and not under root's home, where `dev` could not
  # read it. No version pinned — `ask, do not remember`, the posture install_node takes for
  # the same reason.
  #
  # The variable has to be set for whoever runs uv LATER as well, or `uv run` on the dev
  # account looks for an interpreter in a directory it cannot see and downloads a second
  # copy into ~/.local. Hence the profile.d line, written before the install so a failure
  # leaves the machine consistent.
  cat > /etc/profile.d/uv.sh <<'PROFILE'
export UV_PYTHON_INSTALL_DIR=/opt/uv/python
PROFILE
  chmod 644 /etc/profile.d/uv.sh
  UV_PYTHON_INSTALL_DIR=/opt/uv/python uv python install

  # Readable by `dev`, who is not who installed it: root's umask decides what the installer
  # leaves behind, and this file does not get to assume it was 022.
  chmod -R a+rX /opt/uv
  as_user "uv --version"
}

# Bun, from its own installer, under /opt with a symlink in PATH — the third instance of
# the same three decisions, and for the same reasons.
install_bun() {
  if command -v bun >/dev/null 2>&1; then
    echo "bun is already installed: $(bun --version)"
    return 0
  fi

  # The installer downloads a .zip and says so by dying without unzip, which the cloud
  # image does not carry. Asked for by name rather than assumed.
  command -v unzip >/dev/null 2>&1 || $APT install -y unzip

  mkdir -p /opt/bun
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash
  [ -x /opt/bun/bin/bun ] || { echo "the installer left no binary at /opt/bun/bin/bun"; exit 1; }
  ln -sfn /opt/bun/bin/bun /usr/local/bin/bun
  # bunx is a symlink to bun inside the installation, so the link here points at the link
  # there: one file to replace when the version moves.
  ln -sfn /opt/bun/bin/bunx /usr/local/bin/bunx
  chmod -R a+rX /opt/bun
  as_user "bun --version"
}
