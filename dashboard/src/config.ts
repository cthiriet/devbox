import { join } from "node:path";

/** Local port. 3021 and not 3020, which another site on the same machine holds. */
export const PORT = Number(process.env.PORT ?? 3021);

/**
 * The only writable location, declared as ReadWritePaths in the unit. Frozen at first
 * import: tests/prepare.ts diverts it before anything else loads.
 */
export const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");

/** Served by Caddy without going through Bun, hence the variable. */
export const PUBLIC_DIR = process.env.PUBLIC_DIR ?? join(import.meta.dir, "..", "public");

/**
 * The SPA's shell, `index.html`, as this process reads it - and deliberately NOT out of
 * PUBLIC_DIR.
 *
 * public/ is the manifest's `publicDir`: the platform deploys it on its own and Caddy
 * serves it without Bun ever seeing it, so the application rsync EXCLUDES it. A fallback
 * that opened public/index.html would work on the Mac, where both directories sit side by
 * side, and answer an empty page on the server after a perfectly successful deployment -
 * the same class of gap as the engine copy this file already carries.
 *
 * So the build deposits a second copy here, beside engine/, where the rsync does travel.
 * Both are build artefacts, neither is committed.
 */
export const SHELL_DIR = process.env.SHELL_DIR ?? join(import.meta.dir, "..", "shell");

/**
 * The exact public address. The Origin check compares against it verbatim, so behind
 * Caddy it cannot be rebuilt from req.url, which reads http://127.0.0.1:3021/.
 */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(
  /\/+$/,
  "",
);

/** True over HTTPS, which is what the __Host- cookie prefix requires. */
export const ONLINE = PUBLIC_URL.startsWith("https://");

/**
 * The CLI's token from before accounts. Adopted once, at the founding, as account 1's first token
 * - the CLI goes on working without anyone touching it - and read by nothing after: tokens
 * live in the database, each an account's, and removing this variable revokes nothing.
 */
export const API_TOKEN = process.env.DEVBOX_REMOTE_TOKEN ?? "";

/**
 * The address that founds account 1, on a service that has never had an account: the first
 * Google or GitHub sign-in with a verified address folding to it. Read until account 1 exists and
 * by nothing after. See admission() in src/accounts.ts for why a name and not "first to sign in".
 *
 * Not deleted from process.env, unlike the provider secrets: it is not a secret, and a hot reload
 * has to read it again. Withheld from every child all the same, by engineEnv.
 */
export const FOUNDER_EMAIL = (process.env.DEVBOX_FOUNDER_EMAIL ?? "").trim();

/**
 * The two variables of the password era, read by nothing since 15/09 and only asked whether they
 * are still set, so that every start can say they can go. Their values are never taken: a stale
 * PASSWORD_HASH is an offline guess at a password someone may reuse elsewhere, and it has no
 * business in this process's memory either.
 */
export const RETIRED = {
  PASSWORD_HASH: (process.env.PASSWORD_HASH ?? "") !== "",
  DEVBOX_INVITE_CODE: (process.env.DEVBOX_INVITE_CODE ?? "") !== "",
} as const;

/**
 * Seven days, like another site on the same machine: a tool used most days should not ask
 * every morning.
 */
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

/* --- the engine ------------------------------------------------------------ */

/**
 * Where `build` deposited devbox, its prelude, the profiles and the Terraform sources.
 * Read-only in production: the deployment rsyncs it with --delete and the unit mounts it
 * read-only, which is exactly why nothing devbox writes may live here.
 */
export const ENGINE_DIR = process.env.ENGINE_DIR ?? join(import.meta.dir, "..", "engine");

export const DEVBOX = join(ENGINE_DIR, "devbox");

