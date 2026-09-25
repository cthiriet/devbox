import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ACCOUNTS_DIR, DATA_DIR } from "../src/config";
import { database } from "../src/db";
import { prepareLaunch } from "../src/engine";
import { sourcesOf } from "../src/secrets";
import { accountTree, ensureAccountKey, stageRoots } from "../src/tree";

/**
 * One account, one tree: the directories, the roots copied into them, and the key.
 *
 * Two of these failures were paid for rather than caught. The roots were copied from a list
 * kept by hand until 27/08, it said two names when they wanted three, and `file()` is
 * evaluated at PLAN time - so terraform refused everything, `destroy` included, and a cx33
 * this service had created became undestroyable by it while it went on billing. The key is
 * the same shape of failure one step further on: a pair minted over half a pair leaves every
 * live machine unreachable AND undestroyable, because a destroy passes the public key as
 * -var ssh_public_key.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const ROOT = join(DATA_DIR, "tree-test");
let drawn = 0;

/** An engine directory and a roots directory of this test's own, never the service's. */
function fixture(): { engine: string; roots: string } {
  drawn += 1;
  const engine = join(ROOT, `engine-${drawn}`);
  const roots = join(ROOT, `roots-${drawn}`);
  mkdirSync(engine, { recursive: true });
  mkdirSync(roots, { recursive: true });
  return { engine, roots };
}

/**
 * An account id nothing else in this process uses. The trees are memoised per process, and
 * these tests are about what the FIRST call does, so each one asks for an account of its own.
 */
const nextAccount = (() => {
  let id = 500;
  return () => (id += 1);
})();

/**
 * The memo forgotten for one account, which is what a restart does to it.
 *
 * Reached through the same globalThis slot src/tree.ts keeps it on, deliberately: the
 * alternative is an exported "forget" that exists for no reason but this file, and the
 * property being pinned - a redeployment's roots reaching an account that already has a tree -
 * only happens across a restart.
 */
function asAfterARestart(account: number): void {
  const trees = (globalThis as Record<symbol, unknown>)[Symbol.for("devbox.dashboard.trees")];
  (trees as Map<number, unknown> | undefined)?.delete(account);
}

/** The staged state is process-wide: put back what the other test files expect at the end. */
afterAll(() => {
  stageRoots();
});

