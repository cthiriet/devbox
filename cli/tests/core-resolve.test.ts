import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  fakeMachine,
  fakeTerraform,
  runCore,
  sandbox,
  strip,
  verdict,
  type Run,
} from "./harness.ts";

/**
 * Which machine a verb acts on — devbox-core's `resolve`, and its refusal to guess.
 *
 * This is the function that destroyed the wrong ssh_config block one morning. Not because
 * it picked the wrong machine: it picked none, said so, and the command carried on anyway.
 * `die` inside a `$( )` kills the subshell it runs in and nothing else, so the red line was
 * printed by a corpse while the caller read the empty string it left behind, `read` happily
 * succeeded on it, and the rest of `down` ran with an empty cloud and an empty name.
 *
 * So the interesting assertion here is never only "it refused". It is "it refused AND
 * nothing happened afterwards" — checked twice over, by the exit code and by the total
 * absence of later output, including any Terraform invocation at all. A test that only read
 * stderr would have passed against the broken version.
 *
 * Everything below runs LOCAL: DEVBOX_REMOTE is emptied on purpose, because the dashboard has
 * its own resolver (`remote_resolve`) reading its own fleet, and mixing the two would test
 * neither. The fleet is described by dropping state files into DEVBOX_TF_ROOT, which works
 * because `instances` reads those files directly rather than asking Terraform — the
 * decision the core documents, and the one that makes this whole file cost no cloud.
 */

/** jq is how devbox-core builds and reads every JSON answer; without it there is no behaviour. */
const CANNOT_RUN = Bun.which("jq") === null;

/**
 * What the fake `terraform output -json` hands back for every machine.
 *
 * Only shape and price, never an address that resolves: 192.0.2.10 is TEST-NET-1, which
 * exists in RFC 5737 precisely so that a test cannot accidentally reach a host.
 */
const OUTPUTS = {
  ip: { value: "192.0.2.10" },
  user: { value: "dev" },
  port: { value: 22 },
  cloud: { value: "hetzner" },
  region: { value: "fsn1" },
  instance_type: { value: "cx33" },
  hourly_eur: { value: 0.0156 },
};

/**
 * `down` reads the provider credential BEFORE it destroys, so without this the hetzner
 * branch dies on "no HCLOUD_TOKEN" and no test could ever observe which machine `resolve`
 * had chosen. The value is deliberately not a token shape, and nothing in these runs can
 * spend it: the Hetzner API is only called once the LAST machine is gone, and the fake
 * terraform never empties a state, so `instances` is never empty when that branch is
 * reached. The stubbed `curl` below is the second lock on that door.
 */
const HETZNER = { HCLOUD_TOKEN: "not-a-real-token" };

