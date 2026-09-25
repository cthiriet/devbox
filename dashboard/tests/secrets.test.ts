import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR, type Cloud } from "../src/config";
import { openDatabase } from "../src/database";
import { recordOrigin } from "../src/db";
import {
  chooseRuntime,
  engineEnv,
  mediumOf,
  prepareLaunch,
  privateDirectoryName,
  SecretsMissing,
  sweepLaunches,
} from "../src/engine";
import { applySchema } from "../src/schema";
import {
  checkedCandidates,
  checkedSecretValue,
  cloudGaps,
  clouds,
  cloudsThroughService,
  forgetSecret,
  heldValue,
  importSecrets,
  missing,
  missingSecrets,
  openVault,
  overview,
  ownCredentials,
  resolveSecret,
  sourcesFor,
  sourcesOf,
  storeSecret,
  vaultState,
  VaultClosed,
  type Sources,
  destroySourcesFor,
} from "../src/secrets";
import {
  deleteSecret,
  keyringFromEnv,
  newMasterKey,
  readSecret,
  setSecret,
  type Keyring,
} from "../src/vault";
import { accountTree } from "../src/tree";

/** Whose vault every Sources below is: stated, since no function has a default owner. */
const OWNER_SELF = 1;

/**
 * And whose TREE, which a launch needs as well as a vault: prepareLaunch refuses the pair when
 * the two name two accounts, so both are that of OWNER_SELF here.
 */
const TREE = accountTree(OWNER_SELF);

/**
 * Where a secret comes from, and where it goes.
 *
 * The vault itself - sealing, contexts, rotation - is tests/vault.test.ts. What is pinned
 * here is the layer the service stands on: the database first and the fallback after, in one
 * place; the answers derived from that (clouds, missing, the profiles' secrets, the page);
 * and the directory a launch is handed, which is the one place a sealed value ever exists
 * decrypted outside this process.
 *
 * The check that started this file still runs through all of it. devbox asks for a missing
 * secret at the keyboard, and a systemd service has no keyboard: the seed dies on "empty,
 * nothing sent" three minutes in, with a machine already ordered and billing. The refusal is
 * only worth anything if it fires before the order.
 *
 * Every database and directory is fresh, under .test-data; nothing here is the service's.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const ROOT = join(DATA_DIR, "secrets-test");
let drawn = 0;

function freshDatabase(): Database {
  mkdirSync(ROOT, { recursive: true });
  drawn += 1;
  const db = openDatabase(join(ROOT, `vault-${drawn}.db`));
  applySchema(db);
  return db;
}

function directory(name: string): string {
  const path = join(ROOT, `${name}-${++drawn}`);
  mkdirSync(path, { recursive: true });
  return path;
}

function ring(key = newMasterKey(1)): Keyring {
  const keyring = keyringFromEnv({ DEVBOX_MASTER_KEY: key });
  if (keyring === null) throw new Error("expected a keyring");
  return keyring;
}

/**
 * A vault that opens, a fallback environment and a fallback directory, all the test's own.
 *
 * The directory is narrowed back to a string: a Sources no longer promises one, an account
 * without the service's fallback having none, and these tests write files into theirs.
 */
function sources(
  env: Record<string, string> = {},
  keyring: Keyring | null = ring(),
): Sources & { secretsDir: string } {
  const secretsDir = directory("legacy");
  return { ...sourcesOf({ db: freshDatabase(), owner: OWNER_SELF, keyring, env, secretsDir }), secretsDir };
}

/** The same database and files, with the master key gone - or wrong. */
const closed = (open: Sources): Sources => ({ ...open, keyring: null });

const set = (at: Sources, kind: "cloud" | "profile", name: string, value: string) =>
  setSecret(at.db, at.keyring as Keyring, at.owner, kind, name, value, 1);

/**
 * A file this process cannot read, or null where chmod does not stop it - root, on a runner
 * that tests as root. A test that needs one says so by skipping, rather than passing on a
 * file that was never unreadable.
 */
function unreadable(path: string, content: string): string | null {
  writeFileSync(path, content);
  chmodSync(path, 0o000);
  try {
    accessSync(path, constants.R_OK);
    chmodSync(path, 0o600);
    return null;
  } catch {
    return path;
  }
}

