import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The screens, end to end, against a core that answers but does nothing.
 *
 * These spawn the real entry point with DEVBOX_CORE pointed at tests/fixtures/core, so what
 * is under test is the whole path a command takes: argv parsed, the core spawned, its JSON
 * or its `==>` narration read back, the frame drawn, and the status left behind.
 *
 * stdout here is a pipe, which is how Ink is made to write one final frame instead of
 * animating. In real use the shim would send a pipe to the core instead — that is the
 * point of the shim — but the rendering is identical either way, and a pipe is the only
 * way to assert on it.
 */
const ENTRY = join(import.meta.dir, "..", "src", "index.tsx");
const CORE = join(import.meta.dir, "fixtures", "core");

/**
 * The profile's secrets, handed over by the environment.
 *
 * `up` on the claude profile wants two tokens, and this layer resolves them before the
 * core is spawned — so a test that did not provide them would be testing the gate rather
 * than the run. Handing them over the environment is one of the two ways the core itself
 * accepts them, and it is the way that touches no file.
 */
const TOKENS = { DEVBOX_CLAUDE_TOKEN: "sk-test", DEVBOX_GITHUB_TOKEN: "ghp-test" };

async function run(
  argv: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number; text: string }> {
  const child = Bun.spawn(["bun", ENTRY, ...argv], {
    env: { ...process.env, DEVBOX_CORE: CORE, DEVBOX_REMOTE: "", ...extra },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const strip = (text: string) => text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");
  return { code, text: strip(stdout) + strip(stderr) };
}

/** How many times a sentence was drawn — the difference between warned and nagged. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("devbox ls", () => {
  test("lists the fleet and adds up what it costs", async () => {
    const { code, text } = await run(["ls"]);
    expect(code).toBe(0);
    expect(text).toContain("devbox-aaaa1");
    expect(text).toContain("devbox-bbbb2");
    // 0.014 + 0.043, and the day that follows from it. The total is the reason this
    // screen exists: the failure mode of a tool that starts three machines is forgetting
    // the third.
    expect(text).toContain("0,057 EUR/h");
    expect(text).toContain("1,37 EUR a day");
    // The month joined the day rather than replacing it — 0,057 × 730 — and the assertion
    // above is what keeps it a joining. Same sentence devbox-core's fleet_table prints.
    expect(text).toContain("41,61 EUR a month");
  });

  test("prices each machine by the month as well as by the hour", async () => {
    const { text } = await run(["ls"]);
    expect(text).toContain("EUR/MO");
    // 0.014 × 730 and 0.043 × 730, per row. A fleet is read row by row and only added up
    // at the end, so the column is where a single expensive machine is noticed.
    expect(text).toContain("10,22");
    expect(text).toContain("31,39");
  });

  test("aligns on the widest value rather than on a fixed width", async () => {
    const { text } = await run(["ls"]);
    // The rows, and not the `ssh devbox-aaaa1` hint underneath them.
    const rows = text.split("\n").filter((line) => /^\s+devbox-\w+\s+\w/.test(line));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.indexOf("hetzner")).toBe(rows[1]?.indexOf("scaleway") ?? -1);
  });
});

describe("devbox profiles", () => {
  test("names the secrets each profile will ask for", async () => {
    const { code, text } = await run(["profiles"]);
    expect(code).toBe(0);
    expect(text).toContain("claude github");
    expect(text).toContain("4c/8G/80G");
    // `plain` declares no disk floor and is nonetheless chosen above 80 GB, so that is what
    // the TEMPLATE column shows. It used to read `2c/4G/?G`, which described the header
    // faithfully and the machine not at all.
    expect(text).toContain("2c/4G/80G");
    // A profile with no repository shows an em dash, and the column ends there: the
    // sentence that used to fill it explained an absence at the width of a repository URL.
    const plain = text.split("\n").find((line) => line.trim().startsWith("plain"));
    expect(plain?.trimEnd().endsWith("—")).toBe(true);
  });
});

describe("devbox probe", () => {
  test("prints the floors under the table, because they explain an empty one", async () => {
    const { code, text } = await run(["probe"]);
    expect(code).toBe(0);
    expect(text).toContain("cx33");
    expect(text).toContain("at least 4 vCPU, 8 GB and 80 GB");
  });

  test("says what the month is, in the block that already explains the price", async () => {
    const { text } = await run(["probe"]);
    expect(text).toContain("EUR/MO");
    expect(text).toContain("10,22");
    // The caveat, once, under the table: an interpolation printed beside three published
    // hourly prices has to say that nobody published it, and that Hetzner bills less.
    expect(text).toContain("carried over 730 h");
    expect(text).toContain("19,49 published");
    // Once, and not per row: a footnote on every line of a table read by scanning is how
    // a warning becomes something the eye learns to skip.
    expect(occurrences(text, "carried over 730 h")).toBe(1);
  });

  test("names the cloud it could not ask", async () => {
    const { text } = await run(["probe"]);
    expect(text).toContain("not asked");
    expect(text).toContain("gcp: no usable Application Default Credentials.");
  });

  test("a floor moved by a flag is the floor that gets printed", async () => {
    const { text } = await run(["probe", "--min-ram", "16"]);
    expect(text).toContain("at least 4 vCPU, 16 GB");
  });
});

describe("devbox info", () => {
  test("is the Termius form, in the order Termius asks for it", async () => {
    const { code, text } = await run(["info"]);
    expect(code).toBe(0);
    const fields = ["Address", "Port", "Username", "Key", "Fingerprint"];
    const positions = fields.map((field) => text.indexOf(field));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("heads the card with both prices, punctuated the way the core punctuates it", async () => {
    const { text } = await run(["info"]);
    expect(text).toContain("0,014 €/h, 10,22 €/mo");
  });

  test("takes the forward port from the profile rather than assuming 9010", async () => {
    const { text } = await run(["info"]);
    expect(text).toContain("http://localhost:9010");
    expect(text).toContain("16443 → localhost:6443");
  });
});

describe("devbox orphans", () => {
  test("says so plainly when the providers run nothing the state does not know", async () => {
    const { code, text } = await run(["orphans"]);
    expect(code).toBe(0);
    expect(text).toContain("no orphan");
  });
});

describe("a run that works", () => {
  test("turns each ==> into a finished phase, and keeps the warning", async () => {
    const { code, text } = await run(["up"], TOKENS);
    expect(code).toBe(0);
    expect(text).toContain("✔ profile claude");
    expect(text).toContain("✔ ordering cx33 in hel1 at 0,014 EUR/h");
    expect(text).toContain("/!\\ cx33 is out in fsn1 after all, next offer");
  });

  test("reproduces the closing summary the core printed, verbatim", async () => {
    const { text } = await run(["up"], TOKENS);
    expect(text).toContain("devbox-aaaa1 — hetzner / hel1 / cx33 — 0,014 €/h");
  });
});

describe("a run that fails", () => {
  test("leaves non-zero and keeps the output the verdict refers to", async () => {
    const { code, text } = await run(["seed", "devbox-aaaa1"], TOKENS);
    expect(code).toBe(1);
    expect(text).toContain("every creatable offer refused the order");
    // `hz_up` says "see above" about exactly this line, so hiding it would cut the
    // sentence off from its evidence.
    expect(text).toContain("Error: resource_unavailable");
  });
});

describe("devbox down", () => {
  test("refuses to destroy anything when there is no terminal to confirm on", async () => {
    const { code, text } = await run(["down", "devbox-aaaa1"]);
    expect(code).toBe(1);
    expect(text).toContain("no terminal to confirm on");
    expect(text).toContain("devbox down devbox-aaaa1 --yes");
    // The core was never spawned: nothing said it destroyed anything.
    expect(text).not.toContain("Meter stopped");
  });

  test("--yes is this layer's flag and never reaches the core", async () => {
    const { code, text } = await run(["down", "devbox-aaaa1", "--yes"]);
    expect(code).toBe(0);
    expect(text).toContain("devbox-aaaa1 destroyed");
    expect(text).not.toContain("unknown command");
  });

  // With several machines and no name the core refuses rather than guess. Confirming
  // first would be asking about a machine nobody named.
  test("does not confirm what the core is about to refuse to guess", async () => {
    const { code, text } = await run(["down"]);
    expect(code).toBe(1);
    expect(text).toContain("several machines — name one");
    expect(text).not.toContain("no terminal to confirm on");
  });
});

describe("a dashboard whose token nothing holds", () => {
  test("is refused in front of every screen, ls included", async () => {
    const { code, text } = await run(["ls"], { DEVBOX_REMOTE: "https://devbox.example" });
    expect(code).toBe(1);
    expect(text).toContain("needs a token and there is no terminal to ask on");
    expect(text).toContain("DEVBOX_REMOTE_TOKEN=…");
    // And the way back to the local state is named, because there is no silent fallback
    // to it on purpose.
    expect(text).toContain("DEVBOX_REMOTE= devbox");
  });

  test("but a token in the environment answers it without asking", async () => {
    const { code, text } = await run(["ls"], {
      DEVBOX_REMOTE: "https://devbox.example",
      DEVBOX_REMOTE_TOKEN: "tok-test",
    });
    expect(code).toBe(0);
    expect(text).toContain("fleet held by https://devbox.example");
  });
});

/**
 * The version gate's warning, which is worth nothing if nobody sees it.
 *
 * The gate exists because a fixed devbox-core and a stale copy on the dashboard are two
 * files, and a warning that never reaches the terminal renders exactly like agreement —
 * the failure it was written to remove. So the thing under test here is visibility, on
 * both kinds of screen: the JSON ones, where the core's stderr used to be discarded, and
 * the streamed ones, where Run.tsx has always read it.
 */
describe("what the core warned about while a screen read it", () => {
  test("shows a core warning on a JSON screen", async () => {
    const { code, text } = await run(["ls"]);
    // A warning is not a failure: the gate never kills a command that would have worked.
    expect(code).toBe(0);
    // Both fingerprints, because "they differ" without saying which is which leaves the
    // reader unable to tell whether it is the Mac or the dashboard that is behind.
    expect(text).toContain("7e2a1c9");
    expect(text).toContain("1108254");
    // And the way out of the mismatch, spelled out. This is the assertion that would
    // have caught the morning that was lost to it. Read with its line breaks folded: a pipe
    // is 80 columns to Ink, the sentence is longer, and where the frame wraps it is not the
    // thing under test — that every word of it reached the screen is.
    expect(text.replace(/\s+/g, " ")).toContain(
      "redeploy the dashboard (cd dashboard && bun run verify first)",
    );
    // The screen still drew: the warning is an annotation on the fleet, not a substitute
    // for it.
    expect(text).toContain("devbox-aaaa1");
  });

  test("renders a streamed warning exactly once", async () => {
    const { text } = await run(["up"], TOKENS);
    // Collection happens in coreJson and never in coreStream, so Run.tsx stays the only
    // renderer of a warning that arrived on a stream. Were the store fed from both ends,
    // this sentence would be drawn one extra time — by the Notices box, above the run —
    // while the phases around it were drawn as often as before.
    //
    // Which is why it is counted against a neighbouring phase and not against the literal
    // 1: stdout is a pipe here, Ink cannot erase what it has already written, and its
    // <Static> block therefore lands whole on the way out, so every finished phase of
    // this run appears twice in the capture. That is the harness and not the screen. The
    // invariant the gate depends on survives it intact — the warning is written exactly
    // as often as the phases it sits between, and never once more.
    const warned = occurrences(text, "/!\\ cx33 is out in fsn1 after all, next offer");
    const stepped = occurrences(text, "✔ ordering cx33 in hel1 at 0,014 EUR/h");
    expect(warned).toBeGreaterThan(0);
    expect(warned).toBe(stepped);
  });
});

describe("a verb this layer has never heard of", () => {
  test("is handed to the core, which owns the error message", async () => {
    const { code, text } = await run(["wat"]);
    expect(code).toBe(1);
    expect(text).toContain("unknown command: wat");
  });
});

describe("devbox with nothing after it", () => {
  test("names the ten verbs and points at the long version", async () => {
    const { code, text } = await run([]);
    expect(code).toBe(0);
    for (const verb of ["up", "seed", "info", "ls", "profiles", "probe", "orphans", "tunnel", "sync", "down"]) {
      expect(text).toContain(verb);
    }
    expect(text).toContain("devbox help --full");
  });
});
