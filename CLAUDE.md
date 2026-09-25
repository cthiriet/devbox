# CLAUDE.md

devbox orders a dev machine on Hetzner, Scaleway or GCP with Terraform, provisions it from a
profile and writes the SSH config to reach it. A CLI and a self-hosted dashboard share one
executor.

## Layout

    devbox                 entry point: the Ink app (cli/) on a terminal, devbox-core otherwise
    devbox-core            the executor, in bash: clouds, Terraform, ~/.ssh/config, seeding
    cli/                   the Ink renderer (src/), and the tests of it and devbox-core (tests/)
    prelude.sh             functions profiles call on the machine: install_*, clone_repo, run_setup
    profiles/              published profiles: claude, opencode
    tf/<cloud>/            one Terraform root per cloud: hetzner, scaleway, gcp
    cloud-init.yaml.tftpl  first-boot user-data; it and devbox-provision.sh are read by the roots
    dashboard/             Bun server (server.ts, src/), React SPA (web/), tests/, scripts/,
                           deploy.json (a generic deployment manifest)
    docs/deploy.md         an example deployment: systemd and Caddy

## Commands

    make test                              both suites, cli/ and dashboard/
    cd dashboard && bun run verify         tests, tsc on both sides, deployment rehearsal
    cd dashboard && bun run build          engine, then web, then the shell
    cd dashboard && bun run dev            the server on :3021
    cd dashboard && bun run dev:web        Vite on :3022, proxying /api to :3021 with the
                                           Origin rewritten, so CSRF is checked, not disabled
    cd dashboard && bun run dev:web:node   the same under node: Bun's cannot proxy the terminal

## Nothing personal in the repository

This repository is public. No real domain, cloud account, project ID, server or private
repository name in code, comments or defaults: a personal default is inherited by every reader
who does not own it. Personal things live in `~/.config/devbox/`, which devbox reads on top of
the repository: its profiles shadow `profiles/` by name, its `secrets/` holds tokens, and a real
deployment's scripts belong there too. A comment that records a failure keeps the mechanism and
drops the name ("a production module").

## One executor, and the dashboard's copy of it

- `devbox-core` is the only executor. The dashboard runs `dashboard/engine/devbox`, a gitignored
  copy made by `bun run engine` (`scripts/build-engine.ts`) with `prelude.sh`, `profiles/` and
  the Terraform roots. Changing any of them changes nothing on a server until the dashboard is
  rebuilt and redeployed; `bun run verify` first, which checks the engine arrives byte for byte.
- With `DEVBOX_REMOTE` set, `up`, `seed` and `down` run on the server, with its engine; the local
  core only calls the API and follows the job log.
- Before each remote verb, `version_gate` in devbox-core compares its sha256 with
  `GET /api/version`. Three outcomes, never two: silence when equal, a warning naming both short
  digests when they differ, a sentence starting `cannot tell what` when it could not check. A
  doubt must never read as agreement; the host-key and unpushed-work checks follow the same rule.

## Accounts

- Sign-in is Google or GitHub only (`src/oauth.ts`, no dependency). Account 1 is founded only by
  an identity whose verified address folds to `DEVBOX_FOUNDER_EMAIL` (`doors()`, `src/accounts.ts`).
- Isolation is a directory tree per account, `DATA_DIR/accounts/<id>/` (home and SSH key, state,
  profiles, logs), built only by `accountTree(id)` (`src/tree.ts`). devbox-core lists a fleet by
  listing `$DEVBOX_TF_ROOT`, so the tree is the boundary, not a filter. In the shared database,
  every per-account query names the account. Another account's machine is a plain 404.
- A launch's credentials (`Sources`) come only from `sourcesFor(account)`, or `destroySourcesFor()`
  for a destroy (`src/secrets.ts`). No default, so forgetting the account does not compile. A
  destroy gets the credentials its machine was ordered with (`machine_origins`).
- Each account orders on its own cloud credentials; the service's environment and files answer
  for account 1 alone. An optional module (`DEVBOX_EXTENSION`, `src/extension.ts`) may put
  accounts on the service's cloud accounts. It decides, and never reads the vault.

## Secrets

- `src/vault.ts` seals them in `devbox.db`: AES-256-GCM under a data key per account, sealed in
  turn under `DEVBOX_MASTER_KEY`, each ciphertext bound to its owner, kind and name. A row that
  fails to open throws, and never reads as absent.
