import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fakeMachine, fakeTerraform, runCore, sandbox, verdict, warnings } from "./harness.ts";

/**
 * No credential on a command line.
 *
 * devbox-core received its tokens in the environment, which only their owner can read, and
 * then handed every one of them to curl as `-H "Authorization: Bearer $TOKEN"` - an argument.
 * An argv is public: `ps -ww` and /proc/<pid>/cmdline show it to every account on the host,
 * and the dashboard shares its host with other sites. Found by a review on 11/09, at every
 * call that authenticates: Hetzner, Scaleway, GCP, the GitHub preflight of `seed`, and the
 * dashboard's own token at the version gate and at each API call.
 *
 * The header travels as curl configuration on stdin now (`-K -`), written by a builtin
 * printf. Two halves are asserted, because each alone passes against a broken fix: that no
 * token appears in any argv, AND that every request still carries its header - a curl
 * called with no credential at all would satisfy the first.
 *
 * The first block records what a stub curl was given, per call: its argv, NUL-separated so
 * an argument with a space stays one argument, and what it read through `-K -`. The second
 * runs the REAL curl against a local dashboard that looks at `ps` while each request is in
 * flight, which is the review's own measurement turned into a test.
 */

type Env = Record<string, string>;
type Call = { argv: string[]; config: string | null };

const NO_JQ = Bun.which("jq") === null;
const NO_PS = Bun.which("ps") === null;

/** One marker in every credential below, so a leak of any of them is one search. */
const MARK = "QZXW";

// A quote and a backslash in the first, because those are what the configuration syntax
// escapes, and an escape that went wrong would send a different token or cut it short.
const HCLOUD = `hc-${MARK}-"quoted"\\back`;
const SCW = `scw-${MARK}-secret`;
const GCP = `ya29.${MARK}-gcp`;
const DASHBOARD = `dash-${MARK}-token`;
const GITHUB = `ghp_${MARK}_github`;

/** The configuration line curl must have read for a header: `\` and `"` escaped, nothing else. */
const configFor = (header: string): string =>
  `header = "${header.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`;

/** What the fake terraform answers for the one machine the seed test describes. */
const OUTPUTS = {
  ip: { value: "203.0.113.7" },
  user: { value: "dev" },
  port: { value: 22 },
  cloud: { value: "hetzner" },
  region: { value: "fsn1" },
  instance_type: { value: "cx33" },
  hourly_eur: { value: 0.0256 },
};

/** An executable in the sandbox's own bin. */
function stub(env: Env, name: string, body: string): void {
  const bin = join(env["HOME"] ?? "", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), ["#!/usr/bin/env bash", body, ""].join("\n"), { mode: 0o755 });
}

/**
 * A `curl` that writes down each call, then answers like the API it was aimed at.
 *
 * Answers rather than fails, so each flow walks through every call site it has: a probe that
 * died on its first request would leave the second and third untested. The answers are the
 * emptiest the core accepts - no server types, no SKUs, no machine - and anything not listed
 * exits 7, curl's "could not connect", so nothing here can reach a network.
 *
 * The output honours the three shapes devbox-core asks for: `-w '\n%{http_code}'` (body, a
 * newline, the code), `-o FILE -w '%{http_code}'` (body to the file, the code alone), and no
 * -w at all (the body).
 */
