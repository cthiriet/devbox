import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, runCore, sandbox, verdict } from "./harness.ts";

/**
 * One `terraform init` at a time, per plugin cache.
 *
 * The dashboard runs several jobs at once and points every one of them at a single
 * TF_PLUGIN_CACHE_DIR. Terraform's cache is not safe for two concurrent inits
 * (hashicorp/terraform#32028, #31964): two processes unpacking the same provider into it
 * corrupt each other. devbox-core serialises the init, and only the init.
 *
 * Proven with the real file, not by reading it. `up --cloud hetzner` is driven all the way
 * to its init by a curl that answers the Hetzner API with one creatable offer, and a
 * terraform whose init writes `start` and `end` lines, two seconds apart, into one
 * append-only file shared by every run. Its apply refuses, so each `up` dies at the line
 * after the init, having ordered nothing. Two runs launched together overlap by a wide
 * margin if nothing holds them apart: the intervals are what is asserted.
 */

type Env = Record<string, string>;

const NO_JQ = Bun.which("jq") === null;
const NO_PERL = Bun.which("perl") === null;

const INIT_SECONDS = 2;

/** One creatable x86 offer, so hz_up reaches its init. */
const SERVER_TYPES = JSON.stringify({
  server_types: [
    {
      id: 1,
      name: "cx33",
      architecture: "x86",
      deprecated: false,
      deprecation: null,
      cores: 4,
      memory: 8,
      disk: 80,
      cpu_type: "shared",
      locations: [{ name: "fsn1", available: true }],
      prices: [{ location: "fsn1", price_hourly: { gross: "0.0100" } }],
    },
  ],
});

function stub(env: Env, name: string, body: string): void {
  const bin = join(env["HOME"] ?? "", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), ["#!/usr/bin/env bash", body, ""].join("\n"), { mode: 0o755 });
}

/**
 * A sandbox that `up` walks to its apply: the Hetzner API answered, a key already there so
 * nothing is generated, nc and ssh-keyscan present for `need`, and a terraform whose init
 * takes INIT_SECONDS and says when it started and ended.
 */
function hetzner(events: string, extra: Env = {}): Env {
  const env = sandbox();
  const home = env["HOME"] ?? "";
  writeFileSync(join(home, ".ssh", "devbox"), "not a key\n", { mode: 0o600 });
  writeFileSync(join(home, ".ssh", "devbox.pub"), "ssh-ed25519 AAAA devbox\n");
  stub(
    env,
    "curl",
    [
      "prev=; fmt=; url=; config=0",
      'for a in "$@"; do',
      '  case "$prev" in -K) [ "$a" = - ] && config=1 ;; -w) fmt=$a ;; esac',
      '  case "$a" in http://*|https://*) url=$a ;; esac',
      "  prev=$a",
      "done",
      // The header arrives on stdin; left unread, the core's printf could meet a closed pipe.
      '[ "$config" = 1 ] && cat >/dev/null',
      "answer() { if [ -n \"$fmt\" ]; then printf '%s\\n%s' \"$1\" 200; else printf '%s' \"$1\"; fi; }",
      "case $url in",
      `  https://api.hetzner.cloud/v1/server_types*) answer '${SERVER_TYPES}' ;;`,
      `  https://api.hetzner.cloud/v1/pricing*)      answer '{"pricing":{"primary_ips":[]}}' ;;`,
      `  https://api.hetzner.cloud/v1/datacenters*)  answer '{"datacenters":[]}' ;;`,
      "  *) exit 7 ;;",
      "esac",
    ].join("\n"),
  );
  stub(env, "nc", "exit 1");
  stub(env, "ssh-keyscan", "exit 0");
  const now = `perl -MTime::HiRes=time -e 'printf "%.3f", time'`;
  stub(
    env,
    "terraform",
    [
      `printf '%s\\n' "$*" >> ${JSON.stringify(join(home, "bin", "terraform.log"))}`,
      'case " $* " in',
      '  *" init "*)',
      `    printf 'start %s %s\\n' "$TF_WORKSPACE" "$(${now})" >> ${JSON.stringify(events)}`,
      `    sleep ${INIT_SECONDS}`,
      `    printf 'end %s %s\\n' "$TF_WORKSPACE" "$(${now})" >> ${JSON.stringify(events)}`,
      '    [ -n "${FAKE_INIT_FAILS:-}" ] && { echo "fake init failed" >&2; exit 1; }',
      "    exit 0 ;;",
      '  *" apply "*) echo "fake apply refused" >&2; exit 1 ;;',
      "esac",
      "exit 0",
    ].join("\n"),
  );
  return {
    ...env,
    PATH: `${join(home, "bin")}:${process.env["PATH"] ?? ""}`,
    DEVBOX_REMOTE: "",
    HCLOUD_TOKEN: "hc-fake-token",
    DEVBOX_HETZNER_LOCATIONS: "fsn1",
    ...extra,
  };
}

type Interval = { name: string; start: number; end: number };

/**
 * The init intervals, read back in the order they were written. Lines are appended by
 * processes that ran concurrently, so the file's order IS the order of the events: two
 * inits that did not overlap read start, end, start, end.
 */
