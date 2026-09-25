/**
 * The data directory of the one-user service, turned into account 1's tree.
 *
 * Once, at startup, before anything is served and before the roots are staged: from here on
 * every path devbox writes is accountTree(id)'s, and the deployment that exists today has its
 * state, its home, its configuration and its logs at the top of DATA_DIR. Nothing reads them
 * there any more, so a service that came up without moving them would answer an empty fleet,
 * with the machines still billing and their state still on the disk. That is the failure this
 * file exists to make impossible, and every step below is ordered against it.
 *
 * It is the DIRECTORY half of the migration, and the only one that runs here. The identity
 * half - who account 1 is - happens at the first sign-in, and the two cannot be one
 * transaction: a rename is not a row. So there are two marks, `accounts/1` on the disk and
 * `user_version` in the database, and a service stopped between them replays only what is
 * missing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FOUNDING_ACCOUNT } from "./schema";
import { rootNeeds } from "./roots";

/** The directories the old layout kept at the top of DATA_DIR, in the order they are moved. */
const MOVED = ["tf", "home", "config", "logs"] as const;

/**
 * What the old layout left beside tf/, put there by the root synchronisation of the day.
 *
 * Named rather than derived, because what makes them stale is precisely that the roots which
 * named them have moved into the account: rootNeeds() now answers for accounts/1/tf and would
 * not name a file some earlier root read. The names are joined with whatever the roots ask for
 * today, so a file that was both is removed once.
 */
const BESIDE = ["prelude.sh", "cloud-init.yaml.tftpl", "devbox-provision.sh"] as const;

/**
 * Where the key was before accounts: DEVBOX_KEY, or ssh's own default.
 *
 * This is the old SSH_KEY constant of src/config.ts, and it lives here alone now - the one
 * place that still has a reason to know it. It may point ANYWHERE, inside the data directory
 * or outside it: the deployment passes the path in the service's environment, beside the key
 * it names.
 */
export function legacyKeyPath(env: Record<string, string | undefined> = process.env): string {
  return env.DEVBOX_KEY ?? join(homedir(), ".ssh", "devbox");
}

/** Whether a Terraform state holds anything a provider is charging for. devbox-core's rule. */
function stateHasResources(path: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  const resources = (parsed as { resources?: unknown }).resources;
  if (!Array.isArray(resources)) return false;
  return resources.some((one) => (one as { mode?: unknown }).mode === "managed");
}

/**
 * Every state under the old tf/, the workspaces included - the same places instances() looks.
 *
 * `default` is the state file itself and each directory of terraform.tfstate.d is a workspace,
 * which is how devbox-core gives every machine its own state under one root.
 */
function livingStates(tfRoot: string): string[] {
  const found: string[] = [];
  let clouds: string[];
  try {
    clouds = readdirSync(tfRoot);
  } catch {
    return found;
  }
  for (const cloud of clouds) {
    const directory = join(tfRoot, cloud);
    try {
      if (!statSync(directory).isDirectory()) continue;
    } catch {
      continue;
    }
    const candidates = [join(directory, "terraform.tfstate")];
    const workspaces = join(directory, "terraform.tfstate.d");
    try {
      for (const workspace of readdirSync(workspaces)) {
        candidates.push(join(workspaces, workspace, "terraform.tfstate"));
      }
    } catch {
      // No workspace directory: `default` alone, which is already in the list.
    }
    for (const candidate of candidates) {
      if (stateHasResources(candidate)) found.push(candidate);
    }
  }
  return found;
}

export type Migration = {
  /** Said once, at startup, in the order the work was done. */
  lines: string[];
};

/**
 * Moves the old layout under accounts/1, or answers null because there is nothing to move.
 *
 * Idempotent by the one mark that cannot be half-written: `accounts/1` exists, or it does not.
 * A second start finds it and moves nothing.
 */