function recordingCurl(env: Env): string {
  const bin = join(env["HOME"] ?? "", "bin");
  const calls = join(bin, "calls");
  mkdirSync(calls, { recursive: true });
  const region = JSON.stringify({
    quotas: [{ metric: "CPUS", limit: 100, usage: 0 }],
    zones: ["https://www.googleapis.com/compute/v1/projects/p/zones/europe-west1-b"],
  });
  stub(
    env,
    "curl",
    [
      `f=$(mktemp ${JSON.stringify(calls)}/call.XXXXXX)`,
      `printf '%s\\0' "$@" > "$f"`,
      "prev=; out=; fmt=; url=; config=0",
      'for a in "$@"; do',
      '  case "$prev" in -K) [ "$a" = - ] && config=1 ;; -o) out=$a ;; -w) fmt=$a ;; esac',
      '  case "$a" in http://*|https://*) url=$a ;; esac',
      "  prev=$a",
      "done",
      // Exactly what curl would have parsed as its configuration.
      '[ "$config" = 1 ] && cat > "$f.config"',
      "answer() {",
      '  if [ -n "$out" ]; then printf \'%s\' "$1" > "$out"; printf \'%s\' "$2"',
      '  elif [ -n "$fmt" ]; then printf \'%s\\n%s\' "$1" "$2"',
      "  else printf '%s' \"$1\"; fi",
      "}",
      "case $url in",
      `  https://api.hetzner.cloud/v1/server_types*) answer '{"server_types":[]}' 200 ;;`,
      `  https://api.hetzner.cloud/v1/pricing*)      answer '{"pricing":{"primary_ips":[]}}' 200 ;;`,
      `  https://api.hetzner.cloud/v1/datacenters*)  answer '{"datacenters":[]}' 200 ;;`,
      `  https://api.scaleway.com/*)                 answer '{"servers":{}}' 200 ;;`,
      `  https://cloudbilling.googleapis.com/*)      answer '{"skus":[]}' 200 ;;`,
      `  https://compute.googleapis.com/*/regions/*) answer '${region}' 200 ;;`,
      `  https://compute.googleapis.com/*)           answer '{"items":[]}' 200 ;;`,
      `  https://api.github.com/*)                   answer '{}' 200 ;;`,
      `  */api/version)                              answer 'not found' 404 ;;`,
      `  */api/machines)                             answer '[]' 200 ;;`,
      "  *) exit 7 ;;",
      "esac",
    ].join("\n"),
  );
  return calls;
}

/** Every call the stub recorded, in no particular order. */
function recorded(dir: string): Call[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.endsWith(".config"))
    .map((name) => {
      const config = join(dir, `${name}.config`);
      return {
        argv: readFileSync(join(dir, name), "utf8").split("\0").slice(0, -1),
        config: existsSync(config) ? readFileSync(config, "utf8") : null,
      };
    });
}

