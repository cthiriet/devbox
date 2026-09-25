# Security policy

## Reporting a vulnerability

Report it privately, through GitHub: the repository's **Security** tab, then **Report a
vulnerability**. That opens an advisory only the maintainer can read. There is no e-mail
address, and a public issue is the wrong place for anything that would help someone reach
another person's machines or cloud account.

A useful report says what you did, what happened, and what it gives an attacker: which of
the assets below it reaches, and from where — the internet, a browser tab, a machine, or
the host running the dashboard.

Only the tip of `main` is supported. There are no releases, so that is where a fix lands.

## Threat model

The [Security section of the README](README.md#security) is the short version. This one is
detailed enough to tell a bug from a trade.

**The machines.**

- **The operator key**, `~/.ssh/devbox`, has no passphrase, on purpose, so a phone can join a
  machine. It opens every machine, and the `dev` user there has passwordless sudo.
- **Port 22 is open to the internet.** Each Terraform root's `ssh_source_cidrs` defaults to
  anywhere and devbox never narrows it: a mobile address cannot be pinned. Password and root
  logins are off. The application's port is reached only through an SSH tunnel.
- **Profile secrets** (a GitHub token, a model provider's key) are cached on the workstation in
  `~/.config/devbox/secrets/`, mode `600`. At seed time they travel over SSH into
  `/run/secrets`: tmpfs, `0400`, gone at reboot. Never in user-data, which the metadata service
  serves to any process on the VM. A secret pushed to a machine is readable by whatever runs there.
- **Cloud credentials** order and destroy machines, so they spend money. Give devbox a
  dedicated project per provider.

**The dashboard**, if you run one, holds all of this for every account: key pairs, Terraform
state, cloud credentials, profile secrets. Its host is worth every machine of every account.

- **The vault.** Secrets are sealed in its SQLite database with AES-256-GCM, under a data key per
  account, itself sealed under the master key. Each ciphertext is bound to its owner, kind and
  name, so a value copied to another row does not open. Fingerprints are HMACs under a key
  derived from the data key, so they cannot test guesses offline. No route returns a value.
- **The master key**, `DEVBOX_MASTER_KEY`, comes from an environment file only root reads, never
  from the database. Read once at startup, it is removed from the process environment and
  withheld from every child; on Linux the service also makes itself undumpable, closing its
  `/proc/<pid>/environ` to its children (macOS has no equivalent). Lost, the sealed secrets are
  gone. A rotation draws new data keys, so a retired key opens only older database copies.
- **What each piece gives.** A copy of `devbox.db`: addresses, identities, secret names, dates
  and token digests, never a value. The master key alone: nothing. The host, or an image of its
  disk: everything, including the fallback (the service's environment and `DEVBOX_SECRETS_DIR`).
- **Launches.** A job gets its secrets in a `0700` directory of its own (tmpfs when available),
  removed when it ends, and never on a command line: devbox-core hands curl its credential
  headers on stdin and openssl the GCP private key through a pipe.
- **A GCP key is input.** Tokens are asked of `https://oauth2.googleapis.com/token` alone; a key
  naming another `token_uri`, or a `universe_domain` other than `googleapis.com`, is refused.
- **Accounts are isolated by a directory each** (home, key, Terraform state, profiles, logs);
  devbox-core only sees the asking account's, and every database read names it. All jobs run as
  one system user: the boundary holds against what the dashboard asks, not against code already
  on the host. Each account orders on its own cloud credentials; the service's fallback answers
  for the first account, and a private extension may add others for clouds, never for profiles.
- **Exposure.** The service binds to `127.0.0.1` and leaves TLS to a proxy. The secrets page
  uses a CSS-masked text field, not a password field a browser would offer to save; a screen
  reader may still read it aloud.

**Who gets in.**

- **Sign-in** is Google or GitHub only: OAuth with state and PKCE in an `HttpOnly`,
  `SameSite=Lax`, ten-minute cookie, and a token exchange at fixed addresses. A known identity
  (Google's `sub`, GitHub's numeric id) opens its account. A new one links to the account holding
  one of its verified addresses, but only an address its provider is the authority for: GitHub
  for every verified address, Google only for `@gmail.com` and Workspace accounts (the `hd`
  claim). Any other Google address never links and never founds; it may only create a new
  account, at most `DEVBOX_MAX_NEW_ACCOUNTS_PER_HOUR` (30) an hour. Account 1 is founded only by
  a vouched `DEVBOX_FOUNDER_EMAIL`, and only while no account has ever existed.
- **Sessions** are `__Host-session` cookies over HTTPS (`HttpOnly`, `Secure`, `SameSite=Strict`,
  seven days); the database keeps only their SHA-256.
- **Writes** need a session, an `Origin` equal to `PUBLIC_URL` and the session's anti-CSRF
  token. Destroying also needs the machine's name retyped, checked again by the server. Another
  account's machine answers 404, as an unknown name does.
- **CLI tokens** belong to one account, are shown once and stored as a SHA-256. They skip the
  Origin and CSRF checks, read what their account reads, and order, seed, destroy and label. They
  never write a secret or a profile, never touch tokens or sessions, never open a terminal: a
  token that could replace a cloud credential could collect every secret a seed pushes.
- **The web terminal** is a root-capable shell behind the same three conditions as a write
  (the token in `Sec-WebSocket-Protocol`). The host key must match the one recorded at creation,
  never a fresh keyscan; none recorded is a refusal. OSC 52 lets the machine write the reader's
  clipboard (up to 64 KiB) but never read it. Two terminals per account, four in all.
- **The destroy dialog** runs one constant, read-only `git status` over SSH, with the same
  host-key check; a failure is an answer, never a refusal to destroy.
- **A shared profile link** (`/profiles/new#import=…`) carries a spec, never a value, and saves
  nothing. Saving and ordering one you have not read runs its setup script with your tokens.
- **`GET /api/session`** answers anyone; anonymously, only which providers sign in, whether
  account 1 is still to be founded, and the deployed engine's digest.

## In scope

Anything in this repository that breaks the model above, for example:

- reaching the dashboard's writes, terminal or API without an account's session or token, or a
  way around the Origin, anti-CSRF or host-key checks;
- a session without an identity or vouched address of that account; a callback without its
  browser's state; a link on an unverified address or a non-Gmail, non-Workspace Google one; a
  sign-in returning to another origin; founding account 1 any other way than described;
- one account reaching anything of another's: a secret (value, fingerprint or name), a profile,
  a job or its log, a label, a machine (or learning that one exists), a token or a session;
- a secret, the master key or a sign-in client secret reaching user-data, a log, a command line,
  a JSON answer, a child's environment, a file with a looser mode than documented, or (on
  Linux) another process of the service's account through `/proc`;
- a sealed value that opens under another owner, kind or name, or without the master key;
- a request field, profile header or provider answer that becomes a shell command, a path
  outside its directory, or an unintended Terraform argument;
- ordering or destroying a machine without the rights above, or leaving one billing that
  `devbox orphans` would not show.

## Out of scope

- The trades above, as described: the key without a passphrase, port 22 open, passwordless sudo,
  secrets readable on the machine they were pushed to. Making any of them worse is in scope.
- Trust in the providers where they are the authority: a recycled Gmail address, a lapsed and
  re-registered Workspace domain, or a compromised Google or GitHub account opens the account
  created under it.
- Open sign-up, bounded by the hourly cap, which many provider accounts can fill.
- An attacker who already holds the operator key, a cloud token, your workstation, the
  dashboard's host or an image of its disk.
- Your own profiles, what they install and the setup scripts they run. A setup path escaping
  its checkout is in scope.
- Your deployment: proxy, TLS, host, environment file. [docs/deploy.md](docs/deploy.md) is an
  example, not a hardened product.
- Vulnerabilities in a cloud provider, Terraform, OpenSSH, Bun or a dependency, unless devbox
  uses it unsafely.
- Denial of service within the caps (`DEVBOX_MAX_JOBS_PER_ACCOUNT`, `DEVBOX_MAX_JOBS`, the
  terminal limits), including a few accounts filling the service-wide ones. Past a cap: in scope.
