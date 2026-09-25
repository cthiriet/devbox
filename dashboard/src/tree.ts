/**
 * One account, one tree - the whole of the isolation between accounts.
 *
 * devbox-core reads its world in four variables - HOME, DEVBOX_TF_ROOT, DEVBOX_CONFIG_DIR,
 * DEVBOX_KEY - and `instances()` enumerates a fleet by LISTING the directories of
 * $DEVBOX_TF_ROOT, with no predicate of any kind. So an account's own tree is not a filter
 * that every route has to remember: it is a boundary the executor cannot see past. `ls` of one
 * account does not list another's machine, `down` cannot resolve it, and the terminal finds no
 * host key for it. A predicate would have to be right in twenty places; this has to be right
 * once, here.
 *
 *   DATA_DIR/accounts/<id>/          0700
 *     home/.ssh/                     config, known_hosts, devbox (0600), devbox.pub
 *     tf/<cloud>/                    the sources, the lock, the STATE, .terraform
 *     tf/.roots                      the digest of the roots copied here
 *     prelude.sh, …                  the files the roots read at dirname(tfRoot)
 *     config/profiles/               composed profiles, and those deposited by hand
 *     logs/                          0700, files 0600
 *
 * The logs are in the tree for the reason the rest is: job ids are global and logPath() reads
 * an id alone, so in one directory a single forgotten WHERE would put one account's apply log
 * in another's browser.
 *
 * src/accounts.ts stays pure - it decides what an account is and opens nothing - and this file
 * is the half that touches the disk.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCOUNTS_DIR, ENGINE_DIR, ROOTS_DIR } from "./config";
import { storedProfiles, syncProfiles } from "./profiles";
import { rootNeeds } from "./roots";

/**
 * The brand, declared and never created: nothing can build an AccountPaths but accountTree
 * below, and a route that wants one has to name an account to get it.
 *
 * `declare const` rather than a real Symbol, unlike the one on Sources: that one is put on an
 * object by two constructors and has to exist at runtime, and this one is only ever a type.
 */
declare const TREE: unique symbol;

export type AccountPaths = {
  readonly [TREE]: true;
  /** users.id, which is also owners.id in the vault: one number names an account everywhere. */
  account: number;
  home: string;
  tfRoot: string;
  configDir: string;
  profilesDir: string;
  logDir: string;
  sshKey: string;
};

function pathsOf(account: number): AccountPaths {
  const root = join(ACCOUNTS_DIR, String(account));
  const configDir = join(root, "config");
  return {
    account,
    home: join(root, "home"),
    tfRoot: join(root, "tf"),
    configDir,
    profilesDir: join(configDir, "profiles"),
    logDir: join(root, "logs"),
    sshKey: join(root, "home", ".ssh", "devbox"),
  } as AccountPaths;
}

/* --- the Terraform roots, staged once ---------------------------------------------- */

/** What stageRoots left: a directory laid out like an account, and the digest naming it. */
export type StagedRoots = { digest: string; path: string };

/**
 * Kept on globalThis for the reason src/engine.ts keeps the runtime there: `bun --hot`
 * evaluates this module again at every save, and the staging is a process's first moments.
 */
const STAGED_SLOT = Symbol.for("devbox.dashboard.roots.staged");
const TREES_SLOT = Symbol.for("devbox.dashboard.trees");
const slots = globalThis as {
  [STAGED_SLOT]?: StagedRoots | null;
  [TREES_SLOT]?: Map<number, AccountPaths>;
};

/** What the last stageRoots() prepared, or null when the engine holds no tf/ to prepare from. */
export function stagedRoots(): StagedRoots | null {
  return slots[STAGED_SLOT] ?? null;
}

/** The name a file was copied under, and its bytes: what the digest is taken over. */
type Staged = { path: string; bytes: Uint8Array };

/**
 * Prepares the Terraform sources ONCE per start, in the shape an account's tree wants them.
 *
 * A root reaches outside its own directory: tf/<cloud>/main.tf holds
 * `file("${path.module}/../../prelude.sh")` and others like it, so it only works inside a
 * repository-shaped layout - those files beside the tf/ that holds the root. Nothing here
 * lists them: src/roots.ts READS the names off the .tf files being copied, which is the
 * repair of 27/08, when two hand-written lists said two names and the roots wanted three.
 * `file()` is evaluated at PLAN time, so terraform then refused everything - `destroy`
 * included, on a cx33 that went on billing.
 *
 * The staging directory is laid out exactly like an account's root - tf/ and the files beside
 * it - so copying it into a tree is one loop and no path arithmetic.
 *
 * THE DIGEST IS TAKEN OVER WHAT WAS ACTUALLY COPIED: sorted relative paths, and bytes. A
 * digest over the .tf files alone would let an account keep last week's prelude.sh with
 * nothing anywhere saying so - and prelude.sh is the file that provisions the machine.
 *
 * Constant cost whatever the number of accounts: this runs once, and accountTree only ever
 * compares one line against `tf/.roots`.
 */