/** The URL a call was aimed at. */
const urlOf = (call: Call): string => call.argv.find((arg) => /^https?:\/\//.test(arg)) ?? "";

/**
 * The two halves, for every call whose URL starts with `prefix`: not one argument holds the
 * marker, and the configuration read on stdin is that header and nothing else.
 */
function expectCarried(calls: Call[], prefix: string, header: string): void {
  const aimed = calls.filter((call) => urlOf(call).startsWith(prefix));
  expect(aimed.length, prefix).toBeGreaterThan(0);
  for (const call of aimed) {
    expect(call.argv.join(" "), urlOf(call)).not.toContain(MARK);
    expect(call.argv.slice(0, 2), urlOf(call)).toEqual(["-K", "-"]);
    expect(call.config, urlOf(call)).toBe(configFor(header));
  }
}

/** A sandbox whose curl is the recorder, gcloud a failure, and whose PATH starts with both. */
function recording(extra: Env = {}): { env: Env; calls: string } {
  const env = sandbox();
  const calls = recordingCurl(env);
  // ADC on this workstation would mint a real token for a real project.
  stub(env, "gcloud", "exit 1");
  return {
    env: {
      ...env,
      PATH: `${join(env["HOME"] ?? "", "bin")}:${process.env["PATH"] ?? ""}`,
      DEVBOX_REMOTE: "",
      ...extra,
    },
    calls,
  };
}

afterAll(cleanup);

describe.skipIf(NO_JQ)("no credential on a command line", () => {
  test("the three probes carry their token in curl's configuration, never in its argv", async () => {
    const hetzner = recording({ HCLOUD_TOKEN: HCLOUD });
    const scaleway = recording({
      SCW_ACCESS_KEY: `SCW${MARK}ACCESS`,
      SCW_SECRET_KEY: SCW,
      SCW_DEFAULT_PROJECT_ID: "66666666-7777-8888-9999-000000000000",
      DEVBOX_SCALEWAY_ZONES: "fr-par-1",
    });
    // GCP_TOKEN in the environment is honoured before any key or gcloud is looked at, which
    // reaches every GCP call site without minting anything: the catalogue and the region
    // through gcp_api, and the machine types through the concurrent reads, in the background.
    const gcp = recording({
      GCP_TOKEN: GCP,
      DEVBOX_GCP_PROJECT: "acme-devbox-000000",
      DEVBOX_GCP_REGIONS: "europe-west1",
    });

    for (const [cloud, side] of [["hetzner", hetzner], ["scaleway", scaleway], ["gcp", gcp]] as const) {
      const run = await runCore(["probe", "--json", "--cloud", cloud], side.env);
      // Walked to the end, which is what makes "every call site" true: a probe that stopped
      // at its first request would name the cloud in `not asked:`.
      expect(run.stderr, cloud).not.toContain("not asked:");
      expect(JSON.parse(run.stdout), cloud).toEqual([]);
    }

    expectCarried(recorded(hetzner.calls), "https://api.hetzner.cloud/", `Authorization: Bearer ${HCLOUD}`);
    // server_types, pricing, and the datacenters read that is allowed to fail.
    expect(recorded(hetzner.calls)).toHaveLength(3);
    expectCarried(recorded(scaleway.calls), "https://api.scaleway.com/", `X-Auth-Token: ${SCW}`);
    expect(recorded(scaleway.calls)).toHaveLength(2);
    expectCarried(recorded(gcp.calls), "https://", `Authorization: Bearer ${GCP}`);
    expect(recorded(gcp.calls).some((call) => urlOf(call).includes("/machineTypes"))).toBe(true);
    expect(recorded(gcp.calls).some((call) => urlOf(call).includes("cloudbilling"))).toBe(true);
  }, 60_000);

  test("the dashboard token, at the version gate and at the API call after it", async () => {
    const { env, calls } = recording({
      DEVBOX_REMOTE: "http://dashboard.invalid",
      DEVBOX_REMOTE_TOKEN: DASHBOARD,
    });

    const run = await runCore(["ls", "--json"], env);

    expect(JSON.parse(run.stdout)).toEqual([]);
    expectCarried(recorded(calls), "http://dashboard.invalid/", `Authorization: Bearer ${DASHBOARD}`);
    expect(recorded(calls).map(urlOf).sort()).toEqual([
      "http://dashboard.invalid/api/machines",
      "http://dashboard.invalid/api/version",
    ]);
  });

  test("the GitHub preflight of seed", async () => {
    const { env, calls } = recording();
    // A profile that declares github: the preflight runs only for a profile that asks for the
    // token. Written the way a copy that adds a repository has to be, secret beside repo.
    const profiles = join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "private.sh"), "#!/bin/bash\n# devbox-secrets:  github\n");
    fakeMachine(env, "hetzner", "devbox-one");
    fakeTerraform(env, OUTPUTS);
    stub(env, "ssh-keyscan", "exit 0");
    // The push that follows the preflight: refused, so the seed stops there.
    stub(env, "ssh", "exit 1");
    writeFileSync(
      join(env["HOME"] ?? "", ".ssh", "config"),
      "# >>> devbox:devbox-one >>>\nHost devbox-one\n  # devbox-profile private\n# <<< devbox:devbox-one <<<\n",
      { mode: 0o600 },
    );
    writeFileSync(join(env["DEVBOX_SECRETS_DIR"] ?? "", "github"), GITHUB, { mode: 0o400 });

    await runCore(["seed", "devbox-one", "--quiet", "--repo", "https://github.com/acme/private"], env);

    expectCarried(recorded(calls), "https://api.github.com/", `Authorization: Bearer ${GITHUB}`);
    // The repository, then its pull requests: both calls, not just the first.
    expect(recorded(calls).map(urlOf).sort()).toEqual([
      "https://api.github.com/repos/acme/private",
      "https://api.github.com/repos/acme/private/pulls?per_page=1",
    ]);
  }, 30_000);

  test("a token holding a line break is refused, and never becomes curl's configuration", async () => {
    // An LF ends a configuration line, so what follows it would be read as curl options of
    // its own: here, a second URL. No escape makes that harmless, so nothing is sent.
    const { env, calls } = recording({
      HCLOUD_TOKEN: `hc-${MARK}\nurl = "http://attacker.invalid/"`,
    });

    const run = await runCore(["probe", "--json", "--cloud", "hetzner"], env);

    expect(run.stderr).toContain("HCLOUD_TOKEN holds a line break");
    expect(run.stderr).not.toContain(MARK);
    expect(recorded(calls)).toEqual([]);
  });

  test("a trailing newline is not a line break: the token goes, without it", async () => {
    // What a token file written with `echo` ends in. $(cat file) already drops it on the way
    // in; one that arrives in the environment is dropped here, rather than refused.
    const { env, calls } = recording({ HCLOUD_TOKEN: `hc-${MARK}-tail\r\n` });

    await runCore(["probe", "--json", "--cloud", "hetzner"], env);

    expectCarried(recorded(calls), "https://api.hetzner.cloud/", `Authorization: Bearer hc-${MARK}-tail`);
  });
});