export function migrateAccounts(options: {
  dataDir: string;
  /** The key the service has been using, which may be outside the data directory. */
  keyPath: string;
}): Migration | null {
  const { dataDir, keyPath } = options;
  const account = join(dataDir, "accounts", String(FOUNDING_ACCOUNT));
  const oldTfRoot = join(dataDir, "tf");
  if (existsSync(account) || !existsSync(oldTfRoot)) return null;

  const lines: string[] = [];

  /**
   * THE KEY FIRST, AND THIS IS THE LOUDEST FAILURE OF THE WHOLE CHANGE.
   *
   * Read - and the refusal decided - before a single directory moves. accountTree() mints a
   * pair when it finds neither half, which is right for a new account and catastrophic here:
   * the machines of the fleet hold the OLD public key, so a fresh one would leave them
   * unreachable, and `destroy` passes `$KEY.pub` as -var ssh_public_key, so they would be
   * undestroyable as well. Billing, unreachable, undestroyable: that is worth refusing to
   * start for, and the message names the path to put the key back at.
   */
  const living = livingStates(oldTfRoot);
  let privateKey: Uint8Array | null = null;
  let publicKey: Uint8Array | null = null;
  try {
    privateKey = readFileSync(keyPath);
  } catch {
    privateKey = null;
  }
  try {
    publicKey = readFileSync(`${keyPath}.pub`);
  } catch {
    publicKey = null;
  }
  if (privateKey === null && living.length > 0) {
    throw new Error(
      `this service's state holds machines and its ssh key cannot be read at ${keyPath}.\n` +
        `  ${living.map((path) => `  ${path}`).join("\n")}\n` +
        "  Those machines were created with that key: the provider holds its public half, and\n" +
        "  a destroy passes it as -var ssh_public_key. Moving the state under accounts/1 with\n" +
        "  no key would have the next start mint a fresh pair, and every one of them would be\n" +
        "  unreachable AND undestroyable while it went on billing.\n" +
        "  Put the key back at that path - DEVBOX_KEY names it - and start again.",
    );
  }

  /**
   * Renamed, never copied. A rename is atomic and leaves no second state on the disk: a copy
   * would, and a state read from the wrong copy is a machine applied against a plan that does
   * not describe it. EXDEV - the data directory straddling two filesystems - is not something
   * to work around by copying for the same reason: it throws, and an operator moves it.
   */
  mkdirSync(account, { recursive: true, mode: 0o700 });
  const moved: string[] = [];
  for (const name of MOVED) {
    const from = join(dataDir, name);
    if (!existsSync(from)) continue;
    try {
      renameSync(from, join(account, name));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(
        `${from} could not be moved to ${join(account, name)} (${code ?? "error"}).` +
          (code === "EXDEV"
            ? " The data directory straddles two filesystems: a copy would leave a second" +
              " Terraform state on the disk, which is how a machine gets applied against a plan" +
              " that does not describe it. Move the whole data directory onto one filesystem."
            : ""),
      );
    }
    moved.push(name);
  }
  lines.push(
    `account ${FOUNDING_ACCOUNT}'s tree: ${moved.join(", ")} moved from ${dataDir} to ${account}`,
  );

  /**
   * The key COPIED into the tree, never moved: a deployment deposits it at its own path, and
   * the next one would deposit it there again - a move would make the service look, once, as
   * though the deposit had failed.
   *
   * Written after the renames rather than before them, because home/ is one of the things
   * being renamed and a directory that already held the key would refuse to be the
   * destination of one. Nothing is lost by the order: what decides whether this service
   * starts at all was read and settled above.
   */
  if (privateKey !== null) {
    const ssh = join(account, "home", ".ssh");
    mkdirSync(ssh, { recursive: true, mode: 0o700 });
    writeFileSync(join(ssh, "devbox"), privateKey, { mode: 0o600 });
    if (publicKey !== null) writeFileSync(join(ssh, "devbox.pub"), publicKey, { mode: 0o644 });
    lines.push(
      `the ssh key was copied from ${keyPath} to ${join(ssh, "devbox")}` +
        (publicKey === null
          ? ", without its .pub, which the next start rebuilds from it"
          : " with its .pub") +
        `: ${living.length} state(s) hold machines created with it`,
    );
  } else {
    lines.push(
      `no ssh key at ${keyPath} and no state holding a machine: account ${FOUNDING_ACCOUNT} gets a` +
        " fresh pair at its first use",
    );
  }

  /**
   * What the old root synchronisation left at the top of DATA_DIR. The roots read them at
   * `${path.module}/../../`, which is now accounts/1/, so the copies up here answer for
   * nothing - and a stale prelude.sh beside a state is the kind of file someone reads in a
   * year and believes.
   */
  const stale = [...new Set([...BESIDE, ...rootNeeds(join(account, "tf")).beside])]
    .filter((name) => existsSync(join(dataDir, name)));
  for (const name of stale) rmSync(join(dataDir, name), { recursive: true, force: true });
  if (stale.length > 0) {
    lines.push(`removed from ${dataDir}, stale since the roots moved into the tree: ${stale.join(", ")}`);
  }

  /**
   * Said even when nothing looks wrong, because this is the half that fails in SILENCE. A
   * profile deposited by hand - the ones a real deployment carries, which this repository may
   * not name - would simply drop out of `devbox profiles` at the old path, and nobody would
   * learn of it until a seed died on "no profile named".
   */
  lines.push(
    `profiles deposited by hand now live in ${join(account, "config", "profiles")}:` +
      " devbox reads that directory first, and nothing reads the old one any more",
  );

  return { lines };
}

