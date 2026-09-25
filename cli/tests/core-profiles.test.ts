import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CORE,
  cleanup,
  fakeMachine,
  fakeTerraform,
  runCore,
  sandbox,
  strip,
  verdict,
  warnings,
} from "./harness.ts";

/**
 * Profiles, read from the outside: the declarative header, the lookup, and `devbox profiles`.
 *
 * WHAT a machine becomes is a profile, and a profile is a shell script with a header of
 * comment lines that nothing generates — so the header is a hand-written interface, and the
 * only thing standing between a typo in it and a machine ordered with the wrong shape is
 * how devbox-core parses it. That parser is five lines of awk and a jq template, and every one
 * of the cases below was found by running them rather than by reading them.
 *
 * Several of those cases were defects of devbox-core, pinned here as they behaved at the time
 * and marked DEFECT where they sat — a test deleted for being red is worth less than one
 * that says out loud what the tool does. Two of them have since been fixed in the core: the
 * seed that died in silence without ~/.ssh/config, and the profile that vanished from the
 * listing over one unreadable number. Those tests now assert the CORRECTED behaviour and
 * keep the old failure in their comment, because the reason a test exists outlives the bug.
 * The ones still marked DEFECT are live.
 *
 * The repository's own profiles/ is always the second directory searched, so every listing
 * below carries bare, claude and opencode alongside whatever the test wrote. Assertions are
 * about containment, never equality: adding a profile to the repository must not turn this
 * file red.
 */

/** cmd_profiles opens with `need jq`, and profile_meta is awk. Without either there is no
 *  behaviour left to assert — skipped rather than failed, and visible in the run. */
const CANNOT_RUN = Bun.which("jq") === null || Bun.which("awk") === null;

/** Where $HERE/profiles resolves to: the second half of PROFILE_DIRS, always searched. */
const REPO_PROFILES = join(dirname(CORE), "profiles");

/** One row of `devbox profiles --json` — the contract the dashboard pre-fills its form from. */
type Profile = {
  name: string;
  path: string;
  repo: string | null;
  secrets: string[];
  note: string | null;
  min_cpu: number | null;
  min_ram: number | null;
  min_disk: number | null;
  port: number | null;
  ports: number[];
};

const KEYS = [
  "min_cpu",
  "min_disk",
  "min_ram",
  "name",
  "note",
  "path",
  "port",
  "ports",
  "repo",
  "secrets",
];

afterAll(cleanup);

/**
 * A fresh sandbox whose $DEVBOX_CONFIG_DIR/profiles holds exactly these files.
 *
 * Never profiles/ itself. The repository's two profiles are what a real `devbox up` reaches
 * for, and a test that dropped a fixture beside them would be one interrupted run away from
 * leaving a `devbox-broken` in the tree that the next person's `devbox profiles` lists.
 *
 * The sandbox is built here and handed to runCore as an override rather than left to the
 * one runCore makes for itself, which is the only way to write a file the invocation will
 * then read: runCore's own sandbox is created inside the call and never returned.
 */
function withProfiles(files: Record<string, string>): Record<string, string> {
  const env = sandbox();
  mkdirSync(join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles", `${name}.sh`), body);
  }
  return env;
}