/**
 * The real curl, and what `ps` shows while it waits.
 *
 * The dashboard below takes a snapshot of every process's command line - `ps -A -ww -o args=`,
 * the same on macOS and Linux - from inside its handler, so curl is alive and waiting for the
 * answer at that moment. The snapshot is also required to SHOW that curl, so the absence of
 * the token cannot pass by the snapshot having missed the process.
 */
type Seen = { path: string; authorization: string | null; ps: string };
let seen: Seen[] = [];

const dashboard = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const ps = Bun.spawn(["ps", "-A", "-ww", "-o", "args="], { stdout: "pipe", stderr: "ignore" });
    const snapshot = await new Response(ps.stdout).text();
    await ps.exited;
    seen.push({ path, authorization: request.headers.get("authorization"), ps: snapshot });
    if (path === "/api/machines") return Response.json([]);
    return new Response("not found", { status: 404 });
  },
});
dashboard.unref();
afterAll(() => dashboard.stop(true));

describe.skipIf(NO_JQ || NO_PS)("against the real curl", () => {
  test("ps never shows the token while the request is in flight, and the header arrives whole", async () => {
    seen = [];
    // A quote, a backslash and a trailing newline: the header that arrives must be the token
    // exactly, the newline dropped and nothing else touched.
    const token = `dash-${MARK}-"q"\\b\n`;

    const run = await runCore(["ls", "--json"], {
      DEVBOX_REMOTE: dashboard.url.origin,
      DEVBOX_REMOTE_TOKEN: token,
    });

    expect(run.code).toBe(0);
    expect(seen.map((one) => one.path).sort()).toEqual(["/api/machines", "/api/version"]);
    for (const one of seen) {
      expect(one.authorization, one.path).toBe(`Bearer dash-${MARK}-"q"\\b`);
      // The snapshot caught the request it was taken for...
      const lines = one.ps.split("\n");
      expect(lines.some((line) => line.includes("curl") && line.includes(one.path)), one.path).toBe(true);
      // ...and nothing on the host held the token in its argv at that moment. The lines, not
      // the snapshot: a failure prints what leaked, not the whole process table of the host.
      expect(lines.filter((line) => line.includes(MARK)), one.path).toEqual([]);
    }
  }, 30_000);

  test("a dashboard token holding a line break is refused before any request, and the gate says it could not tell", async () => {
    seen = [];
    const run = await runCore(["ls", "--json"], {
      DEVBOX_REMOTE: dashboard.url.origin,
      DEVBOX_REMOTE_TOKEN: `dash-${MARK}\nurl = "${dashboard.url.origin}/elsewhere"`,
    });

    expect(seen).toEqual([]);
    // The third state of the handshake, and not silence: silence is what agreement sounds like.
    expect(warnings(run.stderr).some((line) => line.startsWith("cannot tell what"))).toBe(true);
    expect(verdict(run.stderr)).toContain("the dashboard token holds a line break");
    expect(run.stderr).not.toContain(MARK);
    expect(run.code).toBe(1);
  }, 30_000);
});
