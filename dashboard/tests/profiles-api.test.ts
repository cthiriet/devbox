import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { SENTINEL } from "../src/profiles";
import { PROVIDER_ENV, serverCommand, signIn } from "./server-harness";

/**
 * The composed-profile routes, through the real server and against the real devbox-core.
 *
 * tests/profiles.test.ts pins what the renderer decides and tests/profiles-core.test.ts pins
 * that the bash can read it. What is left is the round trip, and it is the part nothing else
 * can show: a profile saved through a form has to come back out of `devbox profiles --json`,
 * with the secrets it declares counted against what this service holds - because that is the
 * answer /new greys a card on, and the one prepareLaunch refuses a job on.
 *
 * So the engine here is a wrapper: `profiles` goes to the real devbox-core, and `ls` answers
 * from a file this test writes. The fleet is the only thing a fixture has to stand in for -
 * a real one would want terraform, a provider and a machine that bills.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const ROOT = join(DATA_DIR, "profiles-api");
const DASHBOARD = join(import.meta.dir, "..");
const CORE = join(DASHBOARD, "..", "devbox-core");
const FLEET = join(ROOT, "fleet.json");
/**
 * Where the rendered file lands: the ASKING ACCOUNT's directory, not a service-wide one.
 * Account 1 is the one this test founds, and devbox reads $CONFIG_DIR/profiles before its
 * own - which is also what makes a profile deposited by hand private to that account.
 */
const COMPOSED = join(ROOT, "data", "accounts", "1", "config", "profiles");

const PUBLIC_URL = "http://devbox.test";
/** The address that founds account 1 here, as DEVBOX_FOUNDER_EMAIL names it. */
const EMAIL = "founder@devbox.test";
const TOKEN = "the-bearer-token-of-this-test";

const CANNOT_RUN = Bun.which("jq") === null || Bun.which("awk") === null;

const MACHINE = {
  name: "devbox-live",
  cloud: "hetzner",
  region: "fsn1",
  instance_type: "cx33",
  profile: "composed",
  hourly_eur: 0.01,
  ip: "203.0.113.7",
  user: "dev",
  port: 22,
  local_port: 2222,
  app_port: 3000,
};

const spec = (overrides: Record<string, unknown> = {}) => ({
  note: "composed in a test",
  software: ["claude"],
  secrets: [],
  repos: [{ url: "https://github.com/me/app", secret: "github", dir: null }],
  cpu: 2,
  ram: 4,
  disk: 40,
  port: null,
  ...overrides,
});

/** `profiles` from the real core, `ls` from a file: see the header. */
function engine(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "devbox"),
    [
      "#!/usr/bin/env bash",
      `case "$1" in`,
      `  profiles) exec ${JSON.stringify(CORE)} "$@" ;;`,
      `  ls) cat ${JSON.stringify(FLEET)} ;;`,
      "  *) echo '[]' ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // engineReady() looks for the profiles directory beside it; the real core reaches the
  // repository's own through its own $HERE, which is what a deployment ships.
  mkdirSync(join(dir, "profiles"), { recursive: true });
}

type Server = { child: Subprocess; base: string };

