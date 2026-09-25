import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  fakeMachine,
  fakeTerraform,
  runCore,
  sandbox,
  strip,
  verdict,
} from "./harness.ts";

/**
 * The command line itself: which flag each verb takes, what it does with the word behind
 * it, and what it says when it meets one it does not know.
 *
 * This is the surface every caller shares. The Ink layer forwards a verb it does not
 * recognise straight to this file, the dashboard's job runner builds an argv by hand, and
 * a shell pipeline types it — so a flag silently dropped here is a flag silently dropped
 * everywhere. One of those cost a morning: `--profile` read before the name, and the name
 * quietly gone. The whole "the order of the flags" block below exists for that, and it
 * found the bug still there in `seed`. It is fixed now, and the block is what holds it
 * fixed.
 *
 * Nothing here orders, seeds, tunnels or destroys anything. Every invocation is aimed at
 * the parse and stops at the first refusal after it — an unknown machine, an absent
 * credential, a name with a space in it — which is what makes it safe to run the real
 * executor against the real dispatch. The rails are in harness.ts: runCore hands over a
 * throwaway HOME, throwaway DEVBOX_* directories, and PATH as the only thing it inherits.
 *
 * Where a test pins something that is WRONG rather than merely surprising, the comment
 * opens with DEFECT and the reported behaviour is today's, not the desirable one. Fixing
 * devbox-core is not this file's job; noticing is.
 */

type Env = Record<string, string>;

/**
 * jq is the first line of almost every cmd_*, and `need jq` dies before any flag is read:
 * without it there is no parsing left to observe. Skipped rather than failed, and visible
 * in the run, exactly as core.test.ts does for the version handshake.
 */
const NO_JQ = Bun.which("jq") === null;

/** What the fake terraform answers, so a machine can be described without a cloud. */
const OUTPUTS = {
  // TEST-NET-3, which is reserved for documentation and routes nowhere. Nothing in this
  // file should ever open a socket to it, and if a regression makes something try, it
  // fails rather than reaching a stranger's host.
  ip: { value: "203.0.113.7" },
  user: { value: "dev" },
  port: { value: 22 },
  cloud: { value: "hetzner" },
  region: { value: "fsn1" },
  instance_type: { value: "cx33" },
  hourly_eur: { value: 0.0256 },
};

/**
 * The clouds a command said it could not ask, read off stderr.
 *
 * Matched on the shape of the block rather than searched for by name: the line that names
 * hetzner also names the .env.tf it went looking for, and that path lives in a temporary
 * directory whose random characters are nobody's business to assert against.
 */
const notAsked = (stderr: string): string[] =>
  stderr
    .split("\n")
    .filter((line) => /^ {2}\S+:/.test(line))
    .map((line) => line.trim().split(":")[0] ?? "");

/** An executable in the sandbox's own bin, which `offline` puts at the head of PATH. */
function stub(env: Env, name: string, body: string): void {
  const bin = join(env["HOME"] ?? "", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), ["#!/usr/bin/env bash", body, ""].join("\n"), { mode: 0o755 });
}

/**
 * A sandbox that cannot reach a provider even on a workstation that could.
 *
 * runCore already withholds every credential from the environment, which settles Hetzner
 * and Scaleway: both read a token or die naming the file they wanted. GCP does not work
 * that way — `gcloud auth application-default print-access-token` mints one from the
 * operator's own login, and the machine writing these tests has gcloud installed — so
 * `probe` and `orphans` would quietly start asking the real billing and compute APIs about
 * a real project. A gcloud that fails is the difference between a hermetic test and one
 * whose output depends on who is logged in.
 *
 * ssh-keyscan is stubbed for a duller reason: `info` fingerprints the host it is about to
 * describe, and the real one sits on its ten-second timeout before giving up on an address
 * that answers nothing.
 */
function offline(): Env {
  const env = sandbox();
  stub(env, "gcloud", "exit 1");
  stub(env, "ssh-keyscan", "exit 0");
  // The sandbox's own bin in FRONT of the operator's PATH, so the two stubs above are what
  // `command -v` finds while jq, curl and the rest stay reachable.
  return {
    ...env,
    PATH: `${join(env["HOME"] ?? "", "bin")}:${process.env["PATH"] ?? ""}`,
  };
}

/**
 * The same, with machines in the state and a terraform that answers for them.
 *
 * `sshConfig` writes an empty ~/.ssh/config, because that file is where the profile a
 * machine was provisioned with is recorded, and its absence once killed `seed` outright —
 * see the test that used to be about a mute exit. The tests that only need a name to
 * resolve do not care; the ones that walk past `resolve` say so.
 */
