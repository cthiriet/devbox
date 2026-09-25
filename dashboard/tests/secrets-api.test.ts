import { Database } from "bun:sqlite";
import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { privateDirectoryName } from "../src/engine";
import { newMasterKey } from "../src/vault";
import { PROVIDER_ENV, serverCommand, signIn } from "./server-harness";

/**
 * The secrets routes, through the real server.
 *
 * Everything else under tests/ exercises src/ without starting server.ts, and the logic here
 * is tested that way too - tests/secrets.test.ts. What only a running server can show is the
 * wiring: that each route is guarded like the others, that no answer carries a value, that a
 * job's argv and its log hold none, and that the master key never reaches a child. So this
 * file starts server.ts as the deployment does - `bun server.ts`, its own environment - with
 * everything pointed under .test-data, and a `devbox` that records what it was handed instead
 * of ordering anything.
 *
 * Every value planted below carries the same four letters, QZXW, which no fingerprint, id or
 * word in an answer can contain. Finding them anywhere a browser reads is the failure.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const ROOT = join(DATA_DIR, "api-test");
const SEEN = join(ROOT, "seen");
const LEGACY = join(ROOT, "legacy");
const RUNTIME = join(ROOT, "run");
/** Where the server lays launches out: its own directory inside DEVBOX_RUNTIME_DIR. */
const OWN_RUNTIME = join(RUNTIME, privateDirectoryName(join(ROOT, "data"), process.getuid?.() ?? 0));
const DASHBOARD = join(import.meta.dir, "..");

const PUBLIC_URL = "http://devbox.test";
/** The address that founds account 1 here, as DEVBOX_FOUNDER_EMAIL names it. */
const EMAIL = "founder@devbox.test";
const TOKEN = "the-bearer-token-of-this-test";
const MARK = "QZXW";

const MASTER = newMasterKey(1);
const HCLOUD_UNIT = `hc-unit-${MARK}-1111`;
const HCLOUD_PAGE = `hc-page-${MARK}-2222`;
const CLAUDE_PAGE = `sk-claude-${MARK}-3333`;
const GITHUB_FILE = `ghp-github-${MARK}-4444`;
const CANDIDATE = `hc-candidate-${MARK}-5555`;

const PROFILES = [
  { name: "claude", secrets: ["claude", "github"] },
  { name: "bare", secrets: [] },
  { name: "needy", secrets: ["never-set"] },
].map((p) => ({ path: `/engine/profiles/${p.name}.sh`, repo: null, note: null, min_cpu: null, min_ram: null, min_disk: null, port: null, ...p }));

const MACHINE = {
  name: "devbox-live",
  cloud: "hetzner",
  region: "fsn1",
  instance_type: "cx33",
  profile: "claude",
  hourly_eur: 0.01,
  ip: "203.0.113.7",
  user: "dev",
  port: 22,
  local_port: 2222,
  app_port: 3000,
};

const OFFER = {
  hourly_eur: 0.01,
  cloud: "hetzner",
  type: "cx33",
  location: "fsn1",
  cpu: 4,
  ram_gb: 8,
  disk_gb: 80,
  cpu_class: null,
  availability: "available",
};

/**
 * A devbox that answers from fixtures and writes down what it was handed: its whole
 * environment, and for a job the directory and every file in it. The values it writes go to
 * SEEN, which is this test's own fixture, and never to its stdout - which is the job's log.
 */
function fakeEngine(engine: string): void {
  mkdirSync(engine, { recursive: true });
  const q = (value: unknown) => `'${JSON.stringify(value)}'`;
  writeFileSync(
    join(engine, "devbox"),
    [
      "#!/usr/bin/env bash",
      `seen=${JSON.stringify(SEEN)}`,
      'mkdir -p "$seen"',
      'env > "$seen/env-$1-$$-$RANDOM"',
      // What a child of the same account can read back of the SERVER's initial environment,
      // which deleting a variable from process.env does not clear. Linux alone has the file.
      'if [ -e "/proc/$PPID/environ" ]; then { tr "\\0" "\\n" < "/proc/$PPID/environ" > "$seen/parent-$1-$$"; } 2>/dev/null || echo refused > "$seen/parent-$1-$$"; fi',
      'case "$1" in',
      `  profiles) printf '%s' ${q(PROFILES)} ;;`,
      `  ls) printf '%s' ${q([MACHINE])} ;;`,
      `  info) printf '%s' ${q({ ...MACHINE, fingerprint: null, note: null, kube_port: 16443 })} ;;`,
      "  probe)",
      '    printf \'%s\\n\' "$DEVBOX_CACHE_DIR" > "$seen/probe-cache-$$"',
      '    : > "$DEVBOX_CACHE_DIR/gcp-skus.jsonl"',
      `    if [ "\${HCLOUD_TOKEN:-}" = ${JSON.stringify(CANDIDATE)} ]; then printf '%s' ${q([OFFER, OFFER])};`,
      // A provider that repeats what it was sent, which is what the redaction is for.
      `    else printf '[]'; printf 'not asked:\\n  hetzner: Hetzner API answered 401: token %s is invalid\\n' "\${HCLOUD_TOKEN:-}" >&2; fi ;;`,
      "  up|seed|down)",
      '    printf \'%s\\n\' "$DEVBOX_SECRETS_DIR" > "$seen/$1-dir"',
      '    for f in "$DEVBOX_SECRETS_DIR"/*; do [ -f "$f" ] && printf \'%s=%s\\n\' "${f##*/}" "$(cat "$f")"; done > "$seen/$1-secrets"',
      '    printf \'%s\' "${HCLOUD_TOKEN:-}" > "$seen/$1-hcloud"',
      '    echo "done $1" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

type Server = { child: Subprocess; base: string; out: { stdout: string; stderr: string } };

/** Everything a stream says, as it says it: startup warnings are read while the server runs. */
function collect(stream: ReadableStream<Uint8Array>, into: { text: string }): void {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      into.text += decoder.decode(value, { stream: true });
    }
  })();
}

