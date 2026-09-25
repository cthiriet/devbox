import type { Subprocess } from "bun";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { openDatabase } from "../src/database";
import { MAX_JOBS, MAX_JOBS_PER_ACCOUNT } from "../src/config";
import { database, insertJob, labels, readJob, recentJobs, runningJobs, setLabel } from "../src/db";
import { runtimeRoot, SecretsMissing } from "../src/engine";
import { applySchema } from "../src/schema";
import { sourcesOf, type Sources } from "../src/secrets";
import { accountTree } from "../src/tree";
import { keyringFromEnv, newMasterKey, setSecret } from "../src/vault";
import {
  activeJobs,
  drawName,
  logPath,
  readLog,
  reconcile,
  start,
  stripAnsi,
} from "../src/jobs";

/**
 * A fake process, so the state machine can be exercised without ordering a machine.
 * Everything `start` touches is here: two streams and an exit code.
 */
function fakeChild(output: string, code: number): Subprocess {
  const encoder = new TextEncoder();
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text !== "") controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
  return {
    stdout: stream(output),
    stderr: stream(""),
    exited: Promise.resolve(code),
    kill() {},
  } as unknown as Subprocess;
}

/** Whose secrets a job is handed. Stated at every call: start() has no default any more. */
const OWNER_SELF = 1;

/**
 * And whose tree it runs in - the state it writes into, and where its log lands. Both are
 * stated at every call, and prepareLaunch refuses a pair that names two accounts.
 */
const TREE = accountTree(OWNER_SELF);

/**
 * A job that asks for nothing: no vault, no environment, and a fallback directory that does
 * not exist. Enough for the state machine, which is what the first tests here exercise.
 */
const NOTHING_HELD: Sources = sourcesOf({
  db: database,
  owner: OWNER_SELF,
  keyring: null,
  env: {},
  secretsDir: join(DATA_DIR, "jobs-nothing-held"),
});

/** The job finishes asynchronously; this waits for the row to settle. */
async function settled(id: number, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (readJob(OWNER_SELF, id)?.state !== "running") return;
    await Bun.sleep(5);
  }
  throw new Error(`job ${id} never left the running state`);
}

describe("drawName", () => {
  test("has devbox's shape: devbox- and five lowercase alphanumerics", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(drawName()).toMatch(/^devbox-[a-z0-9]{5}$/);
    }
  });

  test("is drawn from the source it is given, so a test can pin it", () => {
    expect(drawName(() => 0)).toBe("devbox-aaaaa");
  });

  test("draws a name here rather than letting devbox draw it", () => {
    // A job needs an identity from the moment it is recorded, minutes before a machine
    // exists to carry one. The duplication of devbox's rule is the price of that.
    expect(drawName()).not.toBe(drawName());
  });
});

