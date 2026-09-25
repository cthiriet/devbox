import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holdsWork, parseUnpushed, UNPUSHED_COMMAND } from "../src/unpushed";

/**
 * What a machine is holding, before it is destroyed.
 *
 * Two halves, and the second is the one that matters: the command is a paragraph of POSIX
 * shell running against a real git on the far side, and every way it can be wrong is quiet.
 * A glob that does not match expands to itself; `@{u}` on a branch with no upstream is an
 * error, not a zero; `git status` counts untracked files only because `--porcelain` says so.
 * So it is run here against real repositories, with `/workspace` pointed at a temporary
 * directory - the one substitution, and the rest of the line is the deployed one.
 *
 * The failures all point the same way, which is why they are worth a test: each of them
 * makes this answer "nothing to lose" about a machine that holds a week of work.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "devbox",
  GIT_AUTHOR_EMAIL: "devbox@example.invalid",
  GIT_COMMITTER_NAME: "devbox",
  GIT_COMMITTER_EMAIL: "devbox@example.invalid",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): void {
  const done = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (done.status !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr}`);
}

/** A bare origin and a clone of it with one commit pushed: the state a seeded machine is in. */
function machine(): { root: string; workspace: string; checkout: string } {
  const root = mkdtempSync(join(tmpdir(), "devbox-unpushed-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });

  const origin = join(root, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-b", "main");

  const checkout = join(workspace, "app");
  git(workspace, "clone", "-q", origin, checkout);
  writeFileSync(join(checkout, "README.md"), "one\n");
  git(checkout, "add", "README.md");
  git(checkout, "commit", "-qm", "first");
  git(checkout, "push", "-q", "-u", "origin", "main");
  return { root, workspace, checkout };
}

/** The deployed command, with `/workspace` moved somewhere a test may write. */
function ask(root: string): ReturnType<typeof parseUnpushed> {
  const line = UNPUSHED_COMMAND.replaceAll("/workspace", join(root, "workspace"));
  const answer = spawnSync("sh", ["-c", line], { env: GIT_ENV, encoding: "utf8" });
  expect(answer.status).toBe(0);
  return parseUnpushed(answer.stdout);
}

describe("what the machine answers", () => {
  test("a checkout with everything committed and pushed holds nothing", () => {
    const { root } = machine();
    const checkouts = ask(root);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toMatchObject({ branch: "main", changed: 0, ahead: 0 });
    expect(holdsWork(checkouts)).toBe(false);
  });

  /**
   * The case this whole thing exists for. A file that was never added is the file this
   * machine is the only copy of, and `git status --porcelain` is what counts it.
   */
  test("a file never added counts, like a modified one", () => {
    const { root, checkout } = machine();
    writeFileSync(join(checkout, "notes.md"), "only here\n");
    const checkouts = ask(root);
    expect(checkouts[0]?.changed).toBe(1);
    expect(holdsWork(checkouts)).toBe(true);
  });

  test("a commit the upstream does not have is counted, not the whole history", () => {
    const { root, checkout } = machine();
    writeFileSync(join(checkout, "README.md"), "two\n");
    git(checkout, "commit", "-qam", "second");
    const checkouts = ask(root);
    expect(checkouts[0]).toMatchObject({ changed: 0, ahead: 1 });
    expect(holdsWork(checkouts)).toBe(true);
  });

  /**
   * A branch nobody ever pushed answers null, and null is not zero: `rev-list @{u}..HEAD`
   * FAILS there rather than returning 0, and a command that read that failure as "nothing
   * ahead" would report the branch holding every commit it has as the safest one to destroy.
   */
  test("a branch with no upstream is null, not zero", () => {
    const { root, checkout } = machine();
    git(checkout, "checkout", "-q", "-b", "spike");
    writeFileSync(join(checkout, "README.md"), "three\n");
    git(checkout, "commit", "-qam", "third");
    const checkouts = ask(root);
    expect(checkouts[0]).toMatchObject({ branch: "spike", ahead: null });
    expect(holdsWork(checkouts)).toBe(true);
  });

  test("several checkouts, each on its own line", () => {
    const { root, workspace, checkout } = machine();
    git(workspace, "clone", "-q", join(root, "origin.git"), "infra");
    writeFileSync(join(checkout, "notes.md"), "here\n");
    const checkouts = ask(root);
    expect(checkouts.map((one) => one.dir.split("/").pop()).sort()).toEqual(["app", "infra"]);
  });

  /**
   * `git init` and an afternoon's work, with nothing committed yet: git answers nothing about
   * `HEAD` there, and a command that asked it first dropped the row entirely. The machine
   * would have reported one clean checkout and said nothing about the other - which is this
   * whole feature answering "nothing to lose" about the one directory that holds everything.
   */
  test("a repository with no commit yet still counts its files", () => {
    const { root, workspace } = machine();
    const fresh = join(workspace, "spike");
    mkdirSync(fresh);
    git(fresh, "init", "-q", "-b", "main");
    writeFileSync(join(fresh, "main.py"), "print('only here')\n");
    const checkouts = ask(root);
    const one = checkouts.find((each) => each.dir.endsWith("/spike"));
    expect(one).toMatchObject({ branch: "-", changed: 1, ahead: 0 });
    expect(holdsWork([one!])).toBe(true);
  });

  /**
   * A directory with a `.git` that git will not open is not a checkout, and the line it
   * would have produced would have said `0 changed` about something nobody can read.
   */
  test("a directory git refuses is left out rather than counted as clean", () => {
    const { root, workspace } = machine();
    mkdirSync(join(workspace, "broken", ".git"), { recursive: true });
    const checkouts = ask(root);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]?.dir.endsWith("/app")).toBe(true);
  });

  test("an empty workspace answers nothing at all, and not an error", () => {
    const root = mkdtempSync(join(tmpdir(), "devbox-unpushed-"));
    mkdirSync(join(root, "workspace"));
    expect(ask(root)).toEqual([]);
    expect(holdsWork([])).toBe(false);
  });

  test("no workspace at all answers the same", () => {
    const root = mkdtempSync(join(tmpdir(), "devbox-unpushed-"));
    expect(ask(root)).toEqual([]);
  });
});

describe("parseUnpushed", () => {
  test("keeps the good lines around one it cannot read", () => {
    const stdout =
      "Welcome to Ubuntu 24.04 LTS\n" +
      "/workspace/app\tmain\t3\t2\n" +
      "garbage\n" +
      "/workspace/infra\tspike\t0\t-\n";
    expect(parseUnpushed(stdout)).toEqual([
      { dir: "/workspace/app", branch: "main", changed: 3, ahead: 2 },
      { dir: "/workspace/infra", branch: "spike", changed: 0, ahead: null },
    ]);
  });

  test("drops a row whose counts are not counts", () => {
    expect(parseUnpushed("/workspace/app\tmain\tlots\t2\n")).toEqual([]);
    expect(parseUnpushed("/workspace/app\tmain\t1\tmany\n")).toEqual([]);
    expect(parseUnpushed("app\tmain\t1\t2\n")).toEqual([]);
  });
});

describe("holdsWork", () => {
  test("is false only when every checkout is committed and pushed", () => {
    const clean = { dir: "/workspace/app", branch: "main", changed: 0, ahead: 0 };
    expect(holdsWork([clean])).toBe(false);
    expect(holdsWork([clean, { ...clean, changed: 1 }])).toBe(true);
    expect(holdsWork([clean, { ...clean, ahead: 1 }])).toBe(true);
    expect(holdsWork([clean, { ...clean, ahead: null }])).toBe(true);
  });
});

describe("UNPUSHED_COMMAND", () => {
  /**
   * `git status` refreshes the index when it can, which takes `index.lock` and writes. An
   * agent may be mid-commit in that checkout while a phone opens the destroy dialog, and a
   * read that can make a write fail is not a read.
   */
  test("takes no lock on the checkout it reads", () => {
    expect(UNPUSHED_COMMAND).toContain("--no-optional-locks");
  });

  /**
   * It is a constant: nothing of the caller's - no machine name, no account - is spelled into
   * a line that runs on someone's machine.
   */
  test("takes nothing from the caller", () => {
    expect(UNPUSHED_COMMAND).toContain("/workspace/*/.git");
    expect(UNPUSHED_COMMAND).not.toContain("`");
  });

  /**
   * Reads only. This string runs on a machine where `dev` has passwordless sudo, beside a
   * checkout somebody is working in, and the next hand to edit it should have to think about
   * that: a `git checkout` or a `git clean` slipped in here would destroy the very work the
   * dialog above it exists to protect.
   */
  test("names no command that writes", () => {
    for (const verb of ["rm ", "sudo", "checkout", "reset", "clean", "stash", "push"]) {
      expect(UNPUSHED_COMMAND).not.toContain(verb);
    }
  });
});
