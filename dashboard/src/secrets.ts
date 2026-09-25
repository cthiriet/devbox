/**
 * Every secret this service holds: where each one is read from, whether a job can have it,
 * and how one is written.
 *
 * Since 11/09 a value can come from three places, and this file is the only one that decides
 * between them - so that clouds(), missing(), missingSecrets(), the page and the directory a
 * job is handed cannot disagree about which one wins.
 *
 *   db    the vault, src/vault.ts: sealed in the database, and written by the page.
 *   env   the service's environment as it stood at startup: the cloud variables, which is
 *         where HCLOUD_TOKEN, the Scaleway keys and DEVBOX_GCP_PROJECT lived before.
 *   file  SECRETS_DIR, where the platform's vault deposited one file per secret: the GCP key
 *         and every profile secret.
 *
 * SINCE 13/09 THE CLOUD ACCOUNTS ARE THE SERVICE'S. The founding account sets them, on its
 * settings page, and every account orders with them - unless that account connected a cloud
 * account of its own, which then answers for that cloud WHOLE: a Scaleway access key of one
 * account beside the secret key of another would be a pair that opens nothing. Only cloud
 * credentials are shared this way. A profile secret - a GitHub token, a Claude token - is
 * never read out of another account's vault, nor out of the service's files, for anyone but
 * the founder they were deposited for. See Sources.service.
 *
 * The database wins, name for name, and the other two answer only for what it does not hold.
 * That is what lets a deployment move one secret at a time and keep working untouched until
 * it does - and what makes a value set through the page the value used, where a file left on
 * the disk is at best a copy and at worst the token from before a rotation.
 *
 * The database is a source only while it can be READ. Without a master key, or with a wrong
 * one, no sealed row opens, and the answer is what the next job will actually get: the
 * fallback, or nothing. Calling "held" a row that no job can open would be the one lie this
 * file exists to prevent - and the page says why, in the vault's own status.
 *
 * Presence costs no decryption: listSecrets answers names without a key, and a file is a
 * stat. The bytes are read in one place, heldValue, for the one consumer that needs them: the
 * engine, laying them out for devbox-core. Nothing here answers a request with a value.
 *
 * The check that started this file still stands. devbox asks for a missing secret at the
 * keyboard, and a systemd service has no keyboard: with stdin closed the read returns nothing
 * and the seed dies on "empty, nothing sent", three minutes into a job, after a machine has
 * already been ordered and is already billing. Checking here means the refusal costs nothing
 * and names what is missing.
 */
import type { Database } from "bun:sqlite";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FOUNDING_ACCOUNT, type Account } from "./accounts";
import { installedExtension, ordersOnService } from "./extension";
import { CLOUDS, SECRETS_DIR, type Cloud } from "./config";
import { checkpoint } from "./database";
import { database, machineOrigin } from "./db";
import type { Checked } from "./validate";
import {
  CLOUD_FIELDS,
  checkedSecretName,
  deleteSecret,
  importLegacy,
  keyringFromEnv,
  listSecrets,
  MASTER_KEY_VARIABLES,
  normalizedValue,
  readSecret,
  rewrap,
  SecretRefused,
  setSecret,
  setSecrets,
  VaultError,
  type CloudField,
  type ImportResult,
  type Keyring,
  type SecretKind,
  type SecretMeta,
  type VaultStatus,
} from "./vault";

type Env = Readonly<Record<string, string | undefined>>;

/** Every cloud field, in the catalogue's order. */
export const CLOUD_FIELD_LIST: readonly CloudField[] = Object.values(CLOUD_FIELDS).flat();
const FIELD_BY_NAME = new Map(CLOUD_FIELD_LIST.map((field) => [field.name, field]));

/**
 * The catalogue's variables: read from the service's environment as the fallback, and taken
 * OUT of every child's environment by engineEnv, which puts back only what the resolution
 * chose. Inherited as they were, a stale HCLOUD_TOKEN would ride along beside the vault's.
 */
export const CLOUD_VARIABLES: readonly string[] = CLOUD_FIELD_LIST.filter(
  (field) => field.legacy === "env",
).map((field) => field.name);

export type Source = "db" | "env" | "file" | "service";

/** The brand only sourcesOf puts on a Sources. Not exported, so nothing else can put it on. */
const SCOPED: unique symbol = Symbol("devbox.sources");

/**
 * Everything the resolution reads, as one parameter, for the same reason every path under
 * src/ is one: a test states it instead of arranging the real disk, database and unit.
 *
 * And WHOSE it is. Until accounts, a function asked for no Sources and was handed the vault of
 * the one owner there was, by a default parameter. That default is exactly what would have
 * gone on working in silence for a second account - account 2 ordering a machine with account
 * 1's token, and account 1's profile secrets pushed into it. So no default is left anywhere,
 * and a Sources has two constructors and no third: sourcesFor(account), which every route
 * calls, and sourcesOf(parts), which states one outright for a test or for the startup.
 */
