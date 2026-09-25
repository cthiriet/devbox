#!/usr/bin/env bash
# The deployment, rehearsed locally, with nothing of production touched.
#
#   dashboard/scripts/simulate-deploy.sh
#
# WHY THIS EXISTS. What the server runs is not this directory: it is what SURVIVES the
# rsync. The exclusions are the whole difficulty - `node_modules`, `data`, `tests`,
# `public` is dropped BY NAME AND AT ANY DEPTH - and every deployment failure
# this repository has had was a file that resolved on the Mac and was not there afterwards.
# A sibling reached by a relative path, a test helper imported from src/, a dependency the
# workspace root hoisted: each of them passes `bun test` and `tsc --noEmit` on this
# workstation and dies on the first request, on the machine that serves every client site.
#
# So the rehearsal is the whole file. Four steps, and they are the deployment's own:
#
#   1. bun run build        locally, exactly as the deployment does before it sends anything
#   2. rsync -a --delete    into a temporary directory, with deploy.json's exclusions
#   3. bun install --production
#   4. start the server, GET /, and require a 200
#
# WHAT IT DOES NOT DO, and must not: it never deploys anything, never opens an ssh
# connection, never reads a secret store, and never asks a cloud for anything. The server it
# starts is bound to 127.0.0.1 on a port nobody else has, with no credentials in its
# environment - `missing()` will name three, and the service is designed to start anyway and
# say so, which is itself part of what this checks.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PORT=${PORT:-3121}
SERVER_PID=
WORK=

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mx\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    # Reaped here, so the shell does not print its own "Terminated" line after the last
    # log line and make a clean run look like a failed one.
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  [ -n "$WORK" ] && rm -rf "$WORK" || true
}
trap cleanup EXIT

command -v rsync >/dev/null || die "rsync is not in PATH"
command -v bun >/dev/null || die "bun is not in PATH"

cd "$HERE"

# --- 1. the build, on this workstation ----------------------------------------
#
# The deployment runs the manifest's `build` locally and rsyncs the result, which is why
# scripts/build-engine.ts may reach the repository root by a relative path: it never
# executes on the server. It is also where `engine/devbox` is asserted to be devbox-core byte for
# byte, so a build that got this far has already proved the handshake's own premise.

log "bun run build"
bun run build >/dev/null || die "the build failed"

# --- 2. the rsync, with deploy.json's own exclusions --------------------------
#
# Read from the manifest rather than transcribed. A list typed here would be a second copy
# of the one thing this script exists to exercise, and it would go stale silently - which is
# the failure it is supposed to catch.

WORK=$(mktemp -d "${TMPDIR:-/tmp}/devbox-deploy-XXXXXX")
APP=$WORK/app
mkdir -p "$APP"

# `while read` and not `mapfile`: macOS ships bash 3.2, which has neither mapfile nor
# readarray, and this repository already learned that lesson in the shim.
EXCLUDE=()
while IFS= read -r name; do
  [ -n "$name" ] && EXCLUDE+=("$name")
done < <(bun --print 'JSON.parse(require("fs").readFileSync("deploy.json","utf8")).exclude.join("\n")')
PUBLIC=$(bun --print 'JSON.parse(require("fs").readFileSync("deploy.json","utf8")).publicDir ?? ""')

args=(-a --delete)
for name in "${EXCLUDE[@]}"; do args+=(--exclude "$name"); done
# publicDir is not the application's to serve: the reverse proxy serves it straight from
# disk and the deployment ships it on its own, so the application rsync leaves it out.
[ -n "$PUBLIC" ] && args+=(--exclude "$PUBLIC")
# And .git, which the deployment drops by itself, after the manifest's list.
args+=(--exclude .git)

log "rsync ${args[*]} -> $APP"
rsync "${args[@]}" "$HERE/" "$APP/"

