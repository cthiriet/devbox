import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ACCOUNTS_DIR,
  DEVBOX_CACHE_DIR,
  ENGINE_DIR,
  ROOTS_DIR,
  TF_PLUGIN_CACHE_DIR,
} from "../src/config";
import { database } from "../src/db";
import {
  describeProfiles,
  engineEnv,
  engineVersion,
  parseSkipped,
  plain,
  prepareDirectories,
  type Profile,
} from "../src/engine";
import { rootNeeds } from "../src/roots";
import { sourcesOf, type Sources } from "../src/secrets";
import { accountTree } from "../src/tree";

/** Whose vault a read is made against: no function has a default one any more. */
const OWNER = 1;

/** And whose tree a child runs in. Made once, like the service makes it at the first request. */
const TREE = accountTree(OWNER);

/** What a launch hands engineEnv, with nothing in it: see tests/secrets.test.ts for a real one. */
const EMPTY_LAUNCH = { account: OWNER, env: { DEVBOX_SECRETS_DIR: "/launch/secrets" }, unset: [] };

/**
 * What the service hands a child, and what it reads back.
 *
 * The other half - the directories themselves, the roots copied into them and the key that
 * signs them - is tests/tree.test.ts. It exists because its absence was found by spending
 * money rather than by a test: the design said server.ts synchronised the Terraform sources
 * into the data directory, it did not, and the first real `up` probed Hetzner, printed its
 * whole catalogue, and died on `chdir data/tf/hetzner: no such file or directory`.
 */