- Write-only: no route returns a value. `GET /api/secrets` answers names, source, size, date and
  an HMAC fingerprint; only `heldValue` reads bytes, for the engine.
- The master key is read once at startup, then deleted from `process.env`. `engineEnv()`
  (`src/engine.ts`) withholds it and the service's own credentials from every child; on Linux
  the process makes itself undumpable (`src/undumpable.ts`). No value ever goes in an argv.
- `src/secrets.ts` alone decides where a value comes from: the vault first, then the fallback
  (the service's environment and `$DEVBOX_SECRETS_DIR`). Removing a value from the vault hands
  the next job back to the fallback, possibly the old token; a closed vault lets it answer for all.
- The CLI token reads, orders, seeds and destroys. It never writes a secret, a profile or a
  token, and never opens a terminal: those routes use `guard(req, { bearer: false })`. A token
  that could swap a cloud credential could send a seed elsewhere and collect its secrets.

## Web app and routes

- `web/` is a Vite + React SPA built before deployment into `public/`; `server.ts` serves
  application routes from `shell/index.html`, a copy that survives the deployment's rsync.
- An application route is declared in three places: `web/src/main.tsx`, the `Bun.serve` route
  table in `server.ts`, and `routes` in `deploy.json`; plus the Caddyfile example in
  `docs/deploy.md`. Missing from one, a reload answers 404. A declared route answers 200 or 401,
  never a redirect. `/api/auth/*` redirects, and lives under the already declared `/api/*`.
- The terminal is a WebSocket, its anti-CSRF token in `Sec-WebSocket-Protocol`. The host key is
  checked against the account's recorded `known_hosts`, never a fresh keyscan; none is a refusal.

## Terraform roots

`tf/<cloud>/main.tf` reads files outside its directory (`../../prelude.sh`,
`cloud-init.yaml.tftpl`, `devbox-provision.sh`). `src/roots.ts` reads those names out of the
`.tf` files, and `build-engine.ts` and `stageRoots()` copy what it finds. Never keep a list by
hand: `file()` is evaluated at plan time, so a missing file breaks `destroy` too.

## Profiles

- No default profile: `up` and `seed` refuse without `--profile` or `DEVBOX_PROFILE`, before
  ordering anything; `seed` alone falls back to the profile the machine recorded.
- `profile_meta` in devbox-core reads the `# devbox-<key>:` header. A profile that adds
  `devbox-repo:` must declare `github` in `devbox-secrets:`, or its seed dies after the order.
- Profiles composed on the dashboard (`src/profiles.ts`): the table is the authority, the file in
  the account's `config/profiles/` its rendering. Every field passes a whitelist (`checkedSpec`),
  `renderProfile` checks again and throws rather than escapes, and the body calls only prelude
  functions named in `src/software.ts`. Nothing typed becomes shell. A name devbox already lists
  is refused: the composed one would shadow it.
- A machine the dashboard seeds gets a corrected prelude only after a redeploy and a new `seed`.

## Running the service

Never restart it while a job runs. A job is its child: a cut `up` leaves a billed machine no state
records (marked `interrupted`, found only by `devbox orphans`), a cut `seed` a half-built one.
One job per machine, capped by `DEVBOX_MAX_JOBS` (4) and `DEVBOX_MAX_JOBS_PER_ACCOUNT` (3): a 409
beyond, no queue. Two terminals per account, four in all.

## Tests

- `cli/tests/` spawns the real devbox-core against a fake dashboard (`Bun.serve`) and a fake
  `terraform` (`harness.ts`). HOME is always a `mkdtemp`, since devbox-core writes
  `~/.ssh/config`; `ssh-keygen` is shadowed in PATH, as it resolves `~` from passwd, not HOME.
- `dashboard/tests/server-harness.ts` starts the real `server.ts` with `DEVBOX_EXTENSION=none`
  and `--no-env-file`, Google and GitHub faked by a preload (`tests/fixtures/oauth-providers.ts`)
  that nothing in `src/` names. `secrets-api.test.ts` plants values sharing one marker; finding
  it in a response, an argv or a job log is the failure.

## Comments

A comment says why: the measured fact, what broke, the trade chosen. Not what the line does.
