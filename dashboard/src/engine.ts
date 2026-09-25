import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ACCOUNTS_DIR,
  CLOUDS,
  DATA_DIR,
  ENGINE_DIR,
  DEVBOX,
  DEVBOX_CACHE_DIR,
  ROOTS_DIR,
  TF_PLUGIN_CACHE_DIR,
  type Cloud,
} from "./config";
import { floorsOf, type Floors } from "./floors";
import { storedProfiles, type ProfileSpec } from "./profiles";
import type { AccountPaths } from "./tree";
import {
  CLOUD_VARIABLES,
  clouds,
  heldValue,
  ownCredentials,
  missingSecrets,
  resolveSecret,
  type Sources,
} from "./secrets";
import { CLOUD_FIELDS, MASTER_KEY_VARIABLES, type CloudField } from "./vault";

/**
 * Running devbox, and reading what it answers.
 *
 * Nothing here composes a command line. `Bun.spawn` takes an argv array and no shell, so
 * a value never has to be escaped, only validated: see src/validate.ts, which is where
 * every field a browser sends is checked before it reaches this file.
 */

type Env = Readonly<Record<string, string | undefined>>;

/* --- where a launch's secrets are laid out ------------------------------------------ */

/**
 * The directory under which every launch gets a directory of its own, and what it sits on.
 *
 * Since 11/09 devbox-core no longer reads the service's secrets where they are kept. The
 * vault's values exist decrypted only in this process, and devbox-core knows two channels
 * and no third: a cloud token in its environment, and a FILE under DEVBOX_SECRETS_DIR - the
 * GCP key, and every profile secret, which cmd_seed reads with `cat`. So each launch is
 * handed a directory holding exactly what it needs, written for it and removed when it exits.
 *
 * Memory first, because what is written there is the plaintext of a sealed value:
 *
 *   DEVBOX_RUNTIME_DIR   when the operator names one, it is used - they know their mounts -
 *                        through a directory of this service's own inside it, checked like
 *                        the one in /dev/shm: the operator knows the mount, not who else can
 *                        write to it, and /run/user or a shared tmpfs is exactly that.
 *   /dev/shm             a tmpfs on every Linux. Under the unit's PrivateDevices=true it is
 *                        still there: systemd bind-mounts the host's /dev/shm into the private
 *                        /dev, and ProtectSystem=strict leaves /dev writable. It is SHARED
 *                        with the host, sticky and world-writable, which is why the root is a
 *                        directory of this service's own, checked for owner and mode below.
 *                        Not /tmp: PrivateTmp=true makes it private, but it is a disk.
 *   DATA_DIR/run         the last resort, and a disk. ReadWritePaths= names DATA_DIR, so it is
 *                        the one place always writable - and a deleted file's bytes stay in
 *                        freed blocks, which is why startup says so when this is the one taken.
 *
 * `medium` is "memory" only when statfs PROVES a tmpfs or a ramfs. Anything it cannot prove -
 * another platform, an unknown filesystem - reads "disk": a doubt must not be announced as
 * the reassuring answer.
 */
export type Runtime = { path: string; medium: "memory" | "disk"; chosen: string; note: string | null };

const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

export function mediumOf(path: string): "memory" | "disk" {
  // f_type is a filesystem magic number on Linux alone; elsewhere it is an index into the
  // kernel's own table, and comparing it against Linux's magic would prove nothing.
  if (process.platform !== "linux") return "disk";
  try {
    const type = Number(statfsSync(path).type) >>> 0;
    return type === TMPFS_MAGIC || type === RAMFS_MAGIC ? "memory" : "disk";
  } catch {
    return "disk";
  }
}