describe("resolveSecret", () => {
  test("a cloud variable: the environment, until the vault holds one, and again after", () => {
    const at = sources({ HCLOUD_TOKEN: "hc-from-the-unit" });
    expect(resolveSecret("cloud", "HCLOUD_TOKEN", at)).toEqual({
      set: true,
      source: "env",
      fingerprint: null,
      updated_at: null,
    });

    const meta = set(at, "cloud", "HCLOUD_TOKEN", "hc-from-the-page");
    expect(resolveSecret("cloud", "HCLOUD_TOKEN", at)).toEqual({
      set: true,
      source: "db",
      fingerprint: meta.fingerprint,
      updated_at: 1,
    });

    expect(forgetSecret("cloud", "HCLOUD_TOKEN", 2, at)).toEqual({ deleted: true, fallback: "env" });
    expect(resolveSecret("cloud", "HCLOUD_TOKEN", at).source).toBe("env");
  });

  test("a profile secret: the file, until the vault holds one, and again after", () => {
    const at = sources();
    writeFileSync(join(at.secretsDir, "github"), "ghp_from_the_file");
    expect(resolveSecret("profile", "github", at).source).toBe("file");

    set(at, "profile", "github", "ghp_from_the_page");
    expect(resolveSecret("profile", "github", at).source).toBe("db");

    expect(forgetSecret("profile", "github", 2, at)).toEqual({ deleted: true, fallback: "file" });
    expect(resolveSecret("profile", "github", at).source).toBe("file");
  });

  test("the GCP key: a file in the fallback, like a profile secret, under the cloud's kind", () => {
    const at = sources();
    writeFileSync(join(at.secretsDir, "gcp"), '{"client_email":"x"}');
    expect(resolveSecret("cloud", "gcp", at).source).toBe("file");
    // Not a profile secret, whatever the directory holds: the name is the cloud's.
    expect(resolveSecret("profile", "gcp", at).set).toBe(false);
  });

  test("the vault alone, with nothing behind it: gone once deleted", () => {
    const at = sources();
    set(at, "profile", "claude", "sk-only-here");
    expect(forgetSecret("profile", "claude", 2, at)).toEqual({ deleted: true, fallback: null });
    expect(resolveSecret("profile", "claude", at)).toEqual({
      set: false,
      source: null,
      fingerprint: null,
      updated_at: null,
    });
  });

  test("a closed vault is no source at all, and the fallback answers in its place", () => {
    // Without the master key no sealed row opens: calling it held would promise a job a value
    // it cannot have. What the next job gets is the fallback - or nothing.
    const at = sources({ HCLOUD_TOKEN: "hc-from-the-unit" });
    set(at, "cloud", "HCLOUD_TOKEN", "hc-from-the-page");
    set(at, "profile", "claude", "sk-only-here");
    expect(resolveSecret("cloud", "HCLOUD_TOKEN", closed(at)).source).toBe("env");
    expect(resolveSecret("profile", "claude", closed(at)).set).toBe(false);
  });

  test("an empty file or an empty variable is nothing, as devbox-core's `[ -s ]` has it", () => {
    const at = sources({ SCW_SECRET_KEY: "" });
    writeFileSync(join(at.secretsDir, "github"), "");
    mkdirSync(join(at.secretsDir, "a-directory"));
    expect(resolveSecret("cloud", "SCW_SECRET_KEY", at).set).toBe(false);
    expect(resolveSecret("profile", "github", at).set).toBe(false);
    expect(resolveSecret("profile", "a-directory", at).set).toBe(false);
  });

  test("a reserved name has no fallback, so a profile cannot pull the cloud's key into a machine", () => {
    const at = sources();
    writeFileSync(join(at.secretsDir, "remote"), "the-dashboard-token");
    writeFileSync(join(at.secretsDir, "gcp"), "{}");
    expect(missingSecrets(["remote", "gcp", "../gcp"], at)).toEqual(["remote", "gcp", "../gcp"]);
  });

  /**
   * Found on 11/09: a `gcp` deposited under the wrong owner
   * passed a stat, GCP read as orderable, and every job then died on EACCES laying it out -
   * the `down` of a Hetzner machine included.
   */
  test("a file this process cannot read is nothing, whatever a stat says of it", () => {
    const at = sources({ DEVBOX_GCP_PROJECT: "acme-devbox-000000", HCLOUD_TOKEN: "hc" });
    const key = unreadable(join(at.secretsDir, "gcp"), '{"client_email":"x"}');
    const github = unreadable(join(at.secretsDir, "github"), "ghp_x");
    try {
      if (key === null || github === null) return; // root reads everything: nothing to show
      expect(resolveSecret("cloud", "gcp", at).set).toBe(false);
      expect(clouds(at)).toEqual(["hetzner"]);
      // A profile secret that cannot be read is missing, and a seed is refused before ordering.
      expect(missingSecrets(["github"], at)).toEqual(["github"]);
      expect(() => prepareLaunch(TREE, { clouds: [], profile: ["github"] }, at, join(ROOT, "runtime"))).toThrow(
        SecretsMissing,
      );
    } finally {
      if (key !== null) chmodSync(key, 0o600);
      if (github !== null) chmodSync(github, 0o600);
    }
  });
});

describe("clouds and missing", () => {
  test("order from a cloud whose tokens are in the vault and nowhere else", () => {
    const at = sources();
    expect(clouds(at)).toEqual([]);
    set(at, "cloud", "HCLOUD_TOKEN", "hc-vault-only");
    expect(clouds(at)).toEqual(["hetzner"]);

    set(at, "cloud", "SCW_SECRET_KEY", "scw-secret");
    set(at, "cloud", "SCW_DEFAULT_PROJECT_ID", "scw-project");
    expect(clouds(at)).toEqual(["hetzner"]);
    set(at, "cloud", "SCW_ACCESS_KEY", "SCWACCESS");
    expect(clouds(at)).toEqual(["hetzner", "scaleway"]);

    set(at, "cloud", "gcp", '{"client_email":"x"}');
    expect(clouds(at)).not.toContain("gcp");
    set(at, "cloud", "DEVBOX_GCP_PROJECT", "acme-devbox-000000");
    expect(clouds(at)).toEqual(["hetzner", "scaleway", "gcp"]);

    // And without the master key, none of it can be read - so none of it is orderable.
    expect(clouds(closed(at))).toEqual([]);
  });

  test("missing names HCLOUD_TOKEN until it resolves, wherever from", () => {
    const at = sources();
    expect(missing(at)).toContain("HCLOUD_TOKEN");
    set(at, "cloud", "HCLOUD_TOKEN", "hc-vault-only");
    expect(missing(at)).not.toContain("HCLOUD_TOKEN");
    expect(missing(sources({ HCLOUD_TOKEN: "hc-from-the-unit" }, null))).not.toContain("HCLOUD_TOKEN");
  });

  test("a service that orders from Scaleway alone is not missing HCLOUD_TOKEN", () => {
    const at = sources();
    set(at, "cloud", "SCW_ACCESS_KEY", "SCWAAAAAAAAAAAAAAAAA");
    set(at, "cloud", "SCW_SECRET_KEY", "scw-secret");
    set(at, "cloud", "SCW_DEFAULT_PROJECT_ID", "scw-project");
    expect(clouds(at)).toEqual(["scaleway"]);
    expect(missing(at)).not.toContain("HCLOUD_TOKEN");
  });

  test("cloudGaps names what one cloud lacks, and nothing once it is usable", () => {
    // What the destroy route says before refusing: the names to set, not a generic "no".
    const at = sources({ SCW_SECRET_KEY: "scw-from-the-unit" });
    expect(cloudGaps("hetzner", at)).toEqual(["HCLOUD_TOKEN"]);
    expect(cloudGaps("scaleway", at)).toEqual(["SCW_ACCESS_KEY", "SCW_DEFAULT_PROJECT_ID"]);
    set(at, "cloud", "HCLOUD_TOKEN", "hc");
    expect(cloudGaps("hetzner", at)).toEqual([]);
    expect(cloudGaps("hetzner", closed(at))).toEqual(["HCLOUD_TOKEN"]);
  });
});