/** `devbox profiles --json`, parsed, with a finder — the shape most tests below want. */
async function listing(env: Record<string, string | undefined>) {
  const run = await runCore(["profiles", "--json"], env);
  let rows: Profile[];
  try {
    rows = JSON.parse(run.stdout) as Profile[];
  } catch {
    // Said in full rather than as "unexpected token": when this breaks, the interesting
    // thing is the whole of what came out, and stderr beside it.
    throw new Error(`not JSON (exit ${run.code})\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  }
  return {
    ...run,
    rows,
    names: rows.map((row) => row.name),
    at: (name: string): Profile | undefined => rows.find((row) => row.name === name),
  };
}

/**
 * `devbox seed --profile P`, which is the cheapest verb that reaches profile_path.
 *
 * `devbox profiles` never calls profile_path — it walks the directories itself — so the name
 * validation, the "no profile named" refusal and the duplicate-key guard are unreachable
 * through it. Of the two verbs that do call it, `up` goes on to hz_up and a live provider
 * API the moment the lookup stops dying, and `seed` goes on to `outputs`, which is a
 * terraform call. `seed` is the one that can be fenced.
 *
 * Two things have to be true first, and both are scaffolding rather than subject:
 *  - a machine has to exist, or resolve() dies before the profile is ever looked at;
 *  - $HOME/.ssh/config is written empty, so profile_of() finds no recorded profile and the
 *    --profile given here is the only one in play. It used to be load-bearing for a worse
 *    reason — an absent file took cmd_seed down with exit 2 and nothing printed — and the
 *    test at the end of "finding a profile by name" is what watches that it stays fixed.
 * The fake terraform is the fence: if a change ever let the lookup fall through, `outputs`
 * meets a script that writes to a log instead of a provider.
 */
async function seedWith(env: Record<string, string>, profile: string) {
  fakeMachine(env, "hetzner", "devbox-t1");
  writeFileSync(join(env["HOME"] ?? "", ".ssh", "config"), "");
  fakeTerraform(env);
  return runCore(["seed", "--profile", profile], {
    ...env,
    PATH: `${join(env["HOME"] ?? "", "bin")}:${process.env["PATH"] ?? ""}`,
  });
}

describe.skipIf(CANNOT_RUN)("the declarative header", () => {
  test("reads every field, whatever whitespace separates the words", async () => {
    // The parser is `$1 == "#" && $2 == "devbox-<key>:"`, so what it actually requires is that
    // the hash, the key and the value be three whitespace-separated words — one space, six
    // spaces and a tab are all the same thing to awk. This is the alignment a header is
    // written with in practice.
    const env = withProfiles({
      every: [
        "#!/bin/bash",
        "# devbox-repo: https://example.test/every.git",
        "#   devbox-secrets:   claude github",
        "#\tdevbox-min-cpu:\t6",
        "# devbox-min-ram:      12",
        "#     devbox-min-disk: 120",
        "# devbox-port:\t9010",
        "# devbox-note: alice@acme.test / hunter2",
        "set -euo pipefail",
        "",
      ].join("\n"),
    });

    const { code, at } = await listing(env);

    expect(code).toBe(0);
    expect(at("every")).toEqual({
      name: "every",
      path: join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles", "every.sh"),
      repo: "https://example.test/every.git",
      // A list and not a string: the seed loop iterates it, and a consumer that had to
      // split would have to guess the separator.
      secrets: ["claude", "github"],
      note: "alice@acme.test / hunter2",
      // Numbers and not strings: these are compared against a provider's offers.
      min_cpu: 6,
      min_ram: 12,
      min_disk: 120,
      port: 9010,
      ports: [9010],
    });
  });

  /**
   * Several ports since 24/09, the app first: one forward each. Readable only whole - a list
   * read in half would forward some ports and drop the rest without a word - and every word a
   * port ssh accepts, because each becomes a LocalForward line and ssh refuses the ENTIRE
   * config on a bad one.
   */
  test("reads the ports as a list, the app first, and only whole", async () => {
    const env = withProfiles({
      several: "#!/bin/bash\n# devbox-port:  9010   5173\t3000 5173\n",
      padded: "#!/bin/bash\n# devbox-port: 08080\n",
      beyond: "#!/bin/bash\n# devbox-port: 9010 99999\n",
      zero: "#!/bin/bash\n# devbox-port: 0\n",
    });

    const { code, at, stderr } = await listing(env);

    expect(code).toBe(0);
    // Whitespace of any kind between them, and a repeat kept once, where it first stood.
    expect(at("several")?.ports).toEqual([9010, 5173, 3000]);
    expect(at("several")?.port).toBe(9010);
    expect(at("padded")?.ports).toEqual([8080]);
    for (const name of ["beyond", "zero"]) {
      expect(at(name)?.ports, name).toEqual([]);
      expect(at(name)?.port, name).toBeNull();
    }
    expect(warnings(stderr)).toEqual([
      "profile beyond: port — not a number, read as absent",
      "profile zero: port — not a number, read as absent",
    ]);
  });

  test("refuses to order a machine whose ports ssh could not read", async () => {
    const env = withProfiles({ beyond: "#!/bin/bash\n# devbox-port: 9010 99999\n" });
    const { code, stderr, stdout } = await runCore(
      ["up", "--name", "devbox-x", "--profile", "beyond", "--cloud", "hetzner"],
      env,
    );
    expect(verdict(stderr)).toContain("devbox-port is not a list of ports between 1 and 65535: '9010 99999'");
    expect(code).toBe(1);
    // Before anything was asked of a provider.
    expect(strip(stdout)).not.toContain("asking");
  }, 30_000);

  test("gives an absent field null, and an absent secrets list an empty array", async () => {
    // Verified against the real thing before being asserted, because "absent" had three
    // plausible answers — a missing key, an empty string, or null — and the dashboard
    // pre-fills a form from this. It is null for everything except secrets, which is [],
    // and the asymmetry is deliberate: `null` means the profile said nothing and the caller
    // may use its own default, while `[]` means the seed loop has nothing to iterate.
    //
    // A key declared with nothing after it answers exactly as an absent one, which is the
    // second half of the same rule and the reason `# devbox-repo:` alone is not an error.
    const env = withProfiles({
      sparse: ["#!/bin/bash", "# nothing at all is declared here", "echo hi", ""].join("\n"),
      empty: ["#!/bin/bash", "# devbox-repo:", "# devbox-secrets:", "# devbox-min-cpu:", ""].join("\n"),
    });

    const { code, at } = await listing(env);

    expect(code).toBe(0);
    for (const name of ["sparse", "empty"]) {
      const row = at(name);
      expect(row, name).toBeDefined();
      expect(row?.repo, name).toBeNull();
      expect(row?.note, name).toBeNull();
      expect(row?.min_cpu, name).toBeNull();
      expect(row?.min_ram, name).toBeNull();
      expect(row?.min_disk, name).toBeNull();
      expect(row?.port, name).toBeNull();
      expect(row?.secrets, name).toEqual([]);
    }
    // The shipped profiles are the same case for the repository, on purpose — they declare
    // no devbox-repo so that a copy does not arrive with someone else's repository baked
    // in — so this is not only a synthetic fixture.
    expect(at("claude")?.repo).toBeNull();
    expect(at("opencode")?.repo).toBeNull();
  });

  test("collapses runs of whitespace inside a value", async () => {
    // Not a decision anyone made: profile_meta blanks $1 and $2, and assigning to a field
    // makes awk rebuild the record with OFS between every field. Two spaces become one, a
    // tab becomes a space, trailing blanks disappear.
    //
    // Pinned rather than shrugged at because a note is where this bites: an account and a
    // password aligned into columns in the file arrive here with one space between them.
    // Anything the header carries whose spacing matters — an aligned table in a note, an
    // indented fragment — would be quietly reflowed, and only a test says so.
    const env = withProfiles({
      spaced: [
        "#!/bin/bash",
        "# devbox-note: two  spaces\tand a tab   ",
        "# devbox-secrets:  claude   github  ",
        "",
      ].join("\n"),
    });

    const { at } = await listing(env);

    expect(at("spaced")?.note).toBe("two spaces and a tab");
    // Harmless here, and the reason the secrets list survives sloppy alignment at all: the
    // rebuild is what makes a plain split(" ") safe on the other side.
    expect(at("spaced")?.secrets).toEqual(["claude", "github"]);
  });

  test("ignores a field whose words are not separated by whitespace", async () => {
    // DEFECT (devbox-core, minor). `# devbox-port:9010` and `#devbox-repo: …` and `# devbox-repo : …`
    // all read as a declaration to a human and as an ordinary comment to awk, which wants
    // the hash and the `key:` to be whole fields. Nothing warns; the field simply comes back
    // null, and `devbox up` then orders the default shape while the header on screen says
    // otherwise. Asserted as it behaves today.
    const env = withProfiles({
      glued: [
        "#!/bin/bash",
        "#devbox-repo: https://example.test/glued.git", // hash glued to the key
        "# devbox-port:9010", // value glued to the colon
        "# devbox-min-ram : 32", // a space before the colon
        "# devbox-min-cpu: 8", // the one written the documented way
        "",
      ].join("\n"),
    });

    const { at } = await listing(env);

    expect(at("glued")?.repo).toBeNull();
    expect(at("glued")?.port).toBeNull();
    expect(at("glued")?.min_ram).toBeNull();
    // The control, so the test cannot pass because the whole file was skipped.
    expect(at("glued")?.min_cpu).toBe(8);
  });

  test("reads a field declared anywhere in the file, not only in the leading block", async () => {
    // "Header" names where these lines are written, not where they are found: the awk has
    // no line range and no stop, so a `# devbox-port:` sitting under two hundred lines of shell
    // counts exactly as much as one on line three.
    //
    // Worth knowing in both directions. It is what lets a profile document a field beside
    // the code that uses it — and it is why claude.sh has to write its example as `#   # devbox-
    // repo: …`, with the real hash first, or the sample line in its own comment would be
    // read as a declaration.
    const env = withProfiles({
      late: [
        "#!/bin/bash",
        "set -euo pipefail",
        "echo 'a hundred lines of profile'",
        "",
        "# devbox-port: 8080",
        "",
      ].join("\n"),
    });

    expect((await listing(env)).at("late")?.port).toBe(8080);
  });
});

