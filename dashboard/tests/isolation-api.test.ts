import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { SENTINEL } from "../src/profiles";
import { newMasterKey } from "../src/vault";
import { signIn as signInAs, startServer, stopServer, type Server } from "./server-harness";

/**
 * Two accounts on one service, and nothing of one reaching the other.
 *
 * Account A founds account 1 with Google, its verified address being DEVBOX_FOUNDER_EMAIL;
 * account B is created by its own first Google sign-in. The engine is a fake `devbox` that answers `ls`, `info` and `profiles` out
 * of the tree it was pointed at - fixtures keyed by DEVBOX_TF_ROOT, profiles listed from
 * DEVBOX_CONFIG_DIR - and writes down, for every call, the four variables that make an
 * account's world, its whole environment, and the launch directory as the child found it. A
 * fake keyed by the tree cannot be fooled by a route that filtered an answer: handed A's tree
 * on B's behalf, it would answer A's fleet, and the record would say so.
 *
 * Every PROFILE secret A plants carries QZXW, like the service's own file. Finding those four
 * letters in anything B was answered, or in anything a child was handed on B's behalf, is the
 * failure. The cloud tokens carry none: since 13/09 the founder's cloud accounts are the
 * service's, and B orders on them on purpose - which a test below proves, token in hand.
 *
 * The caps are lowered to 3 for the service and 2 per account, so that reaching them costs
 * three held jobs rather than seven.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const ROOT = join(DATA_DIR, "isolation-api");
const DATA = join(ROOT, "data");
const SEEN = join(ROOT, "seen");
const FIXTURES = join(ROOT, "fixtures");
const MARK = "QZXW";

const PUBLIC_URL = "http://devbox.test";
const A_EMAIL = "alice@devbox.test";
const B_EMAIL = "bob@devbox.test";

const HCLOUD_UNIT = "hc-unit-service-0000";
const GITHUB_FILE = `ghp-file-${MARK}-0001`;
const A_HCLOUD = "hc-alice-service-1111";
const A_GITHUB = `ghp-alice-${MARK}-2222`;
const A_CLAUDE = `sk-alice-${MARK}-3333`;
const B_HCLOUD = "hc-bob-own-9999";

const treeOf = (account: number) => join(DATA, "accounts", String(account));
const A_TREE = treeOf(1);
const B_TREE = treeOf(2);

const machine = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  cloud: "hetzner",
  region: "fsn1",
  instance_type: "cx33",
  profile: "bare",
  hourly_eur: 0.01,
  ip: "203.0.113.7",
  user: "dev",
  port: 22,
  local_port: 2222,
  app_port: 3000,
  ...extra,
});

/**
 * The fake devbox. Everything it records goes to SEEN, never to its stdout, which is a job's
 * log; everything it answers comes from FIXTURES/<account of the tree it was given>.
 */
