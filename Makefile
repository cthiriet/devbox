.DEFAULT_GOAL := help
SHELL := /bin/bash

KEY := $(HOME)/.ssh/devbox

# NAME= picks one machine among several. Without it, a target acts on the only one there is,
# and refuses to guess when there are more: `down` is the only command here that destroys work.
#
# These targets only delegate. The wrapper works on its own, from any directory:
#
#   ln -sfn $(PWD)/devbox ~/.local/bin/devbox
#
# `devbox` picks its renderer: a terminal gets the Ink app of cli/, everything else gets
# devbox-core, the bash, word for word. `make cli` installs the former; nothing breaks without it.

cli: ## Install the Ink renderer (once; without it devbox prints exactly as it always did)
	@cd cli && bun install
	@echo "devbox now renders in a terminal. DEVBOX_PLAIN=1 to opt out of it."

help: ## List targets
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/' | expand -t18

key: ## Generate the operator SSH key (once)
	@test -f $(KEY) || { test -d $(dir $(KEY)) || install -d -m 700 $(dir $(KEY)); ssh-keygen -t ed25519 -N '' -C devbox -f $(KEY); }
	@echo "$(KEY).pub"

up: key ## Order a machine and provision it (NAME=, CLOUD=, PROFILE=, REPO=)
	@./devbox up $(if $(NAME),--name $(NAME)) $(if $(CLOUD),--cloud $(CLOUD)) \
	          $(if $(PROFILE),--profile $(PROFILE)) $(if $(REPO),--repo $(REPO))

seed: ## Re-run phase 2 alone (after a failure, or to rotate a token)
	@./devbox seed $(NAME)

info: ## Reprint the connection details
	@./devbox info $(NAME)

ls: ## Every machine, and what they cost per hour
	@./devbox ls

profiles: ## What a machine can be made into, and what each profile needs
	@./devbox profiles

probe: ## What each cloud can create right now, cheapest first
	@./devbox probe

down: ## Destroy a machine and stop its meter
	@./devbox down $(NAME)

# Both suites in one go. cli/tests exercises the bash itself, against a fake dashboard.
test: ## Replay both suites, cli/ and dashboard/
	@cd cli && bun test
	@cd dashboard && bun test

# What a server runs is what SURVIVES the rsync, not this directory. The target replays the
# deployment (build, rsync with dashboard/deploy.json's exclusions, `bun install --production`,
# start, GET /) in a temporary directory, touching no server, cloud or secret.
# `bun run verify` calls it too, so the command the version warning names rehearses first.
deploy-sim: ## Rehearse the deployment locally: rsync, install, start, GET / == 200
	@bash dashboard/scripts/simulate-deploy.sh

.PHONY: help key cli up seed info ls profiles probe down test deploy-sim