describe("missingSecrets", () => {
  test("reads the vault first", () => {
    const at = sources();
    set(at, "profile", "github", "ghp_vault");
    expect(missingSecrets(["claude", "github"], at)).toEqual(["claude"]);
  });

  test("names the one whose file was never deposited", () => {
    const at = sources({}, null);
    writeFileSync(join(at.secretsDir, "github"), "ghp_x");
    expect(missingSecrets(["claude", "github"], at)).toEqual(["claude"]);
  });

  test("is empty when every one is held, which is what allows a seed", () => {
    const at = sources();
    writeFileSync(join(at.secretsDir, "claude"), "sk-x");
    set(at, "profile", "github", "ghp_y");
    expect(missingSecrets(["claude", "github"], at)).toEqual([]);
  });

  test("treats an empty file as absent", () => {
    // A vault line left blank deposits a zero-length file. Counted as present, devbox would
    // push it into /run/secrets and the profile would fail on an authentication inside a
    // running machine rather than here, on a secret that was never supplied.
    const at = sources({}, null);
    writeFileSync(join(at.secretsDir, "claude"), "");
    expect(missingSecrets(["claude"], at)).toEqual(["claude"]);
  });

  test("is empty for a profile that declares none", () => {
    // Most profiles declare nothing. Refusing them would close the dashboard on the case
    // it is used for most.
    expect(missingSecrets([], sources())).toEqual([]);
  });

  test("another account orders on the service's cloud accounts, whole or not at all, never on its profile secrets", () => {
    // Since 13/09 the founder's vault holds the service's cloud accounts, and the unit and the
    // `gcp` file stand behind it: every account orders on them. A token deposited for the
    // founder's profiles is the founder's alone, in the vault as on the disk.
    const founder = sources({ HCLOUD_TOKEN: "hc-from-the-unit" });
    const keyring = founder.keyring;
    if (keyring === null) throw new Error("a vault that opens was expected");
    writeFileSync(join(founder.secretsDir, "github"), "ghp_from_the_file");
    for (const [name, value] of [
      ["SCW_ACCESS_KEY", "SCWFOUNDERFOUNDERFOU"],
      ["SCW_SECRET_KEY", "founder-scw-secret"],
      ["SCW_DEFAULT_PROJECT_ID", "founder-scw-project"],
    ] as const) {
      setSecret(founder.db, keyring, OWNER_SELF, "cloud", name, value, 1);
    }
    setSecret(founder.db, keyring, OWNER_SELF, "profile", "claude", "sk-ant-oat01-founder", 1);

    const other = sourcesOf({
      db: founder.db,
      owner: 2,
      keyring,
      env: founder.env,
      secretsDir: founder.secretsDir,
      service: OWNER_SELF,
      profileFiles: false,
    });
    const text = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

    // The service's, said as the service's: never another account's fingerprint or date.
    expect(clouds(other)).toEqual(["hetzner", "scaleway"]);
    expect(resolveSecret("cloud", "SCW_SECRET_KEY", other)).toEqual({
      set: true,
      source: "service",
      fingerprint: null,
      updated_at: null,
    });
    expect(text(heldValue("cloud", "SCW_SECRET_KEY", other))).toBe("founder-scw-secret");
    expect(text(heldValue("cloud", "HCLOUD_TOKEN", other))).toBe("hc-from-the-unit");
    // Its page describes its OWN credentials, of which there are none.
    const scaleway = overview([], [], other).clouds.find((one) => one.cloud === "scaleway");
    expect(scaleway).toMatchObject({ usable: true, via: "service" });
    expect(scaleway?.fields.every((field) => !field.set)).toBe(true);

    // Profile secrets are never the service's: not the founder's vault, not its files.
    expect(missingSecrets(["claude", "github"], other)).toEqual(["claude", "github"]);
    expect(heldValue("profile", "claude", other)).toBeNull();
    expect(heldValue("profile", "github", other)).toBeNull();

    // One key of its own makes the cloud its own, whole: no pair made of two accounts' halves.
    setSecret(founder.db, keyring, 2, "cloud", "SCW_ACCESS_KEY", "SCWOTHEROTHEROTHEROT", 2);
    expect(clouds(other)).toEqual(["hetzner"]);
    expect(resolveSecret("cloud", "SCW_SECRET_KEY", other).set).toBe(false);
    expect(heldValue("cloud", "SCW_SECRET_KEY", other)).toBeNull();
    expect(text(heldValue("cloud", "SCW_ACCESS_KEY", other))).toBe("SCWOTHEROTHEROTHEROT");
    // Orphans: the other account shares Hetzner with the founder, and Scaleway with nobody.
    expect(cloudsThroughService(other, [OWNER_SELF], new Set())).toEqual(["hetzner"]);
    expect(cloudsThroughService(founder, [2], new Set())).toEqual(["hetzner"]);
    expect(cloudsThroughService(founder, [], new Set())).toEqual([]);
    // Nor with anyone on them today - but an account holds a machine it ordered on the founder's
    // Scaleway, and that machine would list as the founder's orphan.
    expect(cloudsThroughService(founder, [], new Set(["scaleway"]))).toEqual(["scaleway"]);

    // Its own gone, the service answers again - and DELETE says whose.
    expect(forgetSecret("cloud", "SCW_ACCESS_KEY", 3, other)).toEqual({ deleted: true, fallback: "service" });
    expect(clouds(other)).toEqual(["hetzner", "scaleway"]);

    // What a route builds with no extension: the stranger reads nothing of the service's - no
    // second tier, no environment, no files. An extension puts it on the service's cloud
    // accounts (tests/extension-api.test.ts); the founder alone reads the profile files.
    const stranger = sourcesFor({ id: 2, email: "b@devbox.test" });
    expect([stranger.service, stranger.profileFiles, stranger.secretsDir, Object.keys(stranger.env)]).toEqual([null, false, null, []]);
    expect(clouds(stranger)).toEqual([]);
    // Nor is a destroy handed them for being a destroy: only for a machine ordered on them, and for
    // that machine's cloud alone - see "a destroy's credentials" below.
    expect(destroySourcesFor({ id: 2, email: "b@devbox.test" }, "devbox-never-ordered", "hetzner")).toMatchObject({
      service: null,
      secretsDir: null,
    });
    const self = sourcesFor({ id: OWNER_SELF, email: "a@devbox.test" });
    // The founder has no second tier: its vault, environment and files are the service's own.
    expect([self.service, self.profileFiles, self.secretsDir !== null]).toEqual([null, true, true]);
  });

  test("names everything when the directory itself does not exist", () => {
    // The mount can be missing, on a workstation or on a unit deployed before the vault
    // wrote anything. A throw here would answer 500 instead of naming what to deposit.
    const at = { ...sources({}, null), secretsDir: join(ROOT, "never-created") };
    expect(missingSecrets(["claude", "github"], at)).toEqual(["claude", "github"]);
  });
});

