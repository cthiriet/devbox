# Hosting the dashboard

The dashboard is a Bun server that runs `devbox-core` for you, so machines can be ordered,
joined and destroyed from a browser or from the CLI. This guide hosts it on one Linux server
with systemd and Caddy, top to bottom. Read [SECURITY.md](../SECURITY.md) first: the server
holds every account's cloud tokens, SSH keys and profile secrets. In the examples,
`devbox.example.com` is your domain, `you@example.com` your address, `you` your login.

## 1. What you need

- **A Linux x86_64 server with systemd** and a DNS name. The committed Terraform lock files
  cover `linux_amd64` and `darwin_arm64` only.
- **Bun 1.3.11** at `/usr/local/bin/bun` (`deploy.json`'s `start`), and **Terraform 1.15.9**,
  pinned: it refuses a state written by a newer version, so never let anything upgrade it.
- **bash, curl, jq, nc** (`netcat-openbsd`), **the OpenSSH client**, **rsync**, and **openssl**
  for GCP. Outbound access to your clouds, the Terraform and npm registries, and port 22.
- **A reverse proxy on the same host** for HTTPS: Bun listens on `127.0.0.1` only.
- **An OAuth app** at Google or GitHub (section 3), and **a password manager** (section 4).
- **A workstation** with this repository, Bun, rsync, lsof and the tools above. It builds
  everything, and only the result is copied.

Prepare the server:

```bash
sudo apt-get install -y curl jq netcat-openbsd openssh-client openssl rsync unzip   # Debian, Ubuntu

curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.11"
sudo install -m 755 ~/.bun/bin/bun /usr/local/bin/bun

v=1.15.9
curl -fsSLO "https://releases.hashicorp.com/terraform/${v}/terraform_${v}_linux_amd64.zip"
curl -fsSLO "https://releases.hashicorp.com/terraform/${v}/terraform_${v}_SHA256SUMS"
sha256sum --ignore-missing -c "terraform_${v}_SHA256SUMS"
sudo unzip -o "terraform_${v}_linux_amd64.zip" terraform -d /usr/local/bin
rm -f "terraform_${v}"_*

sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin devbox
sudo install -d -m 755 -o "$USER" /srv/devbox/app /srv/devbox/public
sudo install -d -m 755 /etc/devbox
```

## 2. Build and copy

```bash
# on the workstation
bun install                          # at the repository root
(cd dashboard/web && bun install)    # the web interface has its own lock file
cd dashboard
bun run verify
```

`verify` runs the tests and type checks, then rehearses the deployment
(`scripts/simulate-deploy.sh`): it builds, copies into a temporary directory with the
exclusions of `deploy.json`, installs, starts the copy on `127.0.0.1:3121`, and checks that `/`
is the web app and `engine/devbox` is `devbox-core` byte for byte. It contacts no server.

The build (`bun run build`) makes `engine/` (`devbox-core`, its prelude, `profiles/`, the
Terraform roots), `public/` (the web bundle) and `shell/index.html` (served by Bun for app
routes). Copy the application without what `deploy.json` excludes, and `public/` on its own:

```bash
cd dashboard
excludes=$(bun --print 'JSON.parse(require("fs").readFileSync("deploy.json","utf8")).exclude.map((n) => "--exclude=" + n).join(" ")')
rsync -a --delete $excludes --exclude=public --exclude=.git ./ you@devbox.example.com:/srv/devbox/app/
rsync -a --delete public/ you@devbox.example.com:/srv/devbox/public/
ssh you@devbox.example.com 'cd /srv/devbox/app && /usr/local/bin/bun install --production'
```

`deploy.json` excludes `node_modules`, `data`, `tests`, `.test-data` and `web`, at any depth,
and `--delete` never removes an excluded path on the server. `-a` keeps the executable bit of
`engine/devbox`, and `devbox` must be able to read all of `app/`. Keep no `.env` in
`dashboard/`: it would travel, and Bun loads it at start. A private extension in
`dashboard/extension/` travels too (see `DEVBOX_EXTENSION`).

## 3. OAuth apps

Nobody signs in with a password: accounts open through Google or GitHub. Set up at least one.
The callback is `PUBLIC_URL/api/auth/<provider>/callback`, and it must match the registered
address character for character.

**Google**, in the Google Cloud console: configure the OAuth consent screen (audience
*External*, status *In production*, scopes `openid` and `.../auth/userinfo.email`, neither of
which needs a review). Then create an OAuth client of type *Web application* with the redirect
URI `https://devbox.example.com/api/auth/google/callback`. Its ID and secret are
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

**GitHub**, under Settings, Developer settings: create an *OAuth App* (not a GitHub App) with
homepage `https://devbox.example.com` and callback
`https://devbox.example.com/api/auth/github/callback`, device flow off, and generate a secret.
Its ID and secret are `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

A provider is offered only when both of its variables are set. They are read once at start, so
a change needs a restart.

## 4. The master key

Secrets saved from the dashboard are sealed in its database under a key that lives in the
service's environment, never in the database. Draw it on the workstation:

```bash
cd dashboard
bun scripts/master-key.ts            # prints v1:<base64 of 32 random bytes>, stores nothing
```

**Put it in a password manager before you set it anywhere.** It is the only copy: lose it and
every sealed secret is lost. Without a key, or with a wrong one, the service still starts, but
the vault stays closed and saving a secret fails with 503.

To rotate it, then rotate any leaked secret at its issuer too:

1. `bun scripts/master-key.ts 2`, and store the new key.
2. Set `DEVBOX_MASTER_KEY=v2:...` and `DEVBOX_MASTER_KEY_PREVIOUS=v1:...`, restart. The journal
   says `vault open; 1 owner(s) moved to the new master key, ...`.
3. Remove `DEVBOX_MASTER_KEY_PREVIOUS`, restart.

## 5. The first account

Set `DEVBOX_FOUNDER_EMAIL=you@example.com` before the first start. Without it, a service that
has never had an account opens no session.

- The first sign-in with a verified address equal to it, case aside, becomes account 1. Every
  other sign-in is refused until then, and a CLI token gets 503.
- The provider must vouch for that address. GitHub does for any verified address. Google does
  only for `@gmail.com` and Google Workspace addresses: for any other, sign in with GitHub.
- Account 1 alone reads the fallback credentials of the environment file and of
  `DEVBOX_SECRETS_DIR`.
- Once account 1 exists, the variable is ignored. Remove it; each start reminds you.

After that, sign-up is open to any verified Google or GitHub address, at most
`DEVBOX_MAX_NEW_ACCOUNTS_PER_HOUR` new accounts per hour. Each account orders with the cloud
credentials it sets on Keys & tokens (`/secrets`), never with yours unless a private extension
says so, but its jobs run on your server, within the job caps.

**Optional: your workstation's SSH key for account 1.** Each account gets its own key pair,
made on the server at first use and never shown. Machines accept only their account's key, and
`devbox sync` points your workstation at `~/.ssh/devbox`. To use that pair for account 1,
deposit it before the first start:

```bash
# on the server, with devbox and devbox.pub copied there over a channel you trust
sudo install -d -m 700 -o devbox -g devbox /var/lib/devbox /var/lib/devbox/accounts \
     /var/lib/devbox/accounts/1 /var/lib/devbox/accounts/1/home /var/lib/devbox/accounts/1/home/.ssh
sudo install -m 600 -o devbox -g devbox devbox     /var/lib/devbox/accounts/1/home/.ssh/devbox
sudo install -m 644 -o devbox -g devbox devbox.pub /var/lib/devbox/accounts/1/home/.ssh/devbox.pub
```

A complete pair is kept as it is. Otherwise, reach machines through the terminal on their page.

## 6. The environment file

All settings go in one file only root can read: systemd reads it before starting the service
as `devbox`, and if `devbox` could read it, so could every program the service runs.

```bash
sudo install -m 600 -o root -g root /dev/null /etc/devbox/devbox.env
sudoedit /etc/devbox/devbox.env      # then write, for example:
```

```ini
PUBLIC_URL=https://devbox.example.com
DATA_DIR=/var/lib/devbox
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
GITHUB_CLIENT_ID=<client id>
GITHUB_CLIENT_SECRET=<client secret>
DEVBOX_FOUNDER_EMAIL=you@example.com
DEVBOX_MASTER_KEY=v1:<from bun scripts/master-key.ts>
```

No comment at the end of a line: it would become part of the value. Every variable the server
reads:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PUBLIC_URL` | yes | `http://localhost:$PORT` | The exact origin users type. Writes are refused unless the browser's `Origin` equals it, and the OAuth callbacks are built on it. `https://` makes cookies `Secure` |
| `DATA_DIR` | yes, with this unit | `data/` beside `server.ts` | Everything the service writes |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | one provider | empty | Google sign-in |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | one provider | empty | GitHub sign-in |
| `DEVBOX_FOUNDER_EMAIL` | until account 1 exists | empty | The address that founds account 1 |
| `DEVBOX_MASTER_KEY` | yes | empty, vault closed | `v<N>:<base64 of 32 bytes>`, seals saved secrets |
| `DEVBOX_MASTER_KEY_PREVIOUS` | during a rotation | empty | The key being replaced |
| `PORT` | no | `3021` | Port on `127.0.0.1`. Change the proxy with it |
| `DEVBOX_MAX_NEW_ACCOUNTS_PER_HOUR` | no | `30` | New accounts per hour. Known identities always sign in |
| `DEVBOX_MAX_JOBS` | no | `4` | Jobs (`up`, `seed`, `down`) at once, all accounts. Beyond it, 409 |
| `DEVBOX_MAX_JOBS_PER_ACCOUNT` | no | `3` | The same, per account. Always one job per machine |
| `DEVBOX_RUNTIME_DIR` | no | `/dev/shm`, else `$DATA_DIR/run` | Where a job's secrets are written while it runs. Use a tmpfs |
| `DEVBOX_SECRETS_DIR` | no | `$DATA_DIR/shared/secrets` | Fallback files for account 1: one per profile secret, and the GCP key as `gcp` |
| `HCLOUD_TOKEN`, `SCW_ACCESS_KEY`, `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID`, `DEVBOX_GCP_PROJECT` | no | empty | Fallback cloud credentials for account 1. A value deleted on Keys & tokens falls back to these. Prefer the page |
| `DEVBOX_EXTENSION` | no | `extension/server.ts` if present | A private extension module. `none` ignores it |
| `DEVBOX_PROFILE` | no | none | The profile a `seed` uses when nothing else names one |
| `DEVBOX_MIN_CORES`, `DEVBOX_MIN_MEMORY_GB`, `DEVBOX_MIN_DISK_GB` | no | `4`, `8`, `80` | Machine floors for a profile that sets none |
| `ENGINE_DIR`, `SHELL_DIR`, `PUBLIC_DIR` | no | `engine/`, `shell/`, `public/` beside `server.ts` | Where the build outputs are read |
| `DEVBOX_KEY` | older deployments | `~/.ssh/devbox` of the service user | Old SSH key, read once by the migration (section 11) |
| `DEVBOX_REMOTE_TOKEN` | older deployments | empty | Old CLI token, adopted as account 1's first token at the founding. Remove afterwards |
| `PASSWORD_HASH`, `DEVBOX_INVITE_CODE` | retired | | Read by nothing. Remove if present |

## 7. The systemd unit

```ini
# /etc/systemd/system/devbox.service
[Unit]
Description=devbox dashboard
Wants=network-online.target
After=network-online.target

[Service]
User=devbox
Group=devbox
WorkingDirectory=/srv/devbox/app
ExecStart=/usr/local/bin/bun run server.ts
EnvironmentFile=/etc/devbox/devbox.env
Restart=always
RestartSec=5
StateDirectory=devbox
StateDirectoryMode=0700
MemoryMax=1G
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

- `StateDirectory` creates `/var/lib/devbox` (`0700`, owned by `devbox`): that is `DATA_DIR`.
  `ProtectSystem=strict` leaves only it, `/dev/shm` and a private `/tmp` writable. The service
  never writes under `/srv/devbox`.
- `Restart=always` is safe: with a bad configuration the service still starts and says what is
  wrong, in the journal and on the page.
- `MemoryMax=1G` is `deploy.json`'s `memory`, an estimate. A job killed mid-`apply` can leave a
  machine no state knows about. After your first concurrent jobs, read `systemctl show devbox
  -p MemoryPeak` and adjust `MemoryMax` or the job caps.

## 8. The reverse proxy

The proxy must send `deploy.json`'s `routes` to `127.0.0.1:3021` and serve every other path
from `/srv/devbox/public`. It must also pass `Origin` unchanged, upgrade WebSockets (the
terminal, `/api/machines/<name>/terminal`), allow at least 200 seconds per response (a probe
takes up to 180), and terminate TLS. Caddy does all of this by default:

```caddyfile
devbox.example.com {
	# deploy.json's "routes", exactly
	@app path /api/* /job/* /jobs /machine/* /new /new/* /orphans /profiles /profiles/* /secrets /login /account /
	handle @app {
		reverse_proxy 127.0.0.1:3021
	}

	# everything else is a file of the web bundle, with the headers Bun sets itself
	handle {
		root * /srv/devbox/public
		header {
			X-Content-Type-Options nosniff
			Referrer-Policy strict-origin-when-cross-origin
			X-Robots-Tag "noindex, nofollow, noarchive"
		}
		file_server
	}
}
```

`/api/*` covers the API, the terminal and sign-in (`/api/auth/<provider>` and its `/callback`).
The other paths are the web app's routes, answered by Bun with `shell/index.html`. A route
missing here answers 404 when the page is reloaded. A new route goes in `server.ts`,
`deploy.json` and this list together. With nginx, raise `proxy_read_timeout` (60 s by default).

## 9. First start and check

```bash
sudo systemctl reload caddy
sudo systemctl daemon-reload && sudo systemctl enable --now devbox
journalctl -u devbox -n 30 --no-pager
```

A healthy first start includes:

```
vault open
launch secrets under /dev/shm/devbox-<uid>-<hash> (/dev/shm), in memory
sign-in: google, github
no account yet: the first sign-in whose verified address is DEVBOX_FOUNDER_EMAIL founds account 1, ...
no extension: every account orders on its own cloud accounts
devbox on http://127.0.0.1:3021, public at https://devbox.example.com
```

Any line starting with `/!\` needs attention. A vault said closed, with its reason, means the
master key is missing or wrong. `ON DISK` means job secrets land on a disk: point
`DEVBOX_RUNTIME_DIR` at a tmpfs. An installed extension says `extension <name> loaded`.

```bash
curl -sS https://devbox.example.com/api/session | jq '{doors, engine, disabled}'
# before the founding: doors.claim true, your providers, engine.ready true, disabled null
```

1. Open `https://devbox.example.com` and sign in with the founder address. The journal says
   `account 1 founded with <provider> as DEVBOX_FOUNDER_EMAIL`.
2. Remove `DEVBOX_FOUNDER_EMAIL` from the environment file (it leaves at the next restart).
3. On Keys & tokens (`/secrets`), set the credentials of a cloud. The page tests them first.
   For GCP it takes a service account key and a project ID; which roles that account needs is
   not documented yet.
4. On Account (`/account`), create a CLI token. It is shown once.

```bash
export DEVBOX_REMOTE_TOKEN=<the token>
curl -sS -H "Authorization: Bearer $DEVBOX_REMOTE_TOKEN" https://devbox.example.com/api/version | jq
# { "core": "<sha256 of engine/devbox>", "built_at": "...", "ready": true }
shasum -a 256 devbox-core            # at the repository root: the same digest
```

## 10. Point the CLI at it

```bash
printf 'DEVBOX_REMOTE=%s\n' https://devbox.example.com >> ~/.config/devbox/.env
devbox ls
devbox sync
```

The token comes from `DEVBOX_REMOTE_TOKEN`, else `~/.config/devbox/secrets/remote`. With
neither, the first remote command asks for it and saves it there (`0600`). The CLI then acts as
that account. `up`, `seed` and `down` run on the server while the CLI follows the log. If the
dashboard does not answer, nothing falls back to local state; `DEVBOX_REMOTE= devbox ls` reads
it on purpose.

**Version handshake.** The server runs its own copy of `devbox-core`. Before each remote
command, the CLI compares its own digest with the `core` of `/api/version`:

- **silence**: they match;
- **a warning** with both short digests and `redeploy the dashboard (cd dashboard && bun run
  verify first)`: redeploy (section 11), or update your clone if the server is newer;
- **`cannot tell what ...`**: the check could not run (a missing tool, no token yet, no answer
  within 4 seconds). It is not a match.

## 11. Upgrading and backups

1. On the workstation: `git pull`, then `cd dashboard && bun run verify`.
2. Copy, as in section 2.
3. Check that no job runs: `pgrep -af 'engine/devbox (up|seed|down)' || echo "no job running"`.
   A restart kills every job, and an `apply` cut in half can leave a machine that no state
   knows about (the Orphans page finds it).
4. `sudo systemctl restart devbox`, then read the journal.

A restart is needed for a new copy and for any change to the environment file or the unit. It
is not needed for Keys & tokens or profiles. A running machine gets new secret values, and a
new engine's provisioning scripts, at its next `devbox seed`.

**Your own profiles.** A `<name>.sh` in `DATA_DIR/accounts/<id>/config/profiles/`, readable by
`devbox`, is listed for that account only and never enters this repository. Profiles composed
on `/profiles` are written there too, and the dashboard never overwrites a file it did not write.

**Backups.** Nothing here backs up `DATA_DIR`, and it holds what cannot be rebuilt:
`devbox.db` (accounts, jobs, sealed secrets), each account's Terraform states under
`accounts/<id>/tf/` (without one, `down` cannot destroy the machine and it keeps billing), and
each account's SSH key under `accounts/<id>/home/.ssh/`. Keep the master key out of that
backup: together they are every secret in clear, and so is a disk image of the server.

**From a deployment older than accounts.** If `DATA_DIR` has a `tf/` at its top and no
`accounts/1/`, the first start moves it into `accounts/1/`. Set `DEVBOX_KEY` to the old SSH
key, readable by `devbox` and outside `/home`: if a state holds machines and the key cannot be
read, the service refuses to start. Set `DEVBOX_FOUNDER_EMAIL` too. Profiles deposited by hand
now go in `accounts/1/config/profiles/`.

## 12. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Saves fail with 403 `origin refused` | `PUBLIC_URL` must be exactly the origin in the address bar, and the proxy must pass `Origin` unchanged |
| The provider rejects the redirect URI | Register exactly `PUBLIC_URL/api/auth/google/callback` or `.../github/callback` |
| The login page says no session can open | The journal says why: a provider lacks its ID or secret, or there is no account and no `DEVBOX_FOUNDER_EMAIL` |
| The founder's sign-in is refused | The verified address must equal `DEVBOX_FOUNDER_EMAIL`. Google vouches only for Gmail and Workspace: use GitHub |
| A page answers 404 after a reload | Its path is missing from the proxy's routes (section 8) |
| Probes or orders fail with 502 after a minute | The proxy's upstream timeout is under 200 seconds |
| The journal says the vault is closed | Fix `DEVBOX_MASTER_KEY` and restart. If a rotation stopped on a named value, set the old key alone, restart, fix that value on Keys & tokens, rotate again |
| `/!\ engine/ is missing or incomplete` | Run `bun run build` on the workstation and copy again |