describe.skipIf(CANNOT_RUN)("devbox profiles --json", () => {
  test("answers a JSON array carrying the repository's own profiles", async () => {
    const { code, stdout, stderr, rows, names, at } = await listing(sandbox());

    expect(code).toBe(0);
    expect(stderr).toBe("");
    // Parsed once more from the raw bytes: `listing` already did it, and the point of this
    // assertion is that stdout alone is the interface — no narration, no warning, no
    // trailing table on the same stream.
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(Array.isArray(rows)).toBe(true);

    expect(names).toContain("claude");
    expect(names).toContain("opencode");
    for (const row of rows) {
      // The key set is the contract. The dashboard reads note and port from here to
      // pre-fill its form, and a row that dropped one of them would leave a field blank
      // rather than fail, which is the failure that is not noticed.
      expect(Object.keys(row).sort(), row.name).toEqual(KEYS);
    }
    // Found through $HERE/profiles, which resolve_here derives from the real file — so a
    // path outside the repository here means the lookup went somewhere unexpected.
    expect(at("claude")?.path).toBe(join(REPO_PROFILES, "claude.sh"));
    expect(at("opencode")?.path).toBe(join(REPO_PROFILES, "opencode.sh"));
    // Read from a COMMITTED file through the real parser, which is the closest this suite
    // gets to an integration test of the header format itself. `every` above covers the
    // fields no shipped profile declares — a repository and a port belong to the copy you
    // write, not to the ones this repository publishes.
    expect(at("claude")?.secrets).toEqual(["claude", "github"]);
    expect(at("claude")?.note).toContain("claude");
    expect(at("claude")?.min_cpu).toBe(2);
    expect(at("claude")?.min_ram).toBe(4);
    expect(at("claude")?.min_disk).toBe(40);
    // Absent, and asserted so: a profile that named someone else's repository would be the
    // wrong thing to ship, and this is what says the shipped ones name none.
    expect(at("claude")?.repo).toBeNull();
  });

  test("puts a personal profile first, and lets it shadow the repository's", async () => {
    // PROFILE_DIRS is "$CONFIG_DIR/profiles $HERE/profiles", in that order, and profiles_json
    // keeps the first name it saw. That is what makes "yours go in ~/.config/devbox/profiles
    // and shadow the repository's" true rather than aspirational — and it must stay
    // one-entry-per-name, or the dashboard's form would offer the same profile twice.
    const env = withProfiles({ claude: "#!/bin/bash\n# devbox-repo: https://example.test/mine.git\n" });

    const { names, at } = await listing(env);

    expect(names.filter((name) => name === "claude")).toHaveLength(1);
    expect(at("claude")?.path).toBe(join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles", "claude.sh"));
    expect(at("claude")?.repo).toBe("https://example.test/mine.git");
    // Shadowed, not hidden: everything else the repository ships is still listed.
    expect(names).toContain("opencode");
  });

  test("lists the same profiles as the table, and says where a personal one goes", async () => {
    const env = withProfiles({ mine: "#!/bin/bash\n# devbox-min-cpu: 2\n" });
    const { names } = await listing(env);
    const table = await runCore(["profiles"], env);

    expect(table.code).toBe(0);
    const text = strip(table.stdout);
    expect(text).toContain("PROFILE");
    for (const name of names) expect(text, name).toContain(name);
    // The table exists to be read by a person, so it has to end on what to do next — and
    // the directory it names is the one the lookup actually searches first, not a constant.
    expect(text).toContain(join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles"));
    expect(text).toContain(join(REPO_PROFILES, "claude.sh"));
  });

  test("refuses a flag it does not know instead of listing anyway", async () => {
    const { code, stdout, stderr } = await runCore(["profiles", "--jsno"], sandbox());

    expect(code).toBe(1);
    expect(verdict(stderr)).toBe("unknown flag for profiles: --jsno");
    // Nothing on stdout, which matters for the caller that pipes this into jq: a table
    // printed after a refused flag would be parsed as garbage rather than seen as an error.
    expect(stdout).toBe("");
  });
});

describe.skipIf(CANNOT_RUN)("finding a profile by name", () => {
  test("searches $DEVBOX_CONFIG_DIR/profiles, then the repository's", async () => {
    const env = withProfiles({ mine: "#!/bin/bash\n# devbox-note: from the config dir\n" });
    const { at } = await listing(env);

    expect(at("mine")?.path).toBe(join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles", "mine.sh"));
    expect(at("mine")?.note).toBe("from the config dir");
  });

  test("falls back to $HOME/.config/devbox/profiles when DEVBOX_CONFIG_DIR is unset", async () => {
    // The variable exists for the dashboard, whose systemd unit points it at a data
    // directory; on a workstation nobody sets it, so the default is the path every reader
    // of the README will actually use. Unset here rather than merely empty — `${VAR:-…}`
    // treats the two the same, and a test that only covered one would miss a change to `-`.
    const env = sandbox();
    mkdirSync(join(env["HOME"] ?? "", ".config", "devbox", "profiles"), { recursive: true });
    writeFileSync(
      join(env["HOME"] ?? "", ".config", "devbox", "profiles", "athome.sh"),
      "#!/bin/bash\n# devbox-repo: https://example.test/athome.git\n",
    );

    const { at, names } = await listing({ ...env, DEVBOX_CONFIG_DIR: undefined });

    expect(at("athome")?.repo).toBe("https://example.test/athome.git");
    expect(names).toContain("claude");
  });

  test("finds the repository's profiles through the documented install symlink", async () => {
    // `ln -sfn $(PWD)/devbox ~/.local/bin/devbox` is how this is installed, so ${BASH_SOURCE[0]}
    // is a symlink in ~/.local/bin and `dirname` on it would make $HERE/profiles point at a
    // directory that does not exist — no claude, no opencode, on every installed copy while
    // every test that ran the file in place stayed green. resolve_here walks the link, and
    // this is the assertion that says so.
    //
    // Spawned here rather than through runCore because the harness only ever spawns CORE
    // itself; the environment is built exactly as runCore builds it — a fresh sandbox, PATH
    // and nothing else — so no credential and no real HOME is in reach.
    const env = sandbox();
    const link = join(env["HOME"] ?? "", "bin", "devbox");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(CORE, link);

    const child = Bun.spawn([link, "profiles", "--json"], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    expect(code).toBe(0);
    const rows = JSON.parse(stdout) as Profile[];
    expect(rows.map((row) => row.name)).toContain("claude");
    expect(rows.find((row) => row.name === "claude")?.path).toBe(
      join(REPO_PROFILES, "claude.sh"),
    );
  });

  test("names the profile it could not find, and the command that lists them", async () => {
    const { code, stdout, stderr } = await seedWith(withProfiles({}), "claud");

    // The name, quoted, because the whole value of the message is telling a typo from a
    // profile that was never deployed to this machine — and "claud" for "claude" is
    // exactly the mistake it has to survive.
    expect(verdict(stderr)).toBe("no profile named 'claud'. devbox profiles");
    expect(code).toBe(1);
    // It died at the lookup: nothing was ordered, and no phase was announced.
    expect(stdout).toBe("");
  });

  test("refuses a name that is not a bare word, before it becomes a path", async () => {
    // profile_path builds "$d/$n.sh", so an unchecked name is a path traversal with a shell
    // script at the end of it — and the dashboard takes the profile name from an HTTP body.
    // The refusal is a whitelist of letters, digits, dash and underscore. The empty name -
    // `--profile ""` - is refused too, by the sentence of the next test.
    for (const name of ["../../etc/passwd", "sub/dir", "with space", "semi;colon"]) {
      const { code, stderr } = await seedWith(withProfiles({}), name);

      expect(verdict(stderr), JSON.stringify(name)).toBe(
        `a profile name must be letters, digits, dash or underscore: '${name}'`,
      );
      expect(code, JSON.stringify(name)).toBe(1);
    }
  }, 30_000);

  /**
   * There is no default profile since 24/09: `bare` went, and any other default would be this
   * tool deciding what a machine is for. The empty name - no --profile and no DEVBOX_PROFILE,
   * or `--profile ""` - is refused with the two ways to name one, and not with the whitelist's
   * sentence, which would read `must be letters ...: ''` to someone who simply named none.
   */
  test("refuses to choose a profile when none is named", async () => {
    const { code, stdout, stderr } = await seedWith(withProfiles({}), "");

    expect(verdict(stderr)).toBe(
      "no profile named: pass --profile <name>, or set DEVBOX_PROFILE. devbox profiles lists them",
    );
    expect(code).toBe(1);
    expect(stdout).toBe("");
  });

  test("refuses a header that declares the same key twice, naming the file and the key", async () => {
    // profile_meta stops at the first match, so a repeated key silently loses everything
    // after it. Refusing is the honest option, and it is checked in profile_path — the
    // lookup — rather than in the parser.
    const env = withProfiles({
      twice: [
        "#!/bin/bash",
        "# devbox-repo: https://example.test/one.git",
        "# devbox-repo: https://example.test/two.git",
        "",
      ].join("\n"),
    });

    const { code, stderr } = await seedWith(env, "twice");

    expect(code).toBe(1);
    expect(stderr).toContain(join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles", "twice.sh"));
    expect(stderr).toContain("devbox-repo:");
    expect(stderr).toContain("more than once");
    // And it says what to do instead, because "two repositories" is the reason someone
    // writes the second line and it has a real answer.
    expect(stderr).toContain("clone_repo");
  });

  test("applies that refusal to keys nothing reads, and only on the lookup", async () => {
    // Two halves of the same shape, both surprising enough to pin.
    //
    // The guard matches /^devbox-[a-z-]+:$/ and not the eight keys profile_json knows, so a
    // repeated `# devbox-wat:` — a field no version of this tool has ever read — takes `devbox
    // seed` down. Strict, and defensible: a key devbox does not know today may be one it knows
    // tomorrow, and the file is the interface.
    const env = withProfiles({ wat: "#!/bin/bash\n# devbox-wat: a\n# devbox-wat: b\n" });

    const seeded = await seedWith(env, "wat");
    expect(seeded.code).toBe(1);
    expect(seeded.stderr).toContain("devbox-wat:");

    // And `devbox profiles` lists that same file without a murmur, because profiles_json walks
    // the directories itself and never calls profile_path. So the duplicate is caught when
    // the profile is USED, not when it is listed — a header can sit broken in the listing
    // until someone tries to seed with it.
    const { code, at } = await listing(env);
    expect(code).toBe(0);
    expect(at("wat")).toBeDefined();
  });

  test("does not search a profiles directory whose path contains a space", async () => {
    // DEFECT (devbox-core, minor). PROFILE_DIRS is one space-separated string and both loops
    // read it as `for d in $PROFILE_DIRS`, unquoted, so word splitting cuts a directory in
    // half at its first space. A profile under "~/my config/profiles" is not found, not
    // listed, and not complained about — `devbox profiles` answers 0 with the repository's two
    // and nothing else.
    //
    // Reachable in one line: DEVBOX_CONFIG_DIR is what a dashboard deployment sets, and
    // $HOME/.config/devbox holds a space on any machine whose account name does. Asserted as
    // it behaves today.
    const env = sandbox();
    const spaced = join(env["HOME"] ?? "", "my config");
    mkdirSync(join(spaced, "profiles"), { recursive: true });
    writeFileSync(join(spaced, "profiles", "unfindable.sh"), "#!/bin/bash\n# devbox-min-cpu: 2\n");

    const { code, stderr, names } = await listing({ ...env, DEVBOX_CONFIG_DIR: spaced });

    expect(code).toBe(0);
    expect(names).not.toContain("unfindable");
    // Silently, which is the part that costs the time: nothing on stderr points at the path.
    expect(stderr).toBe("");
    expect(names).toContain("claude");
  });

  test("still reaches its own message when $HOME/.ssh/config does not exist", async () => {
    // Was a defect of devbox-core, major, and the reason the two seeds below are asserted on
    // the message rather than only on the exit code.
    //
    // cmd_seed calls profile_of() to recover the profile a machine was provisioned with, and
    // profile_of read $SSH_CONFIG with `awk … "$SSH_CONFIG" 2>/dev/null | head -1`: the
    // 2>/dev/null hid awk's "can't open file" but not its exit 2, `set -o pipefail` carried
    // that out of the pipeline, and the caller's `recorded=$(profile_of "$name")` is a plain
    // assignment, so `set -e` took the script down there and then. Measured on a machine
    // that had never run `devbox up`: exit 2, empty stdout, empty stderr — no `x`, no `==>`,
    // nothing to act on. It happened BEFORE profile_path, so the careful "no profile named
    // …" refusal could not be seen by anyone in that state, whatever they had mistyped.
    //
    // profile_of and local_port now open on `[ -f "$SSH_CONFIG" ] || return 0` and close on
    // `cut -d' ' -f1` rather than `head -1` — head closes the pipe early, and the SIGPIPE
    // that follows is the same death by a second road. An absent file means an empty answer,
    // which is what every caller already reads as "this machine has no block here", and the
    // command walks on to the message it always meant to print.
    //
    // Never hypothetical: the file is absent on a fresh account, and on any machine whose
    // fleet came from `devbox sync` failing before it wrote.
    for (const shape of ["a .ssh directory with no config in it", "no .ssh directory at all"]) {
      const env = withProfiles({});
      if (shape.startsWith("no")) rmSync(join(env["HOME"] ?? "", ".ssh"), { recursive: true });
      fakeMachine(env, "hetzner", "devbox-t1");
      fakeTerraform(env);

      const { code, stdout, stderr } = await runCore(["seed", "--profile", "claud"], {
        ...env,
        PATH: `${join(env["HOME"] ?? "", "bin")}:${process.env["PATH"] ?? ""}`,
      });

      // Word for word what the test above gets from a HOME that HAS an ssh config: whether
      // the file exists is now invisible to everything upstream of it.
      expect(verdict(stderr), shape).toBe("no profile named 'claud'. devbox profiles");
      expect(code, shape).toBe(1);
      // 1, not 2, and it is the difference between a caller that can report the refusal and
      // one that can only report a number.
      expect(stdout, shape).toBe("");
    }
  });
});

describe.skipIf(CANNOT_RUN)("a header devbox-core cannot make sense of", () => {
  test("keeps the profile, nulls the field, and names it in a warning", async () => {
    // Was a defect of devbox-core, major. `min_cpu: ($cpu | num)` ran a bare tonumber on
    // whatever the header said, so `# devbox-min-cpu: plenty` killed that one jq invocation.
    // profile_json is called inside a loop whose output is piped to `jq -s '.'`, and neither
    // the loop nor cmd_profiles looked at its status — the array came back one element
    // short, exit 0, and the only trace was jq's own complaint on stderr.
    //
    // Which is the failure mode this suite exists for: a consumer reading --json saw a clean
    // success with a profile missing, and `devbox up --profile broken` then answered "no
    // profile named 'broken'" about a file sitting right there. It did not die in silence,
    // it succeeded in near-silence, which is worse.
    //
    // Now `num` is `try tonumber catch null`: the row stays, the field it could not read is
    // null — exactly what an absent field already gets, so a caller that already handles one
    // handles the other — and profiles_json says which field on stderr before it hands the
    // array over.
    const env = withProfiles({
      broken: "#!/bin/bash\n# devbox-min-cpu: plenty\n# devbox-repo: https://example.test/b.git\n",
      vague: "#!/bin/bash\n# devbox-min-ram: lots\n# devbox-min-disk: 40\n# devbox-port: soon\n",
    });

    const { code, stdout, names, stderr, at } = await listing(env);

    expect(code).toBe(0);
    expect(names).toContain("broken");
    // The rest of the listing survives, as it already did: one bad header costs the operator
    // no other profile.
    expect(names).toContain("claude");
    expect(names).toContain("opencode");
    expect(() => JSON.parse(stdout)).not.toThrow();

    // Null, and null alone — the other seven fields of a profile with one bad number are
    // read as they always were, so a typo in min-cpu does not cost the repo line too.
    expect(at("broken")?.min_cpu).toBeNull();
    expect(at("broken")?.repo).toBe("https://example.test/b.git");
    expect(at("vague")?.min_ram).toBeNull();
    expect(at("vague")?.port).toBeNull();
    expect(at("vague")?.ports).toEqual([]);
    expect(at("vague")?.min_disk).toBe(40);

    // `/!\` and not jq's own noise: this is the line the Ink layer and the dashboard's job
    // log pick up, it names the profile and every field of it that was dropped, and one
    // profile gets one line however many fields it fumbled.
    expect(warnings(stderr)).toEqual([
      "profile broken: min-cpu — not a number, read as absent",
      "profile vague: min-ram, port — not a number, read as absent",
    ]);
    // On stderr, never on stdout: profiles_json computes the warning from an `unreadable`
    // field it then deletes, and --json has to stay the plain array the dashboard parses.
    for (const row of JSON.parse(stdout) as Profile[]) {
      expect(Object.keys(row).sort(), row.name).toEqual(KEYS);
    }
  });

  test("says absent only about what it truly read as absent", async () => {
    // The seam of the fix above, and it was wrong at first. The value and the warning were
    // decided by two predicates that did not agree: `num` was `try tonumber catch null`,
    // which reads anything jq can — a negative, a decimal, an exponent — while `unreadable`
    // selected on digits alone. Everything in the gap was announced as dropped and kept
    // anyway, which is costly in the direction that wastes an afternoon: `# devbox-min-disk: -4`
    // printed "not a number, read as absent" and then went to the provider as -4, so the
    // operator reading the warning looked for a null that was not there and stopped looking
    // at the value that was.
    //
    // One predicate now, and the property is an equivalence: warned if and only if null.
    // These four shapes are all things a hand-written header can say and none of them is a
    // count of CPUs, of gigabytes or a port number.
    const env = withProfiles({
      neg: "#!/bin/bash\n# devbox-min-disk: -4\n",
      decimal: "#!/bin/bash\n# devbox-min-cpu: 2.5\n",
      expo: "#!/bin/bash\n# devbox-min-ram: 1e3\n",
      hex: "#!/bin/bash\n# devbox-port: 0x10\n",
    });

    const { code, stderr, at } = await listing(env);

    expect(code).toBe(0);
    expect(at("neg")?.min_disk).toBeNull();
    expect(at("decimal")?.min_cpu).toBeNull();
    expect(at("expo")?.min_ram).toBeNull();
    expect(at("hex")?.port).toBeNull();
    expect(warnings(stderr).sort()).toEqual([
      "profile decimal: min-cpu — not a number, read as absent",
      "profile expo: min-ram — not a number, read as absent",
      "profile hex: port — not a number, read as absent",
      "profile neg: min-disk — not a number, read as absent",
    ]);
    // And the profiles are still listed. Being unreadable in one field is not a reason to
    // vanish from the listing — that was the original defect this whole group is about.
    for (const name of ["neg", "decimal", "expo", "hex"]) expect(at(name), name).toBeDefined();
  });

  // chmod 000 means nothing to root, and the whole point of the case is a file the process
  // may not open.
  test.skipIf(process.getuid?.() === 0)("survives a profile file it may not read", async () => {
    // A 0400 deposit owned by someone else, or a stray file dropped into the directory: awk
    // fails on every one of the eight fields, the substitutions come back empty, and the
    // profile is listed with nulls rather than taking the command down. Worth pinning
    // because the eight `$(profile_meta …)` calls sit in a jq argument list, which is
    // precisely where `set -e` does NOT fire — the survival is a property of where the
    // substitution is written, and moving it into a variable would change this outcome.
    const env = withProfiles({ locked: "#!/bin/bash\n# devbox-repo: https://example.test/l.git\n" });
    chmodSync(join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles", "locked.sh"), 0o000);

    const { code, stdout, at, names } = await listing(env);

    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(at("locked")?.repo).toBeNull();
    expect(at("locked")?.secrets).toEqual([]);
    expect(names).toContain("claude");
  });

  test("takes a value that could break the JSON as a value", async () => {
    // The header is pasted into jq with --arg, never interpolated into the program, so a
    // note carrying a quote, a backslash or a brace is escaped rather than executed. Cheap
    // to assert and the difference between a note and an injection: --arg is what makes
    // `# devbox-note: he said "run $(rm -rf /)"` a string.
    const env = withProfiles({
      quoted: '#!/bin/bash\n# devbox-note: he said "hi" \\ {"a":1} $(echo no)\n',
    });

    const { code, stdout, at } = await listing(env);

    expect(code).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(at("quoted")?.note).toBe('he said "hi" \\ {"a":1} $(echo no)');
  });
});