describe("stageRoots and the tree it fills", () => {
  test("copies the sources where terraform may actually write", () => {
    const { engine, roots } = fixture();
    const source = join(engine, "tf", "hetzner");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "main.tf"), "# root\n");
    writeFileSync(join(source, ".terraform.lock.hcl"), "# lock\n");

    stageRoots(engine, roots);
    const paths = accountTree(nextAccount());

    expect(existsSync(join(paths.tfRoot, "hetzner", "main.tf"))).toBe(true);
    // The lock travels too, and that is the whole point of committing it: without it the
    // server resolves its own provider versions against the same states.
    expect(existsSync(join(paths.tfRoot, "hetzner", ".terraform.lock.hcl"))).toBe(true);
  });

  test("never touches a state file", () => {
    const { engine, roots } = fixture();
    const source = join(engine, "tf", "hetzner");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "main.tf"), "# root\n");
    // Something that must never be shipped, planted in the engine to prove it is not.
    writeFileSync(join(source, "terraform.tfstate"), '{"from":"the engine"}');

    const account = nextAccount();
    const paths = accountTree(account);
    const state = join(paths.tfRoot, "hetzner", "terraform.tfstate");
    mkdirSync(join(paths.tfRoot, "hetzner"), { recursive: true });
    writeFileSync(state, '{"from":"the account"}');

    // A second deployment, reaching an account that already has a tree.
    stageRoots(engine, roots);
    asAfterARestart(account);
    accountTree(account);

    // The state is what says which machines exist and are billing. Overwriting one would
    // strand a machine that no `down` could ever reach again.
    expect(readFileSync(state, "utf8")).toContain("the account");
    expect(readFileSync(join(paths.tfRoot, "hetzner", "main.tf"), "utf8")).toBe("# root\n");
  });

  test("puts every file the roots reach for where they actually look for it", () => {
    // The roots read `${path.module}/../../prelude.sh` and others like it, so each has to sit
    // two levels above tf/<cloud>. Getting this wrong fails at APPLY and not at init, which
    // means the machine is ordered first: this resolves the path exactly as terraform would
    // rather than trusting a hardcoded one.
    const { engine, roots } = fixture();
    mkdirSync(join(engine, "tf", "hetzner"), { recursive: true });
    writeFileSync(
      join(engine, "tf", "hetzner", "main.tf"),
      'a = file("${path.module}/../../prelude.sh")\n' +
        'b = templatefile("${path.module}/../../cloud-init.yaml.tftpl", {})\n',
    );
    writeFileSync(join(engine, "prelude.sh"), "# prelude\n");
    writeFileSync(join(engine, "cloud-init.yaml.tftpl"), "#cloud-config\n");

    stageRoots(engine, roots);
    const paths = accountTree(nextAccount());

    const asTerraformResolvesIt = (file: string) => join(paths.tfRoot, "hetzner", "..", "..", file);
    expect(existsSync(asTerraformResolvesIt("prelude.sh"))).toBe(true);
    expect(existsSync(asTerraformResolvesIt("cloud-init.yaml.tftpl"))).toBe(true);
  });

  /**
   * A file NOBODY listed, carried because a root asked for it - the whole repair of 27/08.
   * The two copiers each held the list by hand, it said two names when the roots wanted three
   * (devbox-provision.sh, five days after phase 1 became a file of its own), and a machine
   * this service had created could no longer be destroyed. Nothing is listed any more: the
   * names are read off the .tf being laid out, and this names one that exists nowhere in this
   * repository to prove it.
   */
  test("carries a file it was never told about, because a root reads it", () => {
    const { engine, roots } = fixture();
    mkdirSync(join(engine, "tf", "hetzner"), { recursive: true });
    writeFileSync(
      join(engine, "tf", "hetzner", "main.tf"),
      'x = file("${path.module}/../../a-fourth-file.sh")\n',
    );
    writeFileSync(join(engine, "a-fourth-file.sh"), "# invented for this test\n");

    stageRoots(engine, roots);
    const paths = accountTree(nextAccount());

    expect(existsSync(join(paths.tfRoot, "hetzner", "..", "..", "a-fourth-file.sh"))).toBe(true);
  });

  /**
   * The second way out of a root, which a filter on `.tf` drops in silence: a root can read
   * `${path.module}/<file>`, a sibling of the .tf. No root in this repository does so today,
   * and that is exactly why it is tested against a fixture.
   */
  test("carries what a root reads from its own directory", () => {
    const { engine, roots } = fixture();
    mkdirSync(join(engine, "tf", "acme"), { recursive: true });
    writeFileSync(
      join(engine, "tf", "acme", "main.tf"),
      'script = abspath("${path.module}/machine.sh")\n',
    );
    writeFileSync(join(engine, "tf", "acme", "machine.sh"), "#!/bin/sh\n");

    stageRoots(engine, roots);
    const paths = accountTree(nextAccount());

    expect(existsSync(join(paths.tfRoot, "acme", "machine.sh"))).toBe(true);
  });

  test("says so rather than failing at plan time when the build left one out", () => {
    // The service starts anyway - dying would loop on Restart=always - but a root without
    // what it reads can neither create nor destroy, and that has to be READ somewhere before
    // a machine is ordered against it.
    const { engine, roots } = fixture();
    mkdirSync(join(engine, "tf", "hetzner"), { recursive: true });
    writeFileSync(
      join(engine, "tf", "hetzner", "main.tf"),
      'x = file("${path.module}/../../never-built.sh")\n',
    );

    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => void said.push(parts.join(" "));
    try {
      expect(() => stageRoots(engine, roots)).not.toThrow();
    } finally {
      console.warn = warn;
    }
    expect(said.join("\n")).toContain("never-built.sh");
  });

  test("does nothing rather than throwing when the build never ran", () => {
    const { engine, roots } = fixture();
    expect(stageRoots(engine, roots)).toBeNull();
    // And a tree is still a tree: an account can hold secrets and profiles on a service whose
    // engine has never been built.
    expect(() => accountTree(nextAccount())).not.toThrow();
  });

  /**
   * THE DIGEST IS OVER WHAT WAS COPIED, not over the .tf files.
   *
   * A digest over the roots alone would let an account keep last week's prelude.sh - the file
   * that provisions every machine - with nothing anywhere saying so, because its `tf/.roots`
   * would still match.
   */
  test("changes when a file the roots read changes, not only when a root does", () => {
    const { engine, roots } = fixture();
    mkdirSync(join(engine, "tf", "hetzner"), { recursive: true });
    writeFileSync(
      join(engine, "tf", "hetzner", "main.tf"),
      'a = file("${path.module}/../../prelude.sh")\n',
    );
    writeFileSync(join(engine, "prelude.sh"), "# prelude of last week\n");

    const before = stageRoots(engine, roots);
    const again = stageRoots(engine, roots);
    expect(again?.digest).toBe(before?.digest ?? "");

    writeFileSync(join(engine, "prelude.sh"), "# prelude of this deployment\n");
    const after = stageRoots(engine, roots);
    expect(after?.digest).not.toBe(before?.digest);

    // And an account that already has a tree takes the new one, state untouched.
    const account = nextAccount();
    const paths = accountTree(account);
    expect(readFileSync(join(paths.tfRoot, "..", "prelude.sh"), "utf8")).toContain(
      "this deployment",
    );
    expect(readFileSync(join(paths.tfRoot, ".roots"), "utf8").trim()).toBe(after?.digest ?? "");
  });

  test("copies nothing a second time when the digest has not moved", () => {
    const { engine, roots } = fixture();
    mkdirSync(join(engine, "tf", "hetzner"), { recursive: true });
    writeFileSync(join(engine, "tf", "hetzner", "main.tf"), "# root\n");
    stageRoots(engine, roots);

    const account = nextAccount();
    const paths = accountTree(account);
    const root = join(paths.tfRoot, "hetzner", "main.tf");
    // A file terraform itself would have rewritten. It survives, because the stamp matches
    // and nothing is copied - which is what makes this cheap for a hundred accounts.
    writeFileSync(root, "# not what the engine holds\n");

    stageRoots(engine, roots);
    asAfterARestart(account);
    accountTree(account);

    expect(readFileSync(root, "utf8")).toBe("# not what the engine holds\n");
  });
});