function withFleet(names: string[], sshConfig = false): Env {
  const env = offline();
  for (const name of names) fakeMachine(env, "hetzner", name);
  fakeTerraform(env, OUTPUTS);
  if (sshConfig) {
    writeFileSync(join(env["HOME"] ?? "", ".ssh", "config"), "# nothing yet\n", { mode: 0o600 });
  }
  return env;
}

/**
 * A profile that clones a private repository, written the way a copy has to be:
 * `devbox-secrets: github` beside `devbox-repo:`. These tests need a profile whose first
 * question is a token - asked at a closed stdin, or spent by the GitHub preflight - before any
 * ssh is attempted.
 */
function withPrivateProfile(env: Env): Env {
  const directory = join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "private.sh"),
    "#!/bin/bash\n# devbox-repo:     https://github.com/acme/private.git\n# devbox-secrets:  github\n",
  );
  return env;
}

afterAll(cleanup);

describe.skipIf(NO_JQ)("--json is an interface, not a screen", () => {
  test("ls, profiles, probe and orphans each answer JSON, and only JSON, on stdout", async () => {
    // The header says these five answer in JSON so something other than a terminal can
    // consume them. The assertion that matters is not "it contains JSON" but "stdout
    // parses whole": the dashboard and the Ink layer both pipe this into a parser, and one
    // stray line of narration in front of the array breaks every caller at once.
    for (const verb of ["ls", "profiles", "probe", "orphans"]) {
      const { code, stdout } = await runCore([verb, "--json"], offline());

      expect(code, verb).toBe(0);
      expect(() => JSON.parse(stdout) as unknown, verb).not.toThrow();
    }
  }, 60_000);

  test("an empty workstation answers with empty arrays rather than nothing at all", async () => {
    // No state, no credentials, no dashboard. A consumer must still get an array back: the
    // core's own note about fleet_json says it always is one, so nobody special-cases the
    // no-machine day, and the same rule holds for the two commands that ask a provider.
    for (const verb of ["ls", "probe", "orphans"]) {
      const { stdout } = await runCore([verb, "--json"], offline());
      expect(JSON.parse(stdout) as unknown, verb).toEqual([]);
    }

    // profiles is the one that is never empty here: the repository's own profiles/ is on
    // the search path, so this asserts the shape instead.
    const { stdout } = await runCore(["profiles", "--json"], offline());
    const rows = JSON.parse(stdout) as Array<{ name: string; secrets: string[] }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.name)).toContain("claude");
  }, 60_000);

  test("info --json answers one object for the machine it resolved", async () => {
    const { code, stdout } = await runCore(["info", "--json"], withFleet(["devbox-one"]));

    expect(code).toBe(0);
    const machine = JSON.parse(stdout) as Record<string, unknown>;
    // An object and not an array — `info` is the one of the five that describes a single
    // machine, and the fields it adds over `ls` are the reason it exists.
    expect(machine["name"]).toBe("devbox-one");
    expect(machine["ip"]).toBe("203.0.113.7");
    expect(machine["kube_port"]).toBe(16443);
  }, 30_000);

  test("probe and orphans keep what they could not ask off stdout", async () => {
    // Deliberate, and documented in both functions: the array is the contract, and a cloud
    // that could not be reached is real information that goes to stderr. Silence there
    // would let one unconfigured provider hide another's cheaper offer — or, for orphans,
    // another's runaway machine.
    const expected: Record<string, string[]> = {
      probe: ["gcp", "hetzner", "scaleway"],
      orphans: ["gcp", "hetzner", "scaleway"],
    };
    for (const verb of ["probe", "orphans"]) {
      const { stdout, stderr } = await runCore([verb, "--json"], offline());

      expect(JSON.parse(stdout) as unknown, verb).toEqual([]);
      expect(stderr, verb).toContain("not asked:");
      expect(notAsked(stderr).sort(), verb).toEqual(expected[verb] ?? []);
    }
  }, 60_000);

  test("the verbs that were never given a --json do not pretend to have one", async () => {
    // Three of the four say so now, and two of them used to fail in their own way:
    //
    //   down  parsed nothing but --quiet and handed the rest to `resolve`, so the flag was
    //         read as a machine NAME — "no machine named '--json'", the right exit code
    //         behind an explanation nobody can act on.
    //   seed  ended its loop in `*) shift ;;` and swallowed the flag whole; against a
    //         two-machine fleet it went on to die asking WHICH machine, having never
    //         mentioned the word it had thrown away.
    //
    // Both stop at their own parse now, and both name the verb the flag was typed at.
    const refused: Array<[string, string, Env]> = [
      ["up", "unknown flag: --json", offline()],
      ["down", "unknown flag for down: --json", withFleet(["devbox-one"], true)],
      ["seed", "unknown flag for seed: --json", withFleet(["devbox-one", "devbox-two"], true)],
    ];

    for (const [verb, message, env] of refused) {
      const { code, stdout, stderr } = await runCore([verb, "--json"], env);

      expect(verdict(stderr), verb).toBe(message);
      expect(code, verb).toBe(1);
      expect(stdout, verb).toBe("");
      // seed's fleet has two machines in it on purpose: the refusal to guess is what the
      // swallowed flag used to lead to, and its absence is the proof that the parse now
      // stops before `resolve` is ever reached.
      expect(stderr, verb).not.toContain("several machines exist");
    }

    // DEFECT (devbox-core, left alone here): cmd_sync never looks at its arguments at all.
    // Offline it dies on the missing DEVBOX_REMOTE, which is right; with a dashboard set it
    // would have synced and said nothing about the flag.
    const sync = await runCore(["sync", "--json"], offline());
    expect(sync.stderr).toContain("devbox sync needs DEVBOX_REMOTE set");
    expect(sync.stderr).not.toContain("unknown flag");
  }, 60_000);
});