/**
 * server.ts, as the unit starts it - or, given `hot`, as `bun run dev` does: `bun --hot` on an
 * entry file of the test's own that imports it, so that touching the entry reloads the whole
 * graph without editing a file of the repository.
 */
async function startServer(extra: Record<string, string>, options: { hot?: string } = {}): Promise<Server> {
  const data = join(ROOT, "data");
  fakeEngine(join(ROOT, "engine"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: join(ROOT, "home"),
    NODE_ENV: "test",
    PORT: "0",
    DATA_DIR: data,
    ENGINE_DIR: join(ROOT, "engine"),
    SHELL_DIR: join(ROOT, "shell"),
    PUBLIC_DIR: join(ROOT, "public"),
    PUBLIC_URL,
    ...PROVIDER_ENV,
    DEVBOX_FOUNDER_EMAIL: EMAIL,
    DEVBOX_REMOTE_TOKEN: TOKEN,
    DEVBOX_SECRETS_DIR: LEGACY,
    DEVBOX_RUNTIME_DIR: RUNTIME,
    DEVBOX_KEY: join(ROOT, "home", "devbox"),
    HCLOUD_TOKEN: HCLOUD_UNIT,
    ...extra,
  };
  const argv = options.hot === undefined ? ["server.ts"] : ["--hot", options.hot];
  const child = Bun.spawn(serverCommand(argv), {
    cwd: DASHBOARD,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = { text: "" };
  const stderr = { text: "" };
  collect(child.stdout as ReadableStream<Uint8Array>, stdout);
  collect(child.stderr as ReadableStream<Uint8Array>, stderr);

  for (let i = 0; i < 300; i += 1) {
    const found = /devbox on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout.text);
    if (found !== null) {
      return {
        child,
        base: `http://127.0.0.1:${found[1]}`,
        out: {
          get stdout() {
            return stdout.text;
          },
          get stderr() {
            return stderr.text;
          },
        },
      };
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(50);
  }
  child.kill();
  throw new Error(`server.ts never said its port:\n${stdout.text}\n${stderr.text}`);
}

async function stopServer(server: Server | null): Promise<void> {
  if (server === null) return;
  server.child.kill();
  await server.child.exited;
}

/**
 * A session, as the page opens one: a Google sign-in as EMAIL, the cookie, and the token the page
 * reads from /api/session.
 *
 * The FIRST one on a fresh data directory founds account 1 - EMAIL is DEVBOX_FOUNDER_EMAIL - and
 * adopts DEVBOX_REMOTE_TOKEN as its token. Every beforeAll below signs in before anything presents
 * that token, because until the founding it answers 503.
 */
async function login(base: string): Promise<{ cookie: string; csrf: string }> {
  // A Workspace account's address (`hd`): Google vouches for it, so it may found account 1.
  const signed = await signIn(base, "google", { sub: "google-founder", email: EMAIL, hd: "devbox.test" });
  expect(signed.account).toMatchObject({ id: 1 });
  return { cookie: signed.cookie, csrf: signed.csrf };
}

/**
 * A JSON write as the page makes it, for a describe that has no `fromPage` of its own. The
 * secrets' writes refuse the CLI token, so a test that writes one needs a session.
 */
async function pageWrite(base: string, path: string, method: string, value?: unknown): Promise<Call> {
  const { cookie, csrf } = await login(base);
  return call(base, path, {
    method,
    headers: { Cookie: cookie, Origin: PUBLIC_URL, "X-CSRF": csrf, "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

type Call = { status: number; text: string; body: Record<string, unknown> };

async function call(base: string, path: string, init: RequestInit): Promise<Call> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Left empty: a test that wanted JSON says so on `status` or `body`.
  }
  return { status: response.status, text, body };
}

const bearer = { Authorization: `Bearer ${TOKEN}` };

/** Every file of SEEN whose name starts with `prefix`, concatenated. */
function seen(prefix: string): string {
  if (!existsSync(SEEN)) return "";
  return readdirSync(SEEN)
    .filter((name) => name.startsWith(prefix))
    .map((name) => readFileSync(join(SEEN, name), "utf8"))
    .join("\n");
}

async function settled(base: string, id: number): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i += 1) {
    const job = await call(base, `/api/jobs/${id}`, { headers: bearer });
    if (job.body.state !== "running") return job.body;
    await Bun.sleep(25);
  }
  throw new Error(`job ${id} never finished`);
}

/** How many events the vault has recorded, read straight from the server's database file. */
function events(): number {
  const db = new Database(join(ROOT, "data", "devbox.db"), { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM secret_events").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

mkdirSync(LEGACY, { recursive: true });
writeFileSync(join(LEGACY, "github"), GITHUB_FILE);

// The machine the fake `ls` lists, as a workspace of account 1's state. The routes that act on
// one machine - info, seed, destroy, the terminal - ask the account's own tree whether it holds
// that name before anything else, so a fixture fleet with no state behind it would be a 404.
mkdirSync(join(ROOT, "data", "accounts", "1", "tf", "hetzner", "terraform.tfstate.d", MACHINE.name), {
  recursive: true,
});

describe("a service with its master key", () => {
  let server: Server | null = null;
  let base = "";
  let session = { cookie: "", csrf: "" };

  beforeAll(async () => {
    server = await startServer({ DEVBOX_MASTER_KEY: MASTER });
    base = server.base;
    session = await login(base);
  }, 30_000);

  afterAll(() => stopServer(server));

  /** A write from the page: session cookie, our Origin, and - unless told otherwise - the token. */
  const fromPage = (method: string, body?: unknown, options: { csrf?: boolean; origin?: string } = {}): RequestInit => ({
    method,
    headers: {
      Cookie: session.cookie,
      Origin: options.origin ?? PUBLIC_URL,
      ...(options.csrf === false ? {} : { "X-CSRF": session.csrf }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  test("says at startup where launch secrets go, and that the vault opened", () => {
    expect(server?.out.stdout).toContain("vault open");
    // A fresh vault takes in what the unit and the files held, and names it - names only.
    expect(server?.out.stdout).toMatch(/first opening: 2 secret\(s\) taken in .*HCLOUD_TOKEN.*github/);
    expect(server?.out.stdout).not.toContain(MARK);
    expect(`${server?.out.stdout}${server?.out.stderr}`).toContain(
      `launch secrets under ${OWN_RUNTIME} (DEVBOX_RUNTIME_DIR)`,
    );
  });

  test("GET /api/secrets answers the contract, and no value", async () => {
    const answer = await call(base, "/api/secrets", { headers: bearer });
    expect(answer.status).toBe(200);
    expect(answer.text).not.toContain(MARK);

    expect(answer.body.vault).toEqual({ available: true });
    const clouds = answer.body.clouds as {
      cloud: string;
      usable: boolean;
      fields: Record<string, unknown>[];
      machines: string[];
    }[];
    expect(clouds.map((c) => [c.cloud, c.usable, c.machines])).toEqual([
      ["hetzner", true, ["devbox-live"]],
      ["scaleway", false, []],
      ["gcp", false, []],
    ]);
    // The unit's HCLOUD_TOKEN and the github file were taken in at the first opening: the
    // vault holds them now, fingerprinted and dated, and the fallback only shadows.
    expect(clouds[0]?.fields).toEqual([
      {
        name: "HCLOUD_TOKEN",
        label: "API token",
        multiline: false,
        required: true,
        set: true,
        source: "db",
        fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
        updated_at: expect.any(Number),
      },
    ]);
    expect(answer.body.profile).toEqual([
      { name: "claude", set: false, source: null, fingerprint: null, updated_at: null, used_by: ["claude"], machines: ["devbox-live"] },
      {
        name: "github",
        set: true,
        source: "db",
        fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
        updated_at: expect.any(Number),
        used_by: ["claude"],
        machines: ["devbox-live"],
      },
      { name: "never-set", set: false, source: null, fingerprint: null, updated_at: null, used_by: ["needy"], machines: [] },
    ]);
  });

  test("is a read like the others: nobody gets nothing", async () => {
    expect((await call(base, "/api/secrets", {})).status).toBe(401);
  });

  test("a write without the anti-CSRF token, or from another origin, is refused and writes nothing", async () => {
    const before = events();
    const body = { value: HCLOUD_PAGE };
    const path = "/api/secrets/cloud/HCLOUD_TOKEN";

    expect((await call(base, path, fromPage("PUT", body, { csrf: false }))).status).toBe(403);
    expect((await call(base, path, fromPage("PUT", body, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(base, path, { method: "PUT", body: JSON.stringify(body) })).status).toBe(401);
    expect((await call(base, path, fromPage("DELETE", undefined, { csrf: false }))).status).toBe(403);
    expect((await call(base, "/api/secrets/import", fromPage("POST", {}, { csrf: false }))).status).toBe(403);
    expect(
      (await call(base, "/api/clouds/hetzner/test", fromPage("POST", { values: { HCLOUD_TOKEN: CANDIDATE } }, { csrf: false })))
        .status,
    ).toBe(403);

    expect(events()).toBe(before);
    expect(seen("probe-cache")).toBe("");
  });

  test("PUT stores the value and answers the entry: a fingerprint and a date, never the value", async () => {
    const cloud = await call(base, "/api/secrets/cloud/HCLOUD_TOKEN", fromPage("PUT", { value: `${HCLOUD_PAGE}\n` }));
    expect(cloud.status).toBe(200);
    expect(cloud.text).not.toContain(MARK);
    expect(cloud.body).toEqual({
      name: "HCLOUD_TOKEN",
      label: "API token",
      multiline: false,
      required: true,
      set: true,
      source: "db",
      fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
      updated_at: expect.any(Number),
    });

    const profile = await call(base, "/api/secrets/profile/claude", fromPage("PUT", { value: CLAUDE_PAGE }));
    expect(profile.status).toBe(200);
    expect(profile.text).not.toContain(MARK);
    expect(profile.body).toMatchObject({ name: "claude", set: true, source: "db", used_by: ["claude"], machines: ["devbox-live"] });

    // The CLI token does NOT write a secret. With it, a holder could swap a cloud credential
    // for an account of their own and seed a machine there - every profile secret would land
    // on their hardware. See `guard` in server.ts.
    const withToken = (method: string, path: string, value?: unknown) =>
      call(base, path, {
        method,
        headers: { ...bearer, "Content-Type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    expect((await withToken("PUT", "/api/secrets/profile/claude", { value: "sk-from-a-token" })).status).toBe(401);
    expect((await withToken("PUT", "/api/secrets/cloud/HCLOUD_TOKEN", { value: "hc-from-a-token" })).status).toBe(401);
    expect((await withToken("DELETE", "/api/secrets/profile/claude")).status).toBe(401);
    expect((await withToken("POST", "/api/secrets/import", {})).status).toBe(401);
    expect(
      (await withToken("POST", "/api/clouds/hetzner/test", { values: { HCLOUD_TOKEN: CANDIDATE } })).status,
    ).toBe(401);
    // And nothing moved: the value is still the one the page set.
    const after = await call(base, "/api/secrets", { headers: bearer });
    const entry = (after.body.profile as { name: string; fingerprint: string }[]).find((one) => one.name === "claude");
    expect(entry?.fingerprint).toBe(profile.body.fingerprint as string);
  });

  test("PUT refuses what it cannot store, names the field, and quotes nothing", async () => {
    const cases: [string, unknown, string][] = [
      ["/api/secrets/env/HCLOUD_TOKEN", { value: "x" }, "kind"],
      ["/api/secrets/cloud/AWS_SECRET_ACCESS_KEY", { value: "x" }, "name"],
      ["/api/secrets/profile/gcp", { value: "x" }, "name"],
      ["/api/secrets/profile/github", { value: "" }, "value"],
      ["/api/secrets/profile/github", { value: 42 }, "value"],
      ["/api/secrets/profile/github", { value: `${MARK}${"x".repeat(64 * 1024)}` }, "value"],
      ["/api/secrets/cloud/HCLOUD_TOKEN", { value: `hc-${MARK}\nsecond-line` }, "value"],
      ["/api/secrets/profile/github", "not an object", "value"],
    ];
    for (const [path, body, field] of cases) {
      const refused = await call(base, path, fromPage("PUT", body));
      expect(refused.status, path).toBe(400);
      expect(refused.body.field, path).toBe(field);
      expect(refused.text).not.toContain(MARK);
    }
  });

  test("a body past the ceiling is a 413 before any route reads it, and the largest a value can send is not", async () => {
    const before = events();
    // 1 MiB and a few bytes: maxRequestBodySize in server.ts, refused on the Content-Length.
    const over = await call(base, "/api/secrets/profile/github", fromPage("PUT", { value: `${MARK}${"x".repeat(1024 * 1024)}` }));
    expect(over.status).toBe(413);
    expect(over.text).not.toContain(MARK);
    // A value at the vault's own ceiling, every byte a control character JSON writes in six: about
    // 384 KiB, which reaches its route - and is refused there, for its name.
    const largest = await call(
      base,
      "/api/secrets/profile/gcp",
      fromPage("PUT", { value: String.fromCharCode(1).repeat(64 * 1024) }),
    );
    expect(largest.status).toBe(400);
    expect(largest.body.field).toBe("name");
    expect(events()).toBe(before);
  });

  test("a job is handed the vault's values in a directory of its own, gone after, and argv holds none", async () => {
    const created = await call(base, "/api/machines", {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "claude", cloud: "hetzner", name: "devbox-apitest" }),
    });
    expect(created.status).toBe(200);
    const job = await settled(base, created.body.job as number);
    expect(job.state).toBe("succeeded");

    // The vault's claude, the fallback's github, and the vault's token over the unit's.
    expect(seen("up-secrets").trim().split("\n").sort()).toEqual([`claude=${CLAUDE_PAGE}`, `github=${GITHUB_FILE}`]);
    expect(seen("up-hcloud")).toBe(HCLOUD_PAGE);
    const dir = seen("up-dir").trim();
    expect(dir.startsWith(`${OWN_RUNTIME}/launch-`)).toBe(true);
    expect(existsSync(dir)).toBe(false);

    const jobs = await call(base, "/api/jobs", { headers: bearer });
    expect(jobs.text).toContain("devbox-apitest");
    expect(jobs.text).not.toContain(MARK);
    const log = await call(base, `/api/jobs/${created.body.job}/log`, { headers: bearer });
    expect(log.text).toContain("done up");
    expect(log.text).not.toContain(MARK);
  });

  test("a machine's detail is read in this account's tree, and handed no credential", async () => {
    const detail = await call(base, "/api/machines/devbox-live", { headers: bearer });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ name: "devbox-live", profile: "claude", label: null });
    // A name this account's state does not hold is a 404 before any devbox is launched.
    const before = readdirSync(SEEN).filter((name) => name.startsWith("env-info-")).length;
    expect((await call(base, "/api/machines/devbox-nowhere", { headers: bearer })).status).toBe(404);
    expect(readdirSync(SEEN).filter((name) => name.startsWith("env-info-")).length).toBe(before);
  });

  test("a seed runs the machine's recorded profile, with that profile's secrets", async () => {
    const started = await call(base, "/api/machines/devbox-live/seed", {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(started.status).toBe(200);
    expect((await settled(base, started.body.job as number)).state).toBe("succeeded");
    expect(seen("seed-secrets").trim().split("\n").sort()).toEqual([`claude=${CLAUDE_PAGE}`, `github=${GITHUB_FILE}`]);
    expect(existsSync(seen("seed-dir").trim())).toBe(false);
  });

  test("an order whose profile declares a secret held nowhere is refused before anything runs", async () => {
    const refused = await call(base, "/api/machines", {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "needy", cloud: "hetzner", name: "devbox-needy" }),
    });
    expect(refused.status).toBe(412);
    expect(refused.body.profile).toBe("needy");
    expect(refused.body.missing).toEqual(["never-set"]);
    // In the page's words, and the name as it is when the catalogue does not describe it.
    expect(refused.body.error).toContain("needy needs a secret named never-set: add it on the Keys & tokens page.");
    // Account 1 holds the fallback, so its directory is named as the other road.
    expect(refused.body.error).toContain(`Or deposit a file named never-set in ${LEGACY}.`);
  });

  test("a cloud test tries the candidate, answers the count, and writes nothing - cache included", async () => {
    const before = events();
    const fingerprint = async () => {
      const answer = await call(base, "/api/secrets", { headers: bearer });
      const clouds = answer.body.clouds as { fields: { fingerprint: string | null }[] }[];
      return clouds[0]?.fields[0]?.fingerprint;
    };
    const held = await fingerprint();

    const tried = await call(base, "/api/clouds/hetzner/test", fromPage("POST", { values: { HCLOUD_TOKEN: CANDIDATE } }));
    expect(tried.status).toBe(200);
    expect(tried.body).toEqual({ ok: true, offers: 2 });
    expect(tried.text).not.toContain(MARK);

    expect(events()).toBe(before);
    expect(await fingerprint()).toBe(held);
    // Its own cache, somewhere under the launch, and gone with it; the service's untouched.
    const cache = seen("probe-cache").trim();
    expect(cache.startsWith(`${OWN_RUNTIME}/launch-`)).toBe(true);
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(join(ROOT, "data", "cache", "gcp-skus.jsonl"))).toBe(false);
  });

  test("a refused credential is an answer, with the provider's words and none of the value", async () => {
    const tried = await call(base, "/api/clouds/hetzner/test", fromPage("POST", { values: { HCLOUD_TOKEN: `hc-wrong-${MARK}-6666` } }));
    expect(tried.status).toBe(200);
    expect(tried.body.ok).toBe(false);
    expect(tried.body.error).toContain("answered 401");
    expect(tried.text).not.toContain(MARK);

    // Nothing typed: the held token is the one tried, and it is not echoed either.
    const held = await call(base, "/api/clouds/hetzner/test", fromPage("POST", { values: {} }));
    expect(held.body.ok).toBe(false);
    expect(held.text).not.toContain(MARK);
  });

  test("a cloud test refuses what is not that cloud's", async () => {
    expect((await call(base, "/api/clouds/aws/test", fromPage("POST", { values: {} }))).status).toBe(400);
    const other = await call(base, "/api/clouds/hetzner/test", fromPage("POST", { values: { SCW_SECRET_KEY: "x" } }));
    expect(other.status).toBe(400);
    expect(other.body.field).toBe("values");
    // Scaleway with nothing held and nothing typed: said, without spawning anything.
    const scaleway = await call(base, "/api/clouds/scaleway/test", fromPage("POST", { values: {} }));
    expect(scaleway.body).toEqual({
      ok: false,
      error: "nothing holds SCW_ACCESS_KEY, SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID: type them here to try",
    });
  });

  test("PUT /api/clouds/:cloud saves a cloud whole, and answers the cloud without a value", async () => {
    const before = events();
    const values = {
      SCW_ACCESS_KEY: `SCW${MARK}AAAAAAAAAAAAA`,
      SCW_SECRET_KEY: `scw-secret-${MARK}-8888`,
      SCW_DEFAULT_PROJECT_ID: `scw-project-${MARK}-9999`,
    };
    const saved = await call(base, "/api/clouds/scaleway", fromPage("PUT", { values }));
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(MARK);
    expect(saved.body).toMatchObject({ cloud: "scaleway", usable: true });
    const fields = saved.body.fields as { name: string; source: string | null; fingerprint: string | null }[];
    expect(fields.map((field) => [field.name, field.source])).toEqual([
      ["SCW_ACCESS_KEY", "db"],
      ["SCW_SECRET_KEY", "db"],
      ["SCW_DEFAULT_PROJECT_ID", "db"],
    ]);
    expect(fields.every((field) => /^[0-9a-f]{12}$/.test(field.fingerprint ?? ""))).toBe(true);
    // One event per name, and the account can order from it at once.
    expect(events()).toBe(before + 3);
    expect((await call(base, "/api/session", { headers: bearer })).body.clouds).toContain("scaleway");
  });

  test("PUT /api/clouds/:cloud refuses the whole set when one value is refused, and writes none of it", async () => {
    const scaleway = async () => {
      const answer = await call(base, "/api/secrets", { headers: bearer });
      const clouds = answer.body.clouds as { cloud: string; fields: { fingerprint: string | null }[] }[];
      return clouds.find((one) => one.cloud === "scaleway")?.fields.map((field) => field.fingerprint);
    };
    const held = await scaleway();
    const before = events();
    const fresh = `SCWNEW${MARK}NEWNEWNEW`;
    for (const body of [
      { values: { SCW_ACCESS_KEY: fresh, SCW_SECRET_KEY: `second\nline-${MARK}` } },
      { values: { SCW_ACCESS_KEY: fresh, SCW_SECRET_KEY: "" } },
      { values: { SCW_ACCESS_KEY: fresh, HCLOUD_TOKEN: `hc-${MARK}` } },
      { values: {} },
      {},
    ]) {
      const refused = await call(base, "/api/clouds/scaleway", fromPage("PUT", body));
      expect(refused.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect(refused.body.field).toBe("values");
      expect(refused.text).not.toContain(MARK);
    }
    expect((await call(base, "/api/clouds/aws", fromPage("PUT", { values: { SCW_ACCESS_KEY: fresh } }))).status).toBe(400);
    // The access key that came first in every refused set was not written either.
    expect(events()).toBe(before);
    expect(await scaleway()).toEqual(held);
  });

  test("PUT /api/clouds/:cloud is a page's write: the CLI token, a foreign origin and a missing token all write nothing", async () => {
    const before = events();
    const body = { values: { HCLOUD_TOKEN: `hc-token-${MARK}-0000` } };
    const withToken = await call(base, "/api/clouds/hetzner", {
      method: "PUT",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(withToken.status).toBe(401);
    expect((await call(base, "/api/clouds/hetzner", fromPage("PUT", body, { csrf: false }))).status).toBe(403);
    expect((await call(base, "/api/clouds/hetzner", fromPage("PUT", body, { origin: "https://evil.example" }))).status).toBe(403);
    expect(events()).toBe(before);

    // Put back as it was: the describes below restart this server on the same data, and
    // count the clouds it can order from.
    for (const name of ["SCW_ACCESS_KEY", "SCW_SECRET_KEY", "SCW_DEFAULT_PROJECT_ID"]) {
      expect((await call(base, `/api/secrets/cloud/${name}`, fromPage("DELETE"))).status).toBe(200);
    }
  });

  test("DELETE says which fallback takes over, and 404s what the vault does not hold", async () => {
    const cloud = await call(base, "/api/secrets/cloud/HCLOUD_TOKEN", fromPage("DELETE"));
    expect(cloud.body).toEqual({ deleted: true, fallback: "env" });

    const profile = await call(base, "/api/secrets/profile/claude", fromPage("DELETE"));
    expect(profile.body).toEqual({ deleted: true, fallback: null });

    await call(base, "/api/secrets/profile/github", fromPage("PUT", { value: "ghp-page-override" }));
    const github = await call(base, "/api/secrets/profile/github", fromPage("DELETE"));
    expect(github.body).toEqual({ deleted: true, fallback: "file" });

    expect((await call(base, "/api/secrets/profile/claude", fromPage("DELETE"))).status).toBe(404);
  });

  /**
   * Import copies what nobody has decided about yet, and nothing else. HCLOUD_TOKEN and github
   * were set and then deleted through the page just above, and their fallbacks took over
   * again: this test used to expect Import to copy those same stale fallbacks into the vault,
   * which is the fault found on 11/09 - a rotation undone by a button, with the page then showing a
   * value held by the vault where there was only the copy from before it.
   */
  test("import copies the fallback nobody decided about, once, and never what the page deleted", async () => {
    writeFileSync(join(LEGACY, "openai"), `sk-openai-${MARK}-7777`);
    const first = await call(base, "/api/secrets/import", fromPage("POST", {}));
    expect(first.status).toBe(200);
    expect(first.body.imported).toEqual(["profile/openai"]);
    const decided = "deleted from the vault before, and a copy from outside it never goes back in over that";
    expect(first.body.skipped).toEqual([
      `cloud/HCLOUD_TOKEN: ${decided}: set it on the page if it is still wanted`,
      `profile/github: ${decided}: set it on the page if it is still wanted`,
    ]);
    expect(first.text).not.toContain(MARK);

    // What was deleted is still served by its fallback, and says so.
    const after = await call(base, "/api/secrets", { headers: bearer });
    const profile = after.body.profile as { name: string; source: string | null }[];
    expect(profile.find((p) => p.name === "github")?.source).toBe("file");
    expect(profile.find((p) => p.name === "openai")?.source).toBe("db");
    const clouds = after.body.clouds as { fields: { source: string | null }[] }[];
    expect(clouds[0]?.fields[0]?.source).toBe("env");

    const before = events();
    const second = await call(base, "/api/secrets/import", fromPage("POST", {}));
    expect(second.body.imported).toEqual([]);
    expect(second.body.skipped).toEqual([
      `cloud/HCLOUD_TOKEN: ${decided}: set it on the page if it is still wanted`,
      `profile/github: ${decided}: set it on the page if it is still wanted`,
      "profile/openai: already in the database, same value",
    ]);
    expect(events()).toBe(before);
  });

  /**
   * HANDED, and only that: what each child found in its own environment. This used to be
   * called "the master key reached no child", and it passed while a child could still read
   * the key out of the server's /proc/<pid>/environ - see the next test.
   */
  test("no child is handed the master key in its environment, whatever it was asked to do", () => {
    const environments = seen("env-");
    // Every verb above ran at least once: profiles, ls, info, probe, up and seed.
    for (const verb of ["profiles", "ls", "info", "probe", "up", "seed"]) {
      expect(readdirSync(SEEN).some((name) => name.startsWith(`env-${verb}-`))).toBe(true);
    }
    expect(environments).not.toContain("DEVBOX_MASTER_KEY");
    expect(environments).not.toContain(MASTER.slice(3));
    // And a read that needs no provider got no credential at all.
    for (const name of readdirSync(SEEN).filter((n) => /^env-(profiles|ls|info)-/.test(n))) {
      expect(readFileSync(join(SEEN, name), "utf8")).not.toContain("HCLOUD_TOKEN");
    }
  });

  /**
   * REACHED: whether a child could read the key back from the server itself. openVault deletes
   * it from process.env, and the bytes stay in the block /proc/<pid>/environ serves to every
   * process of the same uid, measured on 11/09; server.ts makes itself undumpable,
   * which closes that file. Linux alone has it - and the runner is Linux. A Mac shows the
   * same block through `ps -E`, and nothing closes it there: see src/undumpable.ts.
   */
  test.skipIf(process.platform !== "linux")(
    "nor can any child read it back from the server's initial environment",
    () => {
      const parents = existsSync(SEEN) ? readdirSync(SEEN).filter((name) => name.startsWith("parent-")) : [];
      expect(parents.length).toBeGreaterThan(0);
      for (const name of parents) {
        const text = readFileSync(join(SEEN, name), "utf8");
        expect(text).not.toContain(MASTER.slice(3));
        expect(text.trim()).toBe("refused");
      }
    },
  );
});

describe("the same service restarted with the wrong master key", () => {
  let server: Server | null = null;

  beforeAll(async () => {
    // What a crash would have left: swept at startup, and said.
    mkdirSync(join(OWN_RUNTIME, "launch-leftover", "secrets"), { recursive: true });
    writeFileSync(join(OWN_RUNTIME, "launch-leftover", "secrets", "github"), "left by a crash");
    // And what the sweep must not remove, nor die on: not a directory of ours.
    writeFileSync(join(OWN_RUNTIME, "launch-not-a-directory"), "");
    server = await startServer({ DEVBOX_MASTER_KEY: newMasterKey(1) });
  }, 30_000);

  afterAll(() => stopServer(server));

  test("starts anyway, says why the vault is closed, and sweeps what a crash left", () => {
    const said = `${server?.out.stdout}${server?.out.stderr}`;
    expect(said).toContain("the vault is closed");
    expect(said).toContain("does not open under master key v1");
    expect(said).toContain("removed 1 launch directory");
    expect(said).toContain(`${join(OWN_RUNTIME, "launch-not-a-directory")} is not a directory, and was left alone`);
    expect(existsSync(join(OWN_RUNTIME, "launch-leftover"))).toBe(false);
    expect(existsSync(join(OWN_RUNTIME, "launch-not-a-directory"))).toBe(true);
  });

  test("serves the fallback, and refuses to write with a 503", async () => {
    const base = server?.base ?? "";
    const answer = await call(base, "/api/secrets", { headers: bearer });
    expect(answer.body.vault).toMatchObject({ available: false });
    expect(String((answer.body.vault as { reason: string }).reason)).toContain("does not open");
    const clouds = answer.body.clouds as { usable: boolean; fields: { source: string | null }[] }[];
    // The vault's HCLOUD_TOKEN is out of reach; the unit's answers in its place.
    expect(clouds[0]?.fields[0]?.source).toBe("env");
    expect(clouds[0]?.usable).toBe(true);
    expect(answer.text).not.toContain(MARK);

    const refused = await pageWrite(base, "/api/secrets/profile/claude", "PUT", { value: CLAUDE_PAGE });
    expect(refused.status).toBe(503);
    expect(refused.body.error).toContain("the vault is closed");
  });
});

/**
 * A cloud's credentials can be deleted from a page while machines still run on it. The destroy
 * of such a machine used to be accepted, recorded as a job, and die in the log on a token that
 * was not set - the machine still billing. And one cloud's unreadable credential refused
 * every job, the destroy of a machine on ANOTHER cloud included. Both found on 11/09.
 */
describe("a service that can no longer reach one of its clouds", () => {
  let server: Server | null = null;
  let base = "";
  const BROKEN = join(ROOT, "legacy-broken");
  let gcpUnreadable = false;

  beforeAll(async () => {
    // The GCP key deposited under the wrong owner or mode, and its project in the unit.
    mkdirSync(BROKEN, { recursive: true });
    const key = join(BROKEN, "gcp");
    writeFileSync(key, `{"client_email":"file-${MARK}"}`);
    chmodSync(key, 0o000);
    try {
      accessSync(key, constants.R_OK);
    } catch {
      gcpUnreadable = true; // root reads everything, and then there is nothing to show here
    }
    server = await startServer({
      DEVBOX_MASTER_KEY: MASTER,
      HCLOUD_TOKEN: "",
      DEVBOX_GCP_PROJECT: "acme-devbox-000000",
      DEVBOX_SECRETS_DIR: BROKEN,
    });
    base = server.base;
  }, 30_000);

  afterAll(async () => {
    await stopServer(server);
    chmodSync(join(BROKEN, "gcp"), 0o600);
  });

  const jobCount = async () => ((await call(base, "/api/jobs", { headers: bearer })).body as unknown as unknown[]).length;

  test("offers no cloud whose credential it cannot read, however present the file looks", async () => {
    const answered = await call(base, "/api/session", { headers: bearer });
    expect(answered.body.clouds).toEqual(gcpUnreadable ? [] : ["gcp"]);

    // And the same address, asked by nobody, says nothing about anyone's credentials: which
    // clouds this service can order from was a description of account 1, published to the
    // open internet for as long as this route answered it unauthenticated.
    const anonymous = await call(base, "/api/session", {});
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toMatchObject({
      authenticated: false,
      account: null,
      clouds: [],
      configured: null,
      missing: [],
      secrets_dir: null,
    });
  });

  test("names, per cloud, the machines its credentials are still needed for", async () => {
    const answer = await call(base, "/api/secrets", { headers: bearer });
    const clouds = answer.body.clouds as { cloud: string; usable: boolean; machines: string[] }[];
    expect(clouds[0]).toMatchObject({ cloud: "hetzner", usable: false, machines: ["devbox-live"] });
  });

  test("refuses the destroy of a machine whose cloud it cannot reach, with a 412, before any job", async () => {
    const before = await jobCount();
    const refused = await call(base, "/api/machines/devbox-live/destroy", {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "devbox-live" }),
    });
    expect(refused.status).toBe(412);
    expect(refused.body).toMatchObject({ cloud: "hetzner", missing: ["HCLOUD_TOKEN"] });
    // The variable is in `missing`; the sentence names the cloud and the page that fixes it.
    expect(refused.body.error).toContain("devbox-live runs on Hetzner");
    expect(refused.body.error).toContain("on the Account page");
    expect(await jobCount()).toBe(before);
    expect(seen("down-")).toBe("");
  });

  test("destroys it once the token is back, though GCP's credential still does not open", async () => {
    const put = (name: string, value: string) => pageWrite(base, `/api/secrets/cloud/${name}`, "PUT", { value });
    expect((await put("HCLOUD_TOKEN", HCLOUD_PAGE)).status).toBe(200);
    // GCP's key in the vault this time, and then a row that no longer opens.
    expect((await put("gcp", `{"client_email":"vault-${MARK}"}`)).status).toBe(200);
    const db = new Database(join(ROOT, "data", "devbox.db"));
    try {
      db.run("UPDATE secrets SET nonce = zeroblob(12) WHERE kind = 'cloud' AND name = 'gcp'");
    } finally {
      db.close();
    }

    const started = await call(base, "/api/machines/devbox-live/destroy", {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "devbox-live" }),
    });
    expect(started.status).toBe(200);
    expect((await settled(base, started.body.job as number)).state).toBe("succeeded");
    expect(seen("down-hcloud")).toBe(HCLOUD_PAGE);
    expect(seen("down-secrets")).toBe("");

    const log = await call(base, `/api/jobs/${started.body.job}/log`, { headers: bearer });
    expect(log.text).toContain("gcp: its credentials cannot be read, so it was left out");
    expect(log.text).toContain("done down");
    expect(log.text).not.toContain(MARK);
  });
});

/**
 * `bun run dev` is `bun --hot`, which evaluates every module again at each save and keeps
 * globalThis. The vault read its key from process.env - deleted at the first evaluation - so
 * every reload closed it; and the sweep ran again, under the jobs in flight. Found on 11/09.
 */
describe("the service under bun --hot", () => {
  let server: Server | null = null;
  const ENTRY = join(ROOT, "hot-entry.ts");

  beforeAll(async () => {
    writeFileSync(ENTRY, `import ${JSON.stringify(join(DASHBOARD, "server.ts"))};\n`);
    server = await startServer({ DEVBOX_MASTER_KEY: MASTER }, { hot: ENTRY });
  }, 30_000);

  afterAll(() => stopServer(server));

  test("keeps its vault open and its launches in place across a reload", async () => {
    const base = server?.base ?? "";
    const evaluations = () => (server?.out.stdout ?? "").split("devbox on http://").length - 1;
    expect((await call(base, "/api/secrets", { headers: bearer })).body.vault).toEqual({ available: true });

    // A launch in flight, as a job's would be while the operator saves a file.
    const inFlight = join(OWN_RUNTIME, "launch-in-flight");
    mkdirSync(join(inFlight, "secrets"), { recursive: true });

    // The second evaluation is the second line naming the port, which every evaluation prints.
    appendFileSync(ENTRY, "// saved\n");
    for (let i = 0; i < 400 && evaluations() < 2; i += 1) await Bun.sleep(25);
    expect(evaluations()).toBe(2);

    const after = await call(base, "/api/secrets", { headers: bearer });
    expect(after.body.vault).toEqual({ available: true });
    expect(existsSync(inFlight)).toBe(true);
    // Opened once, whatever the number of evaluations, and the reload says why.
    expect((server?.out.stdout ?? "").split("vault open").length - 1).toBe(1);
    expect(server?.out.stdout).toContain("reloaded: the vault, the launch directories and the jobs");
    // And its sign-in: the four variables left process.env at the first evaluation, and a second
    // one reading them again would have found none and offered no provider.
    expect((await call(base, "/api/session", {})).body.doors).toMatchObject({ providers: ["google", "github"] });
    expect((server?.out.stdout ?? "").split("sign-in: google, github").length - 1).toBe(2);
  }, 20_000);
});
