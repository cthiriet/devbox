import { afterAll, describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanup, pathWithout, runCore, sandbox } from "./harness.ts";

/**
 * The GCP credential, on the road that has no browser at the end of it.
 *
 * devbox authenticated to GCP through `gcloud auth application-default print-access-token`
 * and through nothing else, which is a fine credential for a person at a desk and an
 * impossible one for a systemd unit: the refresh is interactive and opens a browser. That
 * is the whole reason CLOUDS in the dashboard's config.ts named two clouds and not three.
 *
 * So devbox-core learned to mint its own token from a service account key — a signed JWT
 * posted to Google's token endpoint — and THAT is what these tests exercise. The fake below
 * is a real RS256 verifier on localhost, so the signature, the claim set and the grant type
 * are all checked for real, with no Google account and no network anywhere.
 *
 * It is reached through a `curl` first in PATH that sends Google's address to it, and no
 * longer through the key. The endpoint used to be read from the key's token_uri, which is
 * what let these tests point it here — and what let any key point it anywhere, the server's
 * own network included. Since 11/09 devbox-core posts to https://oauth2.googleapis.com/token
 * and refuses a key that names another, so the redirection lives where no key can reach it.
 *
 * gcloud is removed from the PATH in every test here, and that is an assertion rather than
 * hygiene: the point of this path is that the server does not need it installed.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

/**
 * Google's token endpoint, told the truth back.
 *
 * It answers 400 on purpose, and what it puts in error_description is what it OBSERVED —
 * whether the signature verifies against the public half, what algorithm the header
 * claimed, what the claim set asked for. devbox prints the first line of a refusal in its
 * `not asked:` block, so the assertion below reads the verdict of a real verification
 * rather than a hope that one happened.
 *
 * 400 rather than a token: answering 200 would send the probe on to
 * compute.googleapis.com, and a test suite that reaches Google over the network is one
 * that fails on a train.
 */
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const form = new URLSearchParams(await request.text());
    const assertion = form.get("assertion") ?? "";
    const [header, claims, signature] = assertion.split(".");
    let seen: string;
    try {
      const ok = createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(publicKey, Buffer.from(signature ?? "", "base64url"));
      const head = JSON.parse(Buffer.from(header ?? "", "base64url").toString());
      const claim = JSON.parse(Buffer.from(claims ?? "", "base64url").toString());
      seen = [
        `grant=${form.get("grant_type")}`,
        `alg=${head.alg}`,
        `signature=${ok ? "valid" : "INVALID"}`,
        `iss=${claim.iss}`,
        `aud=${claim.aud}`,
        `scope=${claim.scope}`,
        `ttl=${claim.exp - claim.iat}`,
      ].join(" ");
    } catch (error) {
      seen = `unreadable assertion: ${String(error)}`;
    }
    return Response.json({ error: "invalid_grant", error_description: seen }, { status: 400 });
  },
});

const TOKEN_URI = `http://localhost:${server.port}/token`;

/** The one address devbox-core posts an assertion to, whatever the key says. */
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const REAL_CURL = Bun.which("curl") ?? "/usr/bin/curl";

/** A service account key of the shape the console hands out, token_uri included. */
function keyFile(path: string, overrides: Record<string, unknown> = {}): string {
  writeFileSync(
    path,
    JSON.stringify({
      type: "service_account",
      project_id: "acme-devbox-000000",
      client_email: "devbox-dashboard@acme-devbox-000000.iam.gserviceaccount.com",
      private_key: PEM,
      token_uri: GOOGLE_TOKEN,
      universe_domain: "googleapis.com",
      ...overrides,
    }),
    { mode: 0o600 },
  );
  return path;
}

/**
 * A `curl` first in PATH: Google's token endpoint goes to `to`, localhost goes through, and
 * every other address is refused.
 *
 * Refused, not forwarded, and that is the rail: a test in this file that reached for the
 * real Google would pass or fail on the network, and would post a signed assertion there.
 * Localhost goes through so that a key naming a local trap would REALLY reach it if the core
 * ever followed a key again — the refusal test below is only worth something if the old
 * behaviour would fail it. Every argv is written down beside it.
 */