describe.skipIf(NO_JQ)("a flag nobody knows", () => {
  test("tunnel says so, and names the verb it was typed at", async () => {
    const { code, stderr } = await runCore(["tunnel", "--nawak"], offline());

    // The silence is what this is written against. `-*)` sits before the catch-all that
    // reads a bare word as a machine name, so a mistyped flag cannot become a name.
    expect(verdict(stderr)).toBe("unknown flag for tunnel: --nawak");
    expect(code).toBe(1);
  }, 30_000);

  test("orphans says so too", async () => {
    const { code, stderr } = await runCore(["orphans", "--nawak"], offline());

    expect(verdict(stderr)).toBe("unknown flag for orphans: --nawak");
    expect(code).toBe(1);
  }, 30_000);

  test("every verb that parses its own flags refuses one it does not know", async () => {
    // Two wordings, and the difference is not cosmetic: the verbs that came later name
    // themselves in the message, the first three do not. Pinned as they are so that a
    // change to either is a decision rather than an accident.
    const expected: Array<[string, string]> = [
      ["ls", "unknown flag: --nawak"],
      ["info", "unknown flag: --nawak"],
      ["up", "unknown flag: --nawak"],
      ["profiles", "unknown flag for profiles: --nawak"],
      ["probe", "unknown flag for probe: --nawak"],
      ["orphans", "unknown flag for orphans: --nawak"],
      ["tunnel", "unknown flag for tunnel: --nawak"],
    ];

    for (const [verb, message] of expected) {
      const { code, stdout, stderr } = await runCore([verb, "--nawak"], offline());

      expect(verdict(stderr), verb).toBe(message);
      expect(code, verb).toBe(1);
      // And nothing on stdout: a caller reading `--json` output must not be handed half a
      // screen before the refusal.
      expect(stdout, verb).toBe("");
    }
  }, 60_000);

  test("a bare word is a flag error for the verbs that take no name", async () => {
    // ls, profiles, probe and orphans act on the whole fleet or the whole catalogue, so
    // there is no name to give them. `devbox ls devbox-one` is a mistake, and it is said.
    for (const verb of ["ls", "profiles", "probe", "orphans"]) {
      const { code, stderr } = await runCore([verb, "devbox-one"], offline());

      expect(verdict(stderr), verb).toContain("devbox-one");
      expect(code, verb).toBe(1);
    }
  }, 60_000);
});

describe("the dispatch itself", () => {
  test("no verb and --help answer the same page, offline, and exit 0", async () => {
    // The dashboard is pointed at a port nothing listens on. Neither of these is in the
    // allowlist that triggers the version handshake, and the help has to answer on a
    // train: a round trip here would make `devbox` hang before it could even say what it is.
    const unreachable = { ...offline(), DEVBOX_REMOTE: "http://127.0.0.1:1" };
    const bare = await runCore([], unreachable);
    const help = await runCore(["--help"], unreachable);

    expect(bare.code).toBe(0);
    expect(help.code).toBe(0);
    expect(bare.stdout.length).toBeGreaterThan(0);
    // The same page, because a reader who typed the tool's name with nothing after it and
    // a reader who asked for help want the same thing. It is the header comment of
    // devbox-core, printed whole — the awk reads until the comment block stops, so a usage
    // line added up there appears here with nothing else to do.
    expect(help.stdout).toBe(bare.stdout);
    expect(bare.stdout).toContain("devbox up");
    expect(bare.stdout).toContain("devbox down");
    // Nothing was waited on. A round trip to a refused port is instant, but a gate that
    // ever started resolving a name would show up as seconds.
    expect(help.ms).toBeLessThan(5_000);
  }, 30_000);

  test("an unknown verb exits 1 and lists every verb there is", async () => {
    const { code, stdout, stderr } = await runCore(["nawak"], offline());

    expect(code).toBe(1);
    expect(stdout).toBe("");
    const said = verdict(stderr) ?? "";
    expect(said).toContain("unknown command: nawak");
    // The list is the useful half of the message: a typo is usually one letter away from
    // the verb that was meant, and the reader should not have to run --help to find it.
    for (const verb of ["up", "seed", "info", "ls", "profiles", "probe", "orphans", "sync", "tunnel", "down"]) {
      expect(said, verb).toContain(verb);
    }
  }, 30_000);
});