# The exclusions, verified rather than assumed. `tests` and `node_modules` are matched at
# any depth, so a file deposited under one of those names anywhere in engine/ would be
# copied by the build and dropped in flight - the executable bit on engine/devbox goes the
# same way if rsync is ever invoked without -a.
[ -d "$APP/node_modules" ] && die "node_modules survived the rsync"
[ -d "$APP/tests" ] && die "tests/ survived the rsync"
[ -d "$APP/data" ] && die "data/ survived the rsync"
[ -x "$APP/engine/devbox" ] || die "engine/devbox did not survive the rsync, or lost its mode"

# And what the roots READ survived with them.
#
# tf/<cloud>/main.tf reaches two levels up - `file("${path.module}/../../prelude.sh")` and
# others - and `file()` is evaluated at PLAN time, so a root deployed without one of them
# can neither create a machine nor DESTROY one. Measured on 27/08: a live cx33, ordered
# while the old roots were still in place, became undestroyable by the service that had
# ordered it the moment the new ones were laid over them. The names are read off the
# deployed roots themselves, so this checks what will actually run rather than a list.
#
# Through scripts/rehearse.ts, a file tsc checks, and never TypeScript inlined here: see
# that file for the verify it cost on 11/09.
absent=$(cd "$APP" && bun scripts/rehearse.ts roots) \
  || die "the roots of the deployed copy could not be read"
[ -z "$absent" ] || die "the deployed roots read files engine/ does not hold: $absent
  scripts/build-engine.ts is what deposits them."

# web/ is the SOURCE of the interface, not the interface. It carries its own package.json,
# its own node_modules and a hundred megabytes of build dependencies the server has no use
# for: `bun run build` compiles it HERE, before the rsync, and only the result travels. If
# it survives, the manifest's exclusion has been dropped, and step 3's
# `bun install --production` would collapse on front-end dependencies.
[ -d "$APP/web" ] && die "web/ survived the rsync"

# The shell, on the other hand, MUST survive, and it is the half public/ cannot cover.
#
# The manifest declares `publicDir: "public"` and the platform deploys it separately: the
# exclusion line above removes it from the application. But the application paths - `/`,
# `/machine/*`, `/job/*` - are routed to Bun, because a SPA routes them on the client and
# Caddy has no fallback to the index for a path that is not a file. The server therefore has
# to render the index itself, out of a directory the rsync does carry.
# scripts/build-shell.ts deposits it there; without this check, forgetting it would show on
# the first request after a successful deployment, as a blank page.
[ -s "$APP/shell/index.html" ] || die "shell/index.html did not survive the rsync"
grep -qE 'src="/assets/[^"]+\.js"' "$APP/shell/index.html" \
  || die "shell/index.html references no bundle under /assets/: it is not a vite build"
find "$APP/engine" -name node_modules -o -name tests | grep -q . && \
  die "something under engine/ is named after an exclusion and was dropped in flight"

log "$(find "$APP" -type f | wc -l | tr -d ' ') files deployed, engine/ holds $(find "$APP/engine" -type f | wc -l | tr -d ' ')"

# --- 3. the install, on the deployed copy alone --------------------------------
#
# `bun install --production` against this directory's package.json, with no workspace root
# above it. A `workspace:*` dependency would fail here - which is why this package has none
# and must never grow one, however convenient a sibling looks from the Mac.

log "bun install --production"
(cd "$APP" && bun install --production >/dev/null 2>&1) || die "bun install --production failed"

# --- 4. does it answer ---------------------------------------------------------
#
# No credentials, deliberately: the service must start with an incomplete configuration and
# say what is missing, rather than dying and looping on Restart=always. The login page is
# what `/` serves to a browser with no session, and it is what the deployment itself asks
# for at the end.

# The port must be FREE, and this line was added after a measurement.
#
# Bun.serve opens its socket with SO_REUSEPORT: a second server binds to the same port
# without the slightest error, and it is the oldest one that answers. Ten processes left by
# earlier rehearsals were listening on 3121, and step 4's `GET /` was served by a build four
# days old - so the rehearsal was returning a verdict on code that was not the code being
# deployed, which is exactly the lie this whole file exists to make impossible. An occupied
# port is now a failure, not a detail.
if lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  die "something is already listening on 127.0.0.1:$PORT.
  Bun.serve would bind to it anyway (SO_REUSEPORT) and the other one would answer.
    lsof -tnP -iTCP:$PORT -sTCP:LISTEN | xargs kill"
