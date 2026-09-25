import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * prelude.sh, sourced and called - the half of a profile that no `devbox` verb reaches.
 *
 * Everything a profile does happens on a machine, after a provider has billed for it, and
 * that is precisely why the cheap parts have to be provable here. What is exercised below is
 * `clone_repo`'s first argument, because it carries a distinction one character wide:
 * `${1-github}` and not `${1:-github}`. An argument GIVEN and empty means "this repository is
 * public, clone it with no credential" - which is what a profile composed from the dashboard
 * renders for a public url - and the colon form would read that as no argument at all,
 * demand `github`, and kill the seed on a repository that needed nothing.
 *
 * Sourced with stubs: `as_user` is what would run git, and nothing here reaches a network,
 * a real HOME or a real /run/secrets.
 */

const PRELUDE = join(import.meta.dir, "..", "..", "prelude.sh");

/** One shell, prelude sourced, stubs installed, then the script's own lines. */
async function withPrelude(
  script: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const home = mkdtempSync(join(tmpdir(), "devbox-prelude-"));
  const body = [
    "set -uo pipefail",
    `. ${JSON.stringify(PRELUDE)}`,
    // After the source, so they replace what the prelude defines.
    'as_user() { echo "as_user: $*"; }',
    `HOME_DIR=${JSON.stringify(home)}`,
    script,
  ].join("\n");

  const child = Bun.spawn(["bash", "-c", body], {
    env: { PATH: process.env["PATH"] ?? "", HOME: home, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: `${stdout}${stderr}` };
}

describe("clone_repo", () => {
  const url = "https://github.com/public/lib";

  test("an empty secret clones without a credential, and returns 0", async () => {
    // Under `set -e` this used to be the trap: a test that fails as the last command of a
    // function becomes that function's exit status, so a public clone would have taken the
    // whole seed down at its last line. Hence the `if` in clone_repo rather than `&&`.
    const run = await withPrelude(`set -e\nclone_repo '' '${url}' /tmp/devbox-test-lib\necho "after=$?"`);
    expect(run.code).toBe(0);
    expect(run.out).toContain("as_user: git clone --depth 50");
    expect(run.out).toContain("after=0");
    // No credential helper: git_credentials was never called, so no .gitconfig was written.
    expect(run.out).not.toContain("/run/secrets");
  });

  test("no argument at all still means github, which a machine without it refuses", async () => {
    const run = await withPrelude(`clone_repo '' '${url}' /tmp/devbox-test-a\nclone_repo`, {
      DEVBOX_REPO_URL: url,
    });
    // The second call falls back to `github`, whose file does not exist here.
    expect(run.out).toContain("no /run/secrets/github");
    expect(run.code).not.toBe(0);
  });

  test("a named secret that is not held refuses before cloning", async () => {
    const run = await withPrelude(`clone_repo 'gitlab' '${url}' /tmp/devbox-test-b`);
    expect(run.out).toContain("no /run/secrets/gitlab");
    expect(run.out).not.toContain("git clone");
  });

  test("a profile that declares no repository and calls clone_repo says so", async () => {
    const run = await withPrelude("clone_repo ''");
    expect(run.out).toContain("declares no devbox-repo");
  });
});

describe("what a composed profile may call", () => {
  test("the catalogue's functions are all defined", async () => {
    // The dashboard's catalogue renders these names and nothing else; dashboard/tests
    // asserts the pairing from its side, and this asserts it from the shell's, so a function
    // removed here fails a suite that does not import TypeScript at all.
    const run = await withPrelude(
      ["install_node", "install_chrome", "install_gh", "install_claude_code", "install_opencode", "install_python", "install_bun"]
        .map((name) => `declare -F ${name} >/dev/null || { echo "missing: ${name}"; exit 1; }`)
        .join("\n") + "\necho all-defined",
    );
    expect(run.out).toContain("all-defined");
    expect(run.code).toBe(0);
  });
});

/**
 * run_setup, which is how a composed profile goes past the catalogue: a script of the profile's
 * own repository, run last, as dev, from the checkout.
 *
 * `as_user` is replaced by a plain `bash -c` here, so the string run_setup builds is really
 * run - the %q quoting included, which is why the checkout sits under a directory with a space
 * in its name, where an unquoted path would split in two.
 */
describe("run_setup", () => {
  /** A checkout holding the given files, 0755 when the value says so. */
  function checkout(files: Record<string, { body: string; executable?: boolean }>): string {
    const root = join(mkdtempSync(join(tmpdir(), "devbox-setup-")), "with space", "app");
    mkdirSync(root, { recursive: true });
    for (const [path, { body, executable }] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body, { mode: executable ? 0o755 : 0o644 });
    }
    return root;
  }

  /** run_setup with the checkout as $REPO_DIR, and as_user running what it is handed. */
  const setup = (root: string, call: string) =>
    withPrelude(`as_user() { bash -c "$*"; }\nREPO_DIR=${JSON.stringify(root)}\n${call}\necho "after=$?"`);

  test("runs an executable script from the root of the checkout", async () => {
    const root = checkout({
      "scripts/devbox-setup.sh": { body: '#!/bin/bash\necho "ran in $(pwd -P)"\n', executable: true },
    });
    const run = await setup(root, "run_setup scripts/devbox-setup.sh");
    expect(run.out).toContain(`ran in ${realpathSync(root)}`);
    expect(run.out).toContain("after=0");
  });

  test("hands a script without the executable bit to bash", async () => {
    const root = checkout({ "setup.sh": { body: 'echo "read by bash"\n' } });
    const run = await setup(root, "run_setup setup.sh");
    expect(run.out).toContain("read by bash");
    expect(run.code).toBe(0);
  });

  test("a script that fails fails the call, so the seed stops there", async () => {
    const root = checkout({ "setup.sh": { body: "exit 7\n", executable: true } });
    const run = await setup(root, "set -e\nrun_setup setup.sh");
    expect(run.code).not.toBe(0);
    expect(run.out).not.toContain("after=");
  });

  test("refuses a path that leaves the checkout, before running anything", async () => {
    const root = checkout({ "ok.sh": { body: "echo SHOULD-NOT-RUN\n", executable: true } });
    for (const path of ["/etc/profile", "../ok.sh", "a/../ok.sh", "ok.sh;id", "'ok.sh'", ""]) {
      const run = await setup(root, `run_setup ${JSON.stringify(path)}`);
      expect({ path, code: run.code }).toEqual({ path, code: 1 });
      expect(run.out).toContain("run_setup takes a path inside the repository");
      expect(run.out).not.toContain("SHOULD-NOT-RUN");
    }
  });

  test("refuses a symlink that resolves outside the checkout", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "devbox-outside-")), "elsewhere.sh");
    writeFileSync(outside, "echo SHOULD-NOT-RUN\n", { mode: 0o755 });
    const root = checkout({});
    symlinkSync(outside, join(root, "setup.sh"));
    const run = await setup(root, "run_setup setup.sh");
    expect(run.code).toBe(1);
    expect(run.out).toContain("outside");
    expect(run.out).not.toContain("SHOULD-NOT-RUN");
  });

  test("names a script the clone does not hold", async () => {
    const run = await setup(checkout({}), "run_setup scripts/missing.sh");
    expect(run.code).toBe(1);
    expect(run.out).toContain("no scripts/missing.sh in");
  });

  test("a profile with no repository says so", async () => {
    const run = await withPrelude("run_setup setup.sh");
    expect(run.code).toBe(1);
    expect(run.out).toContain("declares no devbox-repo");
  });
});