/* --- the fallback's secrets directory ---------------------------------------------- */

/**
 * The service's fallback directory, moved out of account 1's tree - once, when it was only
 * there because the move above took it there.
 *
 * DEVBOX_SECRETS_DIR used to default to DATA_DIR/config/secrets. `config/` became account 1's
 * configuration directory at the move above, and the default moved with the argument that a
 * service-wide fallback cannot live inside one account: it is DATA_DIR/shared/secrets now. A
 * workstation that relied on the default - `bun run dev`, which names no directory - had its
 * files carried to accounts/1/config/secrets by the rename, where nothing reads them, and the
 * new default is a directory that does not exist. Nothing fails: the fallback is simply empty,
 * every cloud the files held drops out of the list, and a seed refuses a secret the disk still
 * holds a copy of, one directory away.
 *
 * So, with the variable UNSET - a deployment that names its own directory is left alone - and
 * the old place holding a directory while the new one holds nothing, the directory is renamed
 * into place and the journal says so. A rename, within one data directory, for the reason the
 * move above gives: no second copy of a secret left behind on the disk.
 *
 * Idempotent by the same test: once moved, the old place is empty and nothing happens. With
 * BOTH present, nothing is moved - which copy is right is not something to guess about - and
 * the warning names both, since the one inside the tree is read by nothing.
 */
export function relocateSecrets(options: {
  dataDir: string;
  /** DEVBOX_SECRETS_DIR as the environment holds it: undefined only when it is not set at all. */
  secretsDirVariable: string | undefined;
}): { lines: string[]; warnings: string[] } | null {
  if (options.secretsDirVariable !== undefined) return null;
  const from = join(options.dataDir, "accounts", String(FOUNDING_ACCOUNT), "config", "secrets");
  const to = join(options.dataDir, "shared", "secrets");
  if (!existsSync(from)) return null;

  if (existsSync(to)) {
    return {
      lines: [],
      warnings: [
        `${from} and ${to} both exist: the fallback reads ${to} alone, and ${from} - where` +
          " DEVBOX_SECRETS_DIR defaulted before accounts - is read by nothing. Move what it" +
          " still holds by hand, then remove it.",
      ],
    };
  }

  try {
    mkdirSync(join(options.dataDir, "shared"), { recursive: true, mode: 0o700 });
    renameSync(from, to);
  } catch (error) {
    return {
      lines: [],
      warnings: [
        `${from} could not be moved to ${to} (${(error as NodeJS.ErrnoException).code ?? "error"}):` +
          " the fallback reads the second and is empty until it is moved by hand.",
      ],
    };
  }
  return {
    lines: [
      `the fallback's secrets moved from ${from} to ${to}: DEVBOX_SECRETS_DIR is unset, and its` +
        " default left account 1's configuration directory",
    ],
    warnings: [],
  };
}