function tokenCurl(env: Record<string, string>, to: string): string {
  const bin = join(env["HOME"] ?? "", "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "curl.log");
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      "args=()",
      'for a in "$@"; do',
      "  case $a in",
      `    ${GOOGLE_TOKEN}) args+=(${JSON.stringify(to)}) ;;`,
      '    http://localhost:*|http://127.0.0.1:*) args+=("$a") ;;',
      '    http://*|https://*) echo "curl stub: $a is not reachable from a test" >&2; exit 7 ;;',
      '    *) args+=("$a") ;;',
      "  esac",
      "done",
      `exec ${JSON.stringify(REAL_CURL)} "\${args[@]}"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return log;
}

/**
 * A sandbox with no gcloud anywhere in its PATH, which is the server's situation, and the
 * curl above in front of everything else.
 *
 * DEVBOX_GCP_PROJECT is set here and nowhere else, because devbox-core carries no default
 * for it: a project is an account, and the file that shipped one shipped the author's. Every
 * test below is about what happens AFTER the project is known, so they all say the same
 * fictional one — and the refusal that comes when it is absent gets its own test rather than
 * being seven identical failures.
 */
function withoutGcloud(to = TOKEN_URI): Record<string, string> {
  const env: Record<string, string> = { ...sandbox(), DEVBOX_GCP_PROJECT: "acme-devbox-000000" };
  tokenCurl(env, to);
  return { ...env, PATH: `${join(env["HOME"] ?? "", "bin")}:${pathWithout("gcloud")}` };
}

/** What a stub wrote down, or nothing when it was never run. */
const called = (log: string): string => (existsSync(log) ? readFileSync(log, "utf8") : "");

/** The one line devbox prints for a cloud it could not ask. */
function notAsked(stdout: string): string {
  const line = stdout.split("\n").find((candidate) => candidate.trim().startsWith("gcp:"));
  return line?.trim() ?? "";
}

afterAll(() => {
  server.stop(true);
  cleanup();
});

describe("the project is not guessed", () => {
  test("names the variable and skips the cloud, rather than picking a project", async () => {
    // devbox-core carried a default project until this repository was published — the
    // author's, which every reader would have inherited and none would have owned. A wrong
    // location costs latency; a wrong project creates an instance and a firewall rule in an
    // account that is not yours, and bills someone else for them.
    //
    // Absent, GCP behaves exactly as a cloud with no credentials does: named in `not asked:`
    // and skipped, never fatal, because one unconfigured provider must not hide another's
    // offers. A key is planted first, so what is asserted is the project and not the token.
    //
    // The variable is named on the FIRST line because that is the only one that survives:
    // the skipped-cloud line is `head -1` of what the refusal printed.
    const env: Record<string, string> = { ...withoutGcloud(), DEVBOX_GCP_PROJECT: "" };
    keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"));

    const run = await runCore(["probe", "--cloud", "gcp"], env);

    expect(notAsked(run.stdout)).toContain("no GCP project");
    expect(notAsked(run.stdout)).toContain("DEVBOX_GCP_PROJECT");
    expect(run.code).toBe(0);
  });
});

describe("a service account key replaces the browser login", () => {
  test("the key under DEVBOX_SECRETS_DIR is found, signed with, and gcloud never needed", async () => {
    const env = withoutGcloud();
    keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"));

    const run = await runCore(["probe", "--cloud", "gcp"], env);
    const line = notAsked(run.stdout);

    // Everything the endpoint verified, in one line. `signature=valid` is the assertion
    // that matters: it means openssl signed the exact bytes the JWT declares, which is the
    // half of this that no amount of reading the code proves.
    expect(line).toContain("signature=valid");
    expect(line).not.toContain("INVALID");
    expect(line).toContain("alg=RS256");
    expect(line).toContain("grant=urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(line).toContain("iss=devbox-dashboard@acme-devbox-000000.iam.gserviceaccount.com");
    // Google's address, although the request was answered here: the audience is the
    // endpoint devbox-core meant to reach, and that is no longer anything a key decides.
    expect(line).toContain(`aud=${GOOGLE_TOKEN}`);
    expect(line).toContain("scope=https://www.googleapis.com/auth/cloud-platform");
    // An hour, which is the longest Google mints anyway; a longer one is refused outright.
    expect(line).toContain("ttl=3600");

    // The probe did not fall through to the interactive road, which is the whole point.
    expect(run.stdout).not.toContain("gcloud auth application-default");
    expect(run.stdout).not.toContain("gcloud is required");
  });

  test("GOOGLE_APPLICATION_CREDENTIALS names the key, and wins over the secrets directory", async () => {
    const env = withoutGcloud();
    // A decoy in the usual place, so the assertion below can only be satisfied by the
    // variable having been read first: the two keys differ by their client_email alone.
    keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"), { client_email: "decoy@example.com" });
    const named = keyFile(join(env["HOME"] ?? "", "named.json"));

    const run = await runCore(["probe", "--cloud", "gcp"], {
      ...env,
      GOOGLE_APPLICATION_CREDENTIALS: named,
    });

    expect(notAsked(run.stdout)).toContain("iss=devbox-dashboard@");
    expect(notAsked(run.stdout)).not.toContain("decoy@example.com");
  });

  test("a JSON that is not a key is named as such, rather than failing at the signature", async () => {
    const env = withoutGcloud();
    writeFileSync(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"), '{"installed":{"client_id":"x"}}');

    const run = await runCore(["probe", "--cloud", "gcp"], env);

    // The OAuth client JSON the console offers two buttons away from the key. It is the
    // mistake this message exists for, and "openssl would not sign" would not have named it.
    expect(notAsked(run.stdout)).toContain("no client_email");
  });

  test("with no key and no gcloud, the refusal names both roads", async () => {
    const env = withoutGcloud();

    // `probe` keeps the first line of a refusal and no more — one unconfigured cloud may
    // not push another's offers off the screen — so the advice is read where a person
    // actually meets it, on the verb that was going to order a machine.
    const probe = await runCore(["probe", "--cloud", "gcp"], env);
    expect(notAsked(probe.stdout)).toBe("gcp: no GCP credential here.");

    const up = await runCore(["up", "--cloud", "gcp", "--profile", "claude"], { ...env, DEVBOX_REMOTE: "" });

    // `need gcloud` used to be the whole of this, and its sentence — "gcloud is required
    // and not in PATH" — told a server operator to install a browser-driven SDK. The
    // refusal has to carry the road that actually exists there, and name where the key is
    // read from once it is posed.
    expect(up.stderr).toContain("no GCP credential here");
    expect(up.stderr).toContain("gcloud auth application-default login");
    expect(up.stderr).toContain("install -m 600 <key>.json");
    expect(up.stderr).toContain(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"));
    expect(up.stderr).toContain("GOOGLE_APPLICATION_CREDENTIALS");
  });
});

/**
 * The Linux argument ceiling, reproduced on a Mac.
 *
 * Linux caps ONE argument at 128 KB — MAX_ARG_STRLEN, thirty-two pages, unrelated to
 * ARG_MAX and not raisable — and macOS does not. So a JSON blob handed to `jq --arg` works
 * on this desk for as long as it stays small and fails on the server the day it grows.
 *
 * That is not a hypothesis. It cost three separate failures on 31/08, the day the dashboard
 * first offered GCP, and each one was found in production because nothing here could see
 * it: the machine-type accumulator died at once, then `table_json` died as soon as the
 * price catalogue was complete — 286 offers passed, 1750 did not — and both had run for
 * days on the workstation.
 *
 * So the ceiling is brought here instead. `jq` is wrapped in a stub that refuses an
 * oversized argument exactly as Linux's execve would, the GCP probe is fed enough machine
 * types to produce more than 128 KB of rows, and the whole path from the API response to
 * the JSON of `probe --json` is walked. Everything it talks to is local: a token endpoint
 * that mints a real token, a `curl` that answers the compute API from canned JSON, and a
 * price catalogue pre-seeded into the cache devbox already reads.
 */

/** Google's token endpoint again, this time handing back a token so the probe continues. */
const minting = Bun.serve({
  port: 0,
  fetch: () => Response.json({ access_token: "test-token", expires_in: 3600 }),
});

const MINT_URI = `http://localhost:${minting.port}/token`;

/** Enough shapes that the TSV rows exceed the ceiling: ~3000 lines of ~60 bytes. */
const SHAPES = 3000;

/**
 * A `curl` that answers the compute API, sends the token exchange to the minting server,
 * and refuses everything else.
 *
 * Sends rather than answers, because the token exchange above is a REAL request to a real
 * local server, signed by openssl: stubbing it too would leave the interesting half of this
 * path untested. It used to forward every other address to the real curl, which was safe
 * while the key's token_uri pointed here; it names Google now, so only that one address is
 * rewritten, and anything else is refused rather than put on the network.
 *
 * The compute calls arrive with `-K -`, their bearer token on stdin rather than in argv, and
 * the stub drains that stdin: exiting with it unread would leave devbox-core's printf writing
 * into a closed pipe, which is a race the real curl - it reads its configuration first - never
 * runs.
 *
 * It honours `-o`, and that is not politeness. Since 31/08 the twelve zone reads run
 * CONCURRENTLY, and a background job cannot report through `die` - a `die` in a subshell
 * kills the subshell and nothing else - so each child writes its body to a file named by
 * `-o` and prints only the status code, which the foreground reads back. A stub that
 * ignored `-o` would test a calling convention devbox no longer uses.
 */
function fakeCurl(
  env: Record<string, string>,
  real: string,
  options: { zones?: string[]; refuse?: string } = {},
): void {
  const bin = join(env["HOME"] ?? "", "bin");
  mkdirSync(bin, { recursive: true });
  const zones = options.zones ?? ["europe-west1-b"];
  const machineTypes = {
    items: Array.from({ length: SHAPES }, (_, i) => ({
      name: `n1-standard-${i}`,
      guestCpus: 4,
      memoryMb: 8192,
      isSharedCpu: false,
    })),
  };
  const region = {
    quotas: [{ metric: "CPUS", limit: 1000, usage: 0 }],
    zones: zones.map((z) => `https://www.googleapis.com/compute/v1/projects/p/zones/${z}`),
  };
  writeFileSync(join(bin, "machine-types.json"), JSON.stringify(machineTypes));
  writeFileSync(join(bin, "region.json"), JSON.stringify(region));
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/usr/bin/env bash",
      "url=; out=; prev=",
      'for a in "$@"; do',
      '  case "$prev" in -o) out=$a ;; -K) [ "$a" = - ] && cat >/dev/null ;; esac',
      '  case "$a" in http*) url=$a ;; esac',
      "  prev=$a",
      "done",
      "",
      "# body <json> <code>: to -o and the code alone on stdout, or both on stdout.",
      "body() {",
      '  if [ -n "$out" ]; then printf \'%s\' "$1" > "$out"; printf \'%s\' "$2";',
      '  else printf \'%s\\n%s\' "$1" "$2"; fi',
      "}",
      "",
      "zone=${url#*/zones/}; zone=${zone%%/*}",
      "case $url in",
      "  *machineTypes*)",
      `    if [ "$zone" = ${JSON.stringify(options.refuse ?? "")} ] && [ -n ${JSON.stringify(options.refuse ?? "")} ]; then`,
      `      body '{"error":{"code":403,"message":"no quota for this zone"}}' 403`,
      "    else",
      `      body "$(cat ${JSON.stringify(join(bin, "machine-types.json"))})" 200`,
      "    fi ;;",
      `  *regions/*)     body "$(cat ${JSON.stringify(join(bin, "region.json"))})" 200 ;;`,
      // A catalogue that never ends, which is the shape of a paging run that goes wrong.
      // Only reached when no cache was seeded.
      `  *skus*)         body '{"skus":[],"nextPageToken":"encore"}' 200 ;;`,
      `  ${GOOGLE_TOKEN})`,
      "    args=()",
      `    for a in "$@"; do [ "$a" = "$url" ] && a=${JSON.stringify(MINT_URI)}; args+=("$a"); done`,
      `    exec ${JSON.stringify(real)} "\${args[@]}" ;;`,
      '  *)              echo "curl stub: $url is not reachable from a test" >&2; exit 7 ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** A `jq` that refuses an argument Linux's execve would refuse. */
function guardedJq(env: Record<string, string>, real: string): void {
  const bin = join(env["HOME"] ?? "", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "jq"),
    [
      "#!/usr/bin/env bash",
      // 131072 bytes including the terminating NUL, which is what the kernel counts.
      'for a in "$@"; do',
      '  if [ ${#a} -ge 131072 ]; then',
      '    echo "Argument list too long (${#a} bytes in one argument)" >&2',
      "    exit 7",
      "  fi",
      "done",
      `exec ${JSON.stringify(real)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** A price catalogue small enough to write and complete enough to price one family. */
function seedSkus(env: Record<string, string>): void {
  const rate = (units: string, nanos: number) => ({
    pricingInfo: [{ pricingExpression: { tieredRates: [{ unitPrice: { units, nanos } }] } }],
  });
  const skus = [
    {
      category: { usageType: "OnDemand", resourceGroup: "CPU" },
      description: "N1 Instance Core running in Belgium",
      serviceRegions: ["europe-west1"],
      ...rate("0", 20_000_000),
    },
    {
      category: { usageType: "OnDemand", resourceGroup: "RAM" },
      description: "N1 Instance Ram running in Belgium",
      serviceRegions: ["europe-west1"],
      ...rate("0", 3_000_000),
    },
    {
      category: { usageType: "OnDemand", resourceGroup: "PDStandard" },
      description: "Balanced PD Capacity in Belgium",
      serviceRegions: ["europe-west1"],
      ...rate("0", 100_000_000),
    },
  ];
  writeFileSync(
    join(env["DEVBOX_CACHE_DIR"] ?? "", "gcp-skus.jsonl"),
    `${skus.map((sku) => JSON.stringify(sku)).join("\n")}\n`,
  );
}

describe("nothing large travels as a jq argument", () => {
  test(`${SHAPES} shapes price and serialise without exceeding Linux's per-argument cap`, async () => {
    const env = withoutGcloud();
    const bin = join(env["HOME"] ?? "", "bin");
    keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"));
    seedSkus(env);
    fakeCurl(env, Bun.which("curl") ?? "/usr/bin/curl");
    guardedJq(env, Bun.which("jq") ?? "/usr/bin/jq");

    const run = await runCore(["probe", "--cloud", "gcp", "--json"], {
      ...env,
      PATH: `${bin}:${env["PATH"]}`,
      DEVBOX_GCP_REGIONS: "europe-west1",
    });

    // The stub's own sentence, which is the one the server printed twice.
    expect(run.stderr).not.toContain("Argument list too long");

    const offers = JSON.parse(run.stdout) as Array<{ cloud: string; type: string }>;
    expect(offers.length).toBe(SHAPES);
    expect(offers[0]?.cloud).toBe("gcp");

    // And the rows really were past the ceiling, so the test is not passing by being small.
    const tsv = offers.map((o) => `0.1\tgcp\t${o.type}\teurope-west1-b\t4\t8\t80\td\tu`).join("\n");
    expect(tsv.length).toBeGreaterThan(131072);
  }, 120_000);
});

describe("a short price catalogue is refused, never cached", () => {
  test("paging that will not end kills the probe instead of caching half a price list", async () => {
    const env = withoutGcloud();
    const bin = join(env["HOME"] ?? "", "bin");
    keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"));
    // No seedSkus here: the catalogue has to be fetched, and the stub never finishes it.
    fakeCurl(env, Bun.which("curl") ?? "/usr/bin/curl");

    const run = await runCore(["probe", "--cloud", "gcp"], {
      ...env,
      PATH: `${bin}:${env["PATH"]}`,
      DEVBOX_GCP_REGIONS: "europe-west1",
    });

    // What happened for real on 31/08: a run whose paging stopped early cached 17 771 SKUs
    // of 32 771, and every probe on that server reported a cheaper-looking shape than the
    // same probe on the workstation, for a day, with nothing saying so.
    expect(notAsked(run.stdout)).toContain("did not end after");
    expect(existsSync(join(env["DEVBOX_CACHE_DIR"] ?? "", "gcp-skus.jsonl"))).toBe(false);
    expect(existsSync(join(env["DEVBOX_CACHE_DIR"] ?? "", "gcp-skus.jsonl.new"))).toBe(false);
  }, 120_000);
});

describe("a zone that refuses is not swallowed by the concurrency", () => {
  test("one failing zone out of three kills the probe and names the zone", async () => {
    const env = withoutGcloud();
    const bin = join(env["HOME"] ?? "", "bin");
    keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"));
    seedSkus(env);
    fakeCurl(env, Bun.which("curl") ?? "/usr/bin/curl", {
      zones: ["europe-west1-b", "europe-west1-c", "europe-west1-d"],
      refuse: "europe-west1-c",
    });

    const run = await runCore(["probe", "--cloud", "gcp"], {
      ...env,
      PATH: `${bin}:${env["PATH"]}`,
      DEVBOX_GCP_REGIONS: "europe-west1",
    });

    // The whole hazard of reading the twelve zones at once. `die` in a background subshell
    // kills that subshell and nothing else, so a zone answering 403 would come back as a
    // zone with no machine types in it - a shorter list, silently, which is precisely how a
    // half-fetched price catalogue passed for a whole one on 31/08. The transport happens
    // in the child; the verdict is pronounced in the foreground.
    expect(notAsked(run.stdout)).toContain("europe-west1-c");
    expect(notAsked(run.stdout)).toContain("403");

    // And it did NOT quietly answer with the two zones that worked.
    expect(run.stdout).not.toContain("europe-west1-b");
  }, 120_000);
});

/**
 * The token endpoint is Google's, whatever the key says.
 *
 * A key is a file someone hands the dashboard, through a form, and the key's token_uri used
 * to be where devbox-core posted its signed assertion - then printed the first line of the
 * answer. A key naming http://169.254.169.254/ or any address inside the host's network made
 * the SERVER call it and read the reply back to whoever sent the key. On a dashboard meant to
 * take keys from more than one person, that is the first thing to close.
 *
 * The trap below is a real listener on localhost, and the curl in front lets localhost
 * through: the old core would have reached it, which is what makes `hits` worth asserting.
 */
describe("the token endpoint is Google's, whatever the key says", () => {
  test("a key naming another token_uri is refused before a single request leaves", async () => {
    let hits = 0;
    const trap = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ access_token: "harvested" });
      },
    });
    try {
      const env = withoutGcloud();
      const inside = `http://127.0.0.1:${trap.port}/computeMetadata/v1/token`;
      keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"), { token_uri: inside });

      const run = await runCore(["probe", "--cloud", "gcp"], env);
      const line = notAsked(run.stdout);

      expect(line).toContain("is refused");
      expect(line).toContain("(in token_uri)");
      expect(hits).toBe(0);
      // Not refused by the network: devbox-core never ran curl at all.
      expect(called(join(env["HOME"] ?? "", "bin", "curl.log"))).toBe("");
      // The fields are named, never their values. What a key says is attacker-written text
      // on its way to a job log, and the private half is the one thing that must not follow.
      expect(run.stdout + run.stderr).not.toContain(inside);
      expect(run.stdout + run.stderr).not.toContain("PRIVATE KEY");
    } finally {
      trap.stop(true);
    }
  });

  test("so is a key naming another universe_domain, which terraform would follow", async () => {
    // devbox-core never reads it, and exports the key to terraform once a token is minted: the
    // google provider moves every API it calls onto that domain. Refused on the same line.
    const env = withoutGcloud();
    keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"), { universe_domain: "attacker.example" });

    const run = await runCore(["probe", "--cloud", "gcp"], env);

    expect(notAsked(run.stdout)).toContain("(in universe_domain)");
    expect(run.stdout + run.stderr).not.toContain("attacker.example");
    expect(called(join(env["HOME"] ?? "", "bin", "curl.log"))).toBe("");
  });

  test("a key naming no token_uri at all is signed for Google's", async () => {
    // The other half, so the refusal cannot pass by refusing everything: an absent field is
    // not a foreign one, and older keys carry no universe_domain either.
    const env = withoutGcloud();
    keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"), {
      token_uri: undefined,
      universe_domain: undefined,
    });

    const run = await runCore(["probe", "--cloud", "gcp"], env);
    const line = notAsked(run.stdout);

    expect(line).toContain("signature=valid");
    expect(line).toContain(`aud=${GOOGLE_TOKEN}`);
    expect(called(join(env["HOME"] ?? "", "bin", "curl.log"))).toContain(GOOGLE_TOKEN);
  });
});