describe("one account's tree is not another's", () => {
  test("a second account writes nothing at all under the first one's", () => {
    const first = accountTree(nextAccount());
    const listing = (path: string): string[] =>
      readdirSync(path, { recursive: true, encoding: "utf8" }).sort();

    const before = listing(join(first.tfRoot, ".."));
    const second = accountTree(nextAccount());
    const after = listing(join(first.tfRoot, ".."));

    expect(after).toEqual(before);
    expect(second.tfRoot).not.toBe(first.tfRoot);
    expect(second.home).not.toBe(first.home);
    expect(second.logDir).not.toBe(first.logDir);
    // The keys are two pairs, which is what a machine of one account refusing the other's
    // amounts to.
    expect(readFileSync(`${second.sshKey}.pub`, "utf8")).not.toBe(
      readFileSync(`${first.sshKey}.pub`, "utf8"),
    );
  });

  test("the directories are the service's own, 0700", () => {
    const paths = accountTree(nextAccount());
    for (const directory of [
      join(paths.tfRoot, ".."),
      paths.home,
      join(paths.home, ".ssh"),
      paths.tfRoot,
      paths.configDir,
      paths.profilesDir,
      paths.logDir,
    ]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });

  /**
   * The pair no type can refuse. An AccountPaths and a Sources are each well-formed on their
   * own; the mistake is the pairing - a machine ordered in one account's state with another
   * account's cloud token, and that account's profile secrets pushed into its /run/secrets.
   */
  test("a launch is refused when the tree and the vault name two accounts", () => {
    const paths = accountTree(nextAccount());
    const someoneElse = sourcesOf({
      db: database,
      owner: paths.account + 1,
      keyring: null,
      env: {},
      secretsDir: null,
    });
    expect(() => prepareLaunch(paths, { clouds: [], profile: [] }, someoneElse)).toThrow(
      /tree and account/,
    );
  });
});

describe("ensureAccountKey", () => {
  test("mints a pair, 0600 and 0644, and names the account in the comment", () => {
    const paths = accountTree(nextAccount());
    expect(statSync(paths.sshKey).mode & 0o777).toBe(0o600);
    expect(statSync(`${paths.sshKey}.pub`).mode & 0o777).toBe(0o644);
    const pub = readFileSync(`${paths.sshKey}.pub`, "utf8");
    expect(pub).toStartWith("ssh-ed25519 ");
    expect(pub.trim()).toEndWith(`devbox-${paths.account}`);
  });

  test("leaves a pair it finds alone, whatever else runs", () => {
    const account = nextAccount();
    const paths = accountTree(account);
    const before = readFileSync(paths.sshKey, "utf8");
    asAfterARestart(account);
    const again = accountTree(account);
    expect(readFileSync(again.sshKey, "utf8")).toBe(before);
  });

  /**
   * The private half alone is enough to be the same pair, and it has to be: the provider
   * holds the public half of the key the machines were created with, so the public file has
   * to be DERIVED rather than drawn afresh.
   */
  test("rebuilds the public half from the private one, and it is the same pair", () => {
    const lender = accountTree(nextAccount());
    const account = nextAccount();
    const paths = accountTree(account);
    // The account's own pair replaced by the lender's private half alone, as a restore from a
    // backup that kept one file would leave it.
    rmSync(`${paths.sshKey}.pub`, { force: true });
    writeFileSync(paths.sshKey, readFileSync(lender.sshKey), { mode: 0o600 });

    ensureAccountKey(paths);

    expect(readFileSync(`${paths.sshKey}.pub`, "utf8").split(" ").slice(0, 2).join(" ")).toBe(
      readFileSync(`${lender.sshKey}.pub`, "utf8").split(" ").slice(0, 2).join(" "),
    );
    expect(statSync(`${paths.sshKey}.pub`).mode & 0o777).toBe(0o644);
  });

  /**
   * A public key with no private half: the loudest refusal of this file. Minting over it
   * would leave every machine of that account unreachable - the provider holds the old public
   * key - and undestroyable, since a destroy passes `$KEY.pub` as -var ssh_public_key. Both
   * while it bills.
   */
  test("throws rather than minting over half a pair", () => {
    const lender = accountTree(nextAccount());
    const account = nextAccount();
    const ssh = join(ACCOUNTS_DIR, String(account), "home", ".ssh");
    mkdirSync(ssh, { recursive: true, mode: 0o700 });
    writeFileSync(join(ssh, "devbox.pub"), readFileSync(`${lender.sshKey}.pub`), { mode: 0o644 });

    expect(() => accountTree(account)).toThrow(/private key is\s+missing/);
    expect(existsSync(join(ssh, "devbox"))).toBe(false);
  });

  test("says why rather than leaving a job to find out, when ssh-keygen cannot run", () => {
    // A route answers 503 with this sentence. The alternative is an `up` that dies three
    // minutes in, with a machine already ordered at the provider.
    const account = nextAccount();
    const ssh = join(ACCOUNTS_DIR, String(account), "home", ".ssh");
    mkdirSync(ssh, { recursive: true, mode: 0o700 });
    // A directory where the private key should be: it exists, so the public half is derived
    // from it - and ssh-keygen cannot read a directory. What matters is that the refusal
    // carries ssh-keygen's own reason rather than a stack from somewhere in here.
    mkdirSync(join(ssh, "devbox"), { recursive: true });
    try {
      expect(() => accountTree(account)).toThrow(/ssh key could not be made/i);
    } finally {
      rmSync(join(ssh, "devbox"), { recursive: true, force: true });
      chmodSync(ssh, 0o700);
    }
  });
});
