import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { legacyKeyPath, migrateAccounts, relocateSecrets } from "../src/migrate";

/**
 * The data directory of the one-user service, turned into account 1's tree.
 *
 * Nothing reads tf/, home/, config/ and logs/ at the top of DATA_DIR any more. A service that
 * came up without moving them would answer an empty fleet with the machines still billing and
 * their state still on the disk, and - worse - the next accountTree(1) would mint a fresh ssh
 * key for a live fleet, which leaves every machine unreachable AND undestroyable, since a
 * destroy passes the public key as -var ssh_public_key.
 *
 * EXDEV is not exercised: it needs a data directory straddling two filesystems, which a test
 * cannot arrange here. The code throws on it rather than falling back to a copy, and the
 * comment in src/migrate.ts says why a copy would be worse than a refusal.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const ROOT = join(DATA_DIR, "migration-test");
let drawn = 0;

const STATE_WITH_A_MACHINE = JSON.stringify({
  version: 4,
  resources: [{ mode: "managed", type: "hcloud_server", name: "devbox", instances: [{}] }],
});

const EMPTY_STATE = JSON.stringify({ version: 4, resources: [] });

/**
 * A data directory in the shape the service had before accounts, with something of every
 * kind in it: a state holding a machine, a workspace, a home, a hand-written profile, a job
 * log, and the stale files the old root synchronisation left beside tf/.
 */
function oldShape(options: { live: boolean; key: boolean }): { dataDir: string; keyPath: string } {
  drawn += 1;
  const root = join(ROOT, `case-${drawn}`);
  const dataDir = join(root, "data");

  mkdirSync(join(dataDir, "tf", "hetzner", "terraform.tfstate.d", "devbox-aaaaa"), { recursive: true });
  writeFileSync(
    join(dataDir, "tf", "hetzner", "main.tf"),
    'a = file("${path.module}/../../prelude.sh")\n',
  );
  writeFileSync(join(dataDir, "tf", "hetzner", "terraform.tfstate"), EMPTY_STATE);
  writeFileSync(
    join(dataDir, "tf", "hetzner", "terraform.tfstate.d", "devbox-aaaaa", "terraform.tfstate"),
    options.live ? STATE_WITH_A_MACHINE : EMPTY_STATE,
  );

  mkdirSync(join(dataDir, "home", ".ssh"), { recursive: true });
  writeFileSync(join(dataDir, "home", ".ssh", "known_hosts"), "203.0.113.7 ssh-ed25519 AAAA\n");
  writeFileSync(join(dataDir, "home", ".ssh", "config"), "Host devbox-aaaaa\n");

  // The profiles a real deployment carries, deposited by hand - the ones this repository may
  // not name. Left behind, they would simply drop out of the list.
  mkdirSync(join(dataDir, "config", "profiles"), { recursive: true });
  writeFileSync(join(dataDir, "config", "profiles", "handmade.sh"), "#!/bin/bash\n# private\n");

  mkdirSync(join(dataDir, "logs"), { recursive: true });
  writeFileSync(join(dataDir, "logs", "7.log"), "$ devbox up\napply complete\n");

  // What the old root synchronisation put beside tf/, which nothing reads up there any more.
  writeFileSync(join(dataDir, "prelude.sh"), "# the prelude of that deployment\n");
  writeFileSync(join(dataDir, "cloud-init.yaml.tftpl"), "#cloud-config\n");

  // The database stays where it is: it is the service's, not an account's.
  writeFileSync(join(dataDir, "devbox.db"), "SQLite format 3\0");

  const keyPath = join(root, "secrets", "devbox");
  if (options.key) {
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(keyPath, "-----BEGIN OPENSSH PRIVATE KEY-----\nthe key of the fleet\n", { mode: 0o600 });
    writeFileSync(`${keyPath}.pub`, "ssh-ed25519 AAAAfleet devbox\n", { mode: 0o644 });
  }
  return { dataDir, keyPath };
}

/** Everything under a directory, with its bytes: what "moved nothing" is measured against. */
function snapshot(path: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(path, { recursive: true, encoding: "utf8" }).sort()) {
    const full = join(path, entry);
    found[entry] = statSync(full).isDirectory() ? "<dir>" : readFileSync(full, "utf8");
  }
  return found;
}

