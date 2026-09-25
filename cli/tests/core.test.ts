import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE, cleanup, runCore, strip, warnings } from "./harness.ts";

/**
 * The version handshake, exercised against the real devbox-core.
 *
 * This is the first test in the repository that runs the bash. It has to be: the thing
 * under test is a conversation between two files that only exist as bytes — devbox-core here,
 * and the copy build-engine.ts deposits as dashboard/engine/devbox over there — and a
 * TypeScript reimplementation of `sha256sum | cut -d' ' -f1` would prove nothing about
 * whether those two ever agree.
 *
 * Black box, and not sourced: devbox-core runs migrate_from_devbox at load and dispatches
 * unconditionally at the end, so `. devbox-core` is not a way to reach one function. Every
 * test below spawns the file and reads what came out.
 *
 * The rule the file encodes, and the reason each test exists: THREE states, never two.
 *   identical            -> silence
 *   different            -> one warning naming both short digests and the command
 *   could not find out   -> one warning that opens differently, so it cannot be misread
 * A check that renders doubt as agreement is the failure this whole mechanism was written
 * against — it cost a morning of fixing devbox-core and watching the server run the old copy
 * anyway — so "I could not tell" is never silent, and never fatal either.
 */

/** What the dashboard should answer with when it is running these very bytes. */
const OURS = new Bun.CryptoHasher("sha256").update(readFileSync(CORE)).digest("hex");

/** A perfectly well-formed digest that is simply not ours: a dashboard one deploy behind. */
const THEIRS = "0123456789abcdef".repeat(4);

/**
 * jq is what devbox-core reads the answer with, and sha256sum-or-shasum is what it computes
 * ours with; without either, version_gate deliberately says nothing at all and there is no
 * behaviour left to assert. Skipped rather than failed, and visible in the run.
 */
const CANNOT_RUN =
  Bun.which("jq") === null || (Bun.which("shasum") === null && Bun.which("sha256sum") === null);

type Reply = { status: number; body: string; type: string };
type Machine = { name: string } & Record<string, unknown>;

const json = (value: unknown): Reply => ({
  status: 200,
  body: JSON.stringify(value),
  type: "application/json",
});

/** The shape dashboard/src/engine.ts returns: the core's sha256, and when it was built. */
const served = (core: string | null): Reply =>
  json({ core, built_at: core === null ? null : "2026-08-21T09:00:00.000Z" });

/** Milliseconds /api/version sits on the answer, for the one test about the leash. */
let stall = 0;
let version: Reply = served(OURS);
let fleet: Machine[] = [];
let counts: Record<string, number> = {};

/**
 * The dashboard, reduced to the three routes this handshake and the commands around it
 * touch. It counts by path, which is the only way to assert "once per invocation" from
 * outside: nothing in the output of `devbox info` reveals how many times /api/version was
 * asked.
 */
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    counts[path] = (counts[path] ?? 0) + 1;
    if (path === "/api/version") {
      if (stall > 0) return Bun.sleep(stall).then(() => new Response("late", { status: 200 }));
      return new Response(version.body, {
        status: version.status,
        headers: { "content-type": version.type },
      });
    }
    if (path === "/api/machines") return Response.json(fleet);
    const one = fleet.find((machine) => path === `/api/machines/${machine.name}`);
    if (one) return Response.json(one);
    return new Response("not found", { status: 404 });
  },
});
// So that a machine without jq, where the whole block is skipped and afterAll may never
// run, does not sit on an open listener instead of finishing the run.
server.unref();

const roots: string[] = [];

afterAll(() => {
  server.stop(true);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  cleanup();
});

beforeEach(() => {
  counts = {};
  version = served(OURS);
  fleet = [];
  stall = 0;
});


/**
 * One invocation of the real file.
 *
 * HOME is a fresh temporary directory and that is NOT hygiene, it is the safety rail:
 * devbox-core writes $HOME/.ssh/config and $HOME/.ssh/known_hosts through paths built from
 * HOME with no DEVBOX_* override anywhere, so a test that let the operator's own HOME through
 * could rewrite the file that holds every host they ssh to.
 *
 * The environment is built up rather than inherited from process.env for the second rail:
 * an HCLOUD_TOKEN or a SCW_SECRET_KEY exported in the operator's shell is all `probe` would
 * need to start talking to a real provider. Only PATH crosses over.
 *
 * stdin is closed, exactly as the Ink layer spawns this file — which is what makes "never
 * prompts" a testable property rather than a hope.
 */