async function startServer(): Promise<Server> {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(FLEET, "[]");
  engine(join(ROOT, "engine"));

  const child = Bun.spawn(serverCommand(["server.ts"]), {
    cwd: DASHBOARD,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: join(ROOT, "home"),
      NODE_ENV: "test",
      PORT: "0",
      DATA_DIR: join(ROOT, "data"),
      ENGINE_DIR: join(ROOT, "engine"),
      SHELL_DIR: join(ROOT, "shell"),
      PUBLIC_DIR: join(ROOT, "public"),
      PUBLIC_URL,
      ...PROVIDER_ENV,
      DEVBOX_FOUNDER_EMAIL: EMAIL,
      DEVBOX_REMOTE_TOKEN: TOKEN,
      DEVBOX_SECRETS_DIR: join(ROOT, "legacy"),
      DEVBOX_KEY: join(ROOT, "home", "devbox"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let text = "";
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  for (let i = 0; i < 300; i += 1) {
    const found = /devbox on http:\/\/127\.0\.0\.1:(\d+)/.exec(text);
    if (found !== null) {
      void reader.cancel();
      return { child, base: `http://127.0.0.1:${found[1]}` };
    }
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  child.kill();
  throw new Error(`server.ts never said its port:\n${text}`);
}

type Call = { status: number; body: Record<string, unknown> };

async function call(base: string, path: string, init: RequestInit = {}): Promise<Call> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A test that wanted JSON says so on `status`.
  }
  return { status: response.status, body };
}

describe.skipIf(CANNOT_RUN)("composing a profile through the API", () => {
  let server: Server | null = null;
  let base = "";
  let session = { cookie: "", csrf: "" };

  const write = (path: string, method: string, value?: unknown) =>
    call(base, path, {
      method,
      headers: {
        Cookie: session.cookie,
        Origin: PUBLIC_URL,
        "X-CSRF": session.csrf,
        "Content-Type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });

  beforeAll(async () => {
    server = await startServer();
    base = server.base;
    // Before anything presents the CLI token: it is adopted by this very sign-in, and until
    // account 1 is founded a bearer call answers 503.
    const signed = await signIn(base, "google", { sub: "google-founder", email: EMAIL, hd: "devbox.test" });
    session = { cookie: signed.cookie, csrf: signed.csrf };
  });

  afterAll(async () => {
    server?.child.kill();
    await server?.child.exited;
  });

  test("the catalogue is served, and every entry names its secrets", async () => {
    const answer = await call(base, "/api/software", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(answer.status).toBe(200);
    const catalogue = answer.body as unknown as {
      software: { id: string; secrets: { name: string }[] }[];
      secrets: { name: string; label: string }[];
    };
    const entries = catalogue.software;
    expect(entries.map((one) => one.id)).toContain("claude");
    expect(entries.find((one) => one.id === "claude")?.secrets[0]?.name).toBe("claude");
    // And the secrets by name, for the pages that hold nothing else: /secrets and /new.
    expect(catalogue.secrets.find((one) => one.name === "github")?.label).toBe("GitHub token");
  });

  test("a preview writes nothing", async () => {
    const answer = await write("/api/profiles/preview", "POST", { name: "previewed", ...spec() });
    expect(answer.status).toBe(200);
    expect(answer.body.script).toContain("install_claude_code");
    expect(existsSync(join(COMPOSED, "previewed.sh"))).toBe(false);
  });

  test("a save writes the row and the file, and devbox lists what it wrote", async () => {
    const saved = await write("/api/profiles/composed", "PUT", spec());
    expect(saved.status).toBe(200);
    expect(saved.body.declared).toEqual(["claude", "github"]);
    expect(saved.body.required).toEqual(["claude", "github"]);

    const file = readFileSync(join(COMPOSED, "composed.sh"), "utf8");
    expect(file.split("\n")[1]).toBe(SENTINEL);
    expect(file).toBe(String(saved.body.script));

    // The round trip: the real devbox-core reads the file this save wrote.
    const listed = await call(base, "/api/profiles", { headers: { Authorization: `Bearer ${TOKEN}` } });
    const rows = listed.body as unknown as {
      name: string;
      secrets: string[];
      missing_secrets: string[];
      authored: { note: string } | null;
      own: boolean;
      min_cpu: number | null;
    }[];
    const mine = rows.find((row) => row.name === "composed");
    expect(mine?.secrets).toEqual(["claude", "github"]);
    // This service holds neither, so /new greys the card and prepareLaunch would refuse.
    expect(mine?.missing_secrets).toEqual(["claude", "github"]);
    expect(mine?.min_cpu).toBe(2);
    // The spec travels with the profile, so the form can be drawn again from one answer.
    expect(mine?.authored?.note).toBe("composed in a test");
    // And a profile the engine ships carries none.
    expect(rows.find((row) => row.name === "claude")?.authored).toBe(null);
    // The account's own, and the engine's: what /new and /profiles sort by.
    expect(mine?.own).toBe(true);
    expect(rows.find((row) => row.name === "claude")?.own).toBe(false);
  });

  test("a setup script comes back as it was stored, and needs a repository", async () => {
    const saved = await write("/api/profiles/scripted", "PUT", spec({ setup: "./scripts/devbox-setup.sh" }));
    expect(saved.status).toBe(200);
    expect(String(saved.body.script)).toContain("run_setup 'scripts/devbox-setup.sh'\n");
    expect(readFileSync(join(COMPOSED, "scripted.sh"), "utf8")).toBe(String(saved.body.script));

    // Stored under the path the server kept, so the form draws it back without the `./`.
    const listed = await call(base, "/api/profiles", { headers: { Authorization: `Bearer ${TOKEN}` } });
    const rows = listed.body as unknown as { name: string; authored: { setup: string | null } | null }[];
    expect(rows.find((row) => row.name === "scripted")?.authored?.setup).toBe("scripts/devbox-setup.sh");

    const refused = await write("/api/profiles/unscripted", "PUT", spec({ repos: [], setup: "setup.sh" }));
    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe("setup");
    expect(existsSync(join(COMPOSED, "unscripted.sh"))).toBe(false);
  });

  test("a name a published profile already has is refused", async () => {
    const answer = await write("/api/profiles/claude", "PUT", spec());
    expect(answer.status).toBe(400);
    expect(String(answer.body.error)).toContain("shadow");
  });

  test("a file this service did not write is never overwritten", async () => {
    mkdirSync(COMPOSED, { recursive: true });
    const path = join(COMPOSED, "byhand.sh");
    writeFileSync(path, "#!/bin/bash\n# devbox-secrets: private\n");

    const answer = await write("/api/profiles/byhand", "PUT", spec());
    expect(answer.status).toBe(409);
    expect(readFileSync(path, "utf8")).toBe("#!/bin/bash\n# devbox-secrets: private\n");
  });

  test("the CLI token cannot compose one", async () => {
    // The reason is the vault's, taken from the other end: a profile decides what runs as
    // root on a machine and which secrets are pushed into it.
    for (const [path, method] of [
      ["/api/profiles/composed", "PUT"],
      ["/api/profiles/preview", "POST"],
      ["/api/profiles/composed", "DELETE"],
    ] as const) {
      const answer = await call(base, path, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify(spec()),
      });
      expect(answer.status).toBe(401);
    }
    expect(existsSync(join(COMPOSED, "composed.sh"))).toBe(true);
  });

  test("a profile a live machine runs is not deleted", async () => {
    writeFileSync(FLEET, JSON.stringify([MACHINE]));
    const refused = await write("/api/profiles/composed", "DELETE");
    expect(refused.status).toBe(412);
    expect(refused.body.machines).toEqual(["devbox-live"]);
    expect(existsSync(join(COMPOSED, "composed.sh"))).toBe(true);
  });

  test("with nothing running it, the row and the file both go", async () => {
    writeFileSync(FLEET, "[]");
    const gone = await write("/api/profiles/composed", "DELETE");
    expect(gone.status).toBe(200);
    expect(gone.body).toEqual({ deleted: true, removed: true });
    expect(existsSync(join(COMPOSED, "composed.sh"))).toBe(false);

    const listed = await call(base, "/api/profiles", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect((listed.body as unknown as { name: string }[]).map((row) => row.name)).not.toContain("composed");
  });
});