describe.skipIf(NO_JQ)("the order of the flags", () => {
  test("info gives the same answer whichever side of the name --json sits", async () => {
    // One sandbox for both runs, not two: these commands only read, and comparing two
    // answers produced under different temporary paths would compare the paths too.
    const env = withFleet(["devbox-one", "devbox-two"]);
    const flagFirst = await runCore(["info", "--json", "devbox-one"], env);
    const nameFirst = await runCore(["info", "devbox-one", "--json"], env);

    expect(flagFirst.code).toBe(0);
    expect(nameFirst.code).toBe(0);
    // Two machines on purpose. With one, `resolve` answers the same thing whether or not
    // it was given a name, so an argv that lost the word would still look right.
    expect(JSON.parse(nameFirst.stdout) as unknown).toEqual(JSON.parse(flagFirst.stdout) as unknown);
    expect((JSON.parse(flagFirst.stdout) as { name: string }).name).toBe("devbox-one");
  }, 30_000);

  test("tunnel reads its port whichever side of the name it sits", async () => {
    // Refused before anything is opened: the port is validated at the top of cmd_tunnel,
    // so an out-of-range one proves --port was read without a tunnel ever being attempted.
    const env = withFleet(["devbox-one"]);
    const flagFirst = await runCore(["tunnel", "--port", "70000", "devbox-one"], env);
    const nameFirst = await runCore(["tunnel", "devbox-one", "--port", "70000"], env);

    expect(verdict(flagFirst.stderr)).toBe("a port belongs between 1024 and 65535: 70000");
    expect(nameFirst.stderr).toBe(flagFirst.stderr);
    expect(nameFirst.code).toBe(flagFirst.code);

    // And with a port it accepts, both orders resolve the same — a name that does not
    // exist, so the command dies on the fleet rather than on an ssh it must never run.
    const okFlagFirst = await runCore(["tunnel", "--port", "9011", "nope"], env);
    const okNameFirst = await runCore(["tunnel", "nope", "--port", "9011"], env);

    expect(verdict(okFlagFirst.stderr)).toBe("no machine named 'nope'. devbox ls");
    expect(okNameFirst.stderr).toBe(okFlagFirst.stderr);
  }, 30_000);

  test("down takes its --quiet before or after the name", async () => {
    // cmd_down used to test position 1 and then position 2 and throw the rest away, which
    // read both orders correctly and lost everything after them. It loops now, and both
    // orders still have to work. Aimed at a name that does not exist, so the verb that
    // stops the meter is exercised without one running: `resolve` refuses long before a
    // token is read or terraform is called.
    const env = withFleet(["devbox-one"], true);
    const flagFirst = await runCore(["down", "--quiet", "nope"], env);
    const nameFirst = await runCore(["down", "nope", "--quiet"], env);

    expect(verdict(flagFirst.stderr)).toBe("no machine named 'nope'. devbox ls");
    expect(nameFirst.stderr).toBe(flagFirst.stderr);
    expect(nameFirst.code).toBe(flagFirst.code);
  }, 30_000);

  test("probe does not care where --json sits among its flags", async () => {
    // One sandbox again: the "not asked" line names the .env.tf it went looking for, so
    // two sandboxes would differ on the temporary path alone.
    const env = offline();
    const before = await runCore(["probe", "--json", "--cloud", "hetzner"], env);
    const after = await runCore(["probe", "--cloud", "hetzner", "--json"], env);

    expect(JSON.parse(after.stdout) as unknown).toEqual(JSON.parse(before.stdout) as unknown);
    expect(after.code).toBe(before.code);
    // The skipped list is part of the answer too, and it is where a --cloud read in the
    // wrong order would show: three clouds instead of one.
    expect(after.stderr).toBe(before.stderr);
  }, 60_000);

  test("seed reads the name wherever it sits on the line", async () => {
    // This is the bug that cost a morning, and the reason this whole block exists. cmd_seed
    // read the name ONLY from position 1 — `case "${1:-}" in ''|--*) ;; *) want=$1` — and
    // its loop then ended in `*) shift ;;`, which swallowed every word it did not
    // recognise. `devbox seed --profile bare devbox-one` parsed as "seed something, with profile
    // bare", and the machine that was named was gone. cmd_seed loops over the whole line
    // now, and the name is read from wherever it was typed.
    //
    // Two machines on purpose. With one, `resolve` answers the same thing whether or not it
    // was given a name, so an argv that lost the word would still look right.
    const fleet = ["devbox-one", "devbox-two"];
    const flagFirst = await runCore(["seed", "--profile", "private", "devbox-one"], withPrivateProfile(withFleet(fleet, true)));
    const nameFirst = await runCore(["seed", "devbox-one", "--profile", "private"], withPrivateProfile(withFleet(fleet, true)));

    // Neither order asks which machine was meant — that question is what the dropped name
    // used to produce — and both walk straight past the name into the profile: `private`
    // declares github as its only secret, so the prompt names it. That prompt is also the
    // proof that --profile carried its value, there being no default profile since 24/09, and
    // stdin is closed, so it dies there rather than seeding anything.
    for (const [order, run] of [["flag first", flagFirst], ["name first", nameFirst]] as const) {
      expect(run.stderr, order).not.toContain("several machines exist");
      expect(run.stderr, order).toContain("secret github");
      expect(run.stderr, order).toContain("empty, nothing sent");
      expect(run.code, order).toBe(1);
    }
    // The same line either way round, down to the byte.
    expect(nameFirst.stderr).toBe(flagFirst.stderr);

    // And the half of the old bug that was silent rather than loud, which is the one that
    // could have done damage: with a single machine in the fleet, the dropped name left
    // `resolve` with nothing to disambiguate, so `devbox seed --profile claude typo-name` seeded
    // the only machine there is, under a profile it was never provisioned with, and said
    // nothing about the word it had eaten. The name is read now, so it is the name that is
    // refused.
    const typo = await runCore(["seed", "--profile", "claude", "typo-name"], withFleet(["devbox-one"], true));
    expect(verdict(typo.stderr)).toBe("no machine named 'typo-name'. devbox ls");
    expect(typo.code).toBe(1);

    // The other arm of the same loop: two bare words are a mistake, not a name and some
    // rubbish to shift away. `down` says the same thing about destroying two machines.
    const twice = await runCore(["seed", "devbox-one", "devbox-two"], withFleet(fleet, true));
    expect(verdict(twice.stderr)).toBe("seed acts on one machine, and you named two: devbox-one and devbox-two");
    expect(twice.code).toBe(1);
  }, 30_000);

  test("seed still speaks when this workstation has no ~/.ssh/config yet", async () => {
    // Found by the test above and worth its own line, because for a while `devbox seed` on a
    // fresh Mac exited with a code and NOTHING else. cmd_seed reads the profile a machine
    // was provisioned with:
    //
    //   recorded=$(profile_of "$name")
    //
    // and profile_of ended in `awk ... "$SSH_CONFIG" 2>/dev/null | head -1`. When that file
    // does not exist awk exits 2, `set -o pipefail` carried the 2 out of the pipeline, the
    // bare assignment inherited it and `set -e` killed the script — exit 2, not one word on
    // either stream, nothing to act on. machine_json and detail_json call the same helper
    // and survived it only because they are invoked inside `|| true` and `|| exit 1`, where
    // set -e is suspended. A workstation that has never run `devbox up` has no ~/.ssh/config,
    // and `devbox seed` on a machine created from the dashboard is exactly the case that met
    // it.
    //
    // profile_of returns early on a file that is not there now, so an absent config is an
    // absent RECORD and nothing more: the command carries on to what it was going to say.
    // DEVBOX_PROFILE names a profile that asks for a token: one that asked for none would go
    // on to an ssh this test must never run.
    const nowhere = withPrivateProfile({ ...withFleet(["devbox-one"]), DEVBOX_PROFILE: "private" });
    const fresh = await runCore(["seed", "devbox-one"], nowhere);
    // The first secret the default profile declares: what is asserted here is that the
    // command SPEAKS, and which token it asks for is incidental to that.
    expect(fresh.stderr).toContain("secret github (not echoed)");
    expect(fresh.stderr).toContain("empty, nothing sent");
    expect(fresh.code).toBe(1);
    // And the missing file is still missing: the fix is a guard, not a `touch` that would
    // have created an operator's ~/.ssh/config behind their back.
    expect(existsSync(join(nowhere["HOME"] ?? "", ".ssh", "config"))).toBe(false);

    // The same command with the file in place says exactly the same thing — which is the
    // whole claim: whether ~/.ssh/config exists changes what is REMEMBERED about a machine,
    // never whether the command runs.
    const spoke = await runCore(
      ["seed", "devbox-one"],
      withPrivateProfile({ ...withFleet(["devbox-one"], true), DEVBOX_PROFILE: "private" }),
    );
    expect(spoke.stderr).toBe(fresh.stderr);
    expect(spoke.code).toBe(fresh.code);

    // The other half of the silence: the death happened before profile_path, so none of the
    // careful profile errors could be reached in that state at all. This one is now.
    const badProfile = await runCore(
      ["seed", "--profile", "no-such-profile", "devbox-one"],
      withFleet(["devbox-one"]),
    );
    expect(verdict(badProfile.stderr)).toBe("no profile named 'no-such-profile'. devbox profiles");
  }, 30_000);
});

