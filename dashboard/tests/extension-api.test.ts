import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { newMasterKey } from "../src/vault";
import { call, signIn, startServer, stopServer, type Server } from "./server-harness";

/**
 * The dashboard with and without a private extension (src/extension.ts), against the real
 * server.ts.
 *
 * Without one - the dashboard as published - a second account orders on nothing but what it
 * connected, and reads nothing the service holds: not the founder's vault, not the cloud token of
 * the unit, not a file of the service's directory. With one, the extension decides who orders on
 * the service's cloud accounts, may refuse an order before a job is written, and answers its own
 * routes under /api/ext/. Broken or missing, the start says so and the dashboard runs as if there
 * were none. Every value planted here carries QZXW: finding it in an answer is the failure.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const PUBLIC_URL = "http://devbox.test";
const HCLOUD = "hc-from-the-unit-QZXW";
const FIRST = "first@devbox.test";
const SECOND = "second@devbox.test";
const FIXTURES = join(import.meta.dir, "fixtures");

type Answer = { status: number; body: Record<string, unknown>; text: string; cookie: string };
type Browser = { cookie: string; csrf: string };

async function send(base: string, path: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A test that wanted JSON says so on `status`.
  }
  return { status: response.status, body, text, cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
}

const form = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: PUBLIC_URL },
  body: JSON.stringify(value),
});

/** A first Google sign-in as that address, a Workspace account's: FIRST founds account 1, anyone after is created. */
async function account(base: string, email: string): Promise<Browser> {
  const signed = await signIn(base, "google", { sub: `google-${email}`, email, hd: "devbox.test" });
  expect(signed.cookie, `${email} signs in`).not.toBe("");
  return { cookie: signed.cookie, csrf: signed.csrf };
}

const read = (base: string, who: Browser, path: string) => send(base, path, { headers: { Cookie: who.cookie } });

const write = (base: string, who: Browser, path: string, value: unknown = {}) =>
  send(base, path, {
    method: "POST",
    headers: { Cookie: who.cookie, Origin: PUBLIC_URL, "X-CSRF": who.csrf, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });

async function service(root: string, env: Record<string, string> = {}): Promise<Server> {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "legacy"), { recursive: true });
  // The service's own profile file, which answers for the founder alone whatever the extension.
  writeFileSync(join(root, "legacy", "github"), "ghp_service_file_QZXW");
  return startServer({
    root,
    env: { PUBLIC_URL, DEVBOX_FOUNDER_EMAIL: FIRST, DEVBOX_MASTER_KEY: newMasterKey(1), HCLOUD_TOKEN: HCLOUD, ...env },
  });
}

const said = (server: Server | null) => `${server?.out.stdout ?? ""}${server?.out.stderr ?? ""}`;

type Cloud = { cloud: string; usable: boolean; via: string | null };
const hetznerOf = (answer: Answer) => (answer.body.clouds as Cloud[]).find((one) => one.cloud === "hetzner");