/**
 * What a destroy is handed: the credentials its machine was ordered with, and no others. The route
 * itself, with and without an extension, is tests/destroy-api.test.ts; what is pinned here is the
 * resolution under it.
 */
describe("a destroy's credentials", () => {
  const text = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

  test("a tier narrowed to one cloud answers it from the service whole, and every other from the account's vault alone", () => {
    const founder = sources({ HCLOUD_TOKEN: "hc-from-the-unit", SCW_SECRET_KEY: "scw-secret-from-the-unit" });
    const keyring = founder.keyring;
    if (keyring === null) throw new Error("a vault that opens was expected");
    setSecret(founder.db, keyring, OWNER_SELF, "cloud", "SCW_ACCESS_KEY", "SCWFOUNDERFOUNDERFOU", 1);
    setSecret(founder.db, keyring, OWNER_SELF, "cloud", "SCW_DEFAULT_PROJECT_ID", "founder-scw-project", 1);
    const parts = {
      db: founder.db,
      owner: 2,
      keyring,
      env: founder.env,
      secretsDir: founder.secretsDir,
      service: OWNER_SELF,
      profileFiles: false,
    };
    const everyday = sourcesOf(parts);
    const narrowed = sourcesOf({ ...parts, serviceClouds: new Set<Cloud>(["hetzner"]) });

    // Unnarrowed, the service answers Scaleway too: the narrowing is what keeps it out.
    expect(clouds(everyday)).toEqual(["hetzner", "scaleway"]);
    expect(clouds(narrowed)).toEqual(["hetzner"]);
    expect(text(heldValue("cloud", "HCLOUD_TOKEN", narrowed))).toBe("hc-from-the-unit");
    for (const name of ["SCW_ACCESS_KEY", "SCW_SECRET_KEY", "SCW_DEFAULT_PROJECT_ID"]) {
      expect(heldValue("cloud", name, narrowed), name).toBeNull();
      expect(resolveSecret("cloud", name, narrowed).set, name).toBe(false);
    }

    // A token the account connected since does not take the destroy to its own provider account,
    // where a machine ordered on the service's does not live.
    setSecret(founder.db, keyring, 2, "cloud", "HCLOUD_TOKEN", "hc-of-its-own", 2);
    expect(text(heldValue("cloud", "HCLOUD_TOKEN", everyday))).toBe("hc-of-its-own");
    expect(text(heldValue("cloud", "HCLOUD_TOKEN", narrowed))).toBe("hc-from-the-unit");
    expect(resolveSecret("cloud", "HCLOUD_TOKEN", narrowed)).toMatchObject({ set: true, source: "service" });

    // Outside the narrowing, a key of its own is its own, and nothing of the service's completes it.
    setSecret(founder.db, keyring, 2, "cloud", "SCW_ACCESS_KEY", "SCWOWNOWNOWNOWNOWNOW", 3);
    expect(text(heldValue("cloud", "SCW_ACCESS_KEY", narrowed))).toBe("SCWOWNOWNOWNOWNOWNOW");
    expect(heldValue("cloud", "SCW_SECRET_KEY", narrowed)).toBeNull();

    // And ownCredentials takes the tier off whole.
    const own = ownCredentials(narrowed);
    expect([own.service, own.serviceClouds, own.secretsDir]).toEqual([null, null, null]);
    expect(text(heldValue("cloud", "HCLOUD_TOKEN", own))).toBe("hc-of-its-own");
  });

  test("destroySourcesFor hands the service's tier only for a machine recorded as ordered on it, on the cloud its state names", () => {
    const bob = { id: 2, email: "b@devbox.test" };
    recordOrigin(2, { machine: "devbox-unit-svc", cloud: "hetzner", via: "service", orderedAt: 1 });
    recordOrigin(2, { machine: "devbox-unit-own", cloud: "hetzner", via: "own", orderedAt: 2 });

    const serviced = destroySourcesFor(bob, "devbox-unit-svc", "hetzner");
    expect([serviced.service, [...(serviced.serviceClouds ?? [])], serviced.profileFiles]).toEqual([
      OWNER_SELF,
      ["hetzner"],
      false,
    ]);

    // Its own origin, a row naming another cloud, no cloud known, and no row with no extension
    // installed: its own vault alone, every time.
    const cases: [string, Cloud | undefined][] = [
      ["devbox-unit-own", "hetzner"],
      ["devbox-unit-svc", "scaleway"],
      ["devbox-unit-svc", undefined],
      ["devbox-unit-never", "hetzner"],
    ];
    for (const [machine, cloud] of cases) {
      expect(destroySourcesFor(bob, machine, cloud), `${machine} on ${String(cloud)}`).toMatchObject({
        service: null,
        serviceClouds: null,
        secretsDir: null,
        profileFiles: false,
      });
    }

    // A name ordered again on its own credentials is a machine of its own.
    recordOrigin(2, { machine: "devbox-unit-svc", cloud: "hetzner", via: "own", orderedAt: 3 });
    expect(destroySourcesFor(bob, "devbox-unit-svc", "hetzner").service).toBeNull();

    // The founder has nothing to choose: its vault, environment and files are the service's.
    const founder = destroySourcesFor({ id: OWNER_SELF, email: "a@devbox.test" }, "devbox-unit-svc", "hetzner");
    expect([founder.service, founder.profileFiles]).toEqual([null, true]);
  });
});