/**
 * The private key never lands in a file.
 *
 * The dashboard lays the key out in a directory of its own, in memory, and takes it back after
 * the job. devbox-core then copied its private half to `mktemp` - $TMPDIR, or /tmp under a
 * systemd unit, which is a disk - for as long as openssl took to sign. Found on 11/09.
 *
 * Caught in the act rather than after it: the file was removed once the signature was made,
 * so nothing is left to find when the command returns. An `openssl` first in PATH looks at
 * the moment it is asked to sign - what it was handed as a key, and every file in the sandbox
 * outside the secrets directory - then runs the real one. TMPDIR is set inside the sandbox,
 * so a file made there is one the scan sees.
 *
 * The needle is a line of the key's own body, written outside the sandbox so the scan cannot
 * find the needle itself; `-D skip` keeps grep off a FIFO, which is where bash puts a `<( )`
 * on a system without /dev/fd.
 */
describe("the private key never lands in a file", () => {
  const outside: string[] = [];
  afterAll(() => {
    for (const dir of outside) rmSync(dir, { recursive: true, force: true });
  });

  test("openssl reads it from a pipe, and no file outside the secrets directory holds it", async () => {
    const env = withoutGcloud();
    const bin = join(env["HOME"] ?? "", "bin");
    const root = dirname(env["HOME"] ?? "");
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    keyFile(join(env["DEVBOX_SECRETS_DIR"] ?? "", "gcp"));

    const needles = mkdtempSync(join(tmpdir(), "devbox-needle-"));
    outside.push(needles);
    const needle = join(needles, "needle");
    writeFileSync(needle, `${PEM.split("\n")[1] ?? ""}\n`);

    const log = join(bin, "openssl.log");
    writeFileSync(
      join(bin, "openssl"),
      [
        "#!/usr/bin/env bash",
        "prev=",
        'for a in "$@"; do',
        '  if [ "$prev" = -sign ]; then',
        '    if [ -f "$a" ]; then kind=file; else kind=stream; fi',
        `    leaks=$(grep -rlF -D skip --exclude-dir=secrets -f ${JSON.stringify(needle)} ${JSON.stringify(root)} 2>/dev/null | tr '\\n' ' ')`,
        `    printf '%s %s leaks=[%s]\\n' "$kind" "$a" "$leaks" >> ${JSON.stringify(log)}`,
        "  fi",
        "  prev=$a",
        "done",
        `exec ${JSON.stringify(Bun.which("openssl") ?? "/usr/bin/openssl")} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const run = await runCore(["probe", "--cloud", "gcp"], { ...env, TMPDIR: tmp });

    // The key really was read, and read whole: the verifier checked the signature it made.
    expect(notAsked(run.stdout)).toContain("signature=valid");

    const signed = called(log).trim().split("\n");
    expect(signed).toHaveLength(1);
    // A pipe, not a path to a copy. And at that very moment, no copy anywhere.
    expect(signed[0]).toStartWith("stream ");
    expect(signed[0]).toEndWith("leaks=[]");
  });
});
