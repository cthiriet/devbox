#!/bin/bash
# opencode wired to OpenRouter, with a browser it can drive and a repository cloned when
# you declare one. The same shape as claude.sh, on a different agent and a different
# account: pick whichever you already pay for.
#
# devbox-secrets:  openrouter github
# devbox-min-cpu:  2
# devbox-min-ram:  4
# devbox-min-disk: 40
# devbox-note:     opencode: /models picks one — OPENROUTER_API_KEY is already in the env
#
# NO `devbox-repo:`, on purpose: this profile is one of the ones you copy, and a
# copy that arrived with someone else's repository baked in would be worse than one that
# arrived with none. Add the line to your copy:
#
#   cp profiles/opencode.sh ~/.config/devbox/profiles/mine.sh   then add:
#   # devbox-repo:   https://github.com/me/mine.git
#
# `github` is declared for the clone alone, and the clone checks for it first: drop the
# name from the header and this profile still yields a working machine, with no repository
# on it.
#
# Re-enterable on purpose. `devbox seed` streams this over SSH, and a link that drops on a
# five-minute install must not force a rebuild from zero: every step either checks for its
# own result first, or is safe to repeat.
#
# What this profile INSTALLS moved into prelude.sh on 12/09 — install_opencode, word for
# word, for the reason install_node moved there before it and one more: a profile composed
# from the dashboard renders a list of calls into that file, and a recipe locked in here
# could only ever be had by copying this file whole. What stays here is what this profile
# DECIDES: the order, the conditions, and what it declares.
set -euxo pipefail
. /usr/local/lib/devbox/prelude.sh

require_secrets openrouter

# Everything that downloads comes first, and the repository last, so that a seed dying on a
# CDN dies before it has cloned anything rather than after.
step "node"
install_node                   # only for chrome-devtools-mcp
step "chrome + chrome-devtools-mcp"
install_chrome
step "opencode"
install_opencode

# Only when there is something to clone, and only when the token to clone it with is here.
# The first version called clone_repo unconditionally and died on "this profile declares no
# devbox-repo" minutes into the seed, with the machine already ordered.
if [ -n "$REPO_URL" ]; then
  step "repository"
  require_secrets github
  clone_repo
  echo "repository in $REPO_DIR"
else
  echo "no repository declared: the agent starts on an empty machine"
fi

step "done"