async function run(argv: string[], extra: Record<string, string | undefined> = {}) {
  return runCore(argv, {
    DEVBOX_REMOTE: server.url.origin,
    DEVBOX_REMOTE_TOKEN: "t",
    ...extra,
  });
}

/**
 * The remedy, whole where it must appear. Where it must NOT, the needle is its head alone:
 * `not.toContain` of a full sentence passes the moment one word of its tail is reworded, so
 * an absence is asserted on the shortest string that still means "go deploy".
 */
const FIX = "redeploy the dashboard (cd dashboard && bun run verify first)";
const DEPLOY = "redeploy the dashboard";

describe.skipIf(CANNOT_RUN)("the version handshake, from the bash side", () => {
  test("says nothing when both sides run these very bytes", async () => {
    version = served(OURS);
    const { code, stdout, stderr } = await run(["ls", "--json"]);

    // The silence is the feature. A gate that printed "versions match" on every command
    // would be trained away within a week, and then the one line that matters would be
    // read as noise too.
    expect(warnings(stderr)).toEqual([]);
    expect(stderr).not.toContain(DEPLOY);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(code).toBe(0);
  });

  test("warns when the dashboard runs another core, names the command that closes it, and answers anyway", async () => {
    version = served(THEIRS);
    const { code, stdout, stderr } = await run(["ls", "--json"]);

    expect(stderr).toContain(FIX);
    // Both digests, because "they differ" without them cannot be checked against what a
    // deploy just put there, and the operator would have no way to tell a stale warning
    // from a live one.
    expect(stderr).toContain(THEIRS.slice(0, 7));
    expect(stderr).toContain(OURS.slice(0, 7));

    // Once. version_gate sits before the dispatch precisely so this cannot repeat per
    // API call, and a duplicated warning is the first symptom of it having moved.
    const lines = stderr.split("\n").filter((line) => line.includes(DEPLOY));
    expect(lines).toHaveLength(1);

    expect(JSON.parse(stdout)).toEqual([]);
    // The most important assertion in this file. version_gate always returns 0, and if a
    // change ever turns this warn into a die, every machine that is one deploy behind
    // loses `devbox ls`, `devbox info` and `devbox down` — including the one it would have been
    // used to fix the gap with.
    expect(code).toBe(0);
  });

  test("reads a 404 on /api/version as proof the dashboard predates this check", async () => {
    // What production answers today, byte for byte: the route does not exist there yet.
    version = { status: 404, body: "not found", type: "text/plain" };
    const { code, stderr } = await run(["ls", "--json"]);

    // An absent route is not missing information — it can only belong to a build made
    // before the route existed, so it is proof, and it is said as proof.
    expect(stderr).toContain("deployed before this check existed");
    expect(stderr).toContain(FIX);
    expect(code).toBe(0);
  });

  test("never renders doubt as agreement", async () => {
    const cases: Array<{ what: string; reply: Reply; opens?: string; names_deploy: boolean }> = [
      // A 200 with no core at all. Something other than this dashboard is answering — a
      // proxy, a maintenance page, a later rewrite — and a reply that never mentioned an
      // engine cannot be turned into a claim about one. That is doubt, and "deploy" would
      // be advice that changes nothing.
      {
        what: "an answer with no core field",
        reply: json({}),
        opens: "cannot tell what",
        names_deploy: false,
      },
      // engine.ts returns this when the file it hashes is not there: nothing deployed.
      { what: "a core of null", reply: served(null), names_deploy: true },
      // A proxy or a login page in front of the dashboard, answering 200 in HTML.
      {
        what: "a body that is not JSON",
        reply: { status: 200, body: "<html>hello</html>", type: "text/html" },
        opens: "cannot tell what",
        names_deploy: false,
      },
      // A string the server chose, on its way to a terminal. Not a digest, so not usable.
      {
        what: "a core that is not hexadecimal",
        reply: json({ core: "not-a-hash", built_at: null }),
        opens: "cannot tell what",
        names_deploy: false,
      },
      // A gateway that is up while the app behind it is not.
      {
        what: "a 502 from in front of the dashboard",
        reply: { status: 502, body: "bad gateway", type: "text/plain" },
        opens: "cannot tell what",
        names_deploy: false,
      },
    ];

    for (const item of cases) {
      counts = {};
      version = item.reply;
      const { code, stderr } = await run(["ls", "--json"]);
      const said = warnings(stderr);

      expect(said, item.what).toHaveLength(1);
      const line = said[0] ?? "";
      if (item.opens !== undefined) {
        // A deliberately different opening: "cannot tell" and "they differ" call for
        // different actions, and one sentence must never be mistaken for the other.
        expect(line.startsWith(item.opens), `${item.what}: ${line}`).toBe(true);
      }
      expect(line.includes(DEPLOY), item.what).toBe(item.names_deploy);
      if (item.names_deploy) expect(line, item.what).toContain(FIX);
      expect(code, item.what).toBe(0);
    }
  });

  test("stays quiet when the dashboard cannot be reached", async () => {
    // Nothing was learned here, but remote_api dies two hundred milliseconds later with a
    // better sentence than this gate could write, and that sentence names the way back to
    // the local state. A second, vaguer warning in front of it would only be in the way.
    const { stderr, ms } = await run(["ls", "--json"], { DEVBOX_REMOTE: "http://127.0.0.1:1" });

    expect(stderr).not.toContain("cannot tell what");
    expect(stderr).not.toContain(DEPLOY);
    expect(stderr).not.toContain("/api/version");
    expect(stderr).toContain("cannot reach");
    // The gate holds its own leash — 2 s to connect, 4 s in total — because remote_api has
    // none at all. A refused connection must not spend any of it.
    expect(ms).toBeLessThan(3_000);
  });

  test(
    "never prompts for a token",
    async () => {
      // No token in the environment, an empty secrets directory, and stdin closed. If the
      // gate ever asked for the token itself, `read -rs` would take the EOF as an empty
      // answer and die on "empty, nothing sent" — killing a command that had every reason
      // to work. The test's own timeout is the assertion that it did not block.
      const { stderr } = await run(["ls", "--json"], { DEVBOX_REMOTE_TOKEN: undefined });
      const said = warnings(stderr);
      expect(said.some((line) => line.startsWith("cannot tell what"))).toBe(true);
      // The assertions the title was making all along. Without them the test passed while
      // the gate read a token it had no business reading, and it would keep passing if
      // someone put a `read -rs` inside version_gate itself, as long as the warn came out
      // first. The prompt that does appear afterwards belongs to remote_api, which is the
      // right place for it: by then the command has decided to talk to the dashboard.
      const before = stderr.slice(0, stderr.indexOf("cannot tell what"));
      expect(before).not.toContain("not echoed");
      expect(before).not.toContain("empty, nothing sent");
    },
    10_000,
  );

  test("asks once per invocation, not once per API call", async () => {
    fleet = [{ name: "devbox-fake1", cloud: "hetzner", ip: "203.0.113.9", user: "devbox", port: 22 }];
    version = served(OURS);

    // `info` on a remote fleet is two round trips: the fleet, to resolve the name nobody
    // typed, then that one machine. The gate lives before the dispatch, so it must have
    // run between them exactly zero extra times.
    const { code, stdout } = await run(["info", "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout).name).toBe("devbox-fake1");
    expect(counts["/api/machines"]).toBe(1);
    expect(counts["/api/machines/devbox-fake1"]).toBe(1);
    expect(counts["/api/version"]).toBe(1);
  });

  test(
    "asks nothing for the local verbs",
    async () => {
      // An allowlist and not an exclusion list: `--help` has to answer on a train, and
      // `probe` never calls the dashboard at all, so neither may pay for a round trip.
      const help = await run(["--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout.length).toBeGreaterThan(0);
      expect(counts["/api/version"]).toBeUndefined();

      // No cloud is reachable from here: HOME, DEVBOX_CONFIG_DIR and the environment are all
      // fresh, so every provider fails on its missing credentials and is reported as
      // "not asked". That is the point — probe is exercised for its silence, not its rows.
      await run(["probe", "--json"]);
      expect(counts["/api/version"]).toBeUndefined();
    },
    60_000,
  );

  test("asks nothing at all when there is no dashboard", async () => {
    // The guard around the whole gate. Without it, `DEVBOX_REMOTE= devbox ls` — the documented
    // way back to the local state — would warn "cannot tell what  runs", with an empty
    // name in the middle of the sentence, on every command a workstation with no dashboard
    // ever ran. Verified as a mutant: removing the `if [ -n "$REMOTE" ]` makes exactly
    // this assertion fail and nothing else in either suite.
    // The token is removed too, and that is what makes the mutant fail. With a token in
    // hand and REMOTE empty, a gate stripped of its guard curls the relative URL
    // "/api/version", curl refuses it, and the silent branch swallows the whole thing —
    // so the assertion passed against the mutant. Without a token the ungated gate reaches
    // "no dashboard token is cached here yet" and speaks. DEVBOX_TF_ROOT keeps the local read
    // that follows away from the repository's own state.
    const { stderr } = await run(["ls", "--json"], {
      DEVBOX_REMOTE: "",
      DEVBOX_REMOTE_TOKEN: undefined,
      DEVBOX_TF_ROOT: join(mkdtempSync(join(tmpdir(), "devbox-tf-")), "tf"),
    });

    expect(warnings(stderr)).toHaveLength(0);
    expect(counts["/api/version"]).toBeUndefined();
  });

  // chmod 000 means nothing to root, and the whole point of the case is a file the process
  // may not open.
  test.skipIf(process.getuid?.() === 0)(
    "survives a cached token it is not allowed to read",
    async () => {
      // `[ -s ]` says the file exists and is not empty, never that it can be opened. Bare,
      // the `cat` behind it failed and set -e killed the script before the dispatch: no
      // verb, no message of ours, just `cat: Permission denied` and exit 1. A gate that
      // takes the whole command down is worse than no gate.
      const secrets = mkdtempSync(join(tmpdir(), "devbox-locked-"));
      roots.push(secrets);
      writeFileSync(join(secrets, "remote"), "a-token", { mode: 0o000 });

      const { code, stderr } = await run(["ls", "--json"], {
        DEVBOX_SECRETS_DIR: secrets,
        DEVBOX_REMOTE_TOKEN: undefined,
      });

      expect(stderr).not.toContain("Permission denied");
      expect(warnings(stderr).some((line) => line.startsWith("cannot tell what"))).toBe(true);
      // It did not vouch for anything, and it did not stop anything either: the command
      // goes on to remote_api, which asks for the token it could not find.
      expect(code).not.toBe(0);
      expect(stderr).toContain("empty, nothing sent");
    },
    10_000,
  );

  test("calls a preflight that timed out doubt, not agreement", async () => {
    // The leash belongs to this gate alone: remote_api has no --max-time, so a link slow
    // enough to blow four seconds here can still answer the real call a moment later.
    // Silence would then be a true false "all good" — the exact failure the handshake was
    // written against — so a timeout speaks, while a refused connection stays quiet
    // because that one takes the command down with it.
    stall = 6_000;
    const { code, stdout, stderr } = await run(["ls", "--json"]);

    expect(warnings(stderr)).toHaveLength(1);
    expect(stderr).toContain("cannot tell what");
    expect(stderr).toContain("within 4s");
    // And the command it could not vouch for still ran.
    expect(JSON.parse(stdout)).toEqual([]);
    expect(code).toBe(0);
  }, 20_000);

  test("checks before the verb that orders a machine, not only before the reads", async () => {
    // The negative half of the allowlist was covered and the positive half was not, so
    // deleting `up|` from it broke nothing. That is the verb where a stale engine costs
    // money rather than a wrong table: it provisions and seeds from the server's copy.
    // The order fails right after — the stub serves no POST — and that is fine, the gate
    // speaks before the dispatch.
    version = served(THEIRS);
    const { stderr } = await run(["up", "--cloud", "hetzner"]);

    expect(stderr).toContain(FIX);
    expect(counts["/api/version"]).toBe(1);
    // And no provider was ever reached: with DEVBOX_REMOTE set, cmd_up posts the order to the
    // dashboard instead of ordering anything itself, so it dies on what this stub answered
    // long before a cloud credential is read. The environment carries none anyway.
    expect(counts["/api/machines"]).toBe(1);
    expect(stderr).not.toContain("hcloud");
  }, 30_000);

  test("says nothing when the dashboard refuses the token", async () => {
    // One of the two silences the rule allows, pinned so it stays a decision. remote_api
    // is about to die naming $SECRETS_DIR/remote and how to rotate it, which is a better
    // sentence than the gate could write, and the command does not run — so nothing here
    // can be read as agreement.
    version = { status: 401, body: JSON.stringify({ error: "unauthorized" }), type: "application/json" };
    const { code, stderr } = await run(["ls", "--json"]);

    expect(warnings(stderr)).toHaveLength(0);
    expect(code).toBe(0);
  });

  test("leaves stdout alone", async () => {
    version = served(THEIRS);
    const { stdout, stderr } = await run(["ls", "--json"]);

    // The warning goes to stderr and nowhere else. `devbox ls --json | jq` is how the Ink
    // layer and the dashboard both read this file, and one stray line on stdout would
    // break every one of those callers on exactly the machines that are behind.
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(JSON.parse(stdout)).toEqual([]);
    expect(stderr).toContain(FIX);
  });
});