export type Sources = {
  readonly [SCOPED]: true;
  db: Database;
  owner: number;
  /** Null when the master key is absent or wrong: the database is then not a source at all. */
  keyring: Keyring | null;
  /**
   * The account whose vault holds the SERVICE's cloud credentials: the founding account's.
   * For any other owner, a cloud it has set none of its own credentials for resolves from that
   * vault, then from `env` and the `gcp` file of `secretsDir` - and never with a fingerprint or
   * a date, which are another account's. Null, or `owner` itself, and there is no second tier:
   * the account's own vault, then the environment and the files, field by field.
   */
  service: number | null;
  /**
   * The clouds that second tier answers for, when a destroy narrows it - or null, the rule of every
   * other read: each cloud this account set none of its own credentials for.
   *
   * A set names the ONLY clouds the service answers for, and it answers for them WHOLE, whatever
   * this account connected since; every other cloud resolves from this account's vault alone, never
   * from the service's vault, environment or files. It is what destroySourcesFor builds for a
   * machine ordered on the service's cloud accounts: that machine's cloud, and no other.
   */
  serviceClouds: ReadonlySet<Cloud> | null;
  /** The cloud variables of the service's environment, as they stood at startup - or none. */
  env: Env;
  /**
   * Where the files were deposited before the vault - or null. Its `gcp` key is a cloud
   * credential of the service and answers like `env`; the profile secrets beside it answer only
   * when `profileFiles` says so.
   */
  secretsDir: string | null;
  /**
   * Whether the files of `secretsDir` answer for PROFILE secrets: the founder's alone. The
   * service's cloud accounts are everyone's; a GitHub token deposited there for the founder is
   * not, and never was.
   */
  profileFiles: boolean;
};

type SourceParts = Omit<Sources, typeof SCOPED | "service" | "serviceClouds" | "profileFiles"> &
  Partial<Pick<Sources, "service" | "serviceClouds" | "profileFiles">>;

/**
 * `service` left out is no second tier, and `profileFiles` left out is the files answering:
 * the shape of the one owner there was before accounts, which is what a test naming neither
 * means. sourcesFor states both, for every account. `serviceClouds` left out is the rule of
 * every read but a destroy's.
 */
export function sourcesOf(parts: SourceParts): Sources {
  return {
    [SCOPED]: true,
    ...parts,
    service: parts.service ?? null,
    serviceClouds: parts.serviceClouds ?? null,
    profileFiles: parts.profileFiles ?? true,
  };
}

/* --- the vault, opened once ------------------------------------------------------ */

/** Only the catalogue's variables, and only the non-empty ones, like missing() always read them. */
function legacyEnvOf(env: Env): Env {
  const kept: Record<string, string> = {};
  for (const name of CLOUD_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== "") kept[name] = value;
  }
  return Object.freeze(kept);
}

type Opened = { db: Database; keyring: Keyring | null; status: VaultStatus; env: Env };

/**
 * Closed until openVault runs, which server.ts does before it serves anything. Closed is
 * the state of every deployment before the vault, so a module that asks early still gets
 * the right answer for it: the environment and the files.
 */
const NOT_OPENED: Opened = {
  db: database,
  keyring: null,
  status: { available: false, reason: "the vault has not been opened: openVault() runs at startup" },
  env: legacyEnvOf(process.env),
};

/**
 * What openVault left, kept on globalThis rather than in this module, for `bun --hot`.
 *
 * A reload evaluates every module again and keeps globalThis. Held in a module variable, the
 * state went back to "not opened" at each save of a file; and openVault could not simply run
 * again, since the key it reads was deleted from process.env at the first evaluation, which
 * is the point of reading it. So server.ts opens the vault once per process, and every later
 * evaluation of this module reads what that one left here - the keyring included, whose
 * material src/vault.ts keeps process-wide for the same reason.
 */
const OPENED_SLOT = Symbol.for("devbox.dashboard.vault.opened");
const slot = globalThis as { [OPENED_SLOT]?: Opened };
const opened = (): Opened => slot[OPENED_SLOT] ?? NOT_OPENED;

/** `imported`: the names a first opening took in from the environment and the files. */
export type Opening = { status: VaultStatus; rewrapped: number; imported: string[] };

/**
 * Reads the master key, proves it against every data key, and takes it out of the
 * environment it was read from - once, at startup.
 *
 * OUT OF THE ENVIRONMENT, and this is the half that is easy to forget. engineEnv used to hand
 * a child the service's whole environment, so DEVBOX_MASTER_KEY would have travelled into
 * devbox-core, into terraform and into every provider plugin terraform starts, and from
 * there into anything they log or dump. Deleted here, no child is HANDED it: it exists in
 * this process as a parsed key the vault holds out of reach, and engineEnv withholds the
 * names as well, in case anything ever puts them back.
 *
 * AND THAT IS NOT ENOUGH ON ITS OWN, which this comment used to claim it was. The delete
 * unlinks the variable from libc's list and nothing more: the bytes stay in the environment
 * block the kernel laid out at exec, which /proc/<pid>/environ reads back to any process of
 * the same uid - devbox-core, terraform, a provider plugin. Measured on 11/09: a child read
 * the key from /proc/$PPID/environ after this very delete. On Linux, server.ts makes the
 * process undumpable before calling this (src/undumpable.ts), which closes that file and
 * /proc/<pid>/mem to them; on a Mac nothing does, and `ps -E` shows it to the same account.
 *
 * rewrap opens every owner's data key, so a wrong key is found HERE, before a job needs a
 * secret, rather than three minutes into one. It also finishes a rotation left halfway.
 *
 * Nothing thrown gets out. A key that is malformed or wrong leaves the vault closed, with the
 * reason, and the service carries on on the fallback: dying would loop on Restart=always and
 * say nothing, which is exactly the failure missing() exists to avoid.
 */
