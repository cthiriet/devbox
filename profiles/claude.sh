#!/bin/bash
# Claude Code on a machine of its own: installed, authenticated, a browser it can drive,
# and the GitHub CLI so it can hand its work back. A box to give a long task to and leave
# alone.
#
# devbox-secrets:  claude github
# devbox-min-cpu:  2
# devbox-min-ram:  4
# devbox-min-disk: 40
# devbox-note:     claude is authenticated already: open a session and type `claude`
#
# NO `devbox-repo:`, on purpose: this profile is one of the ones you copy, and a
# copy that arrived with someone else's repository baked in would be worse than one that
# arrived with none. Add the line to your copy:
#
#   cp profiles/claude.sh ~/.config/devbox/profiles/mine.sh   then add:
#   # devbox-repo:   https://github.com/me/mine.git
#
# `github` is declared even though nothing here needs it when no repository is cloned, and
# every step that uses it checks for it first. Drop the name from the header if this
# machine will never talk to GitHub: what you lose is `gh`, and the agent's commits keep
# the dev@devbox.local identity.
#
# The `claude` secret is a Claude Code OAuth token — `claude setup-token` on a machine
# where you are already signed in. It is not an Anthropic API key, and the two are not
# interchangeable here.
#
# Re-enterable on purpose. `devbox seed` streams this over SSH, and a link that drops on a
# five-minute install must not force a rebuild from zero: every step either checks for its
# own result first, or is safe to repeat.
#
# What this profile INSTALLS moved into prelude.sh on 12/09 — install_gh and
# install_claude_code, word for word, for the reason install_node moved there before them
# and one more: a profile composed from the dashboard renders a list of calls into that
# file, and a recipe locked in here could only ever be had by copying this file whole.
# What stays here is what this profile DECIDES: the order, the conditions, and what it
# declares.
set -euxo pipefail
. /usr/local/lib/devbox/prelude.sh

require_secrets claude

# Everything that downloads comes first, and the repository last, so that a seed dying on a
# CDN dies before it has cloned anything rather than after.
step "node"
install_node                   # only for chrome-devtools-mcp
step "chrome + chrome-devtools-mcp"
install_chrome

# Only when there is a token to use. The header declares `github`, so there normally is —
# but a copy of this profile that dropped the name must still yield a working machine
# rather than die here, minutes in, with the machine already ordered.
if [ -r /run/secrets/github ]; then
  step "gh"
  install_gh
else
  echo "no github secret: no gh, and commits keep the dev@devbox.local identity"
fi

# Before Claude Code, so the trust gate below is written for a directory that exists.
if [ -n "$REPO_URL" ]; then
  step "repository"
  require_secrets github
  clone_repo
  echo "repository in $REPO_DIR"
else
  echo "no repository declared: the agent starts on an empty machine"
fi

step "claude code"
install_claude_code
step "done"
