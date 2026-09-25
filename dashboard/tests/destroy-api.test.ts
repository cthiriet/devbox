import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { newMasterKey } from "../src/vault";
import { signIn, startServer, stopServer, type Server } from "./server-harness";

/**
 * Which credentials a destroy is handed, through the real server.ts: those its machine was ordered
 * with, and no others.
 *
 * A machine lives in the provider account it was ordered in. A `down` handed another account's
 * token for that cloud is refused by nobody: the provider answers 404 for a server of another
 * project, terraform may drop it from the state, and the job succeeds on a machine that bills on
 * with nothing left to reach it. So an order writes down where it went - machine_origins - and a
 * destroy reads it back: see destroySourcesFor in src/secrets.ts. Two services here, the dashboard
 * as published and one with the extension of tests/fixtures/extension-service.ts, which puts every
 * account on the service's cloud accounts but the address TEST_OFF_SERVICE_FILE names.
 *
 * The engine is a fake `devbox`, as in tests/isolation-api.test.ts: it answers `ls` out of fixtures
 * kept per account, and writes down every call's account, argv, environment and launch directory.
 * The service's cloud accounts are its unit's variables, which the founder's vault takes in at the
 * first opening, and every one of their values carries SRVC: finding those four letters in what a
 * destroy of another account was handed is the failure, wherever the table of destroySourcesFor
 * says it should not be there.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const PUBLIC_URL = "http://devbox.test";
const FOUNDER = "founder@devbox.test";
const BOB = "bob@devbox.test";
const MARK = "SRVC";

const SERVICE = {
  HCLOUD_TOKEN: `hc-service-${MARK}-0001`,
  SCW_ACCESS_KEY: `SCW${MARK}${MARK}${MARK}${MARK}0`,
  SCW_SECRET_KEY: `scw-secret-${MARK}-0002`,
  SCW_DEFAULT_PROJECT_ID: `scw-project-${MARK}-0003`,
} as const;
const OWN_HCLOUD = "hc-bob-own-9999";

const PROFILES = [
  { name: "bare", path: "/engine/profiles/bare.sh", repo: null, secrets: [], note: null, min_cpu: null, min_ram: null, min_disk: null, port: null },
];

const machine = (name: string, cloud = "hetzner") => ({
  name,
  cloud,
  region: "fsn1",
  instance_type: "cx33",
  profile: "bare",
  hourly_eur: 0.01,
  ip: "203.0.113.7",
  user: "dev",
  port: 22,
  local_port: 2222,
  app_port: 3000,
});

type Service = { root: string; seen: string; fixtures: string; server: Server };

/** Everything it records goes to `seen`, never to its stdout, which is a job's log. */
function fakeEngine(seen: string, fixtures: string): (directory: string) => void {
  return (directory) => {
    mkdirSync(join(directory, "tf"), { recursive: true });
    writeFileSync(
      join(directory, "devbox"),
      [
        "#!/usr/bin/env bash",
        `seen=${JSON.stringify(seen)}`,
        `fixtures=${JSON.stringify(fixtures)}`,
        'mkdir -p "$seen"',
        'id="$1-$$-$RANDOM"',
        // Which account's tree this is: the answers are that tree's, and the record says whose.
        'account=$(basename "$(dirname "$DEVBOX_TF_ROOT")")',
        'printf \'%s\\n%s\\n\' "$account" "$*" > "$seen/call-$id"',
        'env > "$seen/env-$id"',
        'for f in "$DEVBOX_SECRETS_DIR"/*; do [ -f "$f" ] && printf \'%s=%s\\n\' "${f##*/}" "$(cat "$f")"; done > "$seen/launch-$id"',
        'case "$1" in',
        '  ls) cat "$fixtures/$account/ls.json" 2>/dev/null || printf \'[]\' ;;',
        `  profiles) printf '%s' '${JSON.stringify(PROFILES)}' ;;`,
        "  probe|orphans) printf '[]' ;;",
        '  up|seed|down) echo "done $*" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  };
}

async function service(name: string, env: Record<string, string> = {}): Promise<Service> {
  const root = join(DATA_DIR, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "legacy"), { recursive: true });
  const seen = join(root, "seen");
  const fixtures = join(root, "fixtures");
  const server = await startServer({
    root,
    engine: fakeEngine(seen, fixtures),
    env: { PUBLIC_URL, DEVBOX_FOUNDER_EMAIL: FOUNDER, DEVBOX_MASTER_KEY: newMasterKey(1), ...SERVICE, ...env },
  });
  return { root, seen, fixtures, server };
}

/** A workspace in one account's state: what holdsMachine asks, and what `ls` skips when half-created. */
function workspace(at: Service, account: number, name: string, cloud = "hetzner"): void {
  mkdirSync(join(at.root, "data", "accounts", String(account), "tf", cloud, "terraform.tfstate.d", name), { recursive: true });
}

/** A fleet for one account: the fake lists it, and the account's state holds a workspace for each. */
function fleet(at: Service, account: number, machines: ReturnType<typeof machine>[]): void {
  const here = join(at.fixtures, String(account));
  mkdirSync(here, { recursive: true });
  writeFileSync(join(here, "ls.json"), JSON.stringify(machines));
  for (const one of machines) workspace(at, account, one.name, one.cloud);
}

type Call = { verb: string; account: string; argv: string; handed: string };

/** Every call the fake recorded, with what its child was handed: its environment and its launch directory. */
function calls(at: Service): Call[] {
  if (!existsSync(at.seen)) return [];
  return readdirSync(at.seen)
    .filter((file) => file.startsWith("call-"))
    .map((file) => {
      const id = file.slice("call-".length);
      const [account = "", argv = ""] = readFileSync(join(at.seen, file), "utf8").split("\n");
      const handed = ["env", "launch"]
        .map((kind) => join(at.seen, `${kind}-${id}`))
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path, "utf8"))
        .join("\n");
      return { verb: argv.split(" ")[0] ?? "", account, argv, handed };
    });
}