describe("start", () => {
  test("records the job, runs it, and writes its log", async () => {
    const result = start(
      TREE,
      { verb: "up", argv: ["up", "--name", "devbox-aaaaa"], machine: "devbox-aaaaa", cloud: "hetzner", profile: "bare", secrets: [] },
      1000,
      () => fakeChild("apply: devbox-aaaaa\ndone\n", 0),
      NOTHING_HELD,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await settled(result.id);

    const row = readJob(OWNER_SELF, result.id);
    expect(row?.state).toBe("succeeded");
    expect(row?.exit_code).toBe(0);
    expect(row?.machine).toBe("devbox-aaaaa");
    expect(row?.cloud).toBe("hetzner");
    expect(JSON.parse(row?.argv ?? "[]")).toEqual(["up", "--name", "devbox-aaaaa"]);

    const log = await readLog(TREE, result.id);
    // The command comes first, so a log read weeks later says what produced it.
    expect(log.text).toContain("$ devbox up --name devbox-aaaaa");
    expect(log.text).toContain("apply: devbox-aaaaa");
  });

  test("marks a non-zero exit as failed, not as finished", async () => {
    const result = start(
      TREE,
      { verb: "down", argv: ["down", "devbox-bbbbb"], machine: "devbox-bbbbb", cloud: null, profile: null, secrets: [] },
      2000,
      () => fakeChild("x no machine named that\n", 1),
      NOTHING_HELD,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await settled(result.id);
    const row = readJob(OWNER_SELF, result.id);
    expect(row?.state).toBe("failed");
    expect(row?.exit_code).toBe(1);
  });
});

/** A child that runs until it is released: what "at the same time" is measured with. */
function holding(): { child: Subprocess; release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const child = {
    stdout: new ReadableStream<Uint8Array>({
      async start(controller) {
        await held;
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    exited: held.then(() => 0),
    kill() {},
  } as unknown as Subprocess;
  return { child, release };
}

/**
 * Several jobs at once, and the three rules that still refuse one: one job per machine, and the
 * two caps of src/config.ts.
 *
 * The single slot these replace was a memory bound, not a rule - devbox-core runs concurrent
 * `up` on their own workspaces - and with accounts it had become one account's fourteen-minute
 * `up` refusing every other account's order. What stays refused is the real conflict, and what
 * the caps count.
 */
describe("several jobs at once", () => {
  /** A second account, with a tree and a vault of its own. */
  const OTHER = 2;
  const OTHER_TREE = accountTree(OTHER);
  const OTHER_HELD: Sources = sourcesOf({
    db: database,
    owner: OTHER,
    keyring: null,
    env: {},
    secretsDir: join(DATA_DIR, "jobs-nothing-held"),
  });

  const order = (machine: string): Parameters<typeof start>[1] => ({
    verb: "up",
    argv: ["up", "--name", machine],
    machine,
    cloud: "hetzner",
    profile: "bare",
    secrets: [],
  });

  /** Releases every held child and waits for each job's row to leave `running`. */
  async function finish(held: { release: () => void }[], rows: { account: number; id: number }[]): Promise<void> {
    for (const one of held) one.release();
    for (const { account, id } of rows) {
      for (let i = 0; i < 200 && readJob(account, id)?.state === "running"; i += 1) await Bun.sleep(5);
    }
    expect(activeJobs()).toEqual([]);
  }

  test("runs a job on a second machine while the first one runs", async () => {
    const a = holding();
    const b = holding();
    const first = start(TREE, order("devbox-par01"), 3000, () => a.child, NOTHING_HELD);
    const second = start(TREE, order("devbox-par02"), 3001, () => b.child, NOTHING_HELD);
    if (!first.ok || !second.ok) throw new Error("expected two jobs");

    // Both registered, both rows running, at the same moment.
    expect(activeJobs().map((job) => job.machine)).toEqual(["devbox-par01", "devbox-par02"]);
    expect(runningJobs(OWNER_SELF).map((job) => job.id)).toEqual([first.id, second.id]);

    await finish([a, b], [
      { account: OWNER_SELF, id: first.id },
      { account: OWNER_SELF, id: second.id },
    ]);
  });

  test("refuses a second job on the same machine, naming the job that holds it", async () => {
    const a = holding();
    const first = start(TREE, order("devbox-same1"), 3002, () => a.child, NOTHING_HELD);
    if (!first.ok) throw new Error("expected a job");

    // A `down` of a machine whose `up` is still applying: one workspace, two terraform runs.
    const second = start(
      TREE,
      { verb: "down", argv: ["down", "devbox-same1"], machine: "devbox-same1", cloud: null, profile: null, secrets: [] },
      3003,
      () => fakeChild("", 0),
      NOTHING_HELD,
    );
    expect(second).toEqual({
      ok: false,
      limit: "machine",
      reason: expect.stringContaining("devbox-same1"),
      busy: first.id,
    });
    // And nothing was recorded for the refused one: a row would show a job that never ran.
    expect(recentJobs(OWNER_SELF, 1000).filter((job) => job.machine === "devbox-same1")).toHaveLength(1);

    // Another account may hold a machine of the same name - devbox draws five characters - and
    // is not refused for this one.
    const theirs = start(OTHER_TREE, order("devbox-same1"), 3004, () => fakeChild("", 0), OTHER_HELD);
    if (!theirs.ok) throw new Error(`expected the other account's job to start: ${theirs.reason}`);

    await finish([a], [
      { account: OWNER_SELF, id: first.id },
      { account: OTHER, id: theirs.id },
    ]);
  });

  test("refuses past the account's cap, naming the cap and no job", async () => {
    const held = Array.from({ length: MAX_JOBS_PER_ACCOUNT }, () => holding());
    const rows = held.map((one, index) => {
      const result = start(TREE, order(`devbox-cap${index}`), 3010 + index, () => one.child, NOTHING_HELD);
      if (!result.ok) throw new Error(`expected job ${index} to start: ${result.reason}`);
      return { account: OWNER_SELF, id: result.id };
    });

    const refused = start(TREE, order("devbox-capx"), 3020, () => fakeChild("", 0), NOTHING_HELD);
    expect(refused).toEqual({
      ok: false,
      limit: "account",
      reason: expect.stringContaining("DEVBOX_MAX_JOBS_PER_ACCOUNT"),
      busy: null,
    });
    expect(recentJobs(OWNER_SELF, 1000).some((job) => job.machine === "devbox-capx")).toBe(false);

    await finish(held, rows);
  });

  test("refuses past the service's cap, and names no job of anyone", async () => {
    // Filled with the first account up to its own cap, and the rest with the second one, so the
    // refusal met is the service's and not the account's.
    const firstShare = Math.min(MAX_JOBS_PER_ACCOUNT, MAX_JOBS);
    const secondShare = MAX_JOBS - firstShare;
    if (secondShare >= MAX_JOBS_PER_ACCOUNT) throw new Error("these defaults need a third account to fill the service");

    const held: { release: () => void }[] = [];
    const rows: { account: number; id: number }[] = [];
    const fill = (paths: typeof TREE, sources: Sources, account: number, count: number, prefix: string) => {
      for (let index = 0; index < count; index += 1) {
        const one = holding();
        const result = start(paths, order(`${prefix}${index}`), 3030 + index, () => one.child, sources);
        if (!result.ok) throw new Error(`expected ${prefix}${index} to start: ${result.reason}`);
        held.push(one);
        rows.push({ account, id: result.id });
      }
    };
    fill(TREE, NOTHING_HELD, OWNER_SELF, firstShare, "devbox-svca");
    fill(OTHER_TREE, OTHER_HELD, OTHER, secondShare, "devbox-svcb");
    expect(activeJobs()).toHaveLength(MAX_JOBS);

    const refused = start(OTHER_TREE, order("devbox-svcx"), 3040, () => fakeChild("", 0), OTHER_HELD);
    expect(refused).toEqual({
      ok: false,
      limit: "service",
      reason: expect.stringContaining("DEVBOX_MAX_JOBS"),
      busy: null,
    });
    expect(recentJobs(OTHER, 1000).some((job) => job.machine === "devbox-svcx")).toBe(false);

    await finish(held, rows);
  });
});

/**
 * The directory a job's secrets are laid out in: see prepareLaunch in src/engine.ts.
 *
 * The plaintext of a sealed value exists on the disk - on a tmpfs, in production - for as
 * long as the child that reads it, and not a moment longer. These run the real `start`, with a
 * spawner that looks at the directory while the "child" is alive, so both halves are asserted:
 * that it was there, right, while it mattered, and that it was gone after.
 */
describe("the launch directory", () => {
  const ROOT = join(DATA_DIR, "jobs-launch");
  let drawn = 0;

  /**
   * A vault of the test's own, and a fallback directory beside it. The directory is narrowed
   * back to a string, which a Sources no longer promises: an account without the service's
   * fallback has no directory at all.
   */
  function held(): Sources & { secretsDir: string } {
    drawn += 1;
    const secretsDir = join(ROOT, `legacy-${drawn}`);
    mkdirSync(secretsDir, { recursive: true });
    const db = openDatabase(join(ROOT, `vault-${drawn}.db`));
    applySchema(db);
    const keyring = keyringFromEnv({ DEVBOX_MASTER_KEY: newMasterKey(1) });
    if (keyring === null) throw new Error("expected a keyring");
    return { ...sourcesOf({ db, owner: OWNER_SELF, keyring, env: {}, secretsDir }), secretsDir };
  }

  type Seen = { dir: string; files: Record<string, { mode: number; text: string }>; mode: number; env: Record<string, string> };

  /** A spawner that records what the child would have found, then exits with `code`. */
  function watching(code: number): { spawner: (argv: string[], env: Record<string, string>) => Subprocess; seen: Seen[] } {
    const seen: Seen[] = [];
    return {
      seen,
      spawner: (_argv, env) => {
        const dir = env.DEVBOX_SECRETS_DIR ?? "";
        const files: Seen["files"] = {};
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          files[name] = { mode: statSync(path).mode & 0o777, text: readFileSync(path, "utf8") };
        }
        seen.push({ dir, files, mode: statSync(join(dir, "..")).mode & 0o777, env });
        return fakeChild("", code);
      },
    };
  }

  const launches = () => readdirSync(runtimeRoot().path).filter((name) => name.startsWith("launch-"));

  test("holds the declared secrets at 0400 in a 0700 directory, and is gone after", async () => {
    const sources = held();
    setSecret(sources.db, sources.keyring!, OWNER_SELF, "profile", "claude", "sk-from-the-vault", 1);
    setSecret(sources.db, sources.keyring!, OWNER_SELF, "cloud", "HCLOUD_TOKEN", "hc-from-the-vault", 1);
    writeFileSync(join(sources.secretsDir, "github"), "ghp_from_the_file");
    // In the fallback, and in no profile this job runs: it must not travel.
    writeFileSync(join(sources.secretsDir, "openai"), "sk-not-declared");

    const { spawner, seen } = watching(0);
    const result = start(
      TREE,
      { verb: "up", argv: ["up"], machine: "devbox-launch1", cloud: "hetzner", profile: "claude", secrets: ["claude", "github"] },
      10_000,
      spawner,
      sources,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await settled(result.id);

    const [child] = seen;
    expect(child?.mode).toBe(0o700);
    expect(statSync(runtimeRoot().path).isDirectory()).toBe(true);
    expect(child?.files).toEqual({
      claude: { mode: 0o400, text: "sk-from-the-vault" },
      github: { mode: 0o400, text: "ghp_from_the_file" },
    });
    // The cloud token in the environment, which is the channel devbox-core reads it from.
    expect(child?.env.HCLOUD_TOKEN).toBe("hc-from-the-vault");
    // And the variable that would have shadowed the file, withheld.
    expect(Object.keys(child?.env ?? {})).not.toContain("DEVBOX_CLAUDE_TOKEN");

    expect(existsSync(child?.dir ?? "/")).toBe(false);
    expect(existsSync(join(child?.dir ?? "/", ".."))).toBe(false);
  });

  test("is removed when the child fails, as when it succeeds", async () => {
    const { spawner, seen } = watching(1);
    const result = start(
      TREE,
      { verb: "down", argv: ["down", "devbox-launch2"], machine: "devbox-launch2", cloud: null, profile: null, secrets: [] },
      11_000,
      spawner,
      held(),
    );
    if (!result.ok) throw new Error("expected a job");
    await settled(result.id);
    expect(readJob(OWNER_SELF, result.id)?.state).toBe("failed");
    expect(seen[0]?.files).toEqual({});
    expect(existsSync(join(seen[0]?.dir ?? "/", ".."))).toBe(false);
  });

  test("is removed when the child cannot even be started, and the job says why", async () => {
    const before = launches();
    const result = start(
      TREE,
      { verb: "seed", argv: ["seed", "devbox-launch3"], machine: "devbox-launch3", cloud: null, profile: null, secrets: [] },
      12_000,
      () => {
        throw new Error("no engine here");
      },
      held(),
    );
    if (!result.ok) throw new Error("expected a job");
    expect(readJob(OWNER_SELF, result.id)?.state).toBe("failed");
    expect(launches()).toEqual(before);
    // The next job is not blocked by one that never ran.
    expect(activeJobs()).toEqual([]);
    await Bun.sleep(20);
    expect((await readLog(TREE, result.id, 0, true)).text).toContain("could not start devbox: Error: no engine here");
  });

  test("refuses a secret nothing holds before recording anything or writing a file", () => {
    const before = launches();
    const rows = recentJobs(OWNER_SELF, 1000).length;
    const sources = held();
    writeFileSync(join(sources.secretsDir, "github"), "ghp_present");
    expect(() =>
      start(
        TREE,
        { verb: "up", argv: ["up"], machine: "devbox-launch4", cloud: "hetzner", profile: "claude", secrets: ["github", "claude"] },
        13_000,
        () => fakeChild("", 0),
        sources,
      ),
    ).toThrow(SecretsMissing);
    expect(recentJobs(OWNER_SELF, 1000).length).toBe(rows);
    expect(launches()).toEqual(before);
  });

  /**
   * Found on 11/09: one cloud's credential that could not be
   * read threw out of start(), and the `down` of a machine on ANOTHER cloud was refused - a
   * machine billing, and nothing here able to destroy it.
   */
  test("runs a `down` whose cloud is fine when another cloud's credential does not open, and logs why", async () => {
    const sources = held();
    setSecret(sources.db, sources.keyring!, OWNER_SELF, "cloud", "HCLOUD_TOKEN", "hc-for-the-down", 1);
    setSecret(sources.db, sources.keyring!, OWNER_SELF, "cloud", "gcp", '{"client_email":"y"}', 1);
    sources.db.run("UPDATE secrets SET nonce = zeroblob(12) WHERE name = 'gcp'");

    const { spawner, seen } = watching(0);
    const result = start(
      TREE,
      { verb: "down", argv: ["down", "--quiet", "devbox-hz"], machine: "devbox-hz", cloud: null, profile: null, secrets: [] },
      15_000,
      spawner,
      sources,
    );
    if (!result.ok) throw new Error("expected a job");
    await settled(result.id);

    expect(readJob(OWNER_SELF, result.id)?.state).toBe("succeeded");
    expect(seen[0]?.env.HCLOUD_TOKEN).toBe("hc-for-the-down");
    expect(seen[0]?.files).toEqual({});
    const log = (await readLog(TREE, result.id, 0, true)).text;
    expect(log.split("\n")[1]).toStartWith("/!\\ gcp: its credentials cannot be read, so it was left out:");
    expect(log).toContain("cloud/gcp of owner 1 does not open");
    expect(log).not.toContain("client_email");
  });

  test("still refuses a profile secret whose row does not open, before recording anything", () => {
    const sources = held();
    setSecret(sources.db, sources.keyring!, OWNER_SELF, "profile", "claude", "sk-x", 1);
    sources.db.run("UPDATE secrets SET nonce = zeroblob(12) WHERE name = 'claude'");
    const rows = recentJobs(OWNER_SELF, 1000).length;
    expect(() =>
      start(
        TREE,
        { verb: "seed", argv: ["seed", "devbox-strict"], machine: "devbox-strict", cloud: null, profile: null, secrets: ["claude"] },
        16_000,
        () => fakeChild("", 0),
        sources,
      ),
    ).toThrow(/does not open/);
    expect(recentJobs(OWNER_SELF, 1000).length).toBe(rows);
  });

  test("keeps every value out of the argv the jobs table records", async () => {
    const sources = held();
    setSecret(sources.db, sources.keyring!, OWNER_SELF, "profile", "claude", "sk-never-in-argv", 1);
    const result = start(
      TREE,
      { verb: "up", argv: ["up", "--profile", "claude"], machine: "devbox-launch5", cloud: "hetzner", profile: "claude", secrets: ["claude"] },
      14_000,
      () => fakeChild("", 0),
      sources,
    );
    if (!result.ok) throw new Error("expected a job");
    await settled(result.id);
    expect(JSON.stringify(readJob(OWNER_SELF, result.id))).not.toContain("sk-never-in-argv");
    // The service's own database was the one written, and it holds no copy either.
    expect(JSON.stringify(database.query("SELECT * FROM jobs").all())).not.toContain("sk-never-in-argv");
  });
});

describe("stripAnsi", () => {
  test("removes the colours terraform and devbox both emit", () => {
    // A browser renders an escape sequence as literal text. A destroy plan is mostly
    // coloured lines, so unstripped it is unreadable on a phone.
    expect(stripAnsi("\u001B[31m- destroyed\u001B[0m")).toBe("- destroyed");
    expect(stripAnsi("\u001B[1;36m==>\u001B[0m done")).toBe("==> done");
  });

  test("leaves ordinary text alone, brackets included", () => {
    expect(stripAnsi("apply: [id=162869115] ok")).toBe("apply: [id=162869115] ok");
  });

  test("drops a lone carriage return but keeps the newline", () => {
    // Progress lines rewrite themselves with \r, which a <pre> renders as a line that
    // never advances.
    expect(stripAnsi("still creating...\rdone\n")).toBe("still creating...done\n");
    expect(stripAnsi("a\r\nb")).toBe("a\r\nb");
  });
});

describe("readLog", () => {
  test("reads from an offset, so a browser follows without re-reading", async () => {
    const result = start(
      TREE,
      { verb: "seed", argv: ["seed", "devbox-eeeee"], machine: "devbox-eeeee", cloud: null, profile: "bare", secrets: [] },
      4000,
      () => fakeChild("one\ntwo\n", 0),
      NOTHING_HELD,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await settled(result.id);

    const whole = await readLog(TREE, result.id);
    const tail = await readLog(TREE, result.id, whole.size - 4);
    expect(tail.text).toBe("two\n");
    expect(tail.size).toBe(whole.size);

    // Asking past the end yields nothing rather than throwing: that is the steady state
    // of a browser polling a finished job.
    expect((await readLog(TREE, result.id, whole.size)).text).toBe("");
  });

  test("withholds a partial line while the job is still running", async () => {
    // An escape sequence split across two polls would survive stripping and land on
    // screen in pieces. The cut is on bytes, so the offset stays exact under UTF-8.
    const id = insertJob(OWNER_SELF, {
      verb: "up",
      machine: "devbox-ggggg",
      cloud: null,
      profile: null,
      argv: ["up"],
      startedAt: 8000,
    });
    await Bun.write(logPath(TREE, id), "complete\nincomplet");

    const running = await readLog(TREE, id, 0, false);
    expect(running.text).toBe("complete\n");
    expect(running.size).toBe("complete\n".length);

    // Once it is over, the remainder is handed over rather than withheld forever.
    const done = await readLog(TREE, id, running.size, true);
    expect(done.text).toBe("incomplet");
  });

  test("counts bytes and not characters", async () => {
    const id = insertJob(OWNER_SELF, {
      verb: "up",
      machine: "devbox-hhhhh",
      cloud: null,
      profile: null,
      argv: ["up"],
      startedAt: 9000,
    });
    // Nine bytes for six characters: an offset counted in characters would cut mid-glyph.
    await Bun.write(logPath(TREE, id), "éàü ok\n");
    const log = await readLog(TREE, id, 0, true);
    expect(log.text).toBe("éàü ok\n");
    expect(log.size).toBe(Buffer.byteLength("éàü ok\n"));
  });

  test("answers for a job that has no log at all", async () => {
    expect(await readLog(TREE, 999_999)).toEqual({ text: "", size: 0 });
  });
});

describe("reconcile", () => {
  test("turns a job left running into interrupted, never into finished, whoever's it was", () => {
    // A job found running belonged to a process this one did not start. Calling it
    // finished would hide the case that costs money: a service restarted mid-apply may
    // have left a machine with the provider that no state records, and only
    // `devbox orphans` can find it.
    //
    // The rows are inserted directly because the only honest way to produce this state is
    // to kill the process that owned it.
    const mine = insertJob(OWNER_SELF, {
      verb: "up",
      machine: "devbox-fffff",
      cloud: "hetzner",
      profile: "claude",
      argv: ["up", "--name", "devbox-fffff"],
      startedAt: 5000,
    });
    // A restart kills the whole cgroup, so the sweep is every account's - the one statement on
    // `jobs` that names none.
    const theirs = insertJob(2, {
      verb: "seed",
      machine: "devbox-fffff",
      cloud: null,
      profile: null,
      argv: ["seed", "devbox-fffff"],
      startedAt: 5001,
    });
    expect(readJob(OWNER_SELF, mine)?.state).toBe("running");
    // And a job is read back by its own account alone.
    expect(readJob(2, mine)).toBeNull();

    // Counted rather than hardcoded, and across every account: other tests in this file leave
    // rows behind, and an absolute number here would break every time one is added.
    const left = (database.query("SELECT COUNT(*) AS n FROM jobs WHERE state = 'running'").get() as { n: number }).n;
    expect(left).toBeGreaterThanOrEqual(2);
    expect(reconcile(6000)).toBe(left);

    for (const [account, id] of [[OWNER_SELF, mine], [2, theirs]] as const) {
      const row = readJob(account, id);
      expect(row?.state).toBe("interrupted");
      expect(row?.ended_at).toBe(6000);
      // No exit code, because nothing here ever saw the process exit.
      expect(row?.exit_code).toBeNull();
    }
    expect(runningJobs(OWNER_SELF)).toEqual([]);
    expect(runningJobs(2)).toEqual([]);
  });

  test("does nothing when there is nothing left over", () => {
    expect(reconcile(7000)).toBe(0);
  });
});

describe("logPath", () => {
  test("is derived from the id, and is the only place it is formed", () => {
    expect(logPath(TREE, 12)).toEndWith("/12.log");
  });
});

describe("labels", () => {
  /**
   * A label is the only place a machine is named twice, so what matters is that it stays
   * beside the real name rather than replacing it: nothing here resolves a machine BY its
   * label, and there is no query that could.
   */
  test("keeps a label, and hands them all back at once", () => {
    setLabel(OWNER_SELF, "devbox-aaaaa", "Le serveur d'Alice", 1);
    setLabel(OWNER_SELF, "devbox-bbbbb", "staging", 2);

    const all = labels(OWNER_SELF);
    expect(all.get("devbox-aaaaa")).toBe("Le serveur d'Alice");
    expect(all.get("devbox-bbbbb")).toBe("staging");
    expect(all.get("devbox-ccccc")).toBeUndefined();
  });

  test("replaces rather than duplicating", () => {
    setLabel(OWNER_SELF, "devbox-ddddd", "first", 1);
    setLabel(OWNER_SELF, "devbox-ddddd", "second", 2);
    expect(labels(OWNER_SELF).get("devbox-ddddd")).toBe("second");
  });

  /** One control both names and un-names: an empty label is a removal. */
  test("removes on the empty string", () => {
    setLabel(OWNER_SELF, "devbox-eeeee", "gone in a moment", 1);
    setLabel(OWNER_SELF, "devbox-eeeee", "", 2);
    expect(labels(OWNER_SELF).has("devbox-eeeee")).toBe(false);
  });

  /**
   * A machine name is unique inside one account's tree and nowhere else: two accounts may both
   * hold a devbox-twin01. Keyed by the name alone, one account's label would rename, on its
   * own page, the machine the other one sees.
   */
  test("keeps one account's label off another account's machine of the same name", () => {
    setLabel(OWNER_SELF, "devbox-twin01", "mine", 1);
    setLabel(2, "devbox-twin01", "theirs", 2);
    expect(labels(OWNER_SELF).get("devbox-twin01")).toBe("mine");
    expect(labels(2).get("devbox-twin01")).toBe("theirs");

    setLabel(2, "devbox-twin01", "", 3);
    expect(labels(OWNER_SELF).get("devbox-twin01")).toBe("mine");
    expect(labels(2).has("devbox-twin01")).toBe(false);
  });
});
