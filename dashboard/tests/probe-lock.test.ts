import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, DEVBOX } from "../src/config";
import { database } from "../src/db";
import { probe } from "../src/engine";
import { sourcesOf, type Sources } from "../src/secrets";
import { accountTree } from "../src/tree";

/**
 * One probe at a time, and an identical one joined rather than run twice.
 *
 * This is the guard that stopped step 2 of the creation wizard from being able to take the
 * whole site down. Measured on the live dashboard on 31/08: four concurrent probes all
 * answered 200 in 4,5 to 5,0 s, and EIGHT answered 502 in 4,15 s - every one of them, plus
 * `/login`, until systemd restarted the unit five seconds later. Each probe hands jq the
 * 5,7 MB price catalogue and jq holds about six times what a file weighs; the unit had
 * 256 MB then. There is no gentle slope between the two - see src/engine.ts for where the
 * ceiling stands now and why that is headroom rather than a measurement.
 *
 * The engine is diverted to a script that records when it starts and when it stops, so
 * what these assert is the thing that actually matters - how many devbox processes were
 * alive at the same moment - and not the shape of a promise.
 */

const LOG = `${DEVBOX}.runs`;

/**
 * A devbox that takes its time.
 *
 * The sleep is not padding: without it two "concurrent" calls would each finish before the
 * next began, the overlap would be unobservable, and a test that cannot fail is not one.
 */
function fakeEngine(): void {
  mkdirSync(join(DEVBOX, ".."), { recursive: true });
  writeFileSync(
    DEVBOX,
    [
      "#!/usr/bin/env bash",
      `echo "start $*" >> ${JSON.stringify(LOG)}`,
      "sleep 0.3",
      `echo "stop $*" >> ${JSON.stringify(LOG)}`,
      "printf '[]'",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(LOG, "");
}

/** The most instances that were ever alive at the same moment. */
function peak(): number {
  let live = 0;
  let most = 0;
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    if (line.startsWith("start")) most = Math.max(most, ++live);
    if (line.startsWith("stop")) live--;
  }
  return most;
}

function starts(): number {
  return readFileSync(LOG, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("start")).length;
}

beforeEach(fakeEngine);

/**
 * Every probe below names its cloud. Asked for none, the probe asks the clouds whose
 * credentials resolve - and this process holds none, so it would answer without spawning
 * anything, which is right and would make every count here zero.
 */
const CLOUD = "hetzner";

/**
 * Whose probe it is. A Sources per account, because the join below is keyed by the account as
 * well as by the query: two accounts asking the same floors are asking with two sets of
 * credentials, and one answer for both would hand the second the first one's offers.
 */
const asking = (owner: number): Sources =>
  sourcesOf({
    db: database,
    owner,
    keyring: null,
    env: {},
    secretsDir: join(DATA_DIR, "probe-lock-secrets"),
  });

const A = asking(1);
const B = asking(2);

/**
 * Each account's own tree, since a probe runs devbox in one: prepareLaunch refuses a launch
 * whose Sources and whose tree name two different accounts, which is the pairing this file
 * would otherwise be the first to write by accident.
 */
const TREE_A = accountTree(1);
const TREE_B = accountTree(2);

describe("probes are serialised", () => {
  test("eight distinct queries at once run one at a time, and all eight answer", async () => {
    // Eight DIFFERENT floors, so none of them can be joined: this measures the queue, and
    // the sharing is measured below.
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => probe(TREE_A, { disk: 80 * (i + 1), cloud: CLOUD }, A)),
    );

    expect(answers).toHaveLength(8);
    for (const answer of answers) expect(answer.offers).toEqual([]);
    expect(starts()).toBe(8);
    // The whole point. Eight was the number that answered 502 in production.
    expect(peak()).toBe(1);
  }, 30_000);

  test("the same query in flight is joined, not spawned a second time", async () => {
    const [a, b, c] = await Promise.all([
      probe(TREE_A, { disk: 320, cloud: CLOUD }, A),
      probe(TREE_A, { disk: 320, cloud: CLOUD }, A),
      probe(TREE_A, { disk: 320, cloud: CLOUD }, A),
    ]);

    // The same object, not merely an equal one: they were handed one answer, not three.
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(starts()).toBe(1);
  }, 30_000);

  test("the same query from two accounts is asked twice, never joined", async () => {
    // The join is a saving between one account's own requests. Across accounts it would be a
    // leak: B would be handed offers computed with A's tokens, and told which clouds A can
    // order from. The queue is still shared - it bounds the memory of one process.
    const [a, b] = await Promise.all([
      probe(TREE_A, { disk: 480, cloud: CLOUD }, A),
      probe(TREE_B, { disk: 480, cloud: CLOUD }, B),
    ]);
    expect(a).not.toBe(b);
    expect(starts()).toBe(2);
    expect(peak()).toBe(1);
  }, 30_000);

  test("with no cloud to ask, asks none - rather than `--cloud \"\"`, which means all three", async () => {
    // devbox-core reads an empty list as every cloud it implements, so a service holding no
    // credential would have spent ten seconds failing three authentications.
    const answer = await probe(TREE_A, { disk: 640 }, A);
    expect(starts()).toBe(0);
    expect(answer.offers).toEqual([]);
    expect(answer.skipped).toEqual([
      "hetzner: no credential set in this service",
      "scaleway: no credential set in this service",
      "gcp: no credential set in this service",
    ]);
  });

  test("a query that failed does not poison the ones queued behind it", async () => {
    // The tail must swallow a rejection. Chained naively, one probe that threw would take
    // every probe after it with it - and the caller of the failure still has to see it.
    writeFileSync(DEVBOX, "#!/usr/bin/env bash\nexit 3\n", { mode: 0o755 });
    await expect(probe(TREE_A, { disk: 80, cloud: CLOUD }, A)).rejects.toThrow();

    fakeEngine();
    const after = await probe(TREE_A, { disk: 160, cloud: CLOUD }, A);
    expect(after.offers).toEqual([]);
  }, 30_000);
});