function origins(at: Service): unknown[] {
  const db = new Database(join(at.root, "data", "devbox.db"), { readonly: true });
  try {
    return db.query("SELECT account_id, machine, cloud, via FROM machine_origins ORDER BY account_id, machine").all();
  } finally {
    db.close();
  }
}

type Answer = { status: number; text: string; body: Record<string, unknown> };
type Browser = { cookie: string; csrf: string };

async function send(base: string, path: string, init: RequestInit = {}): Promise<Answer & { cookie: string }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A test that wanted JSON says so on `status`.
  }
  return { status: response.status, text, body, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
}

/** A first Google sign-in as that address, a Workspace account's. FOUNDER is DEVBOX_FOUNDER_EMAIL, and founds account 1. */
async function signUp(base: string, email: string): Promise<Browser> {
  const signed = await signIn(base, "google", { sub: `google-${email}`, email, hd: "devbox.test" });
  expect(signed.cookie, `${email} signs in`).not.toBe("");
  return { cookie: signed.cookie, csrf: signed.csrf };
}

const read = (at: Service, who: Browser, path: string) => send(at.server.base, path, { headers: { Cookie: who.cookie } });

const write = (at: Service, who: Browser, method: string, path: string, value?: unknown) =>
  send(at.server.base, path, {
    method,
    headers: { Cookie: who.cookie, Origin: PUBLIC_URL, "X-CSRF": who.csrf, "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });

const jobCount = async (at: Service, who: Browser) => ((await read(at, who, "/api/jobs")).body as unknown as unknown[]).length;

async function settled(at: Service, who: Browser, id: number): Promise<Record<string, unknown>> {
  for (let i = 0; i < 400; i += 1) {
    const job = await read(at, who, `/api/jobs/${id}`);
    if (job.status !== 200) throw new Error(`job ${id}: ${job.status} ${job.text}`);
    if (job.body.state !== "running") return job.body;
    await Bun.sleep(25);
  }
  throw new Error(`job ${id} never finished`);
}

async function order(at: Service, who: Browser, name: string): Promise<void> {
  const started = await write(at, who, "POST", "/api/machines", { profile: "bare", cloud: "hetzner", name });
  expect(started.status, started.text).toBe(200);
  expect((await settled(at, who, started.body.job as number)).state).toBe("succeeded");
}

const destroy = (at: Service, who: Browser, name: string) =>
  write(at, who, "POST", `/api/machines/${name}/destroy`, { confirm: name });

/** A destroy accepted and run, and the one `down` it launched. */
async function destroyed(at: Service, who: Browser, account: number, name: string): Promise<Call> {
  const answer = await destroy(at, who, name);
  expect(answer.status, answer.text).toBe(200);
  expect((await settled(at, who, answer.body.job as number)).state).toBe("succeeded");
  const downs = calls(at).filter(
    (call) => call.verb === "down" && call.account === String(account) && call.argv.split(" ").includes(name),
  );
  expect(downs, `${name}'s down`).toHaveLength(1);
  return downs[0] as Call;
}

const hcloud = (value: string) => `HCLOUD_TOKEN=${value}\n`;

describe("the dashboard as published: a destroy of another account is handed nothing of the service's", () => {
  let at: Service;
  let founder: Browser;
  let bob: Browser;

  beforeAll(async () => {
    at = await service("destroy-none");
    founder = await signUp(at.server.base, FOUNDER);
    bob = await signUp(at.server.base, BOB);
  }, 30_000);

  afterAll(async () => {
    await stopServer(at?.server ?? null);
  });

  test("an order records its origin: the account's own, there being nobody else's to order on", async () => {
    expect((await read(at, bob, "/api/session")).body).toMatchObject({ account: { id: 2 }, clouds: [] });
    await order(at, founder, "devbox-founder");
    expect((await write(at, bob, "PUT", "/api/secrets/cloud/HCLOUD_TOKEN", { value: OWN_HCLOUD })).status).toBe(200);
    await order(at, bob, "devbox-bobown");
    expect(origins(at)).toEqual([
      { account_id: 1, machine: "devbox-founder", cloud: "hetzner", via: "own" },
      { account_id: 2, machine: "devbox-bobown", cloud: "hetzner", via: "own" },
    ]);
  }, 30_000);

  test("its destroy is handed its own token, for a machine ordered here or before origins were recorded", async () => {
    // devbox-bobold has no row: a machine ordered before machine_origins existed.
    fleet(at, 2, [machine("devbox-bobown"), machine("devbox-bobold")]);
    for (const name of ["devbox-bobown", "devbox-bobold"]) {
      expect((await destroyed(at, bob, 2, name)).handed, name).toContain(hcloud(OWN_HCLOUD));
    }
  }, 30_000);

  test("its own token gone, each destroy is a 412 before a job: nothing of the service's takes over", async () => {
    expect((await write(at, bob, "DELETE", "/api/secrets/cloud/HCLOUD_TOKEN")).body).toEqual({ deleted: true, fallback: null });
    // And the half-created machine `ls` skips, whose cloud is read off its workspace.
    workspace(at, 2, "devbox-bobhalf");
    const before = await jobCount(at, bob);
    for (const name of ["devbox-bobown", "devbox-bobold", "devbox-bobhalf"]) {
      const refused = await destroy(at, bob, name);
      expect(refused.status, `${name}: ${refused.text}`).toBe(412);
      expect(refused.body, name).toMatchObject({ cloud: "hetzner", missing: ["HCLOUD_TOKEN"] });
    }
    expect(await jobCount(at, bob)).toBe(before);
  });

  test("no child of the other account was ever handed a value of the service's, and the founder keeps its orphans", async () => {
    const bobs = calls(at).filter((call) => call.account === "2");
    expect(bobs.filter((call) => call.verb === "down")).toHaveLength(2);
    for (const call of bobs) expect(call.handed, call.argv).not.toContain(MARK);
    // The founder's children were handed them, which is what makes the loop above a measurement.
    expect(calls(at).some((call) => call.account === "1" && call.handed.includes(hcloud(SERVICE.HCLOUD_TOKEN)))).toBe(true);
    expect((await read(at, founder, "/api/orphans")).status).toBe(200);
  });
});

describe("a hosted service's extension: the service's credentials for a machine ordered on them, and that machine's cloud alone", () => {
  let at: Service;
  let founder: Browser;
  let bob: Browser;
  const OFF = join(DATA_DIR, "destroy-service", "off-service");
  /** The extension stops putting Bob on the service's cloud accounts, until putBack. */
  const takeOff = () => writeFileSync(OFF, BOB);
  const putBack = () => rmSync(OFF, { force: true });

  beforeAll(async () => {
    at = await service("destroy-service", {
      DEVBOX_EXTENSION: join(import.meta.dir, "fixtures", "extension-service.ts"),
      TEST_OFF_SERVICE_FILE: OFF,
    });
    founder = await signUp(at.server.base, FOUNDER);
    bob = await signUp(at.server.base, BOB);
  }, 30_000);

  afterAll(async () => {
    putBack();
    await stopServer(at?.server ?? null);
  });

  test("an order records whose credentials it went to, and a name ordered again replaces its row", async () => {
    expect((await read(at, bob, "/api/session")).body).toMatchObject({ clouds: ["hetzner", "scaleway"] });
    for (const name of ["devbox-svc1", "devbox-svc2", "devbox-svc3", "devbox-again"]) await order(at, bob, name);
    expect((await write(at, bob, "PUT", "/api/secrets/cloud/HCLOUD_TOKEN", { value: OWN_HCLOUD })).status).toBe(200);
    for (const name of ["devbox-own1", "devbox-again"]) await order(at, bob, name);

    expect(origins(at)).toEqual([
      { account_id: 2, machine: "devbox-again", cloud: "hetzner", via: "own" },
      { account_id: 2, machine: "devbox-own1", cloud: "hetzner", via: "own" },
      { account_id: 2, machine: "devbox-svc1", cloud: "hetzner", via: "service" },
      { account_id: 2, machine: "devbox-svc2", cloud: "hetzner", via: "service" },
      { account_id: 2, machine: "devbox-svc3", cloud: "hetzner", via: "service" },
    ]);
    // devbox-legacy1 and devbox-legacy2 have no row: ordered before machine_origins existed.
    fleet(
      at,
      2,
      ["devbox-svc1", "devbox-svc2", "devbox-svc3", "devbox-own1", "devbox-legacy1", "devbox-legacy2"].map((name) => machine(name)),
    );
  }, 30_000);

  test("ordered on its own token, deleted since: a 412 and no job, though the service's would resolve that cloud today", async () => {
    // Back on the service's cloud accounts to ORDER, as DELETE says - and still not for this machine.
    expect((await write(at, bob, "DELETE", "/api/secrets/cloud/HCLOUD_TOKEN")).body).toEqual({ deleted: true, fallback: "service" });
    expect((await read(at, bob, "/api/session")).body).toMatchObject({ clouds: ["hetzner", "scaleway"] });

    const before = await jobCount(at, bob);
    const refused = await destroy(at, bob, "devbox-own1");
    expect(refused.status, refused.text).toBe(412);
    expect(refused.body).toMatchObject({ cloud: "hetzner", missing: ["HCLOUD_TOKEN"] });
    expect(await jobCount(at, bob)).toBe(before);
    expect(calls(at).filter((call) => call.verb === "down")).toEqual([]);
  });

  test("ordered on the service's: its Hetzner token, and none of its Scaleway fields", async () => {
    const down = await destroyed(at, bob, 2, "devbox-svc1");
    expect(down.handed).toContain(hcloud(SERVICE.HCLOUD_TOKEN));
    for (const name of ["SCW_ACCESS_KEY", "SCW_SECRET_KEY", "SCW_DEFAULT_PROJECT_ID"] as const) {
      expect(down.handed, name).not.toContain(SERVICE[name]);
    }
    // Its order was handed them, the account being on every cloud of the service's: the narrowing
    // to the machine's cloud is the destroy's.
    const up = calls(at).find((call) => call.verb === "up" && call.argv.includes("devbox-svc1"));
    expect(up?.handed).toContain(`SCW_SECRET_KEY=${SERVICE.SCW_SECRET_KEY}\n`);
  });

  test("taken off the service's cloud accounts, it still destroys what it ordered there, a token of its own connected since or not", async () => {
    takeOff();
    try {
      expect((await read(at, bob, "/api/session")).body).toMatchObject({ clouds: [] });
      expect((await destroyed(at, bob, 2, "devbox-svc2")).handed).toContain(hcloud(SERVICE.HCLOUD_TOKEN));

      // A token of its own is another provider account, where devbox-svc3 does not live.
      expect((await write(at, bob, "PUT", "/api/secrets/cloud/HCLOUD_TOKEN", { value: OWN_HCLOUD })).status).toBe(200);
      expect((await read(at, bob, "/api/session")).body).toMatchObject({ clouds: ["hetzner"] });
      const down = await destroyed(at, bob, 2, "devbox-svc3");
      expect(down.handed).toContain(hcloud(SERVICE.HCLOUD_TOKEN));
      expect(down.handed).not.toContain(OWN_HCLOUD);
    } finally {
      putBack();
    }
  }, 30_000);

  test("a machine ordered before origins were recorded: the service's only while the account holds none of its own", async () => {
    takeOff();
    try {
      // Beside the token of its own the test above left: its own, and nothing of the service's.
      const own = await destroyed(at, bob, 2, "devbox-legacy2");
      expect(own.handed).toContain(hcloud(OWN_HCLOUD));
      expect(own.handed).not.toContain(MARK);

      // With none: the service's, for that cloud alone - off the service's cloud accounts though it is.
      expect((await write(at, bob, "DELETE", "/api/secrets/cloud/HCLOUD_TOKEN")).status).toBe(200);
      const serviced = await destroyed(at, bob, 2, "devbox-legacy1");
      expect(serviced.handed).toContain(hcloud(SERVICE.HCLOUD_TOKEN));
      expect(serviced.handed).not.toContain(SERVICE.SCW_SECRET_KEY);
    } finally {
      putBack();
    }
  }, 30_000);

  test("the founder's orphans stay refused on a cloud another account ordered machines on, taken off it or not", async () => {
    takeOff();
    try {
      // Bob orders on nothing of the founder's today, and holds machines on its Hetzner: refused there.
      const refused = await read(at, founder, "/api/orphans");
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body.clouds).toEqual(["hetzner"]);
    } finally {
      putBack();
    }
    // Back on every cloud of the service's, Bob shares its Scaleway as well.
    expect((await read(at, founder, "/api/orphans")).body.clouds).toEqual(["hetzner", "scaleway"]);
  });
});