/**
 * THIS FILE NAMES NO PATH THAT BELONGS TO AN ACCOUNT, and that is the whole of it.
 *
 * Everything devbox writes for one account - HOME, the Terraform root, the configuration
 * directory, the logs, the ssh key - used to be a constant here, and a route that forgot
 * whose request it was serving still compiled and still answered. Since 12/09 those five live
 * in src/tree.ts behind accountTree(id), which is the only constructor of an AccountPaths:
 * a reader that wants one has to say which account it is for, and `tsc` asks the question
 * at every call site rather than a test hoping to catch the one that forgot.
 *
 * What is left here is what is genuinely the service's, shared by every account:
 *
 *   accounts/            one tree per account, 0700 - see src/tree.ts
 *   roots/<digest>/      the Terraform sources, prepared once from the engine and copied
 *                        into each tree: constant cost whatever the number of accounts
 *   shared/tf-plugins/   TF_PLUGIN_CACHE_DIR, and not a detail. Measured here on 12/09:
 *                        data/tf weighs 65 MB with a SINGLE cloud initialised, and
 *                        devbox-core runs `terraform init` on every `up`. Without a shared
 *                        cache every account re-downloads every provider, into its own tree.
 *   shared/cache/        the GCP price catalogue devbox-core builds: public prices, the same
 *                        answer for everyone, and 5,7 MB nobody should fetch twice.
 */
export const ACCOUNTS_DIR = join(DATA_DIR, "accounts");
export const ROOTS_DIR = join(DATA_DIR, "roots");
export const TF_PLUGIN_CACHE_DIR = join(DATA_DIR, "shared", "tf-plugins");
export const DEVBOX_CACHE_DIR = join(DATA_DIR, "shared", "cache");

/**
 * One file per secret, named exactly as the profile names it - where secrets lived before
 * the vault, and where the fallback still looks.
 *
 * THE SERVICE'S, NOT AN ACCOUNT'S, which is why it survived the move above. It answers only
 * for an account that holds the fallback - sourcesFor() hands the others `secretsDir: null` -
 * and the files in it are the ones a deployment deposited for the service itself.
 *
 * In production the unit points this at a root-owned directory where the hosting platform's
 * vault deposits each secret as its own file in 0400: the material never becomes an
 * environment variable, so it stays out of `ps`, out of a crash dump and out of anything
 * this service passes to a child. In development the default is a directory of the shared
 * half of the data directory, so a workstation needs no root-owned path to run the dashboard.
 * It used to default under DATA_DIR/config, which is now account 1's configuration directory
 * and moves with it at the migration: a service-wide fallback cannot live inside one account.
 *
 * Since 11/09 devbox-core no longer reads it directly. A child is handed a directory of its
 * own, laid out for that one launch from the vault and from here - see prepareLaunch in
 * src/engine.ts - so a file in this directory reaches a job only when the database holds no
 * value under its name, and only when the job's profile declares it.
 */
export const SECRETS_DIR = process.env.DEVBOX_SECRETS_DIR ?? join(DATA_DIR, "shared", "secrets");

/**
 * The GCP service account key as a file, under the name the platform's vault deposits it -
 * the fallback for the `gcp` cloud credential, which the database holds first when it holds
 * one at all. See CLOUD_FIELDS in src/vault.ts.
 *
 * A path and not a value: nothing here ever opens it. devbox-core does, to mint an hour's
 * access token out of a signed JWT, and terraform does through
 * GOOGLE_APPLICATION_CREDENTIALS, which devbox-core exports once the key has actually
 * produced a token. The dashboard copies it, at most, into the directory a launch is handed.
 *
 * `gcp` and not `gcp.json`: the name is what the deployment deposits, what it declares as
 * that secret's destination, and what devbox-core opens under DEVBOX_SECRETS_DIR — one
 * name, spelled in three places, two of them outside this repository, so a rotation moves
 * all three at once.
 */
export const GCP_KEY = join(SECRETS_DIR, "gcp");

/* --- how many jobs at once ------------------------------------------------ */

/**
 * A cap read from the unit, or the default and the reason the value was passed over.
 *
 * A malformed value does not stop the service, for the reason nothing else here does: a unit
 * that dies at startup loops on Restart=always without saying why. It falls back to the
 * default, and server.ts says so in the journal.
 */