/** An executable that answers instead of the real tool, written where PATH finds it first. */
function stub(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

type Scene = {
  /** One invocation of the real core against this fleet. */
  run(argv: string[], extra?: Record<string, string | undefined>): Promise<Run>;
  /** Every command line the fake terraform was given, in order. */
  terraform(): string[];
  /** The names `destroy` was actually run against — the only proof of what `down` picked. */
  destroyed(): string[];
  /** Every provider request that got out. Must stay empty, in every single test. */
  reached(): string[];
};

/**
 * A fleet, a fake Terraform, and a way to read back what the core did with them.
 *
 * `ssh-keyscan` is stubbed because `info` fingerprints the host it describes, and against
 * a TEST-NET address that is ten seconds of timeout per test for a field this file does not
 * care about. `curl` is stubbed for a different reason: it is the only way anything here
 * could reach a real provider, so it is replaced by something that records and fails rather
 * than trusted not to be called.
 */
function fleet(machines: Array<[cloud: string, name: string]>): Scene {
  const env = sandbox();
  for (const [cloud, name] of machines) fakeMachine(env, cloud, name);

  const home = env["HOME"] ?? "";
  const tflog = fakeTerraform(env, OUTPUTS);
  const bin = join(home, "bin");
  const curllog = join(bin, "curl.log");
  stub(join(bin, "ssh-keyscan"), "exit 1");
  stub(join(bin, "curl"), `printf '%s\\n' "$*" >> ${JSON.stringify(curllog)}\nexit 1`);
  // `down` feeds the key back into `terraform destroy`. Absent, `cat` writes a line of its
  // own to stderr, which would sit in the middle of every assertion about what was said.
  writeFileSync(join(home, ".ssh", "devbox.pub"), "ssh-ed25519 AAAA-not-a-key devbox-test\n");

  const lines = (path: string): string[] =>
    existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];

  return {
    run: (argv, extra = {}) =>
      runCore(argv, {
        ...env,
        // The stubs first, so a lookup finds them and not the machine's own tools.
        PATH: `${bin}:${process.env["PATH"] ?? ""}`,
        // Said out loud rather than left to the sandbox being empty: with DEVBOX_REMOTE unset
        // the core would read ~/.config/devbox/.env, and a test whose subject is `resolve`
        // must not be one edit away from exercising `remote_resolve` instead.
        DEVBOX_REMOTE: "",
        ...extra,
      }),
    terraform: () => lines(tflog),
    destroyed: () =>
      lines(tflog)
        .filter((line) => line.includes(" destroy "))
        .map((line) => /-var name=(\S+)/.exec(line)?.[1] ?? ""),
    reached: () => lines(curllog),
  };
}

type Target = {
  verb: string;
  /** The argv for this verb, with a name or without one. */
  argv: (name?: string) => string[];
  extra: Record<string, string>;
  /** The name the core ended up acting on, read from whatever that verb leaves behind. */
  chose: (run: Run, scene: Scene) => string;
};

/**
 * The two verbs that resolve, held to the same rules.
 *
 * `ls` is NOT one of them and never was — it lists the whole fleet and has nothing to
 * disambiguate — so covering `ls` proves nothing about either of these. The contrast is
 * pinned at the bottom of this file so that "resolve is tested" cannot again mean "ls is
 * tested".
 */
const RESOLVERS: Target[] = [
  {
    verb: "info",
    // --json so that the machine it chose is a field, and not a paragraph of screen to
    // pattern-match against.
    argv: (name) => (name === undefined ? ["info", "--json"] : ["info", name, "--json"]),
    extra: {},
    chose: (run) => String((JSON.parse(run.stdout) as { name: string }).name),
  },
  {
    verb: "down",
    argv: (name) => (name === undefined ? ["down"] : ["down", name]),
    extra: HETZNER,
    // The destroy line, and nothing else. `down` prints the name it acted on only in its
    // closing summary, which --quiet suppresses and the "others are still running" branch
    // skips — the argument list Terraform was handed is the one witness that always exists.
    chose: (_run, scene) => scene.destroyed().join(","),
  },
];

afterAll(cleanup);