function fakeEngine(directory: string): void {
  mkdirSync(join(directory, "tf"), { recursive: true });
  mkdirSync(join(directory, "profiles"), { recursive: true });
  writeFileSync(join(directory, "profiles", "bare.sh"), "#!/bin/bash\n# devbox-note: nothing\n");
  writeFileSync(join(directory, "profiles", "needs-github.sh"), "#!/bin/bash\n# devbox-secrets: github\n");
  writeFileSync(
    join(directory, "devbox"),
    [
      "#!/usr/bin/env bash",
      `seen=${JSON.stringify(SEEN)}`,
      `fixtures=${JSON.stringify(FIXTURES)}`,
      'engine=$(cd "$(dirname "$0")" && pwd)',
      'mkdir -p "$seen"',
      'id="$$-$RANDOM"',
      "{",
      "  printf 'verb=%s\\n' \"$1\"",
      "  printf 'argv=%s\\n' \"$*\"",
      "  printf 'tf=%s\\n' \"$DEVBOX_TF_ROOT\"",
      "  printf 'home=%s\\n' \"$HOME\"",
      "  printf 'config=%s\\n' \"$DEVBOX_CONFIG_DIR\"",
      "  printf 'key=%s\\n' \"$DEVBOX_KEY\"",
      "  printf 'secrets=%s\\n' \"$DEVBOX_SECRETS_DIR\"",
      '} > "$seen/call-$id"',
      'env > "$seen/env-$id"',
      // The launch directory as the child found it: every file, with its bytes.
      'for f in "$DEVBOX_SECRETS_DIR"/*; do [ -f "$f" ] && printf \'%s=%s\\n\' "${f##*/}" "$(cat "$f")"; done > "$seen/launch-$id"',
      // Which account's tree this is: the answers are that tree's and no other.
      'account=$(basename "$(dirname "$DEVBOX_TF_ROOT")")',
      'here="$fixtures/$account"',
      'case "$1" in',
      '  ls) cat "$here/ls.json" 2>/dev/null || printf \'[]\' ;;',
      '  info)',
      '    if [ -f "$here/info-$2.json" ]; then cat "$here/info-$2.json"; else printf "x no machine named \'%s\'\\n" "$2" >&2; exit 1; fi ;;',
      "  profiles)",
      '    listed=" "; first=1; printf "["',
      '    for dir in "$DEVBOX_CONFIG_DIR/profiles" "$engine/profiles"; do',
      '      for f in "$dir"/*.sh; do',
      '        [ -f "$f" ] || continue',
      '        n=$(basename "$f" .sh)',
      '        case "$listed" in *" $n "*) continue ;; esac',
      '        listed="$listed$n "',
      "        declared=$(sed -n 's/^# devbox-secrets:[[:space:]]*//p' \"$f\" | head -1)",
      '        list=""; for s in $declared; do list="$list${list:+,}\\"$s\\""; done',
      '        [ "$first" = 1 ] || printf ","',
      "        first=0",
      '        printf \'{"name":"%s","path":"%s","repo":null,"secrets":[%s],"note":null,"min_cpu":null,"min_ram":null,"min_disk":null,"port":null}\' "$n" "$f" "$list"',
      "      done",
      "    done",
      '    printf "]" ;;',
      "  probe) sleep 0.3; printf '[]' ;;",
      "  orphans) printf '[]' ;;",
      "  up|seed|down)",
      '    name=""; previous=""',
      '    for a in "$@"; do [ "$previous" = "--name" ] && name=$a; previous=$a; done',
      '    if [ -z "$name" ]; then for a in "${@:2}"; do case "$a" in -*) ;; *) name=$a; break ;; esac; done; fi',
      '    : > "$seen/started-$account-$name"',
      // Held while the test says so, and never longer than thirty seconds.
      '    waited=0; while [ -e "$fixtures/hold-$name" ] && [ "$waited" -lt 600 ]; do sleep 0.05; waited=$((waited + 1)); done',
      '    echo "done $1 $name" ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** A fleet for one account's tree: the fake lists it, and the tree holds a workspace for each. */
function fleet(account: number, machines: ReturnType<typeof machine>[]): void {
  const here = join(FIXTURES, String(account));
  mkdirSync(here, { recursive: true });
  writeFileSync(join(here, "ls.json"), JSON.stringify(machines));
  for (const one of machines) {
    writeFileSync(
      join(here, `info-${one.name}.json`),
      JSON.stringify({ ...one, fingerprint: null, note: null, kube_port: 16443 }),
    );
    mkdirSync(join(treeOf(account), "tf", one.cloud, "terraform.tfstate.d", one.name), { recursive: true });
  }
}

type Answer = { status: number; text: string; body: Record<string, unknown>; cookie: string };

async function fetched(base: string, path: string, init: RequestInit): Promise<Answer> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A test that wanted JSON says so on `status`.
  }
  return { status: response.status, text, body, cookie: response.headers.get("set-cookie") ?? "" };
}

/** A browser, as one account: its cookie, its anti-CSRF token, and everything it was answered. */
type Browser = {
  cookie: string;
  csrf: string;
  saw: string[];
  get(path: string, headers?: Record<string, string>): Promise<Answer>;
  write(method: string, path: string, value?: unknown, headers?: Record<string, string>): Promise<Answer>;
};

function browser(base: () => string, cookie: string, csrf: string): Browser {
  const self: Browser = {
    cookie,
    csrf,
    saw: [],
    async get(path, headers = {}) {
      const answer = await fetched(base(), path, { headers: { Cookie: self.cookie, ...headers } });
      self.saw.push(answer.text);
      return answer;
    },
    async write(method, path, value, headers = {}) {
      const answer = await fetched(base(), path, {
        method,
        headers: {
          Cookie: self.cookie,
          Origin: PUBLIC_URL,
          "X-CSRF": self.csrf,
          "Content-Type": "application/json",
          ...headers,
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
      self.saw.push(answer.text);
      return answer;
    },
  };
  return self;
}

type Call = { id: string; verb: string; argv: string; tf: string; home: string; config: string; key: string; secrets: string };

/** Every call the fake recorded, oldest unknown: the ids are pids, and order is not the point. */
function calls(): Call[] {
  if (!existsSync(SEEN)) return [];
  return readdirSync(SEEN)
    .filter((name) => name.startsWith("call-"))
    .map((name) => {
      const fields = Object.fromEntries(
        readFileSync(join(SEEN, name), "utf8")
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      ) as Record<string, string>;
      return { id: name.slice("call-".length), ...fields } as Call;
    });
}

const inTree = (call: Call, tree: string) => call.tf === join(tree, "tf");

/** What a child of that call was handed: its record, its environment, its launch directory. */
const handed = (call: Call): string =>
  ["call", "env", "launch"]
    .map((kind) => join(SEEN, `${kind}-${call.id}`))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

function database(): Database {
  return new Database(join(DATA, "devbox.db"), { readonly: true });
}

function rows<T>(sql: string): T[] {
  const db = database();
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

const spec = (note: string) => ({ note, software: [], secrets: [], repos: [], cpu: null, ram: null, disk: null, port: null });

describe("two accounts on one service", () => {
  let server: Server | null = null;
  let base = "";
  const at = () => base;
  let a: Browser;
  let b: Browser;

  /**
   * A Google sign-in as that address, its subject the address itself: the same identity each time.
   * A Workspace account's (`hd`), which Google vouches for: A founds with it.
   */
  async function signIn(email: string): Promise<Browser> {
    const answer = await signInAs(base, "google", { sub: `google-${email}`, email, hd: "devbox.test" });
    expect(answer.cookie, `${email} signs in`).not.toBe("");
    return browser(at, answer.cookie, answer.csrf);
  }

  /** Waits for a job of that account to leave `running`, asked as that account. */
  async function settled(who: Browser, id: number): Promise<Record<string, unknown>> {
    for (let i = 0; i < 600; i += 1) {
      const job = await who.get(`/api/jobs/${id}`);
      if (job.status !== 200) throw new Error(`job ${id}: ${job.status} ${job.text}`);
      if (job.body.state !== "running") return job.body;
      await Bun.sleep(25);
    }
    throw new Error(`job ${id} never finished`);
  }

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(join(ROOT, "legacy"), { recursive: true });
    // The service's own: a token in its unit, a file on its disk - account 1's at the founding.
    writeFileSync(join(ROOT, "legacy", "github"), GITHUB_FILE);
    fleet(1, [machine("devbox-alice")]);
    fleet(2, [machine("devbox-bob")]);

    server = await startServer({
      root: ROOT,
      engine: fakeEngine,
      env: {
        PUBLIC_URL,
        DEVBOX_FOUNDER_EMAIL: A_EMAIL,
        DEVBOX_MASTER_KEY: newMasterKey(1),
        HCLOUD_TOKEN: HCLOUD_UNIT,
        // The service's cloud accounts are an extension's to share (src/extension.ts).
        DEVBOX_EXTENSION: join(import.meta.dir, "fixtures", "extension-service.ts"),
        TEST_OFF_SERVICE_FILE: join(ROOT, "off-service"),
        DEVBOX_MAX_JOBS: "3",
        DEVBOX_MAX_JOBS_PER_ACCOUNT: "2",
      },
    });
    base = server.base;

    a = await signIn(A_EMAIL);
    b = await signIn(B_EMAIL);
    expect((await b.get("/api/session")).body.account).toEqual({ id: 2, email: B_EMAIL });
  }, 30_000);

  afterAll(async () => {
    for (const name of readdirSync(FIXTURES).filter((one) => one.startsWith("hold-"))) {
      rmSync(join(FIXTURES, name), { force: true });
    }
    await stopServer(server);
  });

  test("says the caps it took at startup", () => {
    expect(server?.out.stdout).toContain("jobs: at most 3 at once, 2 per account");
  });

  test("each account lists its own fleet, out of its own tree, with its own key", async () => {
    const mine = await a.get("/api/machines");
    const theirs = await b.get("/api/machines");
    expect((mine.body as unknown as { name: string }[]).map((one) => one.name)).toEqual(["devbox-alice"]);
    expect((theirs.body as unknown as { name: string }[]).map((one) => one.name)).toEqual(["devbox-bob"]);

    // The four variables of every call, each under the tree of the account it was made for.
    for (const call of calls()) {
      const tree = inTree(call, A_TREE) ? A_TREE : B_TREE;
      expect(call.tf).toBe(join(tree, "tf"));
      expect(call.home).toBe(join(tree, "home"));
      expect(call.config).toBe(join(tree, "config"));
      expect(call.key).toBe(join(tree, "home", ".ssh", "devbox"));
    }
    expect(calls().some((call) => inTree(call, B_TREE) && call.verb === "ls")).toBe(true);

    // Two pairs, each the service's own, 0600.
    const aKey = join(A_TREE, "home", ".ssh", "devbox");
    const bKey = join(B_TREE, "home", ".ssh", "devbox");
    expect(readFileSync(aKey, "utf8")).not.toBe(readFileSync(bKey, "utf8"));
    expect(statSync(aKey).mode & 0o777).toBe(0o600);
    expect(statSync(bKey).mode & 0o777).toBe(0o600);
  });

  test("A plants its secrets, every profile secret marked", async () => {
    for (const [kind, name, value] of [
      ["cloud", "HCLOUD_TOKEN", A_HCLOUD],
      ["profile", "github", A_GITHUB],
      ["profile", "claude", A_CLAUDE],
    ] as const) {
      const put = await a.write("PUT", `/api/secrets/${kind}/${name}`, { value });
      expect(put.status, name).toBe(200);
      expect(put.text).not.toContain(MARK);
    }
  });

  test("B reaches none of A's machine: 404 everywhere, no job, no devbox launched", async () => {
    const before = calls().length;

    expect((await b.get("/api/machines/devbox-alice")).status).toBe(404);
    expect((await b.write("POST", "/api/machines/devbox-alice/seed", {})).status).toBe(404);
    expect((await b.write("POST", "/api/machines/devbox-alice/destroy", { confirm: "devbox-alice" })).status).toBe(404);
    expect((await b.get("/api/machines/devbox-alice/terminal", { "X-CSRF": b.csrf, Origin: PUBLIC_URL })).status).toBe(404);
    // The same answer as a name nobody holds: nothing says the machine exists elsewhere.
    const unknown = await b.get("/api/machines/devbox-nobody");
    const alices = await b.get("/api/machines/devbox-alice");
    expect(alices.text).toBe(unknown.text.replace("devbox-nobody", "devbox-alice"));

    expect(calls().length).toBe(before);
    expect(rows<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")[0]?.n).toBe(0);
    expect((await b.get("/api/jobs")).body as unknown).toEqual([]);

    // And A reads its own, in its own tree.
    const detail = await a.get("/api/machines/devbox-alice");
    expect(detail.status).toBe(200);
    expect(calls().filter((call) => call.verb === "info").every((call) => inTree(call, A_TREE))).toBe(true);
  });

  test("B orders on the service's cloud account - the founder's token - and imports nothing", async () => {
    expect((await b.get("/api/session")).body).toMatchObject({ clouds: ["hetzner"], secrets_dir: null });
    // The service's variables and files become the founder's vault, and nobody else's.
    expect((await b.write("POST", "/api/secrets/import", {})).status).toBe(403);
    // B's settings describe B's own credentials: none, on a cloud that is the service's.
    const listed = (await b.get("/api/secrets")).body.clouds as {
      cloud: string;
      usable: boolean;
      via: string | null;
      fields: { set: boolean; source: string | null; fingerprint: string | null }[];
    }[];
    const hetzner = listed.find((one) => one.cloud === "hetzner");
    expect(hetzner).toMatchObject({ usable: true, via: "service" });
    expect(hetzner?.fields.every((field) => !field.set && field.source === null && field.fingerprint === null)).toBe(true);

    // A probe on B's behalf is handed the founder's token, in B's tree, and no profile secret.
    const before = new Set(calls().map((call) => call.id));
    expect((await b.get("/api/probe?cpu=2")).status).toBe(200);
    const probe = calls().find((call) => !before.has(call.id) && call.verb === "probe");
    expect(probe).toBeDefined();
    if (probe === undefined) return;
    expect(inTree(probe, B_TREE)).toBe(true);
    expect(readFileSync(join(SEEN, `env-${probe.id}`), "utf8")).toContain(`HCLOUD_TOKEN=${A_HCLOUD}\n`);
    expect(handed(probe)).not.toContain(MARK);
    expect(rows<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")[0]?.n).toBe(0);
  });

  let bJob = 0;

  test("B's own order runs in B's tree, with B's token and none of A's secrets", async () => {
    expect((await b.write("PUT", "/api/secrets/cloud/HCLOUD_TOKEN", { value: B_HCLOUD })).status).toBe(200);
    expect((await b.get("/api/session")).body).toMatchObject({ clouds: ["hetzner"] });

    // A profile whose secret only A holds: 412, before a job - A's github is not B's.
    const needy = await b.write("POST", "/api/machines", { profile: "needs-github", cloud: "hetzner", name: "devbox-bobneed" });
    expect(needy.status).toBe(412);
    expect(String(needy.body.error)).toContain("github");
    expect(rows<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")[0]?.n).toBe(0);

    const started = await b.write("POST", "/api/machines", { profile: "bare", cloud: "hetzner", name: "devbox-bob2" });
    expect(started.status).toBe(200);
    bJob = started.body.job as number;
    expect((await settled(b, bJob)).state).toBe("succeeded");

    const up = calls().find((call) => call.verb === "up" && call.argv.includes("devbox-bob2"));
    expect(up).toBeDefined();
    if (up === undefined) return;
    expect(inTree(up, B_TREE)).toBe(true);
    expect(readFileSync(join(SEEN, `env-${up.id}`), "utf8")).toContain(`HCLOUD_TOKEN=${B_HCLOUD}\n`);
    expect(readFileSync(join(SEEN, `launch-${up.id}`), "utf8")).toBe("");
    expect(handed(up)).not.toContain(MARK);
    // The launch directory went with the child.
    expect(existsSync(up.secrets)).toBe(false);
  });

  test("jobs and logs do not cross: another account's id is a 404, never a 403", async () => {
    expect((await a.get("/api/jobs")).body as unknown).toEqual([]);
    expect((await a.get(`/api/jobs/${bJob}`)).status).toBe(404);
    expect((await a.get(`/api/jobs/${bJob}/log`)).status).toBe(404);
    // Indistinguishable from an id nobody holds.
    expect((await a.get(`/api/jobs/${bJob}`)).text).toBe((await a.get("/api/jobs/999999")).text);

    const mine = await b.get(`/api/jobs/${bJob}/log`);
    expect(mine.status).toBe(200);
    expect(mine.text).toContain("done up devbox-bob2");
  });

  test("labels do not cross, even on the same machine name", async () => {
    expect((await a.write("POST", "/api/machines/devbox-alice/label", { label: "Alice's" })).status).toBe(200);
    expect((await b.write("POST", "/api/machines/devbox-alice/label", { label: "Bob's try" })).status).toBe(200);

    const listed = (await a.get("/api/machines")).body as unknown as { name: string; label: string | null }[];
    expect(listed.find((one) => one.name === "devbox-alice")?.label).toBe("Alice's");
    expect((await a.get("/api/machines/devbox-alice")).body.label).toBe("Alice's");
    expect(((await b.get("/api/machines")).body as unknown as { name: string }[]).map((one) => one.name)).toEqual([
      "devbox-bob",
    ]);
  });

  test("composed profiles do not cross: one name, two profiles, each rendered in its own tree", async () => {
    expect((await a.write("PUT", "/api/profiles/alice-only", spec("only A's"))).status).toBe(200);
    expect((await a.write("PUT", "/api/profiles/shared", spec("A's"))).status).toBe(200);
    expect((await b.write("PUT", "/api/profiles/shared", spec("B's"))).status).toBe(200);

    type Listed = { name: string; path: string; authored: { note: string } | null };
    const aList = (await a.get("/api/profiles")).body as unknown as Listed[];
    const bList = (await b.get("/api/profiles")).body as unknown as Listed[];
    expect(aList.find((one) => one.name === "shared")?.authored?.note).toBe("A's");
    expect(bList.find((one) => one.name === "shared")?.authored?.note).toBe("B's");
    expect(bList.map((one) => one.name)).not.toContain("alice-only");
    expect(existsSync(join(B_TREE, "config", "profiles", "alice-only.sh"))).toBe(false);
    expect(readFileSync(join(A_TREE, "config", "profiles", "shared.sh"), "utf8")).toContain("A's");
    expect(readFileSync(join(B_TREE, "config", "profiles", "shared.sh"), "utf8")).toContain("B's");

    expect(rows("SELECT account_id, name FROM profiles ORDER BY account_id, name")).toEqual([
      { account_id: 1, name: "alice-only" },
      { account_id: 1, name: "shared" },
      { account_id: 2, name: "shared" },
    ]);
  });

  test("a profile deposited by hand in A's tree is A's alone", async () => {
    const handmade = join(A_TREE, "config", "profiles", "handmade.sh");
    writeFileSync(handmade, "#!/bin/bash\n# devbox-secrets: github\n# written by hand\n");

    type Listed = { name: string; path: string; authored: unknown };
    const aList = (await a.get("/api/profiles")).body as unknown as Listed[];
    expect(aList.find((one) => one.name === "handmade")).toMatchObject({ path: handmade, authored: null });
    expect(((await b.get("/api/profiles")).body as unknown as Listed[]).map((one) => one.name)).not.toContain(
      "handmade",
    );

    // A may not compose over a file it did not write; B has no such file, and may.
    const refused = await a.write("PUT", "/api/profiles/handmade", spec("over A's file"));
    expect(refused.status).toBe(409);
    expect(readFileSync(handmade, "utf8")).toContain("written by hand");
    const accepted = await b.write("PUT", "/api/profiles/handmade", spec("B's own handmade"));
    expect(accepted.status).toBe(200);
    expect(readFileSync(join(B_TREE, "config", "profiles", "handmade.sh"), "utf8").split("\n")[1]).toBe(SENTINEL);
    expect(readFileSync(handmade, "utf8")).toContain("written by hand");
  });

  test("a secret set by B is B's alone, and B deletes nothing of A's", async () => {
    expect((await b.write("PUT", "/api/secrets/profile/bob-only", { value: "bob-value-1234" })).status).toBe(200);
    const aSecrets = await a.get("/api/secrets");
    expect((aSecrets.body.profile as { name: string }[]).map((one) => one.name)).not.toContain("bob-only");
    expect(rows("SELECT DISTINCT owner_id FROM secrets WHERE name = 'bob-only'")).toEqual([{ owner_id: 2 }]);

    expect((await b.write("DELETE", "/api/secrets/profile/claude")).status).toBe(404);
    const after = (await a.get("/api/secrets")).body.profile as { name: string; source: string | null }[];
    expect(after.find((one) => one.name === "claude")?.source).toBe("db");
  });

  test("B's credential test tries B's token, and never A's", async () => {
    const scaleway = await b.write("POST", "/api/clouds/scaleway/test", { values: {} });
    expect(scaleway.body.ok).toBe(false);
    expect(String(scaleway.body.error)).toContain("nothing holds");

    const before = new Set(calls().map((call) => call.id));
    const tried = await b.write("POST", "/api/clouds/hetzner/test", { values: {} });
    expect(tried.status).toBe(200);
    const probe = calls().find((call) => !before.has(call.id) && call.verb === "probe");
    expect(probe).toBeDefined();
    if (probe === undefined) return;
    expect(inTree(probe, B_TREE)).toBe(true);
    expect(readFileSync(join(SEEN, `env-${probe.id}`), "utf8")).toContain(`HCLOUD_TOKEN=${B_HCLOUD}\n`);
    expect(handed(probe)).not.toContain(MARK);
  });

  test("a cloud B saves whole is B's alone, and moves nothing A holds", async () => {
    const aBefore = (await a.get("/api/secrets")).body.clouds;
    const saved = await b.write("PUT", "/api/clouds/scaleway", {
      values: {
        SCW_ACCESS_KEY: "SCWBOBBOBBOBBOBBOBBO",
        SCW_SECRET_KEY: "bob-scw-secret-0000",
        SCW_DEFAULT_PROJECT_ID: "bob-scw-project-0000",
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ cloud: "scaleway", usable: true });
    expect(rows("SELECT DISTINCT owner_id FROM secrets WHERE name LIKE 'SCW_%'")).toEqual([{ owner_id: 2 }]);
    expect((await a.get("/api/secrets")).body.clouds).toEqual(aBefore);

    // A's session cannot write B's cloud under B's name either: the write lands in A's vault.
    const aPut = await a.write("PUT", "/api/clouds/scaleway", { values: { SCW_ACCESS_KEY: "SCWALICEALICEALICEAL" } });
    expect(aPut.status).toBe(200);
    expect(rows("SELECT owner_id, name FROM secrets WHERE name LIKE 'SCW_%' ORDER BY owner_id, name")).toEqual([
      { owner_id: 1, name: "SCW_ACCESS_KEY" },
      { owner_id: 2, name: "SCW_ACCESS_KEY" },
      { owner_id: 2, name: "SCW_DEFAULT_PROJECT_ID" },
      { owner_id: 2, name: "SCW_SECRET_KEY" },
    ]);

    // Put back as it was, so the probes and orphans below meet the clouds they always did.
    for (const name of ["SCW_ACCESS_KEY", "SCW_SECRET_KEY", "SCW_DEFAULT_PROJECT_ID"]) {
      expect((await b.write("DELETE", `/api/secrets/cloud/${name}`)).status).toBe(200);
    }
    expect((await a.write("DELETE", "/api/secrets/cloud/SCW_ACCESS_KEY")).status).toBe(200);
    expect((await b.get("/api/session")).body.clouds).toEqual(["hetzner"]);
  });

  test("two identical probes of A and B are two children, never one answer shared", async () => {
    const count = (tree: string) => calls().filter((call) => call.verb === "probe" && inTree(call, tree)).length;
    const [aBefore, bBefore] = [count(A_TREE), count(B_TREE)];
    const [aProbe, bProbe] = await Promise.all([a.get("/api/probe?cpu=2"), b.get("/api/probe?cpu=2")]);
    expect(aProbe.status).toBe(200);
    expect(bProbe.status).toBe(200);
    expect(count(A_TREE)).toBe(aBefore + 1);
    expect(count(B_TREE)).toBe(bBefore + 1);
  });

  test("orphans are refused on a provider account two accounts order on, and kept on one's own", async () => {
    // B orders on a Hetzner token of its own since, so nobody shares the founder's: both list.
    expect((await a.get("/api/orphans")).status).toBe(200);
    expect((await b.get("/api/orphans")).status).toBe(200);

    // B's own token gone, B is back on the service's - and DELETE says whose answers now.
    expect((await b.write("DELETE", "/api/secrets/cloud/HCLOUD_TOKEN")).body).toEqual({ deleted: true, fallback: "service" });
    const before = calls().filter((call) => call.verb === "orphans").length;
    for (const who of [b, a]) {
      const refused = await who.get("/api/orphans");
      expect(refused.status).toBe(409);
      expect(refused.body.clouds).toEqual(["hetzner"]);
      expect(String(refused.body.error)).toContain("other accounts");
    }
    expect(calls().filter((call) => call.verb === "orphans").length).toBe(before);

    // B on its own again: each provider account has one account on it, and both list.
    expect((await b.write("PUT", "/api/secrets/cloud/HCLOUD_TOKEN", { value: B_HCLOUD })).status).toBe(200);
    expect((await a.get("/api/orphans")).status).toBe(200);
    expect((await b.get("/api/orphans")).status).toBe(200);
  });

  test("B taken off the service's cloud accounts still destroys what it ordered there", async () => {
    // A lapsed subscription, a removed exemption: the extension stops putting B on the service's
    // cloud accounts while devbox-bob still runs on them. Ordering is closed; destroying is not.
    const flag = join(ROOT, "off-service");
    // Earlier tests may have left B a Hetzner token of its own: set aside for this one, so that
    // devbox-bob's cloud answers only through the service, as for an account that never had one.
    const hetzner = ((await b.get("/api/secrets")).body.clouds as { cloud: string; via: string | null }[]).find(
      (one) => one.cloud === "hetzner",
    );
    const ownToken = hetzner?.via === "own";
    if (ownToken) expect((await b.write("DELETE", "/api/secrets/cloud/HCLOUD_TOKEN")).status).toBe(200);
    writeFileSync(flag, B_EMAIL);
    try {
      expect((await b.get("/api/session")).body).toMatchObject({ clouds: [] });
      const destroyed = await b.write("POST", "/api/machines/devbox-bob/destroy", { confirm: "devbox-bob" });
      expect(destroyed.status, destroyed.text).toBe(200);
      expect((await settled(b, destroyed.body.job as number)).state).toBe("succeeded");
      const down = calls().find((call) => call.verb === "down" && call.argv.includes("devbox-bob"));
      expect(down).toBeDefined();
      if (down === undefined) return;
      expect(inTree(down, B_TREE)).toBe(true);
      // The service's token - the founder's vault or, behind it, the unit's - and never one of B's.
      const handedEnv = readFileSync(join(SEEN, `env-${down.id}`), "utf8");
      expect([`HCLOUD_TOKEN=${A_HCLOUD}\n`, `HCLOUD_TOKEN=${HCLOUD_UNIT}\n`].some((line) => handedEnv.includes(line))).toBe(true);
      expect(handedEnv).not.toContain(B_HCLOUD);
      expect(handed(down)).not.toContain(MARK);
    } finally {
      rmSync(flag, { force: true });
      if (ownToken) await b.write("PUT", "/api/secrets/cloud/HCLOUD_TOKEN", { value: B_HCLOUD });
    }
    expect((await b.get("/api/session")).body).toMatchObject({ clouds: ["hetzner"] });
  });

  test("CLI tokens: another account's is a 404, and goes on working", async () => {
    expect((await a.write("POST", "/api/account/tokens", { label: "  " })).body).toMatchObject({ field: "label" });

    const created = await a.write("POST", "/api/account/tokens", { label: "A's CLI" });
    expect(created.status).toBe(201);
    const aToken = String(created.body.token);
    const aTokenId = created.body.id as number;
    expect(aToken).toStartWith("dvb_");
    expect(created.body).toMatchObject({ id: aTokenId, label: "A's CLI", created_at: expect.any(Number) });

    const listed = await a.get("/api/account/tokens");
    expect(listed.body as unknown).toEqual([{ id: aTokenId, label: "A's CLI", created_at: expect.any(Number), used_at: null }]);
    expect(listed.text).not.toContain(aToken);
    // Nor stored: only a digest is.
    expect(JSON.stringify(rows("SELECT * FROM api_tokens"))).not.toContain(aToken);

    expect((await b.get("/api/account/tokens")).body as unknown).toEqual([]);
    expect((await b.write("DELETE", `/api/account/tokens/${aTokenId}`)).status).toBe(404);
    expect((await b.write("DELETE", "/api/account/tokens/999999")).text).toBe(
      (await b.write("DELETE", `/api/account/tokens/${aTokenId}`)).text,
    );

    const aBearer = { Authorization: `Bearer ${aToken}` };
    const fleetByToken = await fetched(base, "/api/machines", { headers: aBearer });
    expect(fleetByToken.status).toBe(200);
    expect((fleetByToken.body as unknown as { name: string }[]).map((one) => one.name)).toEqual(["devbox-alice"]);

    // The token itself reaches none of the account routes, reads included.
    expect((await fetched(base, "/api/account/tokens", { headers: aBearer })).status).toBe(401);
    expect(
      (
        await fetched(base, "/api/account/tokens", {
          method: "POST",
          headers: { ...aBearer, "Content-Type": "application/json" },
          body: JSON.stringify({ label: "minted by a token" }),
        })
      ).status,
    ).toBe(401);

    // B's token reads B's secrets, and writes none.
    const bCreated = await b.write("POST", "/api/account/tokens", { label: "B's CLI" });
    const bBearer = { Authorization: `Bearer ${String(bCreated.body.token)}` };
    const bSecrets = await fetched(base, "/api/secrets", { headers: bBearer });
    expect(bSecrets.status).toBe(200);
    b.saw.push(bSecrets.text);
    expect((bSecrets.body.profile as { name: string }[]).map((one) => one.name)).toContain("bob-only");
    expect(
      (
        await fetched(base, "/api/secrets/profile/bob-only", {
          method: "PUT",
          headers: { ...bBearer, "Content-Type": "application/json" },
          body: JSON.stringify({ value: "written by a token" }),
        })
      ).status,
    ).toBe(401);

    expect((await a.write("DELETE", `/api/account/tokens/${aTokenId}`)).body).toEqual({ ok: true });
    expect((await fetched(base, "/api/machines", { headers: aBearer })).status).toBe(401);
  });

  test("no route lists the accounts, nor switches what one may spend", async () => {
    // Every account orders on the service's cloud accounts: there is nothing left to decide per
    // account, and so no list of them for the founder to decide on.
    for (const who of [a, b]) expect((await who.get("/api/accounts")).status).not.toBe(200);
    expect((await a.write("PUT", "/api/accounts/2/service-fallback", { allowed: false })).status).not.toBe(200);
    expect((await b.get("/api/session")).body.account).toEqual({ id: 2, email: B_EMAIL });
  });

  test("B's cookie with A's anti-CSRF token is refused, and an anonymous session is told nothing", async () => {
    const forged = await fetched(base, "/api/profiles/forged", {
      method: "PUT",
      headers: { Cookie: b.cookie, Origin: PUBLIC_URL, "X-CSRF": a.csrf, "Content-Type": "application/json" },
      body: JSON.stringify(spec("forged")),
    });
    expect(forged.status).toBe(403);
    expect(existsSync(join(B_TREE, "config", "profiles", "forged.sh"))).toBe(false);
    expect((await fetched(base, "/api/session", {})).body).toMatchObject({ clouds: [], secrets_dir: null });
  });

  test("several jobs at once: two machines of A run together, and the rules that still refuse", async () => {
    for (const name of ["devbox-a1", "devbox-a2", "devbox-b3"]) writeFileSync(join(FIXTURES, `hold-${name}`), "");
    const order = (who: Browser, name: string) =>
      who.write("POST", "/api/machines", { profile: "bare", cloud: "hetzner", name });

    const first = await order(a, "devbox-a1");
    const second = await order(a, "devbox-a2");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [j1, j2] = [first.body.job as number, second.body.job as number];

    // Both children alive at the same moment: each has started, and neither has been released.
    for (let i = 0; i < 400; i += 1) {
      if (existsSync(join(SEEN, "started-1-devbox-a1")) && existsSync(join(SEEN, "started-1-devbox-a2"))) break;
      await Bun.sleep(25);
    }
    expect(existsSync(join(SEEN, "started-1-devbox-a1"))).toBe(true);
    expect(existsSync(join(SEEN, "started-1-devbox-a2"))).toBe(true);
    const running = (await a.get("/api/jobs")).body as unknown as { id: number; state: string }[];
    expect(running.filter((job) => job.state === "running").map((job) => job.id).sort()).toEqual([j1, j2].sort());

    // A second job on the same machine names the one that holds it: the same account's.
    const same = await order(a, "devbox-a1");
    expect(same.status).toBe(409);
    expect(same.body.job).toBe(j1);

    // A's own cap: named, and no job.
    const capped = await order(a, "devbox-a3");
    expect(capped.status).toBe(409);
    expect(String(capped.body.error)).toContain("DEVBOX_MAX_JOBS_PER_ACCOUNT");
    expect(Object.keys(capped.body)).toEqual(["error"]);

    // B fills the service.
    const third = await order(b, "devbox-b3");
    expect(third.status).toBe(200);
    const j3 = third.body.job as number;

    // The service's cap, as B meets it: named, and not one of A's jobs in the answer.
    const full = await order(b, "devbox-b4");
    expect(full.status).toBe(409);
    expect(String(full.body.error)).toContain("(DEVBOX_MAX_JOBS)");
    expect(Object.keys(full.body)).toEqual(["error"]);

    // B's own busy machine names B's own job, and never A's.
    const bSame = await order(b, "devbox-b3");
    expect(bSame.status).toBe(409);
    expect(bSame.body.job).toBe(j3);
    for (const refusal of [full, bSame]) {
      expect(refusal.body.job === j1 || refusal.body.job === j2).toBe(false);
    }

    for (const name of ["devbox-a1", "devbox-a2", "devbox-b3"]) rmSync(join(FIXTURES, `hold-${name}`), { force: true });
    expect((await settled(a, j1)).state).toBe("succeeded");
    expect((await settled(a, j2)).state).toBe("succeeded");
    expect((await settled(b, j3)).state).toBe("succeeded");
    expect(
      rows("SELECT machine FROM jobs WHERE machine IN ('devbox-a3', 'devbox-b4')"),
    ).toEqual([]);
  }, 30_000);

  test("an address is for good, account 1's included: no route changes it", async () => {
    const moved = await a.write("PUT", "/api/account/email", { email: "alice2@devbox.test" });
    expect(moved.status).not.toBe(200);
    expect((await a.get("/api/session")).body).toMatchObject({ account: { id: 1, email: A_EMAIL } });
    // Nor does a provider: the same identity back with another verified address opens account 1,
    // which keeps the address it was founded with.
    const renamed = await signInAs(base, "google", { sub: `google-${A_EMAIL}`, email: "alice2@devbox.test" });
    expect(renamed.account).toEqual({ id: 1, email: A_EMAIL });
  });

  test("signing out everywhere closes every session of B, and none of A's", async () => {
    const bOther = await signIn(B_EMAIL);
    const closed = await b.write("POST", "/api/account/sessions/close");
    expect(closed.body).toEqual({ ok: true });
    expect(closed.cookie).toContain("Max-Age=0");
    expect((await b.get("/api/session")).body.authenticated).toBe(false);
    expect((await bOther.get("/api/session")).body.authenticated).toBe(false);
    expect((await a.get("/api/session")).body.authenticated).toBe(true);

    const back = await signIn(B_EMAIL);
    back.saw = b.saw;
    b = back;
  });

  /**
   * THE MEASUREMENT THIS FILE EXISTS FOR, taken before A grants B anything: nothing A planted,
   * and nothing of the service's own, reached B - not in an answer, not in an argv, not in an
   * environment, not in a launch directory.
   */
  test("B was never answered, nor handed, a single marked value", async () => {
    // A seed of A's with a profile secret, so that A's children hold marked values below.
    const needy = await a.write("POST", "/api/machines", { profile: "needs-github", cloud: "hetzner", name: "devbox-aneed" });
    expect(needy.status).toBe(200);
    expect((await settled(a, needy.body.job as number)).state).toBe("succeeded");

    expect(b.saw.length).toBeGreaterThan(40);
    for (const text of b.saw) expect(text).not.toContain(MARK);

    const bCalls = calls().filter((call) => inTree(call, B_TREE));
    expect(bCalls.length).toBeGreaterThan(5);
    for (const call of bCalls) {
      expect(handed(call), `${call.verb} ${call.id}`).not.toContain(MARK);
      expect(call.home.startsWith(B_TREE)).toBe(true);
    }
    // And A's children were handed A's values, which is what makes the line above a measurement.
    expect(calls().filter((call) => inTree(call, A_TREE)).some((call) => handed(call).includes(MARK))).toBe(true);
  });

  /**
   * Two terminals per account, and the refusal says whose limit it met: "close a tab of yours"
   * and "the service is full" are two different gestures. Last in this file because it adds a
   * machine to A's fleet, which the listings above compare whole.
   *
   * The machine's address is a listener of this test's own that accepts and never speaks: ssh2
   * waits there for a banner, so each terminal stays open - and counted - until it is closed.
   */
  test("terminals: two per account, and the refusal names this account's limit", async () => {
    const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const sockets: WebSocket[] = [];
    const path = "/api/machines/devbox-term/terminal";
    const asked = (who: Browser, name = "devbox-term") =>
      who.get(`/api/machines/${name}/terminal`, { "X-CSRF": who.csrf, Origin: PUBLIC_URL });
    try {
      fleet(1, [machine("devbox-alice"), machine("devbox-term", { ip: "127.0.0.1", port: silent.port })]);
      for (let i = 0; i < 2; i += 1) {
        // Bun's client takes headers, which a browser's does not: the cookie and the origin a
        // page would carry on its own. Its constructor is named through Bun's own overload,
        // which the DOM declaration of WebSocket hides from tsc here.
        const BunSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
        const socket = new BunSocket(`${base.replace("http://", "ws://")}${path}`, {
          protocols: ["devbox-term", a.csrf],
          headers: { Cookie: a.cookie, Origin: PUBLIC_URL },
        });
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.onopen = () => resolve();
          socket.onclose = (event) => reject(new Error(`terminal ${i} closed before opening: ${event.code}`));
        });
      }

      const refused = await asked(a);
      expect(refused.status).toBe(503);
      expect(String(refused.body.error)).toContain("this account already has 2 terminals open");
      // B's limit is B's: the same question goes through every check, to the upgrade a plain GET
      // cannot make.
      expect((await asked(b, "devbox-bob")).status).toBe(426);
    } finally {
      for (const socket of sockets) socket.close();
      silent.stop(true);
    }

    // Closed, they are counted no more.
    let after = await asked(a);
    for (let i = 0; i < 200 && after.status === 503; i += 1) {
      await Bun.sleep(25);
      after = await asked(a);
    }
    expect(after.status).toBe(426);
  }, 20_000);
});