describe.skipIf(NO_JQ)("the value behind a flag", () => {
  test("probe carries the three floors into the template it prints", async () => {
    // The footer is the only place offline where a floor is observable, and that is enough:
    // it is read straight out of MIN_CORES/MIN_MEMORY_GB/MIN_DISK_GB, which is what the
    // candidate query filters on. Three different numbers, so a flag wired to the wrong
    // variable cannot pass.
    const { code, stdout } = await runCore(
      ["probe", "--cloud", "hetzner", "--min-cpu", "7", "--min-ram", "13", "--min-disk", "42"],
      offline(),
    );

    expect(code).toBe(0);
    expect(stdout).toContain("at least 7 vCPU, 13 GB and 42 GB of disk.");

    // The short spellings are the same flags, and they mean floors too — the core keeps
    // both names because `--ram 8` reads like a target and is not one.
    const short = await runCore(
      ["probe", "--cloud", "hetzner", "--cpu", "7", "--ram", "13", "--disk", "42"],
      offline(),
    );
    expect(short.stdout).toContain("at least 7 vCPU, 13 GB and 42 GB of disk.");
  }, 60_000);

  test("probe says what the monthly column is not", async () => {
    // EUR/MO is hourly × 730 and nothing else, which overshoots a real Hetzner invoice by
    // about 17 %: measured 25/08 on fsn1, cpx22 interpolates to 22,78 against a published
    // 19,49, because Hetzner stops counting hours past a cap in the month. The number is
    // still worth printing — no provider gives devbox-core anything but price_hourly — but a
    // "per month" that runs a sixth over the bill in silence is how a reader learns to
    // distrust the whole table. The same footer that carries the floors carries the
    // caveat, once, and this pins it there rather than leaving it to be tidied away as
    // clutter by someone who does not know what it cost to find out.
    const { code, stdout } = await runCore(["probe", "--cloud", "hetzner"], offline());

    expect(code).toBe(0);
    expect(stdout).toContain("EUR/MO");
    expect(stdout).toContain("730 h");
    expect(stdout).toContain("17 %");
  }, 60_000);

  test("probe and orphans ask only the cloud they were given", async () => {
    // The "not asked" list is the receipt: with --cloud hetzner it names one provider, and
    // the two that were never consulted are absent from it.
    for (const verb of ["probe", "orphans"]) {
      const { stderr } = await runCore([verb, "--cloud", "hetzner", "--json"], offline());

      expect(notAsked(stderr), verb).toEqual(["hetzner"]);
    }

    // A cloud that does not exist reaches cloud_servers, which names it back. Proof the
    // word travelled rather than being defaulted away somewhere on the path.
    const { stderr, stdout } = await runCore(["orphans", "--cloud", "nawak", "--json"], offline());
    expect(stderr).toContain("nawak: unknown cloud: nawak");
    // And still an array on stdout: an unreachable provider is not a reason to answer
    // nothing, which a consumer would read as "no orphan".
    expect(JSON.parse(stdout) as unknown).toEqual([]);
  }, 60_000);

  test("up consumes exactly one value per flag", async () => {
    // Every value-taking flag of the heaviest verb, in one line, terminated by a --name
    // that cannot be valid. The name is checked AFTER the parse loop, so this reaches its
    // refusal only if each flag ate its own word: had one of them not, the leftover value
    // would have hit the catch-all and the message would be "unknown flag: cx33" instead.
    //
    // Nothing is ordered. `up` validates the name before it reads a credential, a profile
    // or the state, so the whole provisioning path stays untouched.
    const { code, stderr } = await runCore(
      [
        "up",
        "--cloud", "hetzner",
        "--type", "cx33",
        "--profile", "claude",
        "--repo", "https://example.test/repo.git",
        "--min-cpu", "7",
        "--min-ram", "13",
        "--min-disk", "42",
        "--no-seed",
        "--quiet",
        "--name", "a b",
      ],
      offline(),
    );

    expect(verdict(stderr)).toBe("a machine name must be letters, digits, dash or underscore: 'a b'");
    expect(code).toBe(1);
  }, 30_000);

  /**
   * No default profile since 24/09: `bare` went, and any other default would be this tool
   * deciding what a machine is for. The profile is read before anything is ordered - it says
   * how big the machine has to be - so its absence stops `up` before a provider is asked.
   */
  test("up orders nothing without a profile", async () => {
    const run = await runCore(["up", "--name", "devbox-x", "--cloud", "hetzner"], withFleet([]));
    expect(verdict(run.stderr)).toBe(
      "no profile named: pass --profile <name>, or set DEVBOX_PROFILE. devbox profiles lists them",
    );
    expect(run.code).toBe(1);
    // The key is made first, and that is all: no profile announced, no provider asked.
    expect(strip(run.stdout)).not.toContain("==> profile");
    expect(strip(run.stdout)).not.toContain("asking");
  }, 30_000);

  test("up passes --profile and --cloud on to the things that read them", async () => {
    // A name it accepts this time, so the parse is followed by the two lookups that use
    // these values. The profile is read first — it is what says how big the machine has to
    // be — and an unknown one is refused before anything is ordered.
    const badProfile = await runCore(
      ["up", "--name", "devbox-x", "--profile", "no-such-profile"],
      withFleet([]),
    );
    expect(verdict(badProfile.stderr)).toBe("no profile named 'no-such-profile'. devbox profiles");

    // Then the cloud, which is the last gate before a provider is contacted at all.
    const badCloud = await runCore(
      ["up", "--name", "devbox-x", "--profile", "claude", "--cloud", "nawak"],
      withFleet([]),
    );
    expect(verdict(badCloud.stderr)).toBe("unknown cloud: nawak");
    // And the profile it did accept was announced with the value that was typed.
    expect(badCloud.stdout).toContain("profile claude");
  }, 30_000);

  test("tunnel refuses a port that is not a number, and one out of range", async () => {
    // Both forwards are validated by the same loop, so both flags are checked. The message
    // says what a port is rather than repeating the flag back, which is what someone who
    // typed a hostname into --port needs to read.
    const notANumber = await runCore(["tunnel", "--port", "abc"], offline());
    expect(verdict(notANumber.stderr)).toBe("a port is digits: 'abc'");
    expect(notANumber.code).toBe(1);

    const kubeNotANumber = await runCore(["tunnel", "--kube", "9010:8080"], offline());
    expect(verdict(kubeNotANumber.stderr)).toBe("a port is digits: '9010:8080'");

    // The range is the second half of the rule: below 1024 needs root, and above 65535 is
    // not a port at all. Both are refused before ssh is asked to bind anything.
    const tooLow = await runCore(["tunnel", "--port", "1023", "devbox-one"], withFleet(["devbox-one"]));
    expect(verdict(tooLow.stderr)).toBe("a port belongs between 1024 and 65535: 1023");

    const tooHigh = await runCore(["tunnel", "--kube", "70001", "devbox-one"], withFleet(["devbox-one"]));
    expect(verdict(tooHigh.stderr)).toBe("a port belongs between 1024 and 65535: 70001");
  }, 30_000);

  test("a value flag left at the end of the line names the value it wanted", async () => {
    // Every value-taking flag ends in `shift 2`, and bash refuses to shift further than it
    // has arguments: with the flag last, that shift returned 1, `set -e` took the script
    // down, and NOTHING was printed on either stream. Exit 1 with an empty stderr is
    // indistinguishable from a crash, and a typed `devbox tunnel --port` — the flag typed, the
    // port not yet — is an ordinary way to reach it. A `takes_value "$@"` now sits in front
    // of each of those shifts and says the sentence.
    //
    // Every spelling of every one of them, on purpose: the guard is a call that has to be
    // written out seventeen times, so the way it goes wrong again is one arm of one case
    // that nobody added it to. Five verbs and five separate parse loops, which is what says
    // the behaviour belongs to the shape of the loops rather than to any one of them.
    for (const argv of [
      ["tunnel", "--port"],
      ["tunnel", "--kube"],
      ["orphans", "--cloud"],
      ["probe", "--cloud"],
      ["probe", "--min-cpu"],
      ["probe", "--cpu"],
      ["probe", "--min-ram"],
      ["probe", "--ram"],
      ["probe", "--min-disk"],
      ["probe", "--disk"],
      ["seed", "--profile"],
      ["seed", "--repo"],
      ["up", "--cloud"],
      ["up", "--name"],
      ["up", "--type"],
      ["up", "--profile"],
      ["up", "--repo"],
      // A --name in front for the floors, so the run cannot be stopped by the missing name
      // before it reaches the flag being tested.
      ["up", "--name", "devbox-x", "--min-cpu"],
      ["up", "--name", "devbox-x", "--cpu"],
      ["up", "--name", "devbox-x", "--min-ram"],
      ["up", "--name", "devbox-x", "--ram"],
      ["up", "--name", "devbox-x", "--min-disk"],
      ["up", "--name", "devbox-x", "--disk"],
    ]) {
      const line = argv.join(" ");
      const flag = argv[argv.length - 1];
      const { code, stdout, stderr } = await runCore(argv, offline());

      // The message names the flag rather than the verb: what the reader has to fix is the
      // word they already typed, and the same sentence comes out of all five loops.
      expect(verdict(stderr), line).toBe(`${flag} needs a value after it`);
      expect(code, line).toBe(1);
      // Still nothing on stdout, and that half was never the bug: a caller reading `--json`
      // must not be handed half an answer in front of the refusal.
      expect(stdout, line).toBe("");
    }
  }, 120_000);
});