export function stageRoots(engineDir: string = ENGINE_DIR, rootsDir: string = ROOTS_DIR): StagedRoots | null {
  const from = join(engineDir, "tf");
  if (!existsSync(from)) {
    slots[STAGED_SLOT] = null;
    return null;
  }

  const staging = join(rootsDir, ".staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });

  const needs = rootNeeds(from);
  const copied: Staged[] = [];

  const take = (source: string, relative: string): void => {
    const bytes = readFileSync(source);
    const target = join(staging, relative);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
    copied.push({ path: relative, bytes });
  };

  for (const file of needs.beside) {
    const source = join(engineDir, file);
    if (!existsSync(source)) {
      // Named at startup rather than three minutes into an apply. The build deposits these,
      // so an absent one means a deployment that carried a root without what it reads - and
      // terraform refuses a `destroy` for that as flatly as a create.
      console.warn(
        `/!\\ the terraform roots read ${file} and engine/ does not hold it:` +
          " nothing can be created or destroyed until `bun run build` runs again.",
      );
      continue;
    }
    take(source, file);
  }

  for (const cloud of readdirSync(from)) {
    const source = join(from, cloud);
    if (!statSync(source).isDirectory()) continue;
    // Plus what this root reads from its own directory: a filter on `.tf` alone drops such a
    // file silently. Nothing is named here either.
    const sibling = needs.inside[cloud] ?? [];
    for (const file of readdirSync(source)) {
      if (!file.endsWith(".tf") && file !== ".terraform.lock.hcl" && !sibling.includes(file)) {
        continue;
      }
      take(join(source, file), join("tf", cloud, file));
    }
  }

  const digest = digestOf(copied);
  const path = join(rootsDir, digest);
  if (existsSync(path)) {
    // The same sources as the last start: the staging is the one that goes.
    rmSync(staging, { recursive: true, force: true });
  } else {
    renameSync(staging, path);
  }
  const staged = { digest, path };
  slots[STAGED_SLOT] = staged;
  return staged;
}

/**
 * The digest of a set of files: each name, its length and its bytes, in sorted order.
 *
 * The length is in the digest as well as the bytes so that no two different sets can be fed
 * in as the same stream of bytes - two files, one of which ends where the other begins.
 */
function digestOf(files: readonly Staged[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hasher.update(`${file.path}\0${file.bytes.length}\0`);
    hasher.update(file.bytes);
  }
  return hasher.digest("hex");
}

/* --- the tree ---------------------------------------------------------------------- */

/**
 * An account's paths, and its directories on the disk - created at the first call for that
 * account in this process, and never at signup.
 *
 * ONE PATH OF CREATION, which is why signup writes nothing on the disk: an account created
 * while the vault is closed, one restored into the database, and one that has simply never
 * ordered anything all arrive here the same way.
 *
 * Memoised because it is worth doing once, and idempotent because the memo is not a promise:
 * a second process, a `bun --hot` reload, a directory removed by hand between two calls all
 * land back here, and each step below asks the disk what it already holds rather than
 * assuming the last call's answer.
 *
 * The roots are copied ONLY when `tf/.roots` differs from the staged digest. Never the state:
 * terraform.tfstate, its backups and terraform.tfstate.d are what say which machines exist
 * and are billing, and nothing here writes into that name space.
 */
export function accountTree(account: number): AccountPaths {
  if (!Number.isInteger(account) || account < 1) {
    throw new Error(`an account's tree is named by its id, and ${String(account)} is not one`);
  }
  const trees = (slots[TREES_SLOT] ??= new Map<number, AccountPaths>());
  const known = trees.get(account);
  if (known !== undefined) return known;

  const paths = pathsOf(account);
  const root = join(ACCOUNTS_DIR, String(account));
  for (const directory of [
    root,
    paths.home,
    join(paths.home, ".ssh"),
    paths.tfRoot,
    paths.configDir,
    // Where a composed profile is rendered, and the FIRST entry of devbox-core's PROFILE_DIRS:
    // made here rather than at the first save, so `devbox profiles` finds a directory instead
    // of skipping a missing one, and so its mode is this service's 0700 and not whatever
    // umask happened to write the first file.
    paths.profilesDir,
    paths.logDir,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask, and an account's tree is the one place where a
    // group-readable directory would mean another unix account of the server reading a
    // state, a known_hosts and a private key.
    chmodSync(directory, 0o700);
  }

  copyRoots(paths);
  ensureAccountKey(paths);

  // The disk made to agree with the table, for this account, once per process. The table is
  // the authority and the file is its render, so a data directory restored from a backup - or
  // this renderer having moved - converges here rather than at the next order, where it would
  // show as a machine provisioned by a profile nobody can read any more.
  //
  // THIS ACCOUNT'S ROWS, and only those. Until 13/09 the table had no account, so every
  // account's first use rendered every row ever composed into its own directory: one account's
  // profile, naming its repositories and its secrets, listed on another's /new - and run by it,
  // since devbox-core searches that directory first.
  const { rows, unreadable } = storedProfiles(account);
  // Said here rather than at startup, where it used to be: the rows are an account's now, and a
  // row that no longer matches what this version accepts is invisible on that account's pages,
  // silently, unless something names it.
  if (unreadable.length > 0) {
    console.warn(
      `/!\\ account ${account}: ${unreadable.length} composed profile(s) no longer match what this version accepts and are not listed: ${unreadable.join(", ")}.` +
        " Their rendered files are left as they are; compose them again to replace them.",
    );
  }
  const { written, kept } = syncProfiles(rows, paths.profilesDir);
  if (written.length > 0) {
    console.log(`account ${account}: composed profiles rendered again: ${written.join(", ")}`);
  }
  for (const name of kept) {
    console.warn(
      `/!\\ account ${account}: ${name}.sh in ${paths.profilesDir} was not written by this service:` +
        " the composed profile of that name is not what devbox would run",
    );
  }

  trees.set(account, paths);
  return paths;
}

/**
 * Whether this account's Terraform state has a workspace of that name, on any cloud - read off
 * the disk, spawning nothing.
 *
 * It is the question the routes that act on ONE machine ask before anything else - info, seed,
 * destroy, the terminal - and the answer for another account's machine is no, mechanically: the
 * workspace lives in that account's tree. A no is a 404 before a job is written and before a
 * devbox is launched, the same 404 an unknown name gets.
 *
 * A workspace DIRECTORY, and not the machines `ls` lists, and the difference is a machine that
 * would otherwise be stranded. devbox-core's `ls` skips a workspace whose outputs it cannot read
 * (`machine_json ... || true`), which is exactly what a half-created machine leaves - and its
 * `down` resolves that same workspace through instances(), which lists every state holding a
 * resource. Asked of `ls`, the destroy of the one machine most worth destroying would be refused.
 * Every name instances() can answer is a directory here, so this refuses nothing devbox-core
 * could act on; what it lets through that devbox-core refuses - an empty workspace - devbox-core
 * refuses by name, in that account's own tree.
 *
 * `default` is the state file at a root's top, which is how instances() names the legacy one.
 */
export function holdsMachine(paths: AccountPaths, name: string): boolean {
  return workspaceClouds(paths, name).length > 0;
}

/**
 * The clouds whose state holds a workspace of that name: holdsMachine's answer, cloud by cloud.
 *
 * What names a machine's cloud when `ls` does not. The half-created machine holdsMachine lets a
 * destroy through is exactly the one `ls` skips, and its cloud is still written in the path of its
 * workspace - which a destroy needs, to be handed the credentials that machine was ordered with
 * (destroySourcesFor in src/secrets.ts).
 */
export function workspaceClouds(paths: AccountPaths, name: string): string[] {
  let clouds: string[];
  try {
    clouds = readdirSync(paths.tfRoot);
  } catch {
    return [];
  }
  return clouds.filter((cloud) => {
    const root = join(paths.tfRoot, cloud);
    try {
      if (name === "default") return statSync(join(root, "terraform.tfstate")).isFile();
      return statSync(join(root, "terraform.tfstate.d", name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** The staged sources into one tree, when they are not already the ones it holds. */
function copyRoots(paths: AccountPaths): void {
  const staged = stagedRoots();
  if (staged === null) return;

  const stamp = join(paths.tfRoot, ".roots");
  let held: string | null = null;
  try {
    held = readFileSync(stamp, "utf8").trim();
  } catch {
    held = null;
  }
  if (held === staged.digest) return;

  // The staging is laid out like an account's root, so this loop is the whole copy: `tf`
  // merges into the tree's own tf/ - leaving every terraform.tfstate, terraform.tfstate.d and
  // .terraform exactly where they are, since nothing under those names is in the source - and
  // each remaining entry is a file a root reads at dirname(tfRoot).
  for (const entry of readdirSync(staged.path)) {
    cpSync(join(staged.path, entry), join(dirname(paths.tfRoot), entry), { recursive: true });
  }
  writeFileSync(stamp, `${staged.digest}\n`, { mode: 0o600 });
}

/* --- the key --------------------------------------------------------------------- */

/**
 * The account's ssh key pair, minted once and never replaced.
 *
 * A file rather than a row of the vault, and the one exception to "a value is never read
 * back": devbox-core reads it, ssh2 reads it, `ssh-keyscan` and `terraform -var` read it, so
 * sealing it would remove nothing from the disk and would only add a copy.
 *
 *   neither present   mint the pair
 *   private only      rebuild the public with `ssh-keygen -y`
 *   PUBLIC ONLY       THROW. Minting over half a pair strands every live machine of that
 *                     account: the provider holds the old public key, and `destroy` passes
 *                     `$KEY.pub` as -var ssh_public_key, so the machine could then be neither
 *                     joined nor destroyed - and it bills either way.
 *   ssh-keygen fails  throw with the reason, so a route answers 503 now rather than a job
 *                     dying three minutes in with a machine already ordered.
 *
 * Written to a temporary and renamed: a half-written private key is exactly the state the
 * paragraph above refuses to be in.
 */
export function ensureAccountKey(paths: AccountPaths): void {
  const publicKey = `${paths.sshKey}.pub`;
  const hasPrivate = existsSync(paths.sshKey);
  const hasPublic = existsSync(publicKey);

  if (hasPrivate && hasPublic) {
    chmodSync(paths.sshKey, 0o600);
    chmodSync(publicKey, 0o644);
    return;
  }

  if (!hasPrivate && hasPublic) {
    throw new Error(
      `${publicKey} exists and ${paths.sshKey} does not: account ${paths.account}'s private key is` +
        " missing, and minting a new pair over it would leave every machine it created" +
        " unreachable and undestroyable - a destroy passes the public key as -var" +
        " ssh_public_key. Put the private key back, or move the public one aside knowingly.",
    );
  }

  const temporary = join(dirname(paths.sshKey), `.devbox.${process.pid}.tmp`);
  rmSync(temporary, { force: true });
  rmSync(`${temporary}.pub`, { force: true });

  if (hasPrivate) {
    // The public half derived from the private one rather than minted: the pair the provider
    // already knows is the private key's, and any other public key would be a different pair.
    const derived = keygen(["-y", "-f", paths.sshKey], paths.account);
    writeFileSync(temporary, derived.endsWith("\n") ? derived : `${derived}\n`, { mode: 0o644 });
    renameSync(temporary, publicKey);
    chmodSync(paths.sshKey, 0o600);
    return;
  }

  // -q so a success says nothing; the comment names the account, which is what an
  // authorized_keys on a machine will show.
  keygen(["-t", "ed25519", "-N", "", "-C", `devbox-${paths.account}`, "-f", temporary, "-q"], paths.account);
  renameSync(temporary, paths.sshKey);
  renameSync(`${temporary}.pub`, publicKey);
  chmodSync(paths.sshKey, 0o600);
  chmodSync(publicKey, 0o644);
}

/**
 * ssh-keygen, through Bun.spawnSync and no shell: an argv array, so no value is ever quoted.
 *
 * stdin closed, deliberately. ssh-keygen asks at the keyboard - to overwrite a file, for the
 * passphrase of an encrypted key - and nobody is at this one: a prompt would hang the request
 * that asked for the tree. Closed, it fails, and the reason travels to the 503.
 */
function keygen(argv: readonly string[], account: number): string {
  let result;
  try {
    result = Bun.spawnSync(["ssh-keygen", ...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error(
      `account ${account}'s ssh key could not be made: ssh-keygen could not be run` +
        ` (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!result.success) {
    const said = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(
      `account ${account}'s ssh key could not be made: ssh-keygen exited ${result.exitCode}` +
        (said === "" ? "" : `: ${said}`),
    );
  }
  return result.stdout.toString();
}