describe.skipIf(CANNOT_RUN)("machine resolution, from the bash side", () => {
  for (const target of RESOLVERS) {
    describe(`${target.verb}, and the refusal to guess`, () => {
      test("dies on an empty fleet instead of acting on nothing", async () => {
        const scene = fleet([]);
        const run = await scene.run(target.argv(), target.extra);

        expect(verdict(run.stderr)).toBe("no machine. devbox up");
        expect(run.code).toBe(1);
        // And it found that out without initialising anything. `instances` reads the state
        // files, which is what keeps "is there anything here at all" free.
        expect(scene.terraform()).toEqual([]);
        expect(scene.reached()).toEqual([]);
      });

      test("takes the only machine when nothing was named", async () => {
        const scene = fleet([["hetzner", "solo"]]);
        const run = await scene.run(target.argv(), target.extra);

        // The single-machine case is the common one and must not need ceremony: a refusal
        // here would make every one-machine workstation type a name it never chose.
        expect(verdict(run.stderr)).toBeNull();
        expect(run.code).toBe(0);
        expect(target.chose(run, scene)).toBe("solo");
      });

      test("refuses between two, lists both, and truly stops there", async () => {
        const scene = fleet([
          ["hetzner", "alpha"],
          ["scaleway", "beta"],
        ]);
        const run = await scene.run(target.argv(), target.extra);

        expect(verdict(run.stderr)).toBe("several machines exist, name the one you mean:");
        // Listed, not merely counted. "several machines exist" without the names sends the
        // reader to `devbox ls` to find out what they were, which is the one thing the refusal
        // already knows.
        expect(run.stderr).toContain("alpha");
        expect(run.stderr).toContain("beta");
        expect(run.code).toBe(1);

        // The three assertions this whole file exists for. The broken version printed the
        // very same red line — the `die` ran, inside a subshell — and then carried on with
        // an empty cloud and an empty name. Nothing after the refusal may happen: no
        // narration on stdout, no Terraform invocation, no provider request.
        expect(run.stdout).toBe("");
        expect(scene.terraform()).toEqual([]);
        expect(scene.reached()).toEqual([]);
      });

      test("dies on a name no state knows, and names it back", async () => {
        const scene = fleet([
          ["hetzner", "alpha"],
          ["hetzner", "beta"],
        ]);
        const run = await scene.run(target.argv("ghost"), target.extra);

        // The name is quoted back because the usual cause is a typo, and a message that
        // does not repeat what it was given cannot show one.
        expect(verdict(run.stderr)).toBe("no machine named 'ghost'. devbox ls");
        expect(run.code).toBe(1);
        expect(run.stdout).toBe("");
        expect(scene.terraform()).toEqual([]);
        expect(scene.reached()).toEqual([]);
      });

      test("takes the named one out of several", async () => {
        const scene = fleet([
          ["hetzner", "alpha"],
          ["hetzner", "beta"],
        ]);
        const run = await scene.run(target.argv("beta"), target.extra);

        expect(verdict(run.stderr)).toBeNull();
        expect(run.code).toBe(0);
        expect(target.chose(run, scene)).toBe("beta");
        // Named the second, touched only the second. This is the assertion that would have
        // caught a resolver that took the first line of the list whenever one was matched.
        expect(scene.terraform().join("\n")).not.toContain("name=alpha");
        expect(scene.reached()).toEqual([]);
      });
    });
  }

  describe("down, where the name has to survive the flags", () => {
    // Two orders, because a human types both, and because the parser was two `case`
    // statements on $1 and $2 before it became a loop. The dispatch handed `cmd_down` a
    // `${1:-}` instead of `"$@"`, so `devbox down --quiet web` arrived as `--quiet` alone: the
    // name was gone, one machine of two made it ambiguous, and the ambiguity was resolved
    // by the bug above.
    for (const [what, argv] of [
      ["before the name", ["down", "--quiet", "beta"]],
      ["after the name", ["down", "beta", "--quiet"]],
    ] as const) {
      test(`keeps the name with --quiet ${what}`, async () => {
        const scene = fleet([
          ["hetzner", "alpha"],
          ["hetzner", "beta"],
        ]);
        const run = await scene.run([...argv], HETZNER);

        expect(verdict(run.stderr)).toBeNull();
        expect(run.code).toBe(0);
        expect(scene.destroyed()).toEqual(["beta"]);
        expect(scene.terraform().join("\n")).not.toContain("name=alpha");
        expect(scene.reached()).toEqual([]);
      });
    }

    test("still resolves the only machine when --quiet is the whole argument list", async () => {
      // The other half of the first `case`: it shifts, and a shift that took the name with
      // it would leave `resolve` with an empty string. Harmless with one machine, which is
      // exactly why it needs pinning — it stays harmless until there are two.
      const scene = fleet([["hetzner", "solo"]]);
      const run = await scene.run(["down", "--quiet"], HETZNER);

      expect(verdict(run.stderr)).toBeNull();
      expect(run.code).toBe(0);
      expect(scene.destroyed()).toEqual(["solo"]);
      expect(scene.reached()).toEqual([]);
    });

    /**
     * The two names, and the flag nobody meant to type.
     *
     * Both of these were pinned in this file as "CURRENT:" for as long as the parser was
     * two `case` statements on $1 and $2: they were what the core did, and what nobody
     * would have chosen. The loop that replaced those statements is what these now assert,
     * and the memory of each failure is kept in the comment because a green test that only
     * says "it refuses" is the same green as a test that never knew why it had to.
     */
    for (const [where, argv] of [
      ["side by side", ["down", "alpha", "beta"]],
      // The interleaved shape matters on its own: with the old $1/$2 pair, `--quiet` in the
      // middle put `beta` in position 3, where nothing looked at all.
      ["with a flag between them", ["down", "alpha", "--quiet", "beta"]],
    ] as const) {
      test(`refuses two names ${where}, and destroys neither`, async () => {
        // `devbox down alpha beta` used to exit 0 having destroyed alpha, with no line about
        // beta on stdout or stderr: the second name was not an error and not a warning, it
        // was nothing. The owner read "alpha destroyed. Meter stopped.", believed both were
        // gone, and beta kept billing. Every other verb here dies on what it does not
        // understand; the one that destroys work now does too.
        const scene = fleet([
          ["hetzner", "alpha"],
          ["hetzner", "beta"],
        ]);
        const run = await scene.run([...argv], HETZNER);

        // Both names quoted back, in the order typed — the dropped one is precisely the one
        // worth naming, and a refusal that hid it would repeat the original silence.
        expect(verdict(run.stderr)).toBe(
          "down destroys one machine at a time, and you named two: alpha and beta",
        );
        expect(run.code).toBe(1);
        expect(run.stdout).toBe("");

        // The assertion the pinned version failed, and the reason this test exists at all:
        // not "beta survived" but "neither was touched". The refusal lands before
        // `resolve`, before the Hetzner credential is read, and before Terraform is spawned
        // at all — so the log is empty rather than merely destroy-free.
        expect(scene.destroyed()).toEqual([]);
        expect(scene.terraform().join("\n")).not.toContain("destroy");
        expect(scene.terraform()).toEqual([]);
        expect(scene.reached()).toEqual([]);
      });
    }

    for (const [where, argv] of [
      ["on its own", ["down", "--quiett"]],
      // Past the name too, because the loop keeps reading after it has what it needs — the
      // old second `case` had already stopped looking by here.
      ["after the name", ["down", "solo", "--quiett"]],
    ] as const) {
      test(`refuses an unknown flag ${where}, by its own name`, async () => {
        // `cmd_info`, `cmd_ls` and `cmd_up` all answered "unknown flag: X". `cmd_down`
        // handed the typo straight to `resolve`, which answered "no machine named
        // '--quiett'" — the right exit code behind an explanation that sent the reader
        // hunting for a machine nobody had lost, on the verb where hesitation matters most.
        const scene = fleet([["hetzner", "solo"]]);
        const run = await scene.run([...argv], HETZNER);

        expect(verdict(run.stderr)).toBe("unknown flag for down: --quiett");
        expect(run.code).toBe(1);
        expect(run.stdout).toBe("");
        expect(scene.destroyed()).toEqual([]);
        expect(scene.terraform()).toEqual([]);
        expect(scene.reached()).toEqual([]);
      });
    }
  });

  describe("ls, which resolves nothing at all", () => {
    test("answers an empty fleet with a line, not with a death", async () => {
      // Deliberately unlike `info` and `down` on the same empty state: `ls` is the command
      // you run to find out, so "there is nothing" is its answer and not its failure.
      const scene = fleet([]);
      const run = await scene.run(["ls"]);

      expect(strip(run.stdout)).toContain("no machine");
      expect(run.code).toBe(0);
      expect(verdict(run.stderr)).toBeNull();
    });

    test("lists two rather than refusing between them", async () => {
      const scene = fleet([
        ["hetzner", "alpha"],
        ["scaleway", "beta"],
      ]);
      const run = await scene.run(["ls"]);

      expect(run.code).toBe(0);
      expect(strip(run.stdout)).toContain("alpha");
      expect(strip(run.stdout)).toContain("beta");
      expect(verdict(run.stderr)).toBeNull();
      expect(scene.reached()).toEqual([]);
    });

    test("prices the month beside the hour, never instead of it", async () => {
      // The monthly figure is interpolated, hourly × MONTH_HOURS, because price_hourly is
      // the only price devbox-core asks any of the three providers for. It is pinned here and
      // not merely trusted: the Ink layer and the dashboard now multiply by their own copy
      // of that 730, and the first symptom of one of them drifting is `devbox ls` and a web
      // page quoting two different rents for the same machine — the exact failure this
      // column was added to prevent.
      const scene = fleet([
        ["hetzner", "alpha"],
        ["scaleway", "beta"],
      ]);
      const run = await scene.run(["ls"]);
      const text = strip(run.stdout);

      // 0,0156/h apiece, the price the fake terraform hands back for every machine.
      expect(text).toContain("EUR/MO");
      expect(text).toContain("0,016  11,39");
      // And the day survives: it is what answers "over the weekend?", where the month
      // answers "what did I sign up for", and one was never a replacement for the other.
      expect(text).toContain("0,75 EUR a day and 22,78 EUR a month");
      expect(run.code).toBe(0);
      expect(scene.reached()).toEqual([]);
    });
  });

  /**
   * What the core does today, pinned as it is.
   *
   * Neither of the two below is the behaviour anyone would choose; both are real, and
   * devbox-core is not touched from here. They are tests so that a fix is a visible red line
   * in this file rather than a silent change of meaning.
   *
   * It worked: two of their neighbours have already left this block. `down` no longer
   * destroys the first of two names in silence, and no longer reads a mistyped flag as a
   * machine name. Both went red here the day the parsing loop landed, and both moved up
   * into "the name has to survive the flags" rather than being deleted — the fix is only
   * proven by the assertion that used to read the other way.
   */
  describe("current behaviour, kept honest", () => {
    test("CURRENT: the refusal lists lines that cannot be typed back", async () => {
      // The refusal prints "<cloud> <name>", one per line, indented — which reads like the
      // answer it is asking for. The first word of a copied line is a cloud, and the core
      // matches names only, so the obvious next command fails with a message about a
      // machine nobody was looking for. On `down`, that is one wasted attempt on the verb
      // where hesitation matters most.
      const scene = fleet([
        ["hetzner", "alpha"],
        ["hetzner", "beta"],
      ]);
      const refused = await scene.run(["down"], HETZNER);
      expect(refused.stderr).toContain("    hetzner alpha");

      const copied = await scene.run(["down", "hetzner"], HETZNER);
      expect(verdict(copied.stderr)).toBe("no machine named 'hetzner'. devbox ls");
      expect(copied.code).toBe(1);
    });

    test("CURRENT: one name on two clouds resolves to the first cloud, without a word", async () => {
      // `resolve` matches on the name column and stops at the first hit, and the clouds are
      // walked in a fixed order — so a name held by two states is a guess, made silently,
      // by the function whose whole purpose is not to guess. `up` refuses a name that
      // already exists on ANY cloud, which is what keeps this out of reach in practice; a
      // hand-made workspace or an import is all it takes to get back into it.
      const scene = fleet([
        ["hetzner", "twin"],
        ["scaleway", "twin"],
      ]);
      const run = await scene.run(["down", "twin"], HETZNER);

      expect(run.code).toBe(0);
      expect(scene.destroyed()).toEqual(["twin"]);
      // hetzner, because hetzner is first in CLOUDS_IMPLEMENTED. Nothing was said about the
      // other one, which is still running and still on the meter.
      expect(scene.terraform().join("\n")).toContain("/hetzner destroy");
      expect(scene.terraform().join("\n")).not.toContain("/scaleway destroy");
      expect(run.stderr).toBe("");
    });
  });
});