describe.skipIf(NO_JQ)("seed and the profile a machine was provisioned with", () => {
  /**
   * A machine recorded as `claude` in its Host block, a `github` file in the launch - which
   * `plain` declares nothing of, so it must NOT reach the machine - and an ssh that writes
   * down what it was asked and refuses, so the seed stops at the first thing it sends.
   *
   * `plain` is written here, in the sandbox's own profile directory: the repository's `bare`
   * played the profile that asks for nothing until 24/09, when it was removed.
   */
  function recordedAsClaude(): { env: Env; ssh: string } {
    const env = withFleet(["devbox-one"]);
    writeFileSync(
      join(env["HOME"] ?? "", ".ssh", "config"),
      "# >>> devbox:devbox-one >>>\nHost devbox-one\n  HostName 203.0.113.7\n  # devbox-profile claude\n# <<< devbox:devbox-one <<<\n",
      { mode: 0o600 },
    );
    writeFileSync(join(env["DEVBOX_SECRETS_DIR"] ?? "", "github"), "ghp_laid_out_for_plain", { mode: 0o400 });
    mkdirSync(join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles"), { recursive: true });
    writeFileSync(
      join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles", "plain.sh"),
      "#!/bin/bash\n# devbox-min-cpu: 2\nset -euo pipefail\n",
    );
    const ssh = join(env["HOME"] ?? "", "bin", "ssh.log");
    stub(env, "ssh", `printf '%s\\n' "$*" >> ${JSON.stringify(ssh)}; exit 1`);
    return { env, ssh };
  }

  test("a --profile typed is the one used, whatever it names", async () => {
    // cmd_seed swapped the recorded profile in whenever $PROFILE EQUALLED the default, which
    // could not tell `seed` from `seed --profile bare`, bare being the default then. The
    // dashboard passes --profile exactly when one was asked for and lays out THAT profile's
    // secrets, so the swap sent it asking for a claude token its launch did not hold: "empty,
    // nothing sent", on 11/09.
    const { env, ssh } = recordedAsClaude();

    const run = await runCore(["seed", "devbox-one", "--quiet", "--profile", "plain"], env);

    expect(run.stderr).not.toContain("secret claude");
    expect(run.stderr).not.toContain("empty, nothing sent");
    // plain declares no secret: nothing was pushed, not even the github file lying in the
    // launch, and the first thing sent was the prelude - claude's token was never asked for.
    const asked = readFileSync(ssh, "utf8");
    expect(asked).not.toContain("/run/secrets/");
    expect(asked).toContain("/usr/local/lib/devbox/prelude.sh");
  }, 30_000);

  test("with no --profile, the recorded one is the one used", async () => {
    // The half the swap exists for: seeding a claude machine with another profile because a
    // flag was forgotten would be a silent swap. claude declares its own token first, and stdin is
    // closed, so asking for it is what says the recorded profile was taken.
    const { env } = recordedAsClaude();

    const run = await runCore(["seed", "devbox-one", "--quiet"], env);

    expect(run.stderr).toContain("secret claude (not echoed)");
    expect(run.code).toBe(1);
  }, 30_000);
});