fi

log "starting the deployed copy on 127.0.0.1:$PORT"
# `exec`, so that $! is the bun itself and not the subshell that launched it: without it the
# cleanup's `kill` killed the subshell, already dead, and left the server behind - which is
# how the ten accumulated.
#
# DEVBOX_RUNTIME_DIR under $WORK, here and in step 6: left unset, a Linux host lays launches
# out in a directory of /dev/shm named after $WORK/data, a new name at every rehearsal, and
# the last line of this script - "nothing outside $WORK was touched" - would be false.
(cd "$APP" && DATA_DIR="$WORK/data" DEVBOX_RUNTIME_DIR="$WORK/run" NODE_ENV=production PORT="$PORT" \
   exec bun run server.ts >"$WORK/server.log" 2>&1) &
SERVER_PID=$!

for _ in $(seq 40); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null && break
  sleep 0.25
done

code=$(curl -s -o "$WORK/index.html" -w '%{http_code}' "http://127.0.0.1:$PORT/" || echo 000)
if [ "$code" != 200 ]; then
  sed -n '1,60p' "$WORK/server.log" >&2
  die "GET / answered $code"
fi

log "GET / answered 200, $(wc -c <"$WORK/index.html" | tr -d ' ') bytes"

# And what `/` rendered is the shell, not the fallback page.
#
# server.ts answers 200 even with no shell, deliberately: the platform checks every declared
# route after a reverse-proxy reload and accepts only 200 or 401, a failure rolling back the
# proxy configuration of EVERY site the machine serves. A 500 here would cost far more than
# the page it would describe. But that means a 200 proves nothing on its own, and this line
# is what separates "the SPA is deployed" from "the server is apologising in 200".
grep -q 'id="root"' "$WORK/index.html" \
  || die "GET / answered 200 but not the SPA shell:
  $(head -c 200 "$WORK/index.html")"

# --- 5. the handshake's premise, on the rsynced copy ---------------------------
#
# What the workstation compares itself against is the sha256 of engine/devbox. Read through the
# API it would need a token; read from the deployed tree it is the same computation on the
# same bytes and needs none. build-engine.ts already asserted the equality before the rsync;
# this asserts it AFTER, which is the half no build can check - a file mangled in flight, an
# exclusion that swallowed it, a mode lost.

deployed=$(shasum -a 256 "$APP/engine/devbox" | cut -d' ' -f1)
source_digest=$(shasum -a 256 "$HERE/../devbox-core" | cut -d' ' -f1)
log "the deployed engine names itself ${deployed:0:7}"
[ "$deployed" = "$source_digest" ] || \
  die "engine/devbox is ${deployed:0:7} after the rsync and devbox-core is ${source_digest:0:7}:
  the version handshake would warn about a gap after every successful deployment."

# --- 6. the deployed service really spawns it ----------------------------------
#
# Through src/engine.ts's own profiles() rather than by spelling a command line here: what
# is being checked is the service's own path to the engine - the launch directory, and the
# environment engineEnv builds from it - and a command line written in this script would
# exercise neither.
#
# `profiles --json` because it is a read verb that touches no cloud and no state. And through
# scripts/rehearse.ts, which tsc checks: the TypeScript that stood inline here called
# engineEnv() with no launch after its signature changed, and nothing but this step saw it.

log "the deployed service, spawning its engine"
answer=$(cd "$APP" && DATA_DIR="$WORK/data" DEVBOX_RUNTIME_DIR="$WORK/run" bun scripts/rehearse.ts engine) \
  || die "the engine failed in the deployed tree"
[ -n "$answer" ] || die "the engine answered nothing"
log "devbox profiles --json answers from the rsynced copy: $answer"

log "done. Nothing outside $WORK was touched, and it is now gone."