export function openVault(
  env: Record<string, string | undefined> = process.env,
  db: Database = database,
  secretsDir: string = SECRETS_DIR,
): Opening {
  let keyring: Keyring | null = null;
  let status: VaultStatus;
  let rewrapped = 0;
  let imported: string[] = [];
  try {
    keyring = keyringFromEnv(env);
    if (keyring === null) {
      status = { available: false, reason: "DEVBOX_MASTER_KEY is not set" };
    } else {
      rewrapped = rewrap(db, keyring);
      status = { available: true };
      imported = firstImport(db, keyring, env, secretsDir);
    }
  } catch (error) {
    keyring = null;
    // A VaultError names a variable or a version and never a key. Anything else is SQLite
    // or the runtime, whose messages never held the key either: it is in a WeakMap.
    status = {
      available: false,
      reason:
        error instanceof VaultError
          ? error.message
          : `the vault could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    for (const variable of MASTER_KEY_VARIABLES) delete env[variable];
  }
  // A rotation and a first import are the writes here, and both move what every job reads.
  if (rewrapped > 0 || imported.length > 0) checkpoint(db);
  slot[OPENED_SLOT] = { db, keyring, status, env: legacyEnvOf(env) };
  return { status, rewrapped, imported };
}

/**
 * The first time a vault opens, it takes in what the service was already running on.
 *
 * Setting DEVBOX_MASTER_KEY is one decision, and it used to take a second one - the Import
 * button - before the vault held anything: until then every value still came from the
 * environment and the files, and a token rotated on the page was the only one the vault knew.
 * Nobody opens a vault in order to keep it empty. So a vault that has never held a value and
 * never recorded an event - a fresh one, not one emptied on purpose - imports once, here, with
 * the same rules as the button: nothing is overwritten, empty files are absent, and a name the
 * page has decided on is never taken back (see importLegacy).
 *
 * A vault that has ever held anything is left as it is: from then on the page decides, and
 * the button stays for a file or a variable added later.
 *
 * Under FOUNDING_ACCOUNT, the one owner this file names outright: what the service held before
 * accounts was the service's, and account 1 is the account that becomes it - founded by the
 * sign-in whose verified address is DEVBOX_FOUNDER_EMAIL (claimed with the service's password, or
 * the first to sign up, before 15/09).
 */
function firstImport(
  db: Database,
  keyring: Keyring,
  env: Record<string, string | undefined>,
  secretsDir: string,
): string[] {
  const used = db
    .query<{ n: number }, [number, number]>(
      "SELECT (SELECT COUNT(*) FROM secrets WHERE owner_id = ?) + (SELECT COUNT(*) FROM secret_events WHERE owner_id = ?) AS n",
    )
    .get(FOUNDING_ACCOUNT, FOUNDING_ACCOUNT);
  if ((used?.n ?? 0) > 0) return [];
  return importLegacy(db, keyring, FOUNDING_ACCOUNT, { env: legacyEnvOf(env), secretsDir }, Date.now()).imported;
}

export function vaultState(): VaultStatus {
  return opened().status;
}

/** How many values the database seals, readable or not: said at startup when none can be read. */
export function sealedCount(db: Database = opened().db): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM secrets").get()?.n ?? 0;
}

const NO_ENV: Env = Object.freeze({});

/**
 * What an account resolves its secrets from: its own vault first, and for the founding account
 * the service's environment and files behind it - the variables and the `gcp` key a deployment
 * put there before anyone signed in.
 *
 * A SECOND TIER EXISTS ONLY WHEN AN EXTENSION SAYS SO. The dashboard as published orders every
 * account on its own cloud accounts, and nothing it holds answers for anyone else. A hosted
 * service's extension may put an account on the SERVICE's cloud accounts (src/extension.ts,
 * ordersOnService): the founding account's vault, then the environment and the `gcp` file,
 * answer for every provider that account connected nothing of - whole, never a field of each
 * (resolveSecret). The environment and the files are handed to nobody else: an account with
 * neither role reading them would be ordering, unannounced, on the service's money.
 *
 * Profile secrets are never shared: the service's files answer them for the founder alone.
 * engineEnv still takes every cloud variable out of a child's environment and puts back only
 * what this resolution chose.
 */
export function sourcesFor(account: Account): Sources {
  const state = opened();
  const founder = account.id === FOUNDING_ACCOUNT;
  const onService = !founder && ordersOnService(account);
  return sourcesOf({
    db: state.db,
    owner: account.id,
    keyring: state.keyring,
    service: onService ? FOUNDING_ACCOUNT : null,
    env: founder || onService ? state.env : NO_ENV,
    secretsDir: founder || onService ? SECRETS_DIR : null,
    profileFiles: founder,
  });
}

/**
 * What the DESTROY of one machine resolves from: the credentials that machine was ordered with,
 * and no others.
 *
 * A machine lives in the provider account it was ordered in, and a `down` handed another
 * account's token for that cloud is refused by nobody: the provider answers 404 for a server of
 * another project, terraform may drop it from the state as already gone, and the job succeeds on
 * a machine that bills on with nothing left to reach it. Today's resolution is the wrong witness
 * both ways. An extension may have taken the account off the service's cloud accounts since the
 * order: sourcesFor() then resolves nothing, and the machine bills on beyond the reach of the only
 * service that knows it. Or the account deleted the token of its own it ordered with: sourcesFor()
 * then resolves the SERVICE's, for a server in the account's own project. Until machine_origins,
 * this function closed the first trap by handing the service's cloud accounts to every destroy of
 * every account but the founder - and a stranger's `down`, with no extension installed at all, was
 * handed the founder's HCLOUD_TOKEN.
 *
 * So the order writes down where it went (POST /api/machines), and this reads it back, for the
 * cloud the machine's STATE names - never the order's alone, a row naming another cloud being
 * another machine of that name:
 *
 *   via "service", on that cloud   the service's cloud accounts for THAT cloud, whole, whatever
 *                                  this account connected since; nothing of the service's for any
 *                                  other cloud (Sources.serviceClouds)
 *   via "own", or another cloud    this account's own vault alone: a 412 once nothing holds it
 *   no cloud known                 this account's own vault alone
 *   no row                         THE RULE FOR A MACHINE ORDERED BEFORE THE TABLE: the service's,
 *                                  for that cloud, only while an extension is installed and this
 *                                  account holds no credential of its own for that cloud; its own
 *                                  vault alone otherwise
 *
 * That last rule is a guess, and it says which way it errs. Without an extension no account ever
 * ordered on another's cloud accounts, so nothing of the service's is handed. With one, an account
 * holding a credential of its own for that cloud is handed its own. What it cannot tell apart is an
 * account that ordered on its own token and then deleted every credential of that cloud: that one
 * is handed the service's, as every destroy was before the table. It fades with the machines
 * ordered before it.
 *
 * Whole, and not behind this account's own credentials as an order resolves: a token connected
 * after the order would otherwise take the destroy of a machine ordered on the service's cloud
 * accounts to this account's own project, which is the same 404 from the other side. A destroy
 * spends nothing and pushes nothing into a machine, and profile secrets stay the founder's.
 *
 * The founder has nothing to choose: its vault, environment and files are the service's own.
 */
export function destroySourcesFor(account: Account, machine: string, cloud: Cloud | undefined): Sources {
  const everyday = sourcesFor(account);
  if (account.id === FOUNDING_ACCOUNT) return everyday;
  const own = ownCredentials(everyday);
  if (cloud === undefined) return own;

  const state = opened();
  const origin = machineOrigin(account.id, machine);
  const onService =
    origin === null
      ? installedExtension() !== null && !ownedClouds(state.db, account.id).has(cloud)
      : origin.via === "service" && origin.cloud === cloud;
  if (!onService) return own;

  return sourcesOf({
    db: state.db,
    owner: account.id,
    keyring: state.keyring,
    service: FOUNDING_ACCOUNT,
    serviceClouds: new Set([cloud]),
    env: state.env,
    secretsDir: SECRETS_DIR,
    profileFiles: false,
  });
}

/**
 * The same account with no second tier: its own vault, and for the founder its environment and
 * files. What a credential test completes a blank field from, so that an account trying a key
 * of its own is never tried with the service's beside it - and what a destroy resolves from for
 * any machine not ordered on the service's cloud accounts.
 */
export function ownCredentials(sources: Sources): Sources {
  return serviceOf(sources) === null
    ? sources
    : sourcesOf({ ...sources, service: null, serviceClouds: null, env: NO_ENV, secretsDir: null, profileFiles: false });
}

/* --- where a value comes from ------------------------------------------------------ */

type Metas = ReadonlyMap<string, SecretMeta>;
const NO_METAS: Metas = new Map();

/**
 * This account's rows, the service's CLOUD rows when another vault answers for them - both
 * empty when the vault is closed - and the clouds this account set credentials of its own for.
 * `owned` is read whatever the key: a name is listed without it, and an account whose own
 * credentials cannot open must not quietly order on the service's instead.
 */
type Held = { own: Metas; service: Metas; owned: ReadonlySet<Cloud> };
const keyOf = (kind: SecretKind, name: string) => `${kind}/${name}`;

const CLOUD_OF: ReadonlyMap<string, Cloud> = new Map(
  CLOUDS.flatMap((cloud) =>
    (CLOUD_FIELDS[cloud] as readonly CloudField[]).map((field) => [field.name, cloud] as const),
  ),
);

/** The service's vault, when it is another account's than this one: see Sources.service. */
function serviceOf(sources: Sources): number | null {
  return sources.service !== null && sources.service !== sources.owner ? sources.service : null;
}

/**
 * Whether one cloud of this account resolves through the service's tier: never without one; the
 * clouds a destroy names, whole, when it names some; and otherwise each cloud this account set no
 * credential of its own for. `owned` is asked only in that last case, being a query.
 */
function throughService(cloud: Cloud, sources: Sources, owned: () => ReadonlySet<Cloud>): boolean {
  if (serviceOf(sources) === null) return false;
  if (sources.serviceClouds !== null) return sources.serviceClouds.has(cloud);
  return !owned().has(cloud);
}

function ownedClouds(db: Database, owner: number): Set<Cloud> {
  const owned = new Set<Cloud>();
  for (const meta of listSecrets(db, owner)) {
    const cloud = meta.kind === "cloud" ? CLOUD_OF.get(meta.name) : undefined;
    if (cloud !== undefined) owned.add(cloud);
  }
  return owned;
}

/** One query per vault for a whole answer, rather than one per field. */
function heldIn(sources: Sources): Held {
  const service = serviceOf(sources);
  const mine = listSecrets(sources.db, sources.owner);
  const owned = service === null ? new Set<Cloud>() : ownedClouds(sources.db, sources.owner);
  if (sources.keyring === null) return { own: NO_METAS, service: NO_METAS, owned };
  const byKey = (metas: readonly SecretMeta[]) => new Map(metas.map((meta) => [keyOf(meta.kind, meta.name), meta]));
  return {
    own: byKey(mine),
    service: service === null ? NO_METAS : byKey(listSecrets(sources.db, service).filter((meta) => meta.kind === "cloud")),
    owned,
  };
}

/**
 * A profile secret's name becomes a file name in a launch directory and, in devbox-core, a
 * path under /run/secrets and part of a variable: one that today's rule refuses resolves to
 * nothing, whatever holds it. A row stored under an older rule stays listed - and removable,
 * DELETE checks no name - but it is never laid out.
 */
const usableName = (kind: SecretKind, name: string) =>
  kind !== "profile" || checkedSecretName("profile", name).ok;

/**
 * A legacy file as devbox-core reads one: `[ -s file ]`. Absent, not a regular file, or
 * empty all count as absent - the platform's vault writes whatever a line holds, so a line
 * left blank deposits a zero-length file, and devbox would push it into /run/secrets as a
 * valid secret: the profile then fails on an authentication, deep inside a running machine,
 * instead of here on a secret that was never supplied.
 *
 * Unreadable counts as absent too, rather than as a 500: what cannot be read cannot be handed
 * to a child either. And unreadable is asked of the file itself, with access(R_OK), not
 * inferred from a stat that answers for a file this process may not open. Found on 11/09: a
 * `gcp` deposited under the wrong owner or mode passed the stat, so GCP read as orderable,
 * and every job then died on EACCES while laying the key out - a `down` on Hetzner included,
 * which left a machine this service could no longer destroy.
 */
function legacyFilePresent(directory: string | null, name: string): boolean {
  if (directory === null) return false;
  const path = join(directory, name);
  try {
    const found = statSync(path, { throwIfNoEntry: false });
    if (found === undefined || !found.isFile() || found.size === 0) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the value was before the vault, if it is still there: what takes over when the
 * database holds nothing under the name, and what DELETE reports as taking over again.
 *
 * A profile secret under a name the vault would refuse - `gcp`, `remote`, `../x` - has no
 * fallback either. `gcp` in SECRETS_DIR is the cloud's key and `remote` the core's dashboard
 * token: a profile that declared either would otherwise push them into a machine's
 * /run/secrets, where every process on it can read them.
 */
export function fallbackOf(kind: SecretKind, name: string, sources: Sources): "env" | "file" | null {
  if (kind === "cloud") {
    const field = FIELD_BY_NAME.get(name);
    if (field === undefined) return null;
    if (field.legacy === "env") return (sources.env[field.name] ?? "") !== "" ? "env" : null;
    return legacyFilePresent(sources.secretsDir, field.name) ? "file" : null;
  }
  if (!usableName(kind, name) || !sources.profileFiles) return null;
  return legacyFilePresent(sources.secretsDir, name) ? "file" : null;
}

/**
 * What the page shows of one secret, and what every other answer here is derived from.
 * `fingerprint` and `updated_at` belong to the vault alone: a variable or a file has neither
 * a date this service recorded nor a fingerprint it could compute without reading it.
 */
export type Resolved = {
  set: boolean;
  source: Source | null;
  fingerprint: string | null;
  updated_at: number | null;
};

const ABSENT: Resolved = { set: false, source: null, fingerprint: null, updated_at: null };
const SERVICE: Resolved = { set: true, source: "service", fingerprint: null, updated_at: null };

/** A cloud field of another account's service tier, or undefined when the classic rule applies. */
function sharedCloud(kind: SecretKind, name: string, sources: Sources): Cloud | undefined {
  return kind === "cloud" && serviceOf(sources) !== null ? CLOUD_OF.get(name) : undefined;
}

function ownRow(kind: SecretKind, name: string, held: Held): Resolved {
  const meta = held.own.get(keyOf(kind, name));
  return meta === undefined
    ? ABSENT
    : { set: true, source: "db", fingerprint: meta.fingerprint, updated_at: meta.updated_at };
}

export function resolveSecret(
  kind: SecretKind,
  name: string,
  sources: Sources,
  held: Held = heldIn(sources),
): Resolved {
  if (!usableName(kind, name)) return ABSENT;
  const cloud = sharedCloud(kind, name, sources);
  if (cloud !== undefined) {
    // A cloud this account resolves on its own is its own, whole - no field of the service's
    // beside it; one it resolves through the service is the service's, said without the
    // founder's fingerprint or date.
    if (!throughService(cloud, sources, () => held.owned)) return ownRow(kind, name, held);
    return held.service.has(keyOf(kind, name)) || fallbackOf(kind, name, sources) !== null ? SERVICE : ABSENT;
  }
  const own = ownRow(kind, name, held);
  if (own.set) return own;
  const fallback = fallbackOf(kind, name, sources);
  return fallback === null ? ABSENT : { set: true, source: fallback, fingerprint: null, updated_at: null };
}

/**
 * The bytes of a secret, from the source resolveSecret names. For the engine alone, which
 * lays them out for one launch: see prepareLaunch in src/engine.ts. Null when nothing holds it.
 *
 * A sealed row that does not open THROWS, and that is readSecret's own rule kept on purpose:
 * a null there would read as "not in the database", and the fallback would quietly hand the
 * job the stale file in its place.
 */
export function heldValue(kind: SecretKind, name: string, sources: Sources): Uint8Array | null {
  if (!usableName(kind, name)) return null;
  const cloud = sharedCloud(kind, name, sources);
  const service = serviceOf(sources);
  if (cloud !== undefined && service !== null) {
    if (!throughService(cloud, sources, () => ownedClouds(sources.db, sources.owner))) {
      return sources.keyring === null ? null : readSecret(sources.db, sources.keyring, sources.owner, kind, name);
    }
    if (sources.keyring !== null) {
      const sealed = readSecret(sources.db, sources.keyring, service, kind, name);
      if (sealed !== null) return sealed;
    }
    return fromFallback(kind, name, sources);
  }
  if (sources.keyring !== null) {
    const sealed = readSecret(sources.db, sources.keyring, sources.owner, kind, name);
    if (sealed !== null) return sealed;
  }
  return fromFallback(kind, name, sources);
}

function fromFallback(kind: SecretKind, name: string, sources: Sources): Uint8Array | null {
  switch (fallbackOf(kind, name, sources)) {
    case "env":
      return new TextEncoder().encode(sources.env[name] ?? "");
    case "file":
      return sources.secretsDir === null ? null : new Uint8Array(readFileSync(join(sources.secretsDir, name)));
    default:
      return null;
  }
}

/* --- what the rest of the service asks ---------------------------------------------- */

function gapsOf(cloud: Cloud, sources: Sources, held: Held): string[] {
  const fields: readonly CloudField[] = CLOUD_FIELDS[cloud];
  return fields
    .filter((field) => field.required && !resolveSecret("cloud", field.name, sources, held).set)
    .map((field) => field.name);
}

function cloudUsable(cloud: Cloud, sources: Sources, held: Held): boolean {
  return gapsOf(cloud, sources, held).length === 0;
}

/**
 * The required credentials of one cloud that nothing holds: empty when it is usable. Named,
 * for the one refusal that has to say what to set: a destroy - see server.ts.
 */
export function cloudGaps(cloud: Cloud, sources: Sources): string[] {
  return gapsOf(cloud, sources, heldIn(sources));
}

/**
 * The clouds this service can order from RIGHT NOW: those whose every required credential
 * resolves, in the vault or in the fallback.
 *
 * Asked rather than assumed, and asked on every call. A probe of a cloud with no credential
 * costs ten seconds of failing authentication - measured on 27/08: hetzner alone 0,62 s,
 * scaleway alone 0,83 s, the unfiltered probe 10,7 s - in front of an operator watching a
 * spinner, for a cloud they cannot choose anyway. And a list frozen at startup would go on
 * refusing a cloud whose token was set through the page a minute ago.
 *
 * GCP was the first cloud to be decided this way, on 31/08, when devbox-core learned to mint
 * its own token from a service account key: with the key deposited it was orderable here,
 * without it not. Since 02/09 it takes the project as well - devbox-core carried the author's
 * as a default until the repository was published, and a form that offered GCP on the
 * strength of the key alone would take the order, start a job, and die at the apply.
 *
 * Since 11/09 every cloud is decided the same way, Hetzner and Scaleway included, which used
 * to be listed whatever this service held: their credentials can now be set, and unset, from
 * a page. And Scaleway wants all THREE fields - see CLOUD_FIELDS for the access key that
 * devbox-core's own check did not ask for and terraform refuses to plan without. A cloud that
 * cannot be ordered from must be absent from the list, not present and broken.
 */
export function clouds(sources: Sources): Cloud[] {
  const held = heldIn(sources);
  return CLOUDS.filter((cloud) => cloudUsable(cloud, sources, held));
}

/**
 * What an account lacks to order anything, named.
 *
 * The service starts despite an incomplete configuration: dying at startup would make it
 * loop on Restart=always without ever saying why.
 *
 * HCLOUD_TOKEN is named only when NO cloud can be ordered from. It used to be named
 * whenever it was unset, from the days Hetzner was the only cloud this service ordered
 * from: a dashboard running on Scaleway or GCP alone then announced itself incomplete on
 * its login page while every order went through. Hetzner stays the name given, being the
 * one a single variable opens; set through the page, it stops being missing without a
 * restart.
 *
 * PASSWORD_HASH and DEVBOX_REMOTE_TOKEN were named here too, before accounts. They are not
 * an account's gaps: an account has its own identities and its own tokens, PASSWORD_HASH opens
 * nothing since 15/09, and DEVBOX_REMOTE_TOKEN is read until account 1 is founded and by nothing
 * after. What the service itself lacks for anyone to get in at all - a provider, a founder - is
 * doors() in src/accounts.ts, said at startup and carried by /api/session as `disabled`.
 */
export function missing(sources: Sources): string[] {
  return clouds(sources).length === 0 ? ["HCLOUD_TOKEN"] : [];
}

export function configured(sources: Sources): boolean {
  return missing(sources).length === 0;
}

/**
 * The clouds an account reaches with credentials other accounts may be ordering on too, and so
 * the clouds where "at the provider, not in my state" stops meaning "mine and forgotten".
 * GET /api/orphans refuses on any of them: see server.ts.
 *
 *   an account on the service's   every usable cloud it resolves through them: the provider
 *                                 account is the service's, and every account's.
 *   the founder, or one owner     every usable cloud that one of `others` - the accounts an
 *                                 extension puts on its cloud accounts today - set nothing of its
 *                                 own for; and every one in `ordered`, on which another account
 *                                 holds a machine it ordered on these very credentials
 *                                 (machine_origins), taken off them since or not. Asked of today
 *                                 alone, the machines of an account taken off would still run
 *                                 there, and list as the founder's orphans.
 *
 * A cloud an account connected on its own answers none of this: its provider account is its
 * own, and its orphans are its own.
 */
export function cloudsThroughService(
  sources: Sources,
  others: readonly number[],
  ordered: ReadonlySet<string>,
): Cloud[] {
  const held = heldIn(sources);
  if (serviceOf(sources) !== null) {
    return CLOUDS.filter(
      (cloud) => throughService(cloud, sources, () => held.owned) && cloudUsable(cloud, sources, held),
    );
  }
  const ownedByOthers = others.map((id) => ownedClouds(sources.db, id));
  return CLOUDS.filter(
    (cloud) =>
      cloudUsable(cloud, sources, held) &&
      (ordered.has(cloud) || ownedByOthers.some((owned) => !owned.has(cloud))),
  );
}

/**
 * Those of `secrets` that nothing holds. Empty means the profile can be seeded.
 *
 * A name the vault would refuse counts as missing, reserved names included: see fallbackOf.
 */
export function missingSecrets(secrets: readonly string[], sources: Sources): string[] {
  const held = heldIn(sources);
  return secrets.filter((name) => !resolveSecret("profile", name, sources, held).set);
}

/* --- what the page is told ----------------------------------------------------------- */

export type FieldEntry = {
  name: string;
  label: string;
  multiline: boolean;
  required: boolean;
} & Resolved;

/**
 * `machines` are the live ones on that cloud, by name: what a cloud's credentials are still
 * needed for. Deleting them leaves those machines billing with nothing here able to destroy
 * them - the page reads this to say so before the delete, and the destroy route refuses
 * with a 412 after it.
 */
export type CloudEntry = {
  cloud: Cloud;
  usable: boolean;
  /**
   * Whose provider account a machine on this cloud goes to: this account's own, the service's,
   * or none when it cannot be ordered from. `fields` describe this account's OWN credentials
   * either way - what its settings page connects, replaces and disconnects.
   */
  via: "own" | "service" | null;
  fields: FieldEntry[];
  machines: string[];
};

export type ProfileEntry = { name: string } & Resolved & { used_by: string[]; machines: string[] };

export type Overview = { vault: VaultStatus; clouds: CloudEntry[]; profile: ProfileEntry[] };

/** What a profile says of itself that matters here: its name and what it declares. */
export type Declaring = { name: string; secrets: readonly string[] };
/** What a live machine says: its name, the profile it was seeded with, and where it runs. */
export type Running = { name: string; profile: string | null; cloud: string };

function fieldEntry(field: CloudField, sources: Sources, held: Held): FieldEntry {
  return {
    name: field.name,
    label: field.label,
    multiline: field.multiline,
    required: field.required,
    ...(serviceOf(sources) === null
      ? resolveSecret("cloud", field.name, sources, held)
      : ownRow("cloud", field.name, held)),
  };
}

function viaOf(cloud: Cloud, sources: Sources, held: Held): CloudEntry["via"] {
  if (!cloudUsable(cloud, sources, held)) return null;
  return throughService(cloud, sources, () => held.owned) ? "service" : "own";
}

function profileEntry(
  name: string,
  profiles: readonly Declaring[],
  fleet: readonly Running[],
  sources: Sources,
  held: Held,
): ProfileEntry {
  const users = profiles.filter((profile) => profile.secrets.includes(name)).map((p) => p.name);
  return {
    name,
    ...resolveSecret("profile", name, sources, held),
    used_by: [...users].sort(),
    // Seeded with whatever was held THEN, and holding it in /run/secrets until the next seed:
    // the one thing a rotation through the page cannot reach on its own.
    machines: fleet
      .filter((machine) => machine.profile !== null && users.includes(machine.profile))
      .map((machine) => machine.name)
      .sort(),
  };
}

/** The fallback's profile secrets: every file a job could be handed, and nothing else. */
function legacyProfileNames(directory: string | null): string[] {
  if (directory === null) return [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.filter(
    (name) => checkedSecretName("profile", name).ok && legacyFilePresent(directory, name),
  );
}

/** One cloud's card, as GET /api/secrets draws it and PUT answers it. */
export function cloudFieldEntry(name: string, sources: Sources): FieldEntry | null {
  const field = FIELD_BY_NAME.get(name);
  return field === undefined ? null : fieldEntry(field, sources, heldIn(sources));
}

export function profileSecretEntry(
  name: string,
  profiles: readonly Declaring[],
  fleet: readonly Running[],
  sources: Sources,
): ProfileEntry {
  return profileEntry(name, profiles, fleet, sources, heldIn(sources));
}

/**
 * GET /api/secrets: names, places and fingerprints, never a value - and nothing on this
 * road reads one. heldIn selects no ciphertext, and a file is only ever stat'ed.
 *
 * The profile list is every name something could want: what a profile declares, what the
 * vault holds, what the fallback holds. The three differ on purpose, and each difference is
 * worth a row: a declared name held nowhere is a seed that will be refused, a held name no
 * profile declares is a secret nothing reads any more.
 */
export function overview(
  profiles: readonly Declaring[],
  fleet: readonly Running[],
  sources: Sources,
  status: VaultStatus = vaultState(),
): Overview {
  const held = heldIn(sources);
  const names = new Set<string>();
  for (const profile of profiles) for (const name of profile.secrets) names.add(name);
  for (const meta of held.own.values()) if (meta.kind === "profile") names.add(meta.name);
  for (const name of legacyProfileNames(sources.profileFiles ? sources.secretsDir : null)) names.add(name);

  return {
    vault: status,
    clouds: CLOUDS.map((cloud) => {
      const fields: readonly CloudField[] = CLOUD_FIELDS[cloud];
      return {
        cloud,
        usable: cloudUsable(cloud, sources, held),
        via: viaOf(cloud, sources, held),
        fields: fields.map((field) => fieldEntry(field, sources, held)),
        machines: fleet
          .filter((machine) => machine.cloud === cloud)
          .map((machine) => machine.name)
          .sort(),
      };
    }),
    profile: [...names].sort().map((name) => profileEntry(name, profiles, fleet, sources, held)),
  };
}

/* --- writing ------------------------------------------------------------------------- */

/** The vault cannot be written: no master key, or one that does not open what it holds. 503. */
export class VaultClosed extends Error {
  override name = "VaultClosed";
}

function writable(sources: Sources): Keyring {
  if (sources.keyring !== null) return sources.keyring;
  const status = vaultState();
  throw new VaultClosed(status.available ? "the vault is closed" : `the vault is closed: ${status.reason}`);
}

/** C0 controls and DEL, built from codepoints so this file holds none of them itself. */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);

/**
 * A value as a request sent it, before the vault's own rules - which are the ones that
 * count for emptiness and size, and are not repeated here.
 *
 * One rule of this file's own: a single-line cloud credential is exactly one line. It
 * becomes an environment variable and, from there, an HTTP header; a pasted value carrying a
 * line break in its middle is a malformed Authorization header that the provider answers as
 * a revoked token, and a NUL would not even survive the trip into the environment. The one
 * trailing newline a textarea adds is the vault's to remove, and is let through.
 */
export function checkedSecretValue(kind: SecretKind, name: string, value: unknown): Checked<string> {
  if (typeof value !== "string") return { ok: false, field: "value", reason: "expected a string" };
  const field = kind === "cloud" ? FIELD_BY_NAME.get(name) : undefined;
  if (field !== undefined && !field.multiline && CONTROL.test(value.replace(/\r?\n$/, ""))) {
    return { ok: false, field: "value", reason: "one line, without control characters" };
  }
  return { ok: true, value };
}

/**
 * The values POST /api/clouds/:cloud/test is asked to try, as the bytes the vault would
 * store: the same checks, the same trailing newline removed, and nothing stored.
 */
export function checkedCandidates(
  cloud: Cloud,
  values: unknown,
): Checked<Record<string, Uint8Array>> {
  if (values === undefined || values === null) return { ok: true, value: {} };
  if (typeof values !== "object" || Array.isArray(values)) {
    return { ok: false, field: "values", reason: "expected an object of NAME: value" };
  }
  const fields: readonly CloudField[] = CLOUD_FIELDS[cloud];
  const candidates: Record<string, Uint8Array> = {};
  for (const [name, raw] of Object.entries(values)) {
    if (!fields.some((field) => field.name === name)) {
      return {
        ok: false,
        field: "values",
        reason: `${JSON.stringify(name)} is not a ${cloud} credential: expected ${fields.map((f) => f.name).join(", ")}`,
      };
    }
    const checked = checkedSecretValue("cloud", name, raw);
    if (!checked.ok) return { ok: false, field: "values", reason: `${name}: ${checked.reason}` };
    try {
      candidates[name] = normalizedValue(checked.value);
    } catch (error) {
      if (!(error instanceof SecretRefused)) throw error;
      return { ok: false, field: "values", reason: `${name}: ${error.reason}` };
    }
  }
  return { ok: true, value: candidates };
}

/**
 * The three writes, each followed by a checkpoint: see `checkpoint` in src/database.ts for
 * why a secret is the one row that cannot wait for the next one.
 */
export function storeSecret(
  kind: SecretKind,
  name: string,
  value: string,
  now: number,
  sources: Sources,
): SecretMeta {
  const meta = setSecret(sources.db, writable(sources), sources.owner, kind, name, value, now);
  checkpoint(sources.db);
  return meta;
}

/**
 * A cloud's credentials, all of those given or none: see setSecrets in src/vault.ts for the
 * half-written pair this replaces. The names are the caller's to have checked against that
 * cloud (checkedCandidates); the vault checks them against its catalogue once more.
 */
export function storeCloud(
  values: Readonly<Record<string, Uint8Array>>,
  now: number,
  sources: Sources,
): SecretMeta[] {
  const metas = setSecrets(
    sources.db,
    writable(sources),
    sources.owner,
    Object.entries(values).map(([name, value]) => ({ kind: "cloud" as const, name, value })),
    now,
  );
  checkpoint(sources.db);
  return metas;
}

/** One cloud as GET /api/secrets draws it, without the machines: what the cloud's save answers. */
export function cloudEntry(cloud: Cloud, sources: Sources): Omit<CloudEntry, "machines"> {
  const held = heldIn(sources);
  const fields: readonly CloudField[] = CLOUD_FIELDS[cloud];
  return {
    cloud,
    usable: cloudUsable(cloud, sources, held),
    via: viaOf(cloud, sources, held),
    fields: fields.map((field) => fieldEntry(field, sources, held)),
  };
}

/**
 * Needs no key: a row can be removed while the vault is closed, which is also how a row that
 * no longer opens is got rid of. `fallback` is what the next job reads instead, if anything:
 * the environment, a file, or - for an account that has just disconnected the last of a
 * cloud's own credentials - the service's.
 */
export function forgetSecret(
  kind: SecretKind,
  name: string,
  now: number,
  sources: Sources,
): { deleted: boolean; fallback: Exclude<Source, "db"> | null } {
  const deleted = deleteSecret(sources.db, sources.owner, kind, name, now);
  if (deleted) checkpoint(sources.db);
  const after = resolveSecret(kind, name, sources);
  return { deleted, fallback: after.source === "db" ? null : after.source };
}

/**
 * The environment as read at startup and the files: what the service held before the vault.
 * For an account without the fallback both are empty, and there is nothing to import.
 */
export function importSecrets(now: number, sources: Sources): ImportResult {
  const result = importLegacy(
    sources.db,
    writable(sources),
    sources.owner,
    { env: sources.env, secretsDir: sources.secretsDir },
    now,
  );
  if (result.imported.length > 0) checkpoint(sources.db);
  return result;
}