describe("migrateAccounts", () => {
  test("moves the whole old layout under accounts/1, and says what it did", () => {
    const { dataDir, keyPath } = oldShape({ live: true, key: true });
    const migration = migrateAccounts({ dataDir, keyPath });
    expect(migration).not.toBeNull();

    const account = join(dataDir, "accounts", "1");
    // The state above all: this is what says which machines exist and are billing.
    expect(
      readFileSync(join(account, "tf", "hetzner", "terraform.tfstate.d", "devbox-aaaaa", "terraform.tfstate"), "utf8"),
    ).toBe(STATE_WITH_A_MACHINE);
    expect(readFileSync(join(account, "home", ".ssh", "known_hosts"), "utf8")).toContain("203.0.113.7");
    expect(readFileSync(join(account, "config", "profiles", "handmade.sh"), "utf8")).toContain("private");
    expect(readFileSync(join(account, "logs", "7.log"), "utf8")).toContain("apply complete");

    // Renamed, not copied: a second state on the disk is how a machine gets applied against a
    // plan that does not describe it.
    for (const name of ["tf", "home", "config", "logs"]) {
      expect(existsSync(join(dataDir, name))).toBe(false);
    }
    // And the database is the service's, so it stays where it is.
    expect(existsSync(join(dataDir, "devbox.db"))).toBe(true);
  });

  test("copies the key rather than moving it, and the copy is the fleet's own", () => {
    const { dataDir, keyPath } = oldShape({ live: true, key: true });
    const lines = migrateAccounts({ dataDir, keyPath })?.lines ?? [];

    const ssh = join(dataDir, "accounts", "1", "home", ".ssh");
    expect(readFileSync(join(ssh, "devbox"), "utf8")).toContain("the key of the fleet");
    expect(readFileSync(join(ssh, "devbox.pub"), "utf8")).toContain("AAAAfleet");
    expect(statSync(join(ssh, "devbox")).mode & 0o777).toBe(0o600);
    expect(statSync(join(ssh, "devbox.pub")).mode & 0o777).toBe(0o644);
    // A copy: the deployment deposits it at its own path, and the next one will again.
    expect(existsSync(keyPath)).toBe(true);
    expect(lines.join("\n")).toContain(keyPath);
  });

  /**
   * THE REFUSAL THIS WHOLE FILE IS ABOUT. A state holding machines and no key to be found:
   * moving on would have accountTree(1) mint a fresh pair, and every machine of that fleet
   * would be unreachable and undestroyable while it went on billing.
   */
  test("refuses to start when a live state has no key, and moves nothing", () => {
    const { dataDir, keyPath } = oldShape({ live: true, key: false });
    const before = snapshot(dataDir);

    expect(() => migrateAccounts({ dataDir, keyPath })).toThrow(/ssh key cannot be read/);
    // The path to put it back at, named: a refusal without it is a puzzle.
    expect(() => migrateAccounts({ dataDir, keyPath })).toThrow(new RegExp(keyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    expect(existsSync(join(dataDir, "accounts", "1"))).toBe(false);
    expect(snapshot(dataDir)).toEqual(before);
  });

  test("migrates a state that holds nothing, with no key at all", () => {
    // A service that has never ordered anything: there is no fleet to strand, so a fresh pair
    // at the first use is exactly right.
    const { dataDir, keyPath } = oldShape({ live: false, key: false });
    const lines = migrateAccounts({ dataDir, keyPath })?.lines ?? [];
    expect(existsSync(join(dataDir, "accounts", "1", "tf", "hetzner", "main.tf"))).toBe(true);
    expect(existsSync(join(dataDir, "accounts", "1", "home", ".ssh", "devbox"))).toBe(false);
    expect(lines.join("\n")).toContain("fresh pair");
  });

  test("removes the files the roots used to read up there, and names them", () => {
    const { dataDir, keyPath } = oldShape({ live: true, key: true });
    const lines = migrateAccounts({ dataDir, keyPath })?.lines ?? [];

    // The roots read them at ${path.module}/../../, which is accounts/1/ now: a prelude.sh
    // left at the top is a file someone reads in a year and believes.
    expect(existsSync(join(dataDir, "prelude.sh"))).toBe(false);
    expect(existsSync(join(dataDir, "cloud-init.yaml.tftpl"))).toBe(false);
    expect(lines.join("\n")).toContain("prelude.sh");
  });

  /**
   * Said even though nothing looks wrong, because this is the half that fails in SILENCE: a
   * profile deposited by hand at the old path would drop out of `devbox profiles` without an
   * error anywhere, until a seed died on "no profile named".
   */
  test("says where the profiles deposited by hand now live", () => {
    const { dataDir, keyPath } = oldShape({ live: true, key: true });
    const lines = migrateAccounts({ dataDir, keyPath })?.lines ?? [];
    expect(lines.join("\n")).toContain(join("accounts", "1", "config", "profiles"));
  });

  test("a second start finds accounts/1 and changes nothing at all", () => {
    const { dataDir, keyPath } = oldShape({ live: true, key: true });
    migrateAccounts({ dataDir, keyPath });
    const after = snapshot(dataDir);

    expect(migrateAccounts({ dataDir, keyPath })).toBeNull();
    expect(snapshot(dataDir)).toEqual(after);
  });

  test("does nothing on a data directory that never had the old shape", () => {
    drawn += 1;
    const dataDir = join(ROOT, `fresh-${drawn}`);
    mkdirSync(join(dataDir, "accounts"), { recursive: true });
    expect(migrateAccounts({ dataDir, keyPath: join(dataDir, "nowhere") })).toBeNull();
  });
});

describe("legacyKeyPath", () => {
  test("is DEVBOX_KEY, which may point anywhere at all", () => {
    // It is read from the environment rather than derived from DATA_DIR because that is where
    // it was: the deployment passes the path beside the key it names, outside the data
    // directory. The old SSH_KEY constant is gone, and this is the one reader left.
    expect(legacyKeyPath({ DEVBOX_KEY: "/run/secrets/devbox-key" })).toBe("/run/secrets/devbox-key");
    expect(legacyKeyPath({})).toEndWith(join(".ssh", "devbox"));
  });
});

/**
 * The fallback's directory, taken back out of account 1's tree.
 *
 * DEVBOX_SECRETS_DIR defaulted to DATA_DIR/config/secrets before accounts, and `config/` is one
 * of the directories the move gives to account 1. The default moved to DATA_DIR/shared/secrets
 * with it - so a workstation relying on it found its files carried into the tree, and the
 * fallback silently empty: every cloud they held gone from the list, and no error anywhere.
 */
describe("relocateSecrets", () => {
  /** A data directory whose old secrets directory went into the tree with the move. */
  function movedWithTheTree(): { dataDir: string; from: string; to: string } {
    const { dataDir, keyPath } = oldShape({ live: false, key: false });
    mkdirSync(join(dataDir, "config", "secrets"), { recursive: true });
    writeFileSync(join(dataDir, "config", "secrets", "github"), "ghp-from-the-default");
    migrateAccounts({ dataDir, keyPath });
    return {
      dataDir,
      from: join(dataDir, "accounts", "1", "config", "secrets"),
      to: join(dataDir, "shared", "secrets"),
    };
  }

  test("moves it where the default now points, and says so", () => {
    const { dataDir, from, to } = movedWithTheTree();
    expect(readFileSync(join(from, "github"), "utf8")).toBe("ghp-from-the-default");

    const relocation = relocateSecrets({ dataDir, secretsDirVariable: undefined });
    expect(relocation?.warnings).toEqual([]);
    expect(relocation?.lines.join("\n")).toContain(from);
    expect(relocation?.lines.join("\n")).toContain(to);

    expect(readFileSync(join(to, "github"), "utf8")).toBe("ghp-from-the-default");
    // Renamed, not copied: no second copy of a secret left behind on the disk.
    expect(existsSync(from)).toBe(false);
  });

  test("a second start moves nothing and says nothing", () => {
    const { dataDir } = movedWithTheTree();
    relocateSecrets({ dataDir, secretsDirVariable: undefined });
    const after = snapshot(dataDir);

    expect(relocateSecrets({ dataDir, secretsDirVariable: undefined })).toBeNull();
    expect(snapshot(dataDir)).toEqual(after);
  });

  test("leaves a deployment that names its own directory alone", () => {
    const { dataDir, from } = movedWithTheTree();
    const before = snapshot(dataDir);
    // Set, even to a path: the deployment knows where its secrets are, and this one is not it.
    expect(relocateSecrets({ dataDir, secretsDirVariable: "/run/devbox/secrets" })).toBeNull();
    expect(snapshot(dataDir)).toEqual(before);
    expect(existsSync(from)).toBe(true);
  });

  test("moves nothing when both exist, and names both, since one of them is read by nothing", () => {
    const { dataDir, from, to } = movedWithTheTree();
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "github"), "ghp-already-there");
    const before = snapshot(dataDir);

    const relocation = relocateSecrets({ dataDir, secretsDirVariable: undefined });
    expect(relocation?.lines).toEqual([]);
    expect(relocation?.warnings.join("\n")).toContain(from);
    expect(relocation?.warnings.join("\n")).toContain(to);
    expect(snapshot(dataDir)).toEqual(before);
  });
});