describe("overview", () => {
  test("names every secret and carries no byte of any value", () => {
    const at = sources({ SCW_SECRET_KEY: "scw-secret-from-the-unit-QZXW" });
    set(at, "cloud", "HCLOUD_TOKEN", "hc-vault-QZXW");
    set(at, "profile", "claude", "sk-vault-QZXW");
    set(at, "profile", "orphaned", "no-profile-declares-this-QZXW");
    writeFileSync(join(at.secretsDir, "github"), "ghp_file_QZXW");
    writeFileSync(join(at.secretsDir, "gcp"), '{"private_key":"-----BEGIN QZXW"}');
    writeFileSync(join(at.secretsDir, "remote"), "dashboard-token-QZXW");

    const answer = overview(
      [
        { name: "claude", secrets: ["claude", "github"] },
        { name: "bare", secrets: [] },
        { name: "openai", secrets: ["openai"] },
      ],
      [
        { name: "devbox-aaaaa", profile: "claude", cloud: "hetzner" },
        { name: "devbox-bbbbb", profile: null, cloud: "gcp" },
        { name: "devbox-ccccc", profile: null, cloud: "hetzner" },
      ],
      at,
      { available: true },
    );

    const serialised = JSON.stringify(answer);
    expect(serialised).not.toContain("QZXW");
    expect(serialised).not.toContain("BEGIN");

    expect(answer.vault).toEqual({ available: true });
    expect(answer.clouds.map((c) => [c.cloud, c.usable])).toEqual([
      ["hetzner", true],
      ["scaleway", false],
      ["gcp", false],
    ]);
    // What each cloud's credentials are still needed to destroy: the page's delete dialog
    // names them, and GCP's are listed though GCP cannot be ordered from any more.
    expect(answer.clouds.map((c) => [c.cloud, c.machines])).toEqual([
      ["hetzner", ["devbox-aaaaa", "devbox-ccccc"]],
      ["scaleway", []],
      ["gcp", ["devbox-bbbbb"]],
    ]);
    const scaleway = answer.clouds[1]?.fields.map((f) => [f.name, f.set, f.source]);
    expect(scaleway).toEqual([
      ["SCW_ACCESS_KEY", false, null],
      ["SCW_SECRET_KEY", true, "env"],
      ["SCW_DEFAULT_PROJECT_ID", false, null],
    ]);
    expect(answer.clouds[2]?.fields[0]).toMatchObject({ name: "gcp", multiline: true, source: "file" });

    // Declared, held, or in the fallback - and `gcp` and `remote` are not profile secrets.
    expect(answer.profile).toEqual([
      {
        name: "claude",
        set: true,
        source: "db",
        fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
        updated_at: 1,
        used_by: ["claude"],
        machines: ["devbox-aaaaa"],
      },
      {
        name: "github",
        set: true,
        source: "file",
        fingerprint: null,
        updated_at: null,
        used_by: ["claude"],
        machines: ["devbox-aaaaa"],
      },
      { name: "openai", set: false, source: null, fingerprint: null, updated_at: null, used_by: ["openai"], machines: [] },
      { name: "orphaned", set: true, source: "db", fingerprint: expect.any(String), updated_at: 1, used_by: [], machines: [] },
    ]);
  });

  test("still answers with no profile and no machine, which is what an engine that failed gives", () => {
    const at = sources();
    set(at, "profile", "claude", "sk-x");
    const answer = overview([], [], at, { available: true });
    expect(answer.profile.map((p) => [p.name, p.used_by, p.machines])).toEqual([["claude", [], []]]);
  });
});

describe("writing", () => {
  test("refuses to write while the vault is closed, and says why", () => {
    const at = closed(sources());
    expect(() => storeSecret("profile", "github", "ghp_x", 1, at)).toThrow(VaultClosed);
    expect(() => importSecrets(1, at)).toThrow(VaultClosed);
  });

  test("leaves nothing in the WAL after a secret write: it is on the disk, synced", () => {
    // synchronous = NORMAL spares the fsync at commit, and a power cut could lose a
    // rotation; the checkpoint after each secret write is that fsync, taken on purpose.
    const at = sources();
    const path = at.db.filename;
    storeSecret("profile", "github", "ghp_durable", 1, at);
    expect(statSync(`${path}-wal`).size).toBe(0);
    forgetSecret("profile", "github", 2, at);
    expect(statSync(`${path}-wal`).size).toBe(0);
  });

  test("imports once, and a second import changes nothing", () => {
    const at = sources({ HCLOUD_TOKEN: "hc-from-the-unit" });
    writeFileSync(join(at.secretsDir, "github"), "ghp_from_the_file");
    const first = importSecrets(1, at);
    const second = importSecrets(2, at);
    expect(first.imported).toEqual(["cloud/HCLOUD_TOKEN", "profile/github"]);
    expect(second.imported).toEqual([]);
    expect(second.skipped.every((line) => line.endsWith("already in the database, same value"))).toBe(true);
    expect(resolveSecret("profile", "github", at).source).toBe("db");
  });

  test("a single-line credential is one line; a multiline one and a profile secret are not held to it", () => {
    expect(checkedSecretValue("cloud", "HCLOUD_TOKEN", "token\n").ok).toBe(true);
    expect(checkedSecretValue("cloud", "HCLOUD_TOKEN", "tok\nen").ok).toBe(false);
    expect(checkedSecretValue("cloud", "HCLOUD_TOKEN", `tok${String.fromCharCode(0)}en`).ok).toBe(false);
    expect(checkedSecretValue("cloud", "gcp", '{\n  "a": 1\n}\n').ok).toBe(true);
    expect(checkedSecretValue("profile", "ssh-key", "-----BEGIN\nline\n-----END\n").ok).toBe(true);
    expect(checkedSecretValue("profile", "github", 42).ok).toBe(false);
  });

  test("candidates for a test are the bytes the vault would store, and only that cloud's", () => {
    const checked = checkedCandidates("hetzner", { HCLOUD_TOKEN: "hc-candidate\n" });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(new TextDecoder().decode(checked.value.HCLOUD_TOKEN)).toBe("hc-candidate");

    for (const values of [{ SCW_SECRET_KEY: "x" }, { HCLOUD_TOKEN: "" }, { HCLOUD_TOKEN: 7 }, ["x"]]) {
      const refused = checkedCandidates("hetzner", values);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.field).toBe("values");
        expect(refused.reason).not.toContain("hc-candidate");
      }
    }
  });
});