export function capFrom(
  name: string,
  raw: string | undefined,
  fallback: number,
): { value: number; refused: string | null } {
  if (raw === undefined || raw.trim() === "") return { value: fallback, refused: null };
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    return {
      value: fallback,
      refused: `${name}=${JSON.stringify(raw)} is not a whole number of at least 1: ${fallback} is used instead`,
    };
  }
  return { value, refused: null };
}

/**
 * How many jobs run at once: `up`, `seed` and `down`, for the whole service and per account.
 *
 * THESE ARE A MEMORY BOUND, NOT A CORRECTNESS RULE. devbox-core runs concurrent `up` safely: a
 * TF_WORKSPACE per invocation, a state lock per workspace, with_lock around ~/.ssh/config, and
 * a lock of its own around `terraform init`, whose shared plugin cache is not safe under two
 * inits. The one real conflict is two jobs on ONE machine, which src/jobs.ts refuses on its own.
 * What is left to bound is what they cost together, inside the unit's one MemoryMax.
 *
 * AND THE DEFAULTS ARE A GUESS, said as one. What a `terraform apply` holds resident - the
 * provider plugin above all, the google one the heaviest - has never been measured on the
 * server; one probe has (147 to 158 MB, see src/engine.ts). The asymmetry decided the numbers:
 * a ceiling too high costs nothing while the service idles, and a ceiling too low is the OOM
 * killer inside the cgroup in the middle of an apply - a job cut in half, marked `interrupted`
 * at the next start, and a machine ordered at the provider that no state knows and only
 * `devbox orphans` can still find. So deploy.json raised `memory` from 512M to 1G with these,
 * and a manifest is JSON and cannot say why, which is why it is said here.
 *
 * The measurement to take: systemd prints MemoryPeak when the unit stops, and
 * `systemctl show -p MemoryPeak` reads it live. Read it after the first real concurrent `up`s
 * - two, then three - and set these defaults, and the manifest's memory, from what it says.
 */
const jobs = capFrom("DEVBOX_MAX_JOBS", process.env.DEVBOX_MAX_JOBS, 4);
const perAccount = capFrom("DEVBOX_MAX_JOBS_PER_ACCOUNT", process.env.DEVBOX_MAX_JOBS_PER_ACCOUNT, 3);

export const MAX_JOBS = jobs.value;
export const MAX_JOBS_PER_ACCOUNT = perAccount.value;

/**
 * How many accounts a sign-in may create in an hour, founder aside.
 *
 * Signing up has been open to any Google or GitHub identity since 15/09, and most of what an
 * account can spend is already bounded elsewhere: jobs by the caps above and by credentials that
 * work, terminals by a live machine, probes by one queue. What is not is the creation itself - a
 * tree on the disk at first use, a row, a data key at the first secret. Thirty an hour is far
 * above what this service has ever seen, and low enough that a script minting identities fills
 * the hour and not the disk. It refuses creations only: a known identity, and one that links to
 * an account, always sign in.
 */
const newAccounts = capFrom("DEVBOX_MAX_NEW_ACCOUNTS_PER_HOUR", process.env.DEVBOX_MAX_NEW_ACCOUNTS_PER_HOUR, 30);

export const MAX_NEW_ACCOUNTS_PER_HOUR = newAccounts.value;

/** The caps' values passed over, said at startup. */
export const CAP_REFUSALS: readonly string[] = [jobs.refused, perAccount.refused, newAccounts.refused].filter(
  (one): one is string => one !== null,
);

/**
 * Every cloud this dashboard knows how to order from, whether or not it can today.
 *
 * Which of them it can order from RIGHT NOW is `clouds()`, and it lives in src/secrets.ts
 * since 11/09: the answer became a question about the vault as much as about this disk, and
 * the vault's database is opened by a module that imports this one - asked from here, the
 * two would import each other.
 */
export const CLOUDS = ["hetzner", "scaleway", "gcp"] as const;
export type Cloud = (typeof CLOUDS)[number];