describe("engineEnv", () => {
  test("never hands a child the service's GOOGLE_APPLICATION_CREDENTIALS, key or no key", () => {
    // Found by the cross-account review on 13/09: withheld only when the launch laid out the
    // GCP key, so a launch that resolved none - an account without the fallback privilege -
    // inherited the path the service's own environment named. EMPTY_LAUNCH lays out nothing
    // and unsets nothing, which is exactly that launch.
    const before = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = "/etc/devbox/secrets/service-gcp.json";
    try {
      expect(engineEnv(TREE, EMPTY_LAUNCH).GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      else process.env.GOOGLE_APPLICATION_CREDENTIALS = before;
    }
  });

  test("keeps devbox out of the operator's home", () => {
    // devbox writes ~/.ssh/config and ~/.ssh/known_hosts. Left at the real home, this
    // service would rewrite, on the workstation, the file devbox measured as unsafe
    // under concurrent read-modify-write.
    const env = engineEnv(TREE, EMPTY_LAUNCH);
    expect(env.HOME).toBe(TREE.home);
    expect(env.HOME).not.toBe(process.env.HOME);
  });

  test("points the four variables that make a world at the asking account's tree", () => {
    // These four ARE the isolation between accounts: instances() lists the directories of
    // $DEVBOX_TF_ROOT with no predicate, so one account's fleet is not filtered out of
    // another's answer - it is not in the tree the child can see at all.
    const env = engineEnv(TREE, EMPTY_LAUNCH);
    expect(env.DEVBOX_TF_ROOT).toBe(TREE.tfRoot);
    expect(env.DEVBOX_CONFIG_DIR).toBe(TREE.configDir);
    expect(env.DEVBOX_KEY).toBe(TREE.sshKey);
    for (const path of [env.HOME, env.DEVBOX_TF_ROOT, env.DEVBOX_CONFIG_DIR, env.DEVBOX_KEY]) {
      expect(path).toContain(join(ACCOUNTS_DIR, String(OWNER)));
    }
  });

  test("shares the two caches, which hold public bytes and cost 65 MB an account", () => {
    // Measured on 12/09: data/tf weighs 65 MB with a SINGLE cloud initialised, and
    // devbox-core runs `terraform init` on every `up`. Per account, that is every provider
    // downloaded again into every tree. The price catalogue is the same public answer for
    // everyone.
    const env = engineEnv(TREE, EMPTY_LAUNCH);
    expect(env.TF_PLUGIN_CACHE_DIR).toBe(TF_PLUGIN_CACHE_DIR);
    expect(env.DEVBOX_CACHE_DIR).toBe(DEVBOX_CACHE_DIR);
    for (const path of [env.TF_PLUGIN_CACHE_DIR, env.DEVBOX_CACHE_DIR]) {
      expect(path).toContain(".test-data");
      expect(path).not.toContain(join(ACCOUNTS_DIR, String(OWNER)));
    }
  });

  /**
   * The pair no type can refuse: an AccountPaths and a Launch are both well-formed when they
   * belong to two different accounts, and that is precisely the mistake - one account's
   * credentials spent in another's state directory.
   */
  test("refuses a launch that belongs to another account", () => {
    expect(() => engineEnv(TREE, { ...EMPTY_LAUNCH, account: OWNER + 1 })).toThrow(
      /cannot run in account/,
    );
  });

  test("forbids minting an ssh key", () => {
    // A machine created with a fresh key is one neither the phone nor the Mac can join, and
    // it only shows at the first connection attempt.
    expect(engineEnv(TREE, EMPTY_LAUNCH).DEVBOX_KEY_REQUIRED).toBe("1");
  });

  /**
   * The master key never leaves this process, and this is where it would have: engineEnv
   * used to spread the service's whole environment into devbox-core, terraform and every
   * provider plugin. openVault deletes it from process.env after reading it; this pins the
   * second lock, for the day something sets it back.
   */
  test("never hands a child the master key, even when the environment still holds it", () => {
    const planted = "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    process.env.DEVBOX_MASTER_KEY = planted;
    process.env.DEVBOX_MASTER_KEY_PREVIOUS = planted;
    try {
      const env = engineEnv(TREE, EMPTY_LAUNCH);
      expect(Object.keys(env)).not.toContain("DEVBOX_MASTER_KEY");
      expect(Object.keys(env)).not.toContain("DEVBOX_MASTER_KEY_PREVIOUS");
      expect(JSON.stringify(env)).not.toContain(planted);
    } finally {
      delete process.env.DEVBOX_MASTER_KEY;
      delete process.env.DEVBOX_MASTER_KEY_PREVIOUS;
    }
  });

  test("never hands a child the service's own credentials: sign-in clients, founder, token, retired ones", () => {
    const planted = {
      // Read by nothing since 15/09, and withheld all the same: a stale value is still a secret.
      PASSWORD_HASH: "$argon2id$planted",
      DEVBOX_INVITE_CODE: "invite-planted",
      DEVBOX_REMOTE_TOKEN: "api-token-planted",
      // src/oauth.ts deletes these four once taken; this is the case where something set them back.
      GOOGLE_CLIENT_ID: "google-id-planted",
      GOOGLE_CLIENT_SECRET: "google-secret-planted",
      GITHUB_CLIENT_ID: "github-id-planted",
      GITHUB_CLIENT_SECRET: "github-secret-planted",
      // Not a secret, but it decides who takes account 1, and devbox-core has no use for it.
      DEVBOX_FOUNDER_EMAIL: "planted@example.com",
    };
    Object.assign(process.env, planted);
    try {
      const env = engineEnv(TREE, EMPTY_LAUNCH);
      for (const name of Object.keys(planted)) expect(env[name], name).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("planted");
    } finally {
      for (const name of Object.keys(planted)) delete process.env[name];
    }
  });

  test("passes on no cloud variable of its own: only what the launch resolved", () => {
    // The value from before a rotation, still in the unit's environment, must not ride along
    // beside the vault's - nor reach a read that needs no credential at all.
    process.env.HCLOUD_TOKEN = "hc-stale-from-the-unit";
    try {
      expect(engineEnv(TREE, EMPTY_LAUNCH).HCLOUD_TOKEN).toBeUndefined();
      const launched = { ...EMPTY_LAUNCH, env: { ...EMPTY_LAUNCH.env, HCLOUD_TOKEN: "hc-resolved" } };
      expect(engineEnv(TREE, launched).HCLOUD_TOKEN).toBe("hc-resolved");
    } finally {
      delete process.env.HCLOUD_TOKEN;
    }
  });

  test("withholds what the launch names, and takes its secrets directory from it", () => {
    // DEVBOX_GITHUB_TOKEN is what devbox-core reads BEFORE the file, so one left in the unit
    // would win over the vault; the service's own DEVBOX_SECRETS_DIR would hand every child
    // the whole fallback directory.
    process.env.DEVBOX_GITHUB_TOKEN = "ghp_from_the_unit";
    process.env.DEVBOX_SECRETS_DIR = "/the/whole/fallback";
    try {
      const env = engineEnv(TREE, { ...EMPTY_LAUNCH, unset: ["DEVBOX_GITHUB_TOKEN"] });
      expect(env.DEVBOX_GITHUB_TOKEN).toBeUndefined();
      expect(env.DEVBOX_SECRETS_DIR).toBe("/launch/secrets");
    } finally {
      delete process.env.DEVBOX_GITHUB_TOKEN;
      delete process.env.DEVBOX_SECRETS_DIR;
    }
  });
});

describe("the repository's own roots", () => {
  /**
   * The repository holds what its own roots read - checked against the real tf/, not a
   * fixture. A root that names a file nobody ever added fails here, on the workstation,
   * rather than at the first apply.
   *
   * The COPYING of those roots is tests/tree.test.ts now: they are staged once and copied
   * into each account's tree, which is where the failures of 27/08 - a list kept by hand, a
   * machine that could no longer be destroyed - would show today.
   */
  test("the real roots read only files this repository holds", () => {
    const root = join(import.meta.dir, "..", "..");
    const needs = rootNeeds(join(root, "tf"));

    // A regex that matched nothing would make this test pass while proving nothing.
    expect(needs.beside.length).toBeGreaterThan(0);
    for (const name of needs.beside) expect(existsSync(join(root, name))).toBe(true);
    for (const [cloud, names] of Object.entries(needs.inside)) {
      for (const name of names) {
        expect(existsSync(join(root, "tf", cloud, name))).toBe(true);
      }
    }
  });

  test("creates the shared directories devbox assumes and systemd does not make", () => {
    // The SHARED ones alone. An account's own - HOME, the state, the profiles, the logs - are
    // accountTree's, made at that account's first use, so that a signup writes nothing.
    prepareDirectories();
    for (const dir of [ACCOUNTS_DIR, ROOTS_DIR, DEVBOX_CACHE_DIR, TF_PLUGIN_CACHE_DIR]) {
      expect(existsSync(dir)).toBe(true);
    }
  });
});

/**
 * The half of the version handshake this service is responsible for.
 *
 * devbox-core on the workstation and engine/devbox here are two files, and only a deployment
 * renews the second. A fix applied to the first changed nothing a remote job did until
 * someone remembered to ship it, which is a morning already spent. So both sides now name
 * the version they hold, and the name is the sha256 of the file's bytes: nothing here
 * knows a commit - the deployment rsyncs without .git - and there is no number anyone
 * would remember to bump.
 *
 * That only works if the two computations agree, and they are written in two languages:
 * `sha256sum` (or `shasum -a 256`) in bash, `Bun.CryptoHasher` in TypeScript. The first
 * two tests are about nothing else.
 */
describe("engineVersion", () => {
  // Its own corner of the diverted engine directory. These fixtures are named by their
  // bytes, so they must not be the tf/ tree the describe above plants, re-plants and
  // fills differently depending on which of its tests ran.
  const FIXTURES = join(ENGINE_DIR, "version-fixtures");
  mkdirSync(FIXTURES, { recursive: true });

  test("names the engine by the sha256 of its bytes, the way the workstation names it", () => {
    /**
     * The literal is `printf 'hello' | shasum -a 256`, transcribed, and it stays a
     * literal on purpose. Recomputing it here with the same Bun.CryptoHasher that
     * engineVersion uses would prove only that a function equals itself. What the gate
     * rests on is that the shell's sha256 and Bun's sha256 spell the same 64 characters
     * - and a claim about the outside world cannot be pinned from the inside.
     *
     * "hello" without a trailing newline: the newline is a byte like any other, and a
     * fixture that carried one would quietly pin a different digest than the one this
     * comment names.
     */
    const path = join(FIXTURES, "hello");
    writeFileSync(path, "hello");

    expect(engineVersion(path).core).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  // The same claim over arbitrary bytes rather than one famous string, checked against
  // the tool devbox-core actually shells out to. macOS ships shasum; a CI image may not, and
  // a missing tool is not a broken digest - skipped rather than failed, and the skip is
  // visible in the run.
  test.skipIf(Bun.which("shasum") === null)("spells the digest the way the shell spells it", () => {
    const path = join(FIXTURES, "arbitrary-bytes");
    // Deliberately not text. The engine is a bash script today, but nothing in the
    // handshake promises the bytes stay printable, and a digest that only agreed on
    // ASCII would be one that diverges on the day it matters.
    writeFileSync(path, new Uint8Array([0x00, 0x0a, 0x7f, 0x80, 0xff, 0x23, 0x21, 0x0a]));

    // `shasum -a 256 <file>` prints the digest, two spaces, then the name.
    const shell = Bun.spawnSync(["shasum", "-a", "256", path]).stdout.toString();
    expect(shell.slice(0, 64)).toMatch(/^[0-9a-f]{64}$/);
    expect(engineVersion(path).core).toBe(shell.slice(0, 64));
  });

  test("answers null instead of throwing when the build never ran", () => {
    // engineReady() already names a missing engine at startup; a throw here would turn
    // that into a 500 on /api/version, and the gate on the workstation reads an
    // unexpected status as "cannot tell what the remote runs" - an alarm about the wrong
    // thing. A server that has no engine should say so in the answer, in words the gate
    // can turn into "has no engine deployed".
    const path = join(FIXTURES, "never-built");
    expect(existsSync(path)).toBe(false);

    expect(() => engineVersion(path)).not.toThrow();
    expect(engineVersion(path)).toEqual({ core: null, built_at: null });
  });

  test("changes when one byte of the engine changes", () => {
    // This is the property the whole gate is bought with. The fix that cost a morning was
    // a line in devbox-core; a version that did not move for one line would have answered
    // "identical" and hidden it a second time.
    const before = '#!/usr/bin/env bash\nreadonly VERSION_GATE="0"\n';
    const after = '#!/usr/bin/env bash\nreadonly VERSION_GATE="1"\n';
    expect(after.length).toBe(before.length); // one byte apart, not one line

    const first = join(FIXTURES, "core-before");
    const second = join(FIXTURES, "core-after");
    writeFileSync(first, before);
    writeFileSync(second, after);

    expect(engineVersion(first).core).not.toBe(engineVersion(second).core);
  });

  test("dates the engine by the file, not by the process", () => {
    /**
     * The mtime, never `new Date()`: the answer describes the file this service would
     * spawn, so two calls a minute apart must describe it identically.
     *
     * And this is exactly why built_at is never a criterion of equality. build-engine.ts
     * copies devbox-core with cpSync, which does not preserve timestamps: engine/devbox carries
     * the hour of the build and devbox-core the hour of its last edit, so two files
     * identical to the byte carry two different dates. Only .core decides whether the
     * sides match. built_at is there to tell the operator how stale the deployment is,
     * and comparing it would manufacture a difference where there is none.
     */
    const path = join(FIXTURES, "dated");
    writeFileSync(path, "#!/usr/bin/env bash\n");
    // Aged deliberately. Comparing against the mtime of a file written a moment ago passes
    // just as happily against `new Date()` - measured at 198 runs out of 200 - so the
    // assertion said nothing beyond "this is an ISO string". An hour in the past cannot be
    // confused with the hour of the call.
    const long_ago = new Date(Date.now() - 3_600_000);
    utimesSync(path, long_ago, long_ago);

    expect(engineVersion(path).built_at).toBe(statSync(path).mtime.toISOString());
    expect(new Date(engineVersion(path).built_at ?? 0).getTime()).toBeLessThan(Date.now() - 3_000);
  });
});

/**
 * The two halves of `devbox probe --json`, read separately.
 *
 * The rows are on stdout and parse like any other JSON. What matters here is the other
 * half: the clouds that could not be asked go to STDERR, in a block of plain text, and a
 * dashboard that silently dropped them would show "Hetzner is cheapest" when what happened
 * is that Hetzner was the only cloud asked. Losing it would let one unconfigured provider
 * hide another's cheaper offer - and this service asks only the clouds clouds() names, so
 * the block is what says a credential it BELIEVED it had did not work.
 */
describe("parseSkipped", () => {
  test("reads the block devbox-core writes, one cloud per line", () => {
    // Transcribed from devbox-core's cmd_probe: `echo "not asked:" >&2` followed by lines of
    // the form `  <cloud>: <first line of that cloud's error>`.
    const stderr = "not asked:\n  gcp: no credentials here\n  scaleway: SCW_SECRET_KEY is not set\n";
    expect(parseSkipped(stderr)).toEqual([
      "gcp: no credentials here",
      "scaleway: SCW_SECRET_KEY is not set",
    ]);
  });

  test("answers nothing at all when every cloud was asked", () => {
    // The ordinary case on a workstation that holds all three credentials, and the one
    // where an over-eager parser would invent a warning out of an empty string.
    expect(parseSkipped("")).toEqual([]);
    expect(parseSkipped("\n\n")).toEqual([]);
    expect(parseSkipped("warning: something else entirely\n")).toEqual([]);
  });

  test("finds the block even when something else spoke first", () => {
    // stderr is shared. A version warning or a curl retry can land above the block, and
    // the parse keys on the line rather than on the position.
    const stderr = "/!\\ engine and core differ\nnot asked:\n  gcp: no credentials here\n";
    expect(parseSkipped(stderr)).toEqual(["gcp: no credentials here"]);
  });

  test("keeps a message that itself contains a colon", () => {
    // The line is not split on anything: the cloud's own error text is copied whole, and
    // an API URL in it must not truncate the sentence.
    const stderr = "not asked:\n  gcp: GET https://compute.googleapis.com: 403\n";
    expect(parseSkipped(stderr)).toEqual(["gcp: GET https://compute.googleapis.com: 403"]);
  });
});

/**
 * What /api/profiles adds to devbox's answer.
 *
 * Kept a separate function from `profiles()` precisely so this test needs neither a real
 * devbox nor a real /etc: the composition is exercised over a plain array and a directory of
 * this test's own making.
 */
describe("describeProfiles", () => {
  const profile = (overrides: Partial<Profile> = {}): Profile => ({
    name: "claude",
    path: "/engine/profiles/claude.sh",
    repo: null,
    secrets: [],
    note: null,
    min_cpu: null,
    min_ram: null,
    min_disk: null,
    port: null,
    ports: [],
    ...overrides,
  });

  /**
   * The fallback directory alone: no master key, so the vault is not a source. The directory
   * is narrowed back to a string, which a Sources no longer promises: an account without the
   * service's fallback has none at all.
   */
  function secretsDir(name: string): Sources & { secretsDir: string } {
    const directory = join(ENGINE_DIR, "profiles-test", name);
    mkdirSync(directory, { recursive: true });
    return {
      ...sourcesOf({ db: database, owner: OWNER, keyring: null, env: {}, secretsDir: directory }),
      secretsDir: directory,
    };
  }

  test("names the secrets this service does not hold, from missingSecrets", () => {
    // The refusal a creation would answer with 412, shown before the button is pressed:
    // the wizard can grey out a profile instead of ordering a machine that cannot seed.
    const sources = secretsDir("partial");
    writeFileSync(join(sources.secretsDir, "devbox-github-token"), "ghp_x");

    const [described] = describeProfiles(
      TREE,
      [profile({ secrets: ["devbox-claude-token", "devbox-github-token"] })],
      sources,
    );
    expect(described?.missing_secrets).toEqual(["devbox-claude-token"]);
  });

  test("is empty for a profile whose secrets are all deposited", () => {
    const sources = secretsDir("complete");
    writeFileSync(join(sources.secretsDir, "devbox-claude-token"), "sk-x");
    const [described] = describeProfiles(TREE, [profile({ secrets: ["devbox-claude-token"] })], sources);
    expect(described?.missing_secrets).toEqual([]);
  });

  test("flags a hand-written profile that clones from GitHub and declares no token", () => {
    // A copy that adds a repository without adding `github` dies minutes into its seed: the
    // order screen says so first.
    const sources = secretsDir("github-flag");
    const repo = "https://github.com/me/mine.git";
    const described = describeProfiles(
      TREE,
      [
        profile({ name: "copy", repo }),
        profile({ name: "declared", repo, secrets: ["github"] }),
        profile({ name: "elsewhere", repo: "https://gitlab.com/me/mine.git" }),
        profile({ name: "plain" }),
      ],
      sources,
    );
    expect(described.map((one) => [one.name, one.clones_github_without_token])).toEqual([
      ["copy", true],
      ["declared", false],
      ["elsewhere", false],
      ["plain", false],
    ]);

    // A composed one decides "public" in its own form, and is never flagged.
    const spec = {
      name: "composed",
      note: null,
      software: [],
      optional: [],
      secrets: [],
      repos: [{ url: repo, secret: null, dir: null }],
      setup: null,
      cpu: null,
      ram: null,
      disk: null,
      ports: [],
    };
    const [composed] = describeProfiles(
      TREE,
      [profile({ name: "composed", path: `${TREE.profilesDir}/composed.sh`, repo })],
      sources,
      new Map([["composed", spec]]),
    );
    expect(composed?.authored).not.toBeNull();
    expect(composed?.clones_github_without_token).toBe(false);
  });

  /**
   * By the directory, and not by whether a spec exists: a profile deposited by hand in the
   * account's directory has none, and listing it as built-in would present it as something
   * the service ships to every account.
   */
  test("tells the account's own profiles from the published ones", () => {
    const [published, composed, deposited] = describeProfiles(
      TREE,
      [
        profile({ name: "claude" }),
        profile({ name: "composed", path: `${TREE.profilesDir}/composed.sh` }),
        profile({ name: "deposited", path: `${TREE.profilesDir}/deposited.sh` }),
      ],
      secretsDir("own"),
    );
    expect(published?.own).toBe(false);
    expect(composed?.own).toBe(true);
    expect(deposited?.own).toBe(true);
    expect(deposited?.authored).toBeNull();
  });

  test("carries the floors, declared and inherited alike", () => {
    const [described] = describeProfiles(TREE, [profile({ min_cpu: 4 })], secretsDir("floors"));
    expect(described?.floors).toEqual({
      cpu: { value: 4, declared: true },
      ram: { value: 8, declared: false },
      disk: { value: 80, declared: false },
    });
  });

  test("takes nothing away from what devbox answered", () => {
    // The contract is additive. A client reading `port` or `repo` must keep reading them,
    // and a field dropped here would only show as an empty column in a browser.
    const original = profile({ repo: "git@github.com:me/mine.git", port: 3000 });
    const [described] = describeProfiles(TREE, [original], secretsDir("additive"));
    expect(described).toMatchObject(original);
  });

  test("answers an empty list for an empty list", () => {
    expect(describeProfiles(TREE, [], secretsDir("none"))).toEqual([]);
  });
});


/**
 * devbox's colours, stripped on the way.
 *
 * devbox-core writes for a terminal without asking whether it has one: its `die` wraps the
 * sentence in a red cross and a reset. Passed through as they are, those sequences travel
 * into a 404's JSON and onto the page, where they render as garbage around an otherwise
 * right message.
 *
 * The test holds on literals rather than a round trip: a sequence that stopped being
 * stripped looks exactly like a message nobody read closely.
 */
describe("plain", () => {
  const ESC = "\u001B";

  test("strips a `die`'s red cross and reset", () => {
    expect(plain(`${ESC}[1;31mx${ESC}[0m no machine. devbox up`)).toBe("x no machine. devbox up");
  });

  test("leaves a text without any untouched", () => {
    expect(plain("devbox info inexistante --json exited 1")).toBe(
      "devbox info inexistante --json exited 1",
    );
  });

  test("also strips a multiline warning's colours", () => {
    expect(plain(`${ESC}[33m  /!\\ gcp: no credentials here${ESC}[0m\nsuite`)).toBe(
      "  /!\\ gcp: no credentials here\nsuite",
    );
  });
});