describe("prepareLaunch", () => {
  const RUNTIME = join(ROOT, "runtime");
  mkdirSync(RUNTIME, { recursive: true });

  test("lays out the cloud key and the profile secrets asked for, 0400 in 0700, and nothing else", () => {
    const at = sources({ SCW_SECRET_KEY: "scw-from-the-unit", DEVBOX_GCP_PROJECT: "acme" });
    set(at, "cloud", "HCLOUD_TOKEN", "hc-from-the-page");
    set(at, "cloud", "gcp", '{"client_email":"from-the-page"}');
    set(at, "profile", "claude", "sk-from-the-page");
    writeFileSync(join(at.secretsDir, "github"), "ghp_from_the_file\n");
    writeFileSync(join(at.secretsDir, "openai"), "sk-not-asked-for");

    const launch = prepareLaunch(TREE, { clouds: ["hetzner", "scaleway", "gcp"], profile: ["claude", "github"] }, at, RUNTIME);
    try {
      const secrets = launch.env.DEVBOX_SECRETS_DIR ?? "";
      expect(secrets).toBe(join(launch.directory, "secrets"));
      expect(statSync(launch.directory).mode & 0o777).toBe(0o700);
      expect(statSync(secrets).mode & 0o777).toBe(0o700);
      expect(readdirSync(secrets).sort()).toEqual(["claude", "gcp", "github"]);
      for (const name of readdirSync(secrets)) expect(statSync(join(secrets, name)).mode & 0o777).toBe(0o400);

      expect(readFileSync(join(secrets, "claude"), "utf8")).toBe("sk-from-the-page");
      expect(readFileSync(join(secrets, "gcp"), "utf8")).toBe('{"client_email":"from-the-page"}');
      // Copied as it is: this is the byte for byte of what devbox-core read before.
      expect(readFileSync(join(secrets, "github"), "utf8")).toBe("ghp_from_the_file\n");

      expect(launch.env).toMatchObject({
        HCLOUD_TOKEN: "hc-from-the-page",
        SCW_SECRET_KEY: "scw-from-the-unit",
        DEVBOX_GCP_PROJECT: "acme",
      });
      expect(Object.keys(launch.env)).not.toContain("SCW_ACCESS_KEY");
      expect(launch.unset).toEqual(
        expect.arrayContaining(["GOOGLE_APPLICATION_CREDENTIALS", "DEVBOX_CLAUDE_TOKEN", "DEVBOX_GITHUB_TOKEN"]),
      );
    } finally {
      launch.dispose();
    }
    expect(existsSync(launch.directory)).toBe(false);
    launch.dispose(); // idempotent
  });

  test("hands a launch that needs nothing an empty directory and no credential", () => {
    const at = sources({ HCLOUD_TOKEN: "hc-from-the-unit" });
    writeFileSync(join(at.secretsDir, "github"), "ghp_x");
    const launch = prepareLaunch(TREE, { clouds: [], profile: [] }, at, RUNTIME);
    try {
      expect(readdirSync(launch.env.DEVBOX_SECRETS_DIR ?? "")).toEqual([]);
      expect(launch.env).toEqual({ DEVBOX_SECRETS_DIR: join(launch.directory, "secrets") });
      expect(engineEnv(TREE, launch).HCLOUD_TOKEN).toBeUndefined();
    } finally {
      launch.dispose();
    }
  });

  test("tries an override in place of what is held, and gives a test a cache of its own", () => {
    const at = sources({ HCLOUD_TOKEN: "hc-held" });
    const launch = prepareLaunch(
      TREE,
      { clouds: ["hetzner"], profile: [], override: { HCLOUD_TOKEN: new TextEncoder().encode("hc-tried") }, cache: true },
      at,
      RUNTIME,
    );
    try {
      expect(launch.env.HCLOUD_TOKEN).toBe("hc-tried");
      expect(launch.env.DEVBOX_CACHE_DIR).toBe(join(launch.directory, "cache"));
      expect(engineEnv(TREE, launch).DEVBOX_CACHE_DIR).toBe(join(launch.directory, "cache"));
    } finally {
      launch.dispose();
    }
    expect(existsSync(join(launch.directory, "cache"))).toBe(false);
  });

  test("refuses a profile secret nothing holds, and leaves no directory behind", () => {
    const at = sources();
    set(at, "profile", "claude", "sk-x");
    const before = readdirSync(RUNTIME);
    expect(() => prepareLaunch(TREE, { clouds: [], profile: ["claude", "github"] }, at, RUNTIME)).toThrow(SecretsMissing);
    expect(readdirSync(RUNTIME)).toEqual(before);
  });

  test("never lays out a row under a name today's rule refuses: it would be a path", () => {
    // What a rule tightened after the write, or a write to the table, would leave behind.
    const at = sources();
    set(at, "profile", "github", "ghp_x");
    at.db.run("UPDATE secrets SET name = '../escape'");
    expect(resolveSecret("profile", "../escape", at).set).toBe(false);
    const before = readdirSync(RUNTIME);
    expect(() => prepareLaunch(TREE, { clouds: [], profile: ["../escape"] }, at, RUNTIME)).toThrow(SecretsMissing);
    expect(readdirSync(RUNTIME)).toEqual(before);
    expect(existsSync(join(RUNTIME, "escape"))).toBe(false);
  });

  test("throws on a row that does not open rather than falling back to the file", () => {
    // readSecret's own rule, kept: a null would read as "not in the vault", and the stale file
    // would be handed over in its place.
    const at = sources();
    set(at, "profile", "github", "ghp_rotated");
    writeFileSync(join(at.secretsDir, "github"), "ghp_stale");
    at.db.run("UPDATE secrets SET nonce = zeroblob(12)");
    const before = readdirSync(RUNTIME);
    expect(() => prepareLaunch(TREE, { clouds: [], profile: ["github"] }, at, RUNTIME)).toThrow(/does not open/);
    expect(readdirSync(RUNTIME)).toEqual(before);
  });

  /**
   * One cloud's credential is not every cloud's, found on 11/09: a job is handed
   * every cloud, and a `gcp` that no longer opened refused the `down` of a Hetzner machine.
   */
  test("leaves out a cloud whose credential does not open, says why, and hands the others", () => {
    const at = sources({ DEVBOX_GCP_PROJECT: "acme-devbox-000000" });
    set(at, "cloud", "HCLOUD_TOKEN", "hc-still-fine");
    set(at, "cloud", "gcp", '{"client_email":"sealed"}');
    writeFileSync(join(at.secretsDir, "gcp"), '{"client_email":"stale-file"}');
    at.db.run("UPDATE secrets SET nonce = zeroblob(12) WHERE name = 'gcp'");

    const launch = prepareLaunch(TREE, { clouds: ["hetzner", "gcp"], profile: [] }, at, RUNTIME);
    try {
      expect(launch.env.HCLOUD_TOKEN).toBe("hc-still-fine");
      // All of GCP or none of it: not the project without the key, and never the stale file.
      expect(launch.env.DEVBOX_GCP_PROJECT).toBeUndefined();
      expect(readdirSync(launch.env.DEVBOX_SECRETS_DIR ?? "")).toEqual([]);
      expect(launch.unset).toContain("GOOGLE_APPLICATION_CREDENTIALS");
      expect(launch.skipped).toEqual([
        { cloud: "gcp", reason: expect.stringContaining("cloud/gcp of owner 1 does not open") },
      ]);
      expect(JSON.stringify(launch.skipped)).not.toContain("client_email");
    } finally {
      launch.dispose();
    }
  });

  test("a profile secret stays strict when a cloud's credential is left out", () => {
    const at = sources();
    set(at, "cloud", "gcp", "{}");
    at.db.run("UPDATE secrets SET nonce = zeroblob(12) WHERE name = 'gcp'");
    const before = readdirSync(RUNTIME);
    expect(() => prepareLaunch(TREE, { clouds: ["gcp"], profile: ["claude"] }, at, RUNTIME)).toThrow(SecretsMissing);
    expect(readdirSync(RUNTIME)).toEqual(before);
  });
});