function writableDirectory(path: string): boolean {
  try {
    rmSync(mkdtempSync(join(path, ".writable-")), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const currentUid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

/** A path as it may appear in a message: a name found on a shared disk can hold a newline. */
const shownPath = (path: string) => (/^[\x20-\x7e]*$/.test(path) ? path : JSON.stringify(path));

/**
 * The name of this service's own directory inside a runtime base: `devbox-<uid>-<tag>`.
 *
 * Named after the uid and the data directory, so that two dashboards on one host - a
 * development server and the test suite, say - never sweep each other's launches. Exported
 * for the tests, which have to find where a server they started lays its launches out.
 */
export function privateDirectoryName(dataDir: string, uid: number): string {
  const tag = createHash("sha256").update(dataDir).digest("hex").slice(0, 8);
  return `devbox-${uid}-${tag}`;
}

/**
 * This service's directory in a base it does not own - /dev/shm, or DEVBOX_RUNTIME_DIR - or
 * the reason it cannot have one safely.
 *
 * Refused when the name already exists as anything but a directory this uid owns: in a
 * directory others can write to, a name created in advance by someone else - or a symlink
 * pointing elsewhere - is the oldest trap there is. lstat and not stat, so that a symlink is
 * seen as one rather than as whatever it points at.
 */
function privateRoot(base: string, dataDir: string): { path: string } | { refused: string } {
  const uid = currentUid();
  if (uid === null) return { refused: "this platform has no uid to own a directory by" };
  const root = join(base, privateDirectoryName(dataDir, uid));
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") return { refused: `${shownPath(root)} cannot be created (${code ?? "error"})` };
  }
  try {
    const found = lstatSync(root);
    if (found.isSymbolicLink()) return { refused: `${shownPath(root)} is a symbolic link` };
    if (!found.isDirectory()) return { refused: `${shownPath(root)} is not a directory` };
    if (found.uid !== uid) {
      return { refused: `${shownPath(root)} belongs to uid ${found.uid}, and this service runs as ${uid}` };
    }
    chmodSync(root, 0o700);
  } catch (error) {
    return { refused: `${shownPath(root)} cannot be checked (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
  return writableDirectory(root) ? { path: root } : { refused: `${shownPath(root)} cannot be written` };
}

export function chooseRuntime(env: Env = process.env, dataDir: string = DATA_DIR): Runtime {
  const notes: string[] = [];
  const note = () => (notes.length === 0 ? null : notes.join("; "));

  const asked = (env.DEVBOX_RUNTIME_DIR ?? "").trim();
  if (asked !== "") {
    try {
      mkdirSync(asked, { recursive: true, mode: 0o700 });
    } catch {
      // Reported below by privateRoot, which is the question that matters.
    }
    const own = privateRoot(asked, dataDir);
    if ("path" in own) {
      return { path: own.path, medium: mediumOf(own.path), chosen: "DEVBOX_RUNTIME_DIR", note: note() };
    }
    notes.push(`DEVBOX_RUNTIME_DIR=${shownPath(asked)} was passed over: ${own.refused}`);
  }

  if (existsSync("/dev/shm")) {
    const shm = privateRoot("/dev/shm", dataDir);
    if ("path" in shm) {
      return { path: shm.path, medium: mediumOf(shm.path), chosen: "/dev/shm", note: note() };
    }
    // Said, where it used to fall through in silence: on a world-writable tmpfs, a name of
    // ours that someone else holds is worth an operator's attention on its own.
    notes.push(`/dev/shm was passed over: ${shm.refused}`);
  }

  const disk = join(dataDir, "run");
  mkdirSync(disk, { recursive: true, mode: 0o700 });
  chmodSync(disk, 0o700);
  return { path: disk, medium: mediumOf(disk), chosen: "DATA_DIR/run", note: note() };
}

/** Every launch directory starts with this, and the sweep removes nothing else. */
const LAUNCH_PREFIX = "launch-";

/** What a sweep removed, and each entry it left, with the reason. */
export type Sweep = { swept: number; kept: string[] };

/**
 * Removes what a crash left behind: a launch whose process never got to its `finally`.
 *
 * Safe at startup and only there. systemd kills the whole cgroup when the service stops, so
 * no child of a previous run can still be reading one of these; later, a sweep would pull
 * the files out from under a job in flight.
 *
 * Only what is plainly ours: a real directory - lstat, so a `launch-*` symlink is never
 * followed out of the root - owned by this uid. Anything else is left and said. And nothing
 * it meets can stop it: measured on 11/09, one `launch-*` that rm
 * could not remove threw out of server.ts's top level, and the service died before serving -
 * then again, and again, under Restart=always. Each entry is tried alone now; a failure is a
 * line in `kept`, and the service comes up.
 */
export function sweepLaunches(root: string, uid: number | null = currentUid()): Sweep {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { swept: 0, kept: [] };
  }
  let swept = 0;
  const kept: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(LAUNCH_PREFIX)) continue;
    const path = join(root, entry);
    try {
      const found = lstatSync(path);
      if (!found.isDirectory()) {
        kept.push(`${shownPath(path)} is ${found.isSymbolicLink() ? "a symbolic link" : "not a directory"}, and was left alone`);
        continue;
      }
      if (uid !== null && found.uid !== uid) {
        kept.push(`${shownPath(path)} belongs to uid ${found.uid}, and was left alone`);
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      swept += 1;
    } catch (error) {
      kept.push(`${shownPath(path)} could not be removed (${(error as NodeJS.ErrnoException).code ?? "error"})`);
    }
  }
  return { swept, kept };
}

/**
 * The runtime this process chose, kept on globalThis for the reason src/secrets.ts keeps the
 * vault there: `bun --hot` evaluates this module again, and the sweep must not run again with
 * it - a second sweep is exactly "later", with a job's files under it.
 */
const RUNTIME_SLOT = Symbol.for("devbox.dashboard.runtime");
const runtimeSlot = globalThis as { [RUNTIME_SLOT]?: Runtime };

/** Chosen once, at startup by prepareRuntime, or on the first launch when nothing asked before. */
export function runtimeRoot(): Runtime {
  runtimeSlot[RUNTIME_SLOT] ??= chooseRuntime();
  return runtimeSlot[RUNTIME_SLOT];
}

/** Called once by server.ts on the way up: choose, then sweep. */
export function prepareRuntime(env: Env = process.env): { runtime: Runtime } & Sweep {
  const runtime = chooseRuntime(env);
  runtimeSlot[RUNTIME_SLOT] = runtime;
  return { runtime, ...sweepLaunches(runtime.path) };
}

/**
 * What a launch needs, by verb - and a read that needs no provider gets no credential.
 *
 * `ls`, `info` and `profiles` read the Terraform state and the profiles, and no function they
 * reach asks a cloud: handing them tokens would only widen what a crash dump holds, and would
 * let a row that no longer opens take the fleet page down with it. `probe` and `orphans` ask
 * the providers; the three jobs order, seed and destroy. Profile secrets go to `up` and `seed`
 * alone - see src/jobs.ts - because `down` pushes nothing into a machine.
 */
export type LaunchNeeds = {
  /** Whose credentials: the variables in the environment, the GCP key as a file. */
  clouds: readonly Cloud[];
  /** Profile secrets to lay out as files. Every one must resolve, or nothing is launched. */
  profile: readonly string[];
  /** Values tried in place of what is held, by POST /api/clouds/:cloud/test. Never stored. */
  override?: Readonly<Record<string, Uint8Array>>;
  /** A cache of the launch's own, so a test neither reads nor fills the service's. */
  cache?: boolean;
};

export const NO_SECRETS: LaunchNeeds = { clouds: [], profile: [] };
export const CLOUD_CREDENTIALS: LaunchNeeds = { clouds: CLOUDS, profile: [] };

/** A cloud whose credentials were asked for and could not be read, and why - never a value. */
export type SkippedCloud = { cloud: Cloud; reason: string };

export type Launch = {
  directory: string;
  /**
   * Whose launch it is, carried so that engineEnv can refuse a tree that is not this
   * account's. The types cannot see it: an AccountPaths and a Sources are both perfectly
   * well-typed when they belong to two different accounts, and that pairing is exactly the
   * mistake worth refusing - a launch holding one account's tokens, run in another's tree.
   */
  account: number;
  /** Put in the child's environment, over everything else. */
  env: Record<string, string>;
  /** Kept out of the child's environment, inherited or not. */
  unset: readonly string[];
  /** Clouds left out of this launch because a credential of theirs could not be read. */
  skipped: readonly SkippedCloud[];
  /** Removes the directory. Idempotent, and called whether the child succeeded or not. */
  dispose(): void;
};

/** A profile secret nothing holds: refused before a single file is written. 412 on a route. */
export class SecretsMissing extends Error {
  override name = "SecretsMissing";
  readonly names: readonly string[];

  constructor(names: readonly string[]) {
    super(`this service holds no ${names.join(", ")}`);
    this.names = names;
  }
}

/** 0400, and never through an existing name: the directory is new, so one would be a surprise. */
function lay(directory: string, name: string, bytes: Uint8Array): void {
  writeFileSync(join(directory, name), bytes, { mode: 0o400, flag: "wx" });
}

/**
 * The directory and the variables for one launch of devbox-core: `<root>/launch-XXXXXX/`,
 * 0700, holding `secrets/` - DEVBOX_SECRETS_DIR - and, for a credential test, `cache/`.
 *
 * Every value comes through heldValue, so the database wins and the fallback answers for the
 * rest: a legacy file is COPIED here rather than pointed at, and one directory is then all
 * devbox-core ever needs to read.
 *
 * Three variables are withheld as well as supplied. GOOGLE_APPLICATION_CREDENTIALS, when the
 * GCP key is laid out: gcp_key_file() reads that variable BEFORE the directory, so a stale one
 * in the service's environment would win over the vault. And DEVBOX_<NAME>_TOKEN for each
 * profile secret, which secret_value() in the core reads before the file for the same reason.
 *
 * ONE CLOUD'S CREDENTIAL IS NOT EVERY CLOUD'S. A job is handed every cloud's credentials, so
 * that `down` can reach whichever cloud the state names - and that used to make one unreadable
 * credential everybody's failure. Measured on 11/09: a `gcp` row
 * that no longer opened, or a `gcp` file deposited under the wrong owner, threw out of here,
 * and the `down` of a HETZNER machine was refused with it - a machine billing, and a service
 * unable to destroy it for a reason that had nothing to do with it. So a cloud whose credential
 * cannot be read is left out of this launch whole, none of its fields laid out, and named in
 * `skipped` with the reason, which a job writes into its log. A cloud only half laid out would
 * be worse than none: the core would try it, and fail further in.
 *
 * Profile secrets stay strict. A seed without one of its secrets must fail HERE, before
 * anything is ordered, which is the whole point of this file: a secret nothing holds, or a row
 * that does not open, throws, and takes the directory with it, so a refusal leaves no
 * plaintext behind.
 */
export function prepareLaunch(
  paths: AccountPaths,
  needs: LaunchNeeds,
  sources: Sources,
  root: string = runtimeRoot().path,
): Launch {
  // The one check no type can make. Both arguments are branded, and both are valid on their
  // own; what would be wrong is a pair - this account's tree handed the vault of another,
  // which is a machine ordered in one account's state with another's cloud token, and that
  // account's profile secrets pushed into its /run/secrets.
  if (sources.owner !== paths.account) {
    throw new Error(
      `a launch was prepared with account ${paths.account}'s tree and account ${sources.owner}'s secrets`,
    );
  }
  const directory = mkdtempSync(join(root, LAUNCH_PREFIX));
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    chmodSync(directory, 0o700);
    const secrets = join(directory, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    chmodSync(secrets, 0o700);

    const env: Record<string, string> = { DEVBOX_SECRETS_DIR: secrets };
    const unset: string[] = [];
    const skipped: SkippedCloud[] = [];

    for (const cloud of new Set(needs.clouds)) {
      const fields: readonly CloudField[] = CLOUD_FIELDS[cloud];
      // Read whole before anything is laid out, so a cloud goes in complete or not at all.
      const read: { field: CloudField; bytes: Uint8Array; owned: boolean }[] = [];
      try {
        for (const field of fields) {
          const override = needs.override?.[field.name];
          const bytes = override ?? heldValue("cloud", field.name, sources);
          if (bytes !== null) read.push({ field, bytes, owned: override === undefined });
        }
      } catch (error) {
        // A VaultError names a kind and a name; an fs error, a code and a path. Neither can
        // carry a value, which is what lets this reach a job's log.
        const reason = error instanceof Error ? error.message : String(error);
        skipped.push({ cloud, reason: `its credentials cannot be read, so it was left out: ${reason}` });
        for (const { bytes, owned } of read) if (owned) bytes.fill(0);
        // Its stale road in the service's environment stays shut too: the vault or the file
        // was meant to answer for this cloud, and the variable from before them must not.
        if (fields.some((field) => field.name === "gcp")) unset.push("GOOGLE_APPLICATION_CREDENTIALS");
        continue;
      }
      for (const { field, bytes, owned } of read) {
        if (field.legacy === "env") {
          env[field.name] = new TextDecoder().decode(bytes);
        } else {
          lay(secrets, field.name, bytes);
          if (field.name === "gcp") unset.push("GOOGLE_APPLICATION_CREDENTIALS");
        }
        // The caller's override is the caller's to clear; what was read here is this
        // function's, and it has no reason to outlive the write.
        if (owned) bytes.fill(0);
      }
    }

    const absent = needs.profile.filter((name) => !resolveSecret("profile", name, sources).set);
    if (absent.length > 0) throw new SecretsMissing(absent);
    for (const name of new Set(needs.profile)) {
      const bytes = heldValue("profile", name, sources);
      if (bytes === null) throw new SecretsMissing([name]);
      lay(secrets, name, bytes);
      bytes.fill(0);
      // The transformation cmd_seed applies: `tr 'a-z-' 'A-Z_'`.
      unset.push(`DEVBOX_${name.toUpperCase().replaceAll("-", "_")}_TOKEN`);
    }

    if (needs.cache === true) {
      const cache = join(directory, "cache");
      mkdirSync(cache, { mode: 0o700 });
      env.DEVBOX_CACHE_DIR = cache;
    }

    return { directory, account: paths.account, env, unset, skipped, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

/**
 * The environment devbox runs in, identical in development and in production - and the four
 * variables that make it one account's world.
 *
 * HOME, DEVBOX_TF_ROOT, DEVBOX_CONFIG_DIR and DEVBOX_KEY are the whole of the isolation
 * between accounts: `instances()` lists the directories of $DEVBOX_TF_ROOT with no predicate,
 * so pointing them at accountTree(id) is what makes one account's fleet invisible to another
 * rather than merely filtered out of an answer. See src/tree.ts.
 *
 * HOME also matters for the reason it always did. devbox writes ~/.ssh/config and
 * ~/.ssh/known_hosts; left at the operator's real home this service would rewrite, on their
 * workstation, the file devbox already measured as unsafe under concurrent
 * read-modify-write. Pointed into the account's tree it becomes that account's own registry
 * of local ports and profiles, which is what `devbox info` reads back.
 *
 * TWO CACHES ARE SHARED, DELIBERATELY, and both hold public bytes: the GCP price catalogue,
 * and TF_PLUGIN_CACHE_DIR. Measured on 12/09, this data directory's tf/ weighs 65 MB with a
 * SINGLE cloud initialised, and devbox-core runs `terraform init` on every `up`: per account,
 * that is the provider set downloaded again into every tree. (The cache is not safe under
 * concurrent init - hashicorp/terraform#32028 - and jobs now run several at once: devbox-core
 * takes a lock inside this cache around each `terraform init`, as global as the cache itself.)
 *
 * The rest follows from the unit: the deployed code is mounted read-only, so everything
 * devbox writes has to be under the data directory.
 *
 * What is NOT inherited matters as much since 11/09. The master key is never handed to a
 * child: openVault deletes it from process.env after reading it, and it is withheld here
 * again in case anything ever sets it back. Handed is not reached, though - the bytes stay in
 * this process's initial environment block, which only src/undumpable.ts keeps a same-uid
 * child from reading, and only on Linux. The cloud variables are withheld too, and the
 * launch puts back the ones the resolution chose - otherwise the value from before a rotation
 * would ride along whenever the vault held nothing for a cloud the child did not need.
 * DEVBOX_SECRETS_DIR always comes from the launch, never from the service's own: that one
 * would hand every child the whole fallback directory.
 */
export function engineEnv(
  paths: AccountPaths,
  launch: Pick<Launch, "account" | "env" | "unset">,
): Record<string, string> {
  // The pair, checked here as well as in prepareLaunch: this is the last place before the
  // child, and it is the one that decides which state directory the secrets it carries are
  // spent against.
  if (launch.account !== paths.account) {
    throw new Error(
      `account ${launch.account}'s launch cannot run in account ${paths.account}'s tree`,
    );
  }
  // The service's own credentials too. The API token is adopted as account 1's first token, the
  // four provider variables sign anyone in, and the founder's address decides who takes account
  // 1: a child has no use for any of them - devbox-core reads DEVBOX_REMOTE_TOKEN only when it is
  // itself a client of a remote dashboard, which it never is here - and anything a child logs or
  // dumps would carry them. src/oauth.ts deletes the four from process.env once taken; they are
  // withheld here again in case anything sets them back. PASSWORD_HASH and DEVBOX_INVITE_CODE
  // have been read by nothing since 15/09 and stay on the list: a stale value left in a unit is
  // still a secret, and still not a child's.
  const withheld = new Set<string>([
    ...MASTER_KEY_VARIABLES,
    ...CLOUD_VARIABLES,
    "PASSWORD_HASH",
    "DEVBOX_REMOTE_TOKEN",
    "DEVBOX_INVITE_CODE",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "DEVBOX_FOUNDER_EMAIL",
    // Always, and not only when the launch lays out the GCP key. It used to be withheld on that
    // condition alone, so an account whose launch resolved no key inherited whatever path the
    // service's own environment named - the service's key, for an account without the
    // fallback privilege. The launch directory is the only road a key takes now, and
    // devbox-core exports this variable itself once the key it found there has minted a token.
    "GOOGLE_APPLICATION_CREDENTIALS",
    ...launch.unset,
  ]);
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !withheld.has(name)) inherited[name] = value;
  }
  return {
    ...inherited,
    HOME: paths.home,
    DEVBOX_TF_ROOT: paths.tfRoot,
    DEVBOX_CONFIG_DIR: paths.configDir,
    DEVBOX_KEY: paths.sshKey,
    DEVBOX_CACHE_DIR,
    TF_PLUGIN_CACHE_DIR,
    // A missing key must be a failure, never a freshly minted pair: a machine created
    // with a new key is one that neither the phone nor the Mac can join. accountTree is what
    // deposits the account's, once.
    DEVBOX_KEY_REQUIRED: "1",
    // Terraform would otherwise try to open a terminal for a confirmation that no one is
    // there to give.
    TF_IN_AUTOMATION: "1",
    // Last, so the launch's own directory and, for a test, its own cache win.
    ...launch.env,
  };
}

/**
 * The SHARED directories, created on the way up: devbox assumes them and systemd makes none.
 *
 * An account's own are not here, and that is the point - they are accountTree(id)'s, made at
 * the first call for that account, so that creating an account writes nothing on the disk and there is
 * exactly one path of creation. See src/tree.ts.
 */
export function prepareDirectories(): void {
  for (const dir of [ACCOUNTS_DIR, ROOTS_DIR, DEVBOX_CACHE_DIR, TF_PLUGIN_CACHE_DIR]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}


/** Whether the build ever ran. Named at startup rather than discovered mid-job. */
export function engineReady(): boolean {
  return existsSync(DEVBOX) && existsSync(join(ENGINE_DIR, "tf"));
}

export type EngineVersion = { core: string | null; built_at: string | null };

/**
 * Which core this service will actually spawn, named by its bytes.
 *
 * ONE FILE, AND THAT IS THE POINT. The digest widened to the whole deployed tree for a day,
 * while a second executor travelled in engine/core/src and the identity of "the engine" was
 * genuinely more than one file. That executor is gone; the engine is again devbox-core and
 * nothing else, so the identity is again the sha256 of those bytes - the same answer a
 * workstation's `self_version` computes for itself, which is what makes the two comparable
 * at all.
 *
 * There is no number to bump and no commit to read: the deployment rsyncs without .git
 * and this directory never had one, so nothing here knows a SHA. What it does have is the
 * file - scripts/build-engine.ts copies devbox-core to engine/devbox byte for byte, a cpSync
 * then a chmod, no substitution anywhere - so the sha256 of those bytes is the one
 * identity both sides can compute and neither has to maintain. Measured:
 * `shasum -a 256 devbox-core` and this function agree to the character, and the test below
 * pins that agreement against a literal rather than against itself.
 *
 * Read on every call rather than memoised at startup. It costs 98 KB and well under a
 * millisecond, and a digest computed once at boot is exactly the mechanism that
 * manufactures a false "nothing changed" - which is the failure this answer exists to
 * remove, not one to reintroduce to save a microsecond.
 *
 * Null rather than thrown when the file is missing: the tests point ENGINE_DIR at a
 * directory with no devbox in it, and a server deployed before `bun run build` ever ran is
 * in that same state. engineReady() already names it at startup, and a 500 here would
 * turn "I have no engine" into "I am broken", which is a different sentence.
 *
 * built_at is the file's mtime, which is the hour of the last `bun run engine` and not
 * the hour devbox-core was edited - cpSync does not preserve timestamps. Worth reading in a
 * message, never worth comparing.
 */
export function engineVersion(path = DEVBOX): EngineVersion {
  try {
    return {
      core: new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex"),
      built_at: statSync(path).mtime.toISOString(),
    };
  } catch {
    return { core: null, built_at: null };
  }
}

export type EngineResult = { code: number; stdout: string; stderr: string };

/** One child, in an environment already laid out, awaited whole. */
async function execute(
  paths: AccountPaths,
  argv: string[],
  timeoutMs: number,
  launch: Launch,
): Promise<EngineResult> {
  const child = Bun.spawn([DEVBOX, ...argv], {
    env: engineEnv(paths, launch),
    // Closed, as for a job: devbox asks for a missing secret at the keyboard, and no one is
    // at this one.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One devbox invocation, awaited whole.
 *
 * For the read-only verbs only. Anything that orders or destroys goes through
 * src/jobs.ts, which streams to a file instead of holding minutes of output in memory
 * and, more to the point, survives the browser tab that started it.
 *
 * The launch directory goes when the child does, answer or failure alike. A cloud the launch
 * had to leave out is said in the journal: a read has no job log to say it in.
 */
export async function run(
  paths: AccountPaths,
  argv: string[],
  sources: Sources,
  timeoutMs = 60_000,
  needs: LaunchNeeds = NO_SECRETS,
): Promise<EngineResult> {
  const launch = prepareLaunch(paths, needs, sources);
  for (const { cloud, reason } of launch.skipped) {
    console.warn(`/!\\ devbox ${argv[0] ?? ""}: ${cloud}: ${reason}`);
  }
  try {
    return await execute(paths, argv, timeoutMs, launch);
  } finally {
    launch.dispose();
  }
}

/**
 * devbox's colours, removed on the way out.
 *
 * devbox-core writes for a terminal and does not ask whether it has one: its `die` prints a
 * red cross and a reset around the sentence. Piped here, those become literal escape bytes
 * in an error string, and they travel - into the JSON of a 404, into a browser, into a
 * dialogue box that reads `x  no machine. devbox up` with two blocks of gibberish
 * around it. Measured on `/machine/inexistante`, where the page named the failure
 * correctly and rendered it unreadably.
 *
 * The stripping happens here and not in the client, because the same string is what
 * `devbox --json` hands back to a CLI over the wire: one place, and every reader benefits.
 * devbox-core is left alone deliberately - the colours are right on a terminal, and this
 * service is the one that knows it is not one.
 *
 * Exported for the test: an escape sequence that stopped being removed would look exactly
 * like an error message nobody happened to read closely.
 */
export function plain(text: string): string {
  // CSI sequences, which is all devbox emits: ESC [ … final byte.
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * What a finished invocation answered, or the reason it answered nothing usable.
 *
 * Split out of `json` below because `probe` needs both halves of the child: its rows come
 * from stdout and the clouds it could not ask come from stderr, so it cannot hand the
 * whole result to a helper that keeps only one of them.
 */
function parsed<T>(argv: string[], result: EngineResult): T {
  if (result.code !== 0) {
    throw new Error(`devbox ${argv.join(" ")} exited ${result.code}: ${plain(result.stderr).trim()}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`devbox ${argv.join(" ")} did not answer JSON: ${result.stdout.slice(0, 200)}`);
  }
}

/** A read-only verb that answers JSON, or the reason it could not. */
async function json<T>(
  paths: AccountPaths,
  argv: string[],
  sources: Sources,
  timeoutMs?: number,
  needs: LaunchNeeds = NO_SECRETS,
): Promise<T> {
  return parsed<T>(argv, await run(paths, argv, sources, timeoutMs, needs));
}

/**
 * The shapes `devbox --json` answers with.
 *
 * Deliberately the same names as cli/src/types.ts, because they describe the same
 * contracts: two consumers of one interface should not each invent a vocabulary for it. If
 * a field moves, it moves in devbox-core first and both files follow.
 *
 * There was, for a day, a third declaration in a TypeScript port of the core, and these
 * four were an `import type` of it - type-only, because the rsync sends dashboard/ alone
 * and the server has no workspace root to resolve a `workspace:*` from. The port is gone
 * and so is the constraint; what is left is a plain declaration with no specifier the
 * deployed server could fail to resolve.
 */
export type Profile = {
  name: string;
  path: string;
  repo: string | null;
  secrets: string[];
  note: string | null;
  min_cpu: number | null;
  min_ram: number | null;
  min_disk: number | null;
  port: number | null;
  /** Every port of `devbox-port:`, the app first, since 24/09. `port` is the first. */
  ports: number[];
};

export type Machine = {
  name: string;
  cloud: string;
  region: string;
  instance_type: string;
  profile: string | null;
  hourly_eur: number | null;
  ip: string;
  user: string;
  port: number | null;
  local_port: number;
  app_port: number;
  /**
   * Every port the profile forwards, the app first, and the forwards this server's ssh config
   * holds for them. Since 24/09: a machine described by an older engine has neither.
   */
  app_ports?: number[];
  forwards?: { local: number; remote: number }[];
};

export type MachineDetail = Machine & {
  fingerprint: string | null;
  note: string | null;
  kube_port: number;
};

export type Orphan = {
  cloud: string;
  name: string;
  ip: string | null;
  region: string;
  created: string;
};

/** One creatable shape, as `probe --json` returns it: `table_json` in devbox-core. */
export type Offer = {
  hourly_eur: number;
  cloud: string;
  type: string;
  location: string;
  cpu: number;
  ram_gb: number;
  disk_gb: number;
  cpu_class: string | null;
  availability: string | null;
};

/**
 * Every read below takes the account's tree AND its Sources, even the ones that hand the child
 * no secret: which account is asking is not optional anywhere, so no read can be written that
 * forgets it. The tree is what decides which fleet is listed at all; the Sources, which vault
 * answers - and prepareLaunch refuses the pair when they do not name the same account.
 */
export function profiles(paths: AccountPaths, sources: Sources): Promise<Profile[]> {
  return json<Profile[]>(paths, ["profiles", "--json"], sources);
}

/**
 * A profile as a screen needs it: the header, plus the two things only this service knows.
 *
 * `missing_secrets` depends on what is on THIS disk - a profile is identical on a Mac and
 * here, the vault behind it is not - and `floors` on what devbox-core would fill the blanks
 * with. Neither can come out of `profiles --json`, and neither belongs in it.
 */
export type DescribedProfile = Profile & {
  missing_secrets: string[];
  floors: Floors;
  /**
   * The form this profile was composed from, or null for one written by hand.
   *
   * Carried here rather than fetched from a second address, because the two answers have to
   * agree: `devbox profiles --json` reads the FILE, and the spec is what the file was
   * rendered from. A page that asked separately could draw a form out of a row whose file
   * had been shadowed by a hand-written profile of the same name - and offer to edit a
   * profile that is not the one that would run.
   */
  authored: ProfileSpec | null;
  /**
   * The file lives in this account's profile directory: composed here, or deposited there by
   * hand. False for one the engine publishes, which every account shares.
   *
   * Read off the path devbox answered with, the rule `authored` already follows, and not off
   * `authored` itself: a profile deposited by hand has no spec and is still this account's own.
   * Drawn as built-in, it would be listed beside `claude` as something the service ships.
   */
  own: boolean;
  /**
   * A profile written by hand that clones from github.com and declares no `github`: a
   * private repository will not clone, and the seed says so minutes in, on a machine already
   * ordered. Flagged on the order screen instead, and only on a hand-written one - a composed
   * profile declares a repository's secret from its own form, where "public" is a choice.
   *
   * bare.sh, removed on 24/09, is why it exists. It declared `github` for a clone it did not
   * make, which blocked every order of a new account; from 13/09 it declared nothing, and its
   * comment asked a copy that adds a repository to add the secret too. This is the net under
   * that comment. A public repository cloned without a credential is flagged all the same, and the
   * sentence it becomes is true of it: a private one would not clone.
   */
  clones_github_without_token: boolean;
};

/**
 * The enrichment, over a list already obtained.
 *
 * Kept apart from `profiles()` rather than folded into it, and the separation is the point:
 * `profiles()` answers exactly what devbox answered, so a test can pin the parsing of the core's
 * JSON without a secrets directory, and this one composes on top of a plain array, so a test
 * can pin the composition without spawning anything. Folded together they would only be
 * testable through a real devbox and a real /etc - which is to say not testable at all on the
 * machine where this is written.
 *
 * What it reads is a parameter for the same reason as everywhere else in src/: what depends
 * on the disk - and, since 11/09, on the vault - receives it. See src/secrets.ts.
 *
 * THE PREFIX AND THE MAP COME FROM THE SAME PLACE, and that is not tidiness. The prefix
 * decides whether a row is the spec of what would run; the map holds the specs. Drawn from two
 * accounts they would answer about two different profiles: a composed profile would read as
 * hand-written because the path did not match, or - the other way round - one account's form
 * would open on another's spec.
 */
export function describeProfiles(
  paths: AccountPaths,
  list: readonly Profile[],
  sources: Sources,
  authored: ReadonlyMap<string, ProfileSpec> = new Map(),
): DescribedProfile[] {
  return list.map((profile) => {
    // Keyed by name, and matched against the path devbox answered with: a row whose file
    // lives in the engine's own directory is a row whose profile is shadowed by a
    // hand-written one, and it is not the spec of what would run.
    const own = profile.path.startsWith(`${paths.profilesDir}/`);
    const spec = own ? (authored.get(profile.name) ?? null) : null;
    return {
      ...profile,
      missing_secrets: missingSecrets(profile.secrets, sources),
      floors: floorsOf(profile),
      authored: spec,
      own,
      clones_github_without_token:
        spec === null &&
        profile.repo !== null &&
        profile.repo.startsWith("https://github.com/") &&
        !profile.secrets.includes("github"),
    };
  });
}

export async function describedProfiles(
  paths: AccountPaths,
  sources: Sources,
): Promise<DescribedProfile[]> {
  const { rows } = storedProfiles(paths.account);
  return describeProfiles(
    paths,
    await profiles(paths, sources),
    sources,
    new Map(rows.map((row) => [row.spec.name, row.spec])),
  );
}

export function machines(paths: AccountPaths, sources: Sources): Promise<Machine[]> {
  return json<Machine[]>(paths, ["ls", "--json"], sources);
}

/**
 * The fingerprint costs an ssh-keyscan against a live host, hence the longer ceiling.
 *
 * A machine of ANOTHER account is not a refusal here, it is a machine that does not exist:
 * devbox-core resolves a name against the state directories of THIS tree, so it answers `no
 * machine named` and the route turns that into a 404. Never a 403, which would confirm it
 * exists somewhere.
 */
export function machine(
  paths: AccountPaths,
  name: string,
  sources: Sources,
): Promise<MachineDetail> {
  return json<MachineDetail>(paths, ["info", name, "--json"], sources, 30_000);
}

/**
 * What the providers run that no state knows about.
 *
 * Three cloud APIs over the network, so it is slower than everything else here and is
 * asked for deliberately rather than on every page load.
 */
export function orphans(paths: AccountPaths, sources: Sources): Promise<Orphan[]> {
  return json<Orphan[]>(paths, ["orphans", "--json"], sources, 120_000, CLOUD_CREDENTIALS);
}

/**
 * The `not asked:` block devbox-core writes to stderr in JSON mode, one cloud per line.
 *
 * Exported, and tested on a real stderr: this is a text contract between two files written
 * in two languages, and the kind of thing that breaks silently - a probe that stopped
 * reporting a missing credential looks exactly like a probe where every credential is
 * present, and the reader then takes "Hetzner is cheapest" for a market survey when it was
 * a survey of one.
 *
 * Same parse as cli/src/ui/Probe.tsx, because it is the same three lines of bash producing
 * it. If devbox-core changes the block, both follow.
 */
export function parseSkipped(stderr: string): string[] {
  // Through `plain` too: devbox strips its own red cross from these lines with a `sed` that
  // cuts to the first space, which works only because the escape and the cross carry none
  // between them. That is a coincidence of formatting, not a guarantee, and a cloud name
  // arriving with a colour still on it would print as gibberish in the `not asked:` block.
  const lines = plain(stderr).split("\n");
  const start = lines.findIndex((line) => line.trim() === "not asked:");
  if (start === -1) return [];
  return lines
    .slice(start + 1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export type ProbeOptions = {
  cpu?: number;
  ram?: number;
  disk?: number;
  cloud?: string;
};

/** What a probe answers: the rows, and the clouds that could not be asked. */
export type ProbeResult = { offers: Offer[]; skipped: string[] };

/**
 * The probe in flight, if there is one, and the tail of everything waiting behind it.
 *
 * ONE AT A TIME, AND THAT IS A MEMORY BOUND RATHER THAN A COURTESY. Measured on the server
 * on 31/08, against the live dashboard: four concurrent probes all answered 200 in 4,5 to
 * 5,0 s, the same as one alone. EIGHT answered 502 in 4,15 s - all of them - and took
 * the whole dashboard down with them, `/login` included, until systemd restarted the unit
 * five seconds later. There is no gentle slope: the cgroup hits MemoryMax and Bun dies with
 * whatever was inside it, because each probe hands jq the 5,7 MB price catalogue and jq
 * holds about six times what a file weighs.
 *
 * The providers were never the constraint - eight probes are 216 API calls and Hetzner
 * allows 3600 an hour. The unit's MemoryMax was.
 *
 * That ceiling has since moved from 256 MB to 512, then to 1G on 13/09 when jobs started
 * running several at once, in the deployment manifest, dashboard/deploy.json - and neither
 * number is measured: the manifest is JSON and cannot say so, which is why it is said here
 * and, for the jobs, beside their caps in src/config.ts.
 * What IS measured is one probe: 252 MB when the catalogue was still 27 MB, 147 once it
 * was filtered to 5,7, and 158 after a few. Serialised, that is the peak, and 256 would
 * have held it at 62 %.
 *
 * The headroom is for the thing NOT measured and NOT covered by the lock below: src/jobs.ts
 * spawns `up`, `seed` and `down` in this same cgroup - up to DEVBOX_MAX_JOBS of them at once
 * since 13/09 - and those run terraform. What the
 * google provider holds resident during an apply is unknown here, and the asymmetry is
 * what decided it - a ceiling too high costs nothing, the service still sits at 158 MB,
 * while a ceiling too low during an apply is a job marked `interrupted` and a machine
 * ordered at the provider that only `devbox orphans` can still find. systemd prints
 * MemoryPeak at every stop, so the next real `up` gives the measurement for free.
 *
 * And the real cost is not a refused probe. src/jobs.ts marks a job `interrupted` at the
 * next start precisely because a `terraform apply` cut in half leaves a machine ordered at
 * the provider that only `devbox orphans` can still find. The fleet happened to be empty
 * that afternoon. An `up` running during that burst would have been a machine on the meter
 * that the dashboard no longer knew about - which is why anything that restarts the service
 * ought to ask `GET /api/jobs` first. Here nobody asks: it is a `<select>`.
 *
 * Two behaviours, and the first is why this is not just a lock. An identical query already
 * in flight is JOINED rather than queued: a reader flicking back to a floor they just left
 * gets the answer being computed, for free. A different one waits its turn.
 *
 * Nothing caps the queue, deliberately. Serialised, a burst is slow and then correct - the
 * shape a reader can wait out - where the same burst in parallel was a 502 for everyone on
 * the site. `idleTimeout` on the server sits at 200 s and the child is killed at 180 s, so
 * a queue that grew absurd would report failures rather than pile up children.
 *
 * `orphans()` is deliberately outside this: it is the other heavy multi-cloud read, but it
 * is asked for by hand and one at a time, never by a control that moves under a thumb.
 *
 * The credential test of POST /api/clouds/:cloud/test waits in the same line: it IS a
 * probe, with a cache of its own that starts cold - for GCP, the whole price catalogue
 * fetched again - and it is never joined, since two tests of two tokens are two questions.
 *
 * A join is keyed by the ACCOUNT as well as the query. Two accounts asking the same floors
 * are asking with two sets of credentials, and joined, the second would be handed offers
 * computed with the first one's tokens - and told which clouds the first one can order from.
 * The queue stays shared: it bounds the memory of the process, which both accounts share.
 */
let inFlight: { key: string; result: Promise<ProbeResult> } | null = null;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs `task` once everything already queued has finished. The tail swallows a failure: one
 * probe that threw must not poison every probe behind it. Its own caller still sees the
 * rejection - this is a second chain over the same promise, not a replacement for it.
 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function probe(
  paths: AccountPaths,
  options: ProbeOptions,
  sources: Sources,
): Promise<ProbeResult> {
  const key = JSON.stringify([sources.owner, options.cpu, options.ram, options.disk, options.cloud]);
  if (inFlight !== null && inFlight.key === key) return inFlight.result;

  const result = enqueue(() => probeNow(paths, options, sources));
  const entry = { key, result };
  inFlight = entry;
  const settle = () => {
    if (inFlight === entry) inFlight = null;
  };
  result.then(settle, settle);
  return result;
}

/**
 * What THIS DASHBOARD can create right now, cheapest first - `devbox probe --json`.
 *
 * "This dashboard" and not "every cloud", which is the whole of the line below. Asked with
 * no --cloud, devbox probes every cloud it implements, and this service can only order from
 * the ones whose credentials it actually holds.
 *
 * Which clouds that is is no longer fixed for any of them: a cloud is in the list exactly when
 * its credentials resolve, in the vault or in the fallback. See clouds() in src/secrets.ts.
 * And the child is handed the credentials of the clouds it asks, and of no other.
 *
 * Measured on 27/08 on this workstation: hetzner alone 0,62 s, scaleway alone 0,83 s, the
 * unfiltered probe 10,7 s. The ten seconds were GCP failing to authenticate, in front of
 * an operator waiting on a spinner, for a cloud that was not in the list they were about
 * to choose from. A wizard step that takes ten seconds to show what it cannot order is not
 * slow, it is wrong.
 *
 * The ceiling stays generous all the same: a cold Scaleway can take its time, and a probe
 * that times out has nothing to show at all.
 *
 * The two halves of the child are both answers here. Stdout carries the rows; stderr
 * carries the clouds that could not be asked, and losing them would let one unconfigured
 * provider silently hide another's cheaper offer - which is why devbox-core writes that block
 * at all.
 */
async function probeNow(
  paths: AccountPaths,
  options: ProbeOptions,
  sources: Sources,
): Promise<ProbeResult> {
  const argv = ["probe", "--json"];
  if (options.cpu !== undefined) argv.push("--min-cpu", String(options.cpu));
  if (options.ram !== undefined) argv.push("--min-ram", String(options.ram));
  if (options.disk !== undefined) argv.push("--min-disk", String(options.disk));

  const asked: Cloud[] =
    options.cloud !== undefined
      ? CLOUDS.filter((cloud) => cloud === options.cloud)
      : clouds(sources);
  // Never `--cloud ""`: devbox-core reads an empty list as "every cloud I implement", and
  // would ask the three providers this service holds no credential for. Nothing to ask is
  // answered here, with each cloud named, which is what the `not asked:` block is for.
  if (asked.length === 0) {
    return {
      offers: [],
      skipped: CLOUDS.map((cloud) => `${cloud}: no credential set in this service`),
    };
  }
  // A cloud whose credential the launch could not read is not asked either, and is named with
  // its reason, in the same `not asked:` list the page already shows: asked without its
  // credential, the core would only say "not set" of a value that is set and unreadable.
  const launch = prepareLaunch(paths, { clouds: asked, profile: [] }, sources);
  try {
    const unreadable = new Set(launch.skipped.map((skip) => skip.cloud));
    const said = launch.skipped.map(({ cloud, reason }) => `${cloud}: ${reason}`);
    const reachable = asked.filter((cloud) => !unreadable.has(cloud));
    if (reachable.length === 0) return { offers: [], skipped: said };

    // `--cloud` word-splits in devbox-core (`for c in $clouds`), so the list travels as one
    // argument. Without it the probe asks the clouds this service has no business asking.
    argv.push("--cloud", reachable.join(" "));

    const result = await execute(paths, argv, 180_000, launch);
    return { offers: parsed<Offer[]>(argv, result), skipped: [...said, ...parseSkipped(result.stderr)] };
  } finally {
    launch.dispose();
  }
}

export type CloudTest = { ok: true; offers: number } | { ok: false; error: string };

/**
 * Every occurrence of a value replaced, before a message leaves this process.
 *
 * devbox-core names what it was refused, and a provider sometimes repeats what it was sent -
 * an id, a project, the start of a token. The answer to "does this credential work" is read
 * by a browser, and the rule for this whole feature is that no value ever reaches one.
 */
function redacted(text: string, values: readonly string[]): string {
  let out = text;
  // Longest first, so a value that contains another is not left half-replaced. Three
  // characters or fewer would redact half the vocabulary, and no credential is that short.
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length > 3) out = out.replaceAll(value, "[redacted]");
  }
  return out;
}

/**
 * Whether one cloud accepts a set of credentials: `devbox probe --cloud <c> --json`, with the
 * candidates in the child's environment - or, for the GCP key, in its directory - and the
 * rest as the next job would find them.
 *
 * NOTHING IS WRITTEN, and the cache is the part that is easy to miss. The probe keeps GCP's
 * price catalogue on the disk for a day, and a test run against it would answer with what
 * the OLD credential once fetched: the billing API would never be asked whether the new key
 * may read it. So the child gets a cache of its own, inside its launch directory, gone with it.
 *
 * A refusal is an answer and not an error, as the contract says: `ok: false` with the
 * provider's own first line, the one devbox-core prints under `not asked:` - every value
 * involved removed from it first.
 *
 * A field left out of `values` is taken from this account's OWN credentials and from nowhere
 * else - never the service's, which every other account orders on (ownCredentials in
 * src/secrets.ts). An account trying a key of its own is answered about that key; completed
 * with the service's, the answer would be about a pair nobody will ever order with.
 */
export function testCloud(
  paths: AccountPaths,
  cloud: Cloud,
  values: Readonly<Record<string, Uint8Array>>,
  sources: Sources,
): Promise<CloudTest> {
  return enqueue(() => testNow(paths, cloud, values, sources));
}

async function testNow(
  paths: AccountPaths,
  cloud: Cloud,
  values: Readonly<Record<string, Uint8Array>>,
  sources: Sources,
): Promise<CloudTest> {
  const own = ownCredentials(sources);
  const fields: readonly CloudField[] = CLOUD_FIELDS[cloud];
  const absent = fields.filter(
    (field) =>
      field.required &&
      values[field.name] === undefined &&
      !resolveSecret("cloud", field.name, own).set,
  );
  if (absent.length > 0) {
    return {
      ok: false,
      error: `nothing holds ${absent.map((field) => field.name).join(", ")}: type ${absent.length === 1 ? "it" : "them"} here to try`,
    };
  }

  let launch: Launch;
  try {
    launch = prepareLaunch(paths, { clouds: [cloud], profile: [], override: values, cache: true }, own);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // A held field that could not be read, beside the ones typed: the answer is about that
  // field, and a probe run without it would only blame the provider.
  const unreadable = launch.skipped.find((skip) => skip.cloud === cloud);
  if (unreadable !== undefined) {
    launch.dispose();
    return { ok: false, error: unreadable.reason };
  }

  const decoder = new TextDecoder();
  const secrets = [
    ...Object.values(values).map((bytes) => decoder.decode(bytes)),
    ...CLOUD_VARIABLES.flatMap((name) => launch.env[name] ?? []),
  ];
  const argv = ["probe", "--json", "--cloud", cloud];
  try {
    const result = await execute(paths, argv, 180_000, launch);
    const said = (text: string) => redacted(text, secrets);
    if (result.code !== 0) {
      const first = plain(result.stderr).trim().split("\n")[0] ?? "";
      return { ok: false, error: said(first || `devbox probe exited ${result.code}`) };
    }
    const refusal = parseSkipped(result.stderr).find((line) => line.startsWith(`${cloud}:`));
    if (refusal !== undefined) {
      return { ok: false, error: said(refusal.slice(cloud.length + 1).trim()) };
    }
    const offers = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(offers)) return { ok: false, error: "devbox probe did not answer a list" };
    return { ok: true, offers: offers.length };
  } catch (error) {
    return { ok: false, error: redacted(error instanceof Error ? error.message : String(error), secrets) };
  } finally {
    launch.dispose();
  }
}