describe("the dashboard as published: no extension", () => {
  const ROOT = join(DATA_DIR, "extension-none");
  let server: Server | null = null;
  let first: Browser;
  let second: Browser;

  beforeAll(async () => {
    // The harness's own DEVBOX_EXTENSION=none: a dashboard/extension/ a deployment left behind
    // must not turn this into a test of the private one.
    server = await service(ROOT);
    first = await account(server.base, FIRST);
    second = await account(server.base, SECOND);
  });
  afterAll(async () => {
    await stopServer(server);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("the start says there is none", () => {
    expect(said(server)).toContain("every account orders on its own cloud accounts");
    expect(said(server)).not.toContain("/!\\ the extension");
  });

  test("the first account keeps what the service held before it", async () => {
    const base = server?.base ?? "";
    expect((await read(base, first, "/api/session")).body).toMatchObject({ clouds: ["hetzner"] });
  });

  test("a second account orders on nothing it did not connect, and reads nothing of the service's", async () => {
    const base = server?.base ?? "";
    const mine = await read(base, second, "/api/session");
    expect(mine.body).toMatchObject({ account: { id: 2 }, clouds: [], configured: false, secrets_dir: null });
    const secrets = await read(base, second, "/api/secrets");
    expect(hetznerOf(secrets)).toMatchObject({ usable: false });
    expect(hetznerOf(secrets)?.via ?? null).not.toBe("service");
    expect(secrets.text).not.toContain("QZXW");
    expect((await write(base, second, "/api/secrets/import")).status).toBe(403);
    // Nothing to refuse, and no route of an extension.
    expect((await read(base, second, "/api/ext/whoami")).status).toBe(404);
  });

  test("the founder keeps its orphans: nobody else orders on its cloud accounts", async () => {
    const base = server?.base ?? "";
    expect((await read(base, first, "/api/orphans")).status).toBe(200);
  });
});

describe("a hosted service's extension", () => {
  const ROOT = join(DATA_DIR, "extension-service");
  let server: Server | null = null;
  let first: Browser;
  let second: Browser;

  beforeAll(async () => {
    server = await service(ROOT, {
      DEVBOX_EXTENSION: join(FIXTURES, "extension-service.ts"),
      TEST_REFUSE_ORDERS_FOR: SECOND,
    });
    first = await account(server.base, FIRST);
    second = await account(server.base, SECOND);
  });
  afterAll(async () => {
    await stopServer(server);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("the start names it", () => {
    expect(said(server)).toContain("extension test-service loaded from");
  });

  test("it puts the second account on the service's cloud accounts, and nothing more", async () => {
    const base = server?.base ?? "";
    expect((await read(base, second, "/api/session")).body).toMatchObject({ clouds: ["hetzner"], secrets_dir: null });
    const secrets = await read(base, second, "/api/secrets");
    expect(hetznerOf(secrets)).toMatchObject({ usable: true, via: "service" });
    expect(secrets.text).not.toContain("QZXW");
    expect((await write(base, second, "/api/secrets/import")).status).toBe(403);
  });

  test("an order it refuses is refused before a job, and a seed too", async () => {
    const base = server?.base ?? "";
    const order = await write(base, second, "/api/machines", { profile: "bare", cloud: "hetzner" });
    expect(order.status).toBe(402);
    expect(String(order.body.error)).toContain("no subscription");
    const seed = await write(base, second, "/api/machines/devbox-qzxwa/seed");
    expect(seed.status).toBe(402);
    expect((await read(base, second, "/api/jobs")).body as unknown).toEqual([]);
  });

  test("its routes answer behind the server's guard", async () => {
    const base = server?.base ?? "";
    expect((await read(base, second, "/api/ext/whoami")).body).toEqual({ id: 2 });
    expect((await call(base, "/api/ext/whoami")).status).toBe(401);
  });

  test("the founder's orphans are refused: another account orders on its cloud accounts", async () => {
    const base = server?.base ?? "";
    expect((await read(base, first, "/api/orphans")).status).toBe(409);
  });
});

describe("an extension that is not there, or reaches outside /api/ext/", () => {
  const ROOT = join(DATA_DIR, "extension-broken");
  let server: Server | null = null;

  afterAll(async () => {
    await stopServer(server);
    rmSync(ROOT, { recursive: true, force: true });
  });

  test("named and missing: said with /!\\, and the dashboard runs without it", async () => {
    server = await service(ROOT, { DEVBOX_EXTENSION: join(FIXTURES, "missing.ts") });
    expect(said(server)).toContain("/!\\ DEVBOX_EXTENSION names");
    await account(server.base, FIRST);
    const second = await account(server.base, SECOND);
    expect((await read(server.base, second, "/api/session")).body).toMatchObject({ clouds: [] });
    await stopServer(server);
    server = null;
  });

  test("a route outside /api/ext/ refuses the whole extension", async () => {
    server = await service(ROOT, { DEVBOX_EXTENSION: join(FIXTURES, "extension-bad-route.ts") });
    expect(said(server)).toContain("outside /api/ext/");
    await account(server.base, FIRST);
    const second = await account(server.base, SECOND);
    expect((await read(server.base, second, "/api/session")).body).toMatchObject({ clouds: [] });
    expect((await read(server.base, second, "/api/secrets-too")).status).toBe(404);
  });
});