describe("the runtime directory", () => {
  const uid = process.getuid?.() ?? 0;

  test("sweeps what a crash left, and nothing that is not a launch", () => {
    const root = directory("sweep");
    mkdirSync(join(root, "launch-AAAAAA", "secrets"), { recursive: true });
    writeFileSync(join(root, "launch-AAAAAA", "secrets", "github"), "ghp_left_by_a_crash");
    mkdirSync(join(root, "launch-BBBBBB"));
    mkdirSync(join(root, "someone-else"));
    writeFileSync(join(root, "a-file"), "kept");

    expect(sweepLaunches(root)).toEqual({ swept: 2, kept: [] });
    expect(readdirSync(root).sort()).toEqual(["a-file", "someone-else"]);
    expect(sweepLaunches(join(root, "never-created"))).toEqual({ swept: 0, kept: [] });
  });

  /**
   * Found on 11/09: one `launch-*` rm could not remove threw
   * out of server.ts's top level, and the service died before serving, again and again under
   * Restart=always.
   */
  test("leaves what is not plainly its own, says so, and never throws", () => {
    const root = directory("sweep-foreign");
    const elsewhere = directory("sweep-target");
    writeFileSync(join(elsewhere, "precious"), "not a launch");
    symlinkSync(elsewhere, join(root, "launch-LINKED"));
    writeFileSync(join(root, "launch-FILE"), "a file, not a launch directory");
    mkdirSync(join(root, "launch-MINE"));

    const sweep = sweepLaunches(root);
    expect(sweep.swept).toBe(1);
    expect(sweep.kept.sort()).toEqual([
      `${join(root, "launch-FILE")} is not a directory, and was left alone`,
      `${join(root, "launch-LINKED")} is a symbolic link, and was left alone`,
    ]);
    // Never followed out of the root.
    expect(readFileSync(join(elsewhere, "precious"), "utf8")).toBe("not a launch");

    // Another uid's directory: seen through the uid the sweep is told it runs as.
    mkdirSync(join(root, "launch-THEIRS"));
    const foreign = sweepLaunches(root, uid + 1);
    expect(foreign.swept).toBe(0);
    expect(foreign.kept).toContain(`${join(root, "launch-THEIRS")} belongs to uid ${uid}, and was left alone`);
  });

  test.skipIf(uid === 0)("carries on past a launch it cannot remove", () => {
    // What EACCES looks like to a non-root sweep: a directory whose entries cannot be unlinked.
    const root = directory("sweep-stuck");
    const stuck = join(root, "launch-STUCK", "secrets");
    mkdirSync(stuck, { recursive: true });
    writeFileSync(join(stuck, "github"), "left by a crash");
    chmodSync(stuck, 0o500);
    mkdirSync(join(root, "launch-FREE"));
    try {
      const sweep = sweepLaunches(root);
      expect(sweep.swept).toBe(1);
      expect(sweep.kept).toEqual([`${join(root, "launch-STUCK")} could not be removed (EACCES)`]);
      expect(existsSync(join(root, "launch-FREE"))).toBe(false);
    } finally {
      chmodSync(stuck, 0o700);
    }
  });

  test("takes DEVBOX_RUNTIME_DIR when it is set and writable, through a directory of its own", () => {
    const asked = join(directory("runtime-asked"), "nested");
    const data = directory("data");
    const chosen = chooseRuntime({ DEVBOX_RUNTIME_DIR: asked }, data);
    const own = join(asked, privateDirectoryName(data, uid));
    expect(chosen).toMatchObject({ path: own, chosen: "DEVBOX_RUNTIME_DIR", note: null });
    expect(statSync(own).mode & 0o777).toBe(0o700);
  });

  test("passes DEVBOX_RUNTIME_DIR over when its name there is taken by a link or a file", () => {
    // The operator knows the mount, not who else writes to it: a name of ours created in
    // advance there is the trap /dev/shm is checked for.
    const data = directory("data");
    for (const squat of ["link", "file"] as const) {
      const asked = directory(`runtime-squatted-${squat}`);
      const own = join(asked, privateDirectoryName(data, uid));
      if (squat === "link") symlinkSync(directory("somewhere-else"), own);
      else writeFileSync(own, "");
      const chosen = chooseRuntime({ DEVBOX_RUNTIME_DIR: asked }, data);
      expect(chosen.chosen).not.toBe("DEVBOX_RUNTIME_DIR");
      expect(chosen.note).toContain(`DEVBOX_RUNTIME_DIR=${asked} was passed over: ${own}`);
      expect(chosen.note).toContain(squat === "link" ? "is a symbolic link" : "is not a directory");
      if (chosen.chosen === "/dev/shm") rmSync(chosen.path, { recursive: true, force: true });
    }
  });

  test("falls back to memory, then to the data directory, and says which", () => {
    const data = directory("data");
    const chosen = chooseRuntime({}, data);
    if (existsSync("/dev/shm")) {
      expect(chosen.chosen).toBe("/dev/shm");
      expect(chosen.path.startsWith("/dev/shm/devbox-")).toBe(true);
      expect(statSync(chosen.path).mode & 0o777).toBe(0o700);
      rmSync(chosen.path, { recursive: true, force: true });
    } else {
      // A Mac has no /dev/shm, and its data directory is a disk: said as such.
      expect(chosen).toMatchObject({ path: join(data, "run"), chosen: "DATA_DIR/run", medium: "disk" });
      expect(statSync(chosen.path).mode & 0o777).toBe(0o700);
    }
  });

  test("calls nothing memory unless statfs proves it", () => {
    // A doubt must never be announced as the reassuring answer.
    expect(mediumOf(join(ROOT, "no-such-directory"))).toBe("disk");
    if (process.platform !== "linux") expect(mediumOf(ROOT)).toBe("disk");
    if (process.platform === "linux" && existsSync("/dev/shm")) expect(mediumOf("/dev/shm")).toBe("memory");
  });
});