function intervals(events: string): { order: string[]; spans: Interval[] } {
  const lines = readFileSync(events, "utf8").trim().split("\n");
  const order = lines.map((line) => line.split(" ").slice(0, 2).join(" "));
  const spans = new Map<string, Interval>();
  for (const line of lines) {
    const [kind, name = "", at = "0"] = line.split(" ");
    const span = spans.get(name) ?? { name, start: NaN, end: NaN };
    if (kind === "start") span.start = Number(at);
    else span.end = Number(at);
    spans.set(name, span);
  }
  return { order, spans: [...spans.values()].sort((a, b) => a.start - b.start) };
}

function expectSerialised(events: string, names: string[]): void {
  const { order, spans } = intervals(events);
  expect(spans.map((span) => span.name).sort()).toEqual([...names].sort());
  const [first, second] = spans as [Interval, Interval];
  expect(order, readFileSync(events, "utf8")).toEqual([
    `start ${first.name}`,
    `end ${first.name}`,
    `start ${second.name}`,
    `end ${second.name}`,
  ]);
  expect(second.start).toBeGreaterThanOrEqual(first.end);
  // Each init really took its time, or "did not overlap" would say nothing.
  for (const span of spans) expect(span.end - span.start).toBeGreaterThanOrEqual(INIT_SECONDS - 0.1);
}

afterAll(cleanup);

describe.skipIf(NO_JQ || NO_PERL)("terraform init runs one at a time", () => {
  test("two `up` sharing a plugin cache, and two sharing a Terraform root", async () => {
    const scratch = sandbox();
    const cacheEvents = join(scratch["HOME"] ?? "", "cache-events");
    const rootEvents = join(scratch["HOME"] ?? "", "root-events");
    // Not created: the core has to make it. And under its own parent, so the lock can only
    // be there because TF_PLUGIN_CACHE_DIR said so.
    const cache = join(scratch["HOME"] ?? "", "plugins", "cache");

    // Pair one: separate HOMEs and separate roots, one cache. Only the cache is shared, so a
    // lock kept per HOME, as with_lock's is, or per root, would let these overlap.
    const a = hetzner(cacheEvents, { TF_PLUGIN_CACHE_DIR: cache });
    const b = hetzner(cacheEvents, { TF_PLUGIN_CACHE_DIR: cache });
    // Pair two: no cache at all, one root. Concurrent inits there write the same .terraform/.
    const sharedRoot = scratch["DEVBOX_TF_ROOT"] ?? "";
    const c = hetzner(rootEvents, { DEVBOX_TF_ROOT: sharedRoot });
    const d = hetzner(rootEvents, { DEVBOX_TF_ROOT: sharedRoot });

    const runs = await Promise.all([
      runCore(["up", "--cloud", "hetzner", "--name", "cache-a", "--profile", "claude", "--no-seed"], a),
      runCore(["up", "--cloud", "hetzner", "--name", "cache-b", "--profile", "claude", "--no-seed"], b),
      runCore(["up", "--cloud", "hetzner", "--name", "root-c", "--profile", "claude", "--no-seed"], c),
      runCore(["up", "--cloud", "hetzner", "--name", "root-d", "--profile", "claude", "--no-seed"], d),
    ]);

    // Every run went past its init to the apply, which refused: the lock let each through.
    for (const run of runs) {
      expect(run.code, run.stderr).toBe(1);
      expect(verdict(run.stderr), run.stderr).toBe(
        "apply failed for a reason that trying another machine will not fix (see above)",
      );
    }
    expectSerialised(cacheEvents, ["cache-a", "cache-b"]);
    expectSerialised(rootEvents, ["root-c", "root-d"]);

    // Released, and where it was said to be.
    expect(existsSync(cache)).toBe(true);
    expect(existsSync(join(cache, ".devbox-init.lock"))).toBe(false);
    expect(existsSync(join(sharedRoot, ".devbox-init.lock"))).toBe(false);
    // Only the init: apply is not serialised, and was reached by all four.
    for (const env of [a, b, c, d]) {
      const calls = readFileSync(join(env["HOME"] ?? "", "bin", "terraform.log"), "utf8");
      expect(calls).toMatch(/ init -input=false\n/);
      expect(calls).toMatch(/ apply -auto-approve /);
    }
  }, 60_000);

  test("a failed init still releases the lock", async () => {
    const scratch = sandbox();
    const events = join(scratch["HOME"] ?? "", "events");
    const cache = join(scratch["HOME"] ?? "", "cache");
    const failing = hetzner(events, { TF_PLUGIN_CACHE_DIR: cache, FAKE_INIT_FAILS: "1" });

    const failed = await runCore(["up", "--cloud", "hetzner", "--name", "fails", "--profile", "claude", "--no-seed"], failing);

    expect(failed.code, failed.stderr).not.toBe(0);
    expect(failed.stderr).toContain("fake init failed");
    // Died at the init: nothing was ordered.
    expect(readFileSync(join(failing["HOME"] ?? "", "bin", "terraform.log"), "utf8")).not.toContain("apply");
    expect(existsSync(join(cache, ".devbox-init.lock"))).toBe(false);

    // And the next one is not kept waiting behind it.
    const next = await runCore(
      ["up", "--cloud", "hetzner", "--name", "next", "--profile", "claude", "--no-seed"],
      hetzner(events, { TF_PLUGIN_CACHE_DIR: cache }),
    );
    expect(verdict(next.stderr), next.stderr).toBe(
      "apply failed for a reason that trying another machine will not fix (see above)",
    );
    expect(next.ms).toBeLessThan(INIT_SECONDS * 1000 + 10_000);
  }, 60_000);
});