describe("openVault", () => {
  // openVault sets the process-wide state: put the ordinary test state back afterwards, a
  // closed vault on the ordinary test environment.
  afterAll(() => openVault({}));

  test("reads the key, then removes it from the environment it was read from", () => {
    const db = freshDatabase();
    const key = newMasterKey(1);
    setSecret(db, ring(key), OWNER_SELF, "profile", "github", "ghp_x", 1);
    const env: Record<string, string | undefined> = { DEVBOX_MASTER_KEY: key, HCLOUD_TOKEN: "hc" };

    const opening = openVault(env, db);
    // It held a value already: no first import, whatever the environment offers.
    expect(opening).toEqual({ status: { available: true }, rewrapped: 0, imported: [] });
    expect(env).toEqual({ HCLOUD_TOKEN: "hc" });
  });

  test("a vault that never held anything takes in the environment and the files, once", () => {
    const db = freshDatabase();
    const dir = directory("first-import");
    writeFileSync(join(dir, "github"), "ghp_from_the_file");
    writeFileSync(join(dir, "blank"), "");
    const key = newMasterKey(1);
    const decoded = (kind: "cloud" | "profile", name: string) =>
      new TextDecoder().decode(readSecret(db, ring(key), OWNER_SELF, kind, name) ?? new Uint8Array());

    const opening = openVault({ DEVBOX_MASTER_KEY: key, HCLOUD_TOKEN: "hc-from-the-unit", HOME: "/x" }, db, dir);
    expect(opening.status.available).toBe(true);
    const said = opening.imported.join(" ");
    expect(said).toContain("HCLOUD_TOKEN");
    expect(said).toContain("github");
    // An empty file is absent, and a variable outside the catalogue is not a secret.
    expect(said).not.toContain("blank");
    expect(said).not.toContain("HOME");
    expect(decoded("cloud", "HCLOUD_TOKEN")).toBe("hc-from-the-unit");
    expect(decoded("profile", "github")).toBe("ghp_from_the_file");
    // Names, never a value: this list goes to the journal.
    expect(said).not.toContain("ghp_from_the_file");

    // Once. A file added afterwards waits for the button: from now on the page decides.
    writeFileSync(join(dir, "later"), "added-after");
    expect(openVault({ DEVBOX_MASTER_KEY: key }, db, dir).imported).toEqual([]);
  });

  test("a vault emptied on purpose is not filled again at the next opening", () => {
    const db = freshDatabase();
    const dir = directory("emptied");
    writeFileSync(join(dir, "github"), "ghp_from_before_the_rotation");
    const key = newMasterKey(1);
    setSecret(db, ring(key), OWNER_SELF, "profile", "github", "ghp_rotated", 1);
    deleteSecret(db, OWNER_SELF, "profile", "github", 2);

    expect(openVault({ DEVBOX_MASTER_KEY: key }, db, dir).imported).toEqual([]);
    expect(readSecret(db, ring(key), OWNER_SELF, "profile", "github")).toBeNull();
  });

  test("finishes a rotation at startup, and the old key can go after", () => {
    const db = freshDatabase();
    const old = newMasterKey(1);
    setSecret(db, ring(old), OWNER_SELF, "profile", "github", "ghp_rotated", 1);
    const next = newMasterKey(2);

    expect(openVault({ DEVBOX_MASTER_KEY: next, DEVBOX_MASTER_KEY_PREVIOUS: old }, db).rewrapped).toBe(1);
    expect(new TextDecoder().decode(readSecret(db, ring(next), OWNER_SELF, "profile", "github") ?? new Uint8Array())).toBe(
      "ghp_rotated",
    );
  });

  test("a wrong key closes the vault with the reason, and never throws", () => {
    // Dying here would loop on Restart=always and say nothing. The service starts, the page
    // says why, and the fallback serves.
    const db = freshDatabase();
    setSecret(db, ring(newMasterKey(1)), OWNER_SELF, "profile", "github", "ghp_x", 1);
    const wrong = newMasterKey(1);
    const env: Record<string, string | undefined> = { DEVBOX_MASTER_KEY: wrong };

    const opening = openVault(env, db);
    expect(opening.status.available).toBe(false);
    if (!opening.status.available) {
      expect(opening.status.reason).toContain("does not open under master key v1");
      expect(opening.status.reason).not.toContain(wrong.slice(3));
    }
    expect(env).toEqual({});
  });

  test("a malformed key closes the vault with the reason, without quoting it", () => {
    const env: Record<string, string | undefined> = { DEVBOX_MASTER_KEY: "v1:not-a-key-at-all" };
    const opening = openVault(env, freshDatabase());
    expect(opening.status).toEqual({
      available: false,
      reason: "DEVBOX_MASTER_KEY is not standard base64 (A-Z, a-z, 0-9, + and /)",
    });
    expect(env).toEqual({});
  });

  /**
   * `bun --hot` evaluates this module again, and the key it read is gone from process.env by
   * then, measured on 11/09: what the first evaluation opened is what every later one
   * must find, rather than a closed vault until the next restart.
   */
  test("what one evaluation of the module opened, the next one finds", async () => {
    const db = freshDatabase();
    const key = newMasterKey(1);
    setSecret(db, ring(key), OWNER_SELF, "profile", "github", "ghp_across_a_reload", 1);
    const env: Record<string, string | undefined> = { DEVBOX_MASTER_KEY: key, HCLOUD_TOKEN: "hc-unit" };
    openVault(env, db);

    const specifier = "../src/secrets.ts?reloaded";
    const reloaded = (await import(specifier)) as typeof import("../src/secrets");
    const founder = { id: OWNER_SELF, email: "founder@devbox.test", serviceFallback: true };
    expect(reloaded.vaultState()).toEqual({ available: true });
    expect(reloaded.sourcesFor(founder).env).toEqual({ HCLOUD_TOKEN: "hc-unit" });
    const bytes = reloaded.heldValue("profile", "github", {
      ...reloaded.sourcesFor(founder),
      secretsDir: directory("none"),
    });
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe("ghp_across_a_reload");
    // The same state this instance reads, not a copy of it.
    expect(vaultState()).toEqual({ available: true });
    expect(sourcesFor(founder).keyring).toBe(reloaded.sourcesFor(founder).keyring);
  });
});
