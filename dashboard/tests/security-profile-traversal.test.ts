import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { newMasterKey } from "../src/vault";
import { signIn, startServer, stopServer, type Server } from "./server-harness";

/**
 * Account A deleting account B's composed profile through the DELETE /api/profiles/:name name.
 *
 * PUT validates the name against the NAME regex; DELETE does not - it hands req.params.name
 * straight to forgetProfile -> removeAuthored -> join(dir, `${name}.sh`). Bun decodes %2f in a
 * :name segment into "/", so ../../../<id>/config/profiles/<name> escapes the asking account's
 * profiles directory into another account's.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const ROOT = join(DATA_DIR, "sec-profile-traversal");
const DATA = join(ROOT, "data");
const PUBLIC_URL = "http://devbox.test";

type Answer = { status: number; body: Record<string, unknown>; cookie: string };

async function fetched(base: string, path: string, init: RequestInit): Promise<Answer> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not json */
  }
  return { status: response.status, body, cookie: response.headers.get("set-cookie") ?? "" };
}

describe("a profile name cannot escape the asking account's directory", () => {
  let server: Server | null = null;
  let base = "";
  let aCookie = "";
  let aCsrf = "";
  let bCookie = "";
  let bCsrf = "";

  const spec = (note: string) => ({
    note,
    software: [],
    secrets: [],
    repos: [],
    cpu: null,
    ram: null,
    disk: null,
    port: null,
  });

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(join(ROOT, "legacy"), { recursive: true });

    server = await startServer({
      root: ROOT,
      env: {
        PUBLIC_URL,
        DEVBOX_FOUNDER_EMAIL: "alice@devbox.test",
        DEVBOX_MASTER_KEY: newMasterKey(1),
      },
    });
    base = server.base;

    // Account A (id 1) founds the service: its verified address is DEVBOX_FOUNDER_EMAIL.
    const a = await signIn(base, "google", { sub: "google-alice", email: "alice@devbox.test", hd: "devbox.test" });
    expect(a.account).toMatchObject({ id: 1 });
    aCookie = a.cookie;
    aCsrf = a.csrf;

    // Account B (id 2) is created by its own first sign-in.
    const b = await signIn(base, "github", { sub: "2002", email: "bob@devbox.test" });
    expect(b.account).toMatchObject({ id: 2 });
    bCookie = b.cookie;
    bCsrf = b.csrf;
  }, 30_000);

  afterAll(async () => {
    await stopServer(server);
  });

  test("A deletes B's rendered profile through ../ in the DELETE name", async () => {
    // B composes a profile of its own. This writes accounts/2/config/profiles/victim.sh.
    const put = await fetched(base, "/api/profiles/victim", {
      method: "PUT",
      headers: { Cookie: bCookie, Origin: PUBLIC_URL, "X-CSRF": bCsrf, "Content-Type": "application/json" },
      body: JSON.stringify(spec("bob's own profile")),
    });
    expect(put.status).toBe(200);

    const victimFile = join(DATA, "accounts", "2", "config", "profiles", "victim.sh");
    expect(existsSync(victimFile)).toBe(true);

    // A, from accounts/1/config/profiles, climbs back to accounts/ and into 2's.
    const traversal = encodeURIComponent("../../../2/config/profiles/victim");
    const attack = await fetched(base, `/api/profiles/${traversal}`, {
      method: "DELETE",
      headers: { Cookie: aCookie, Origin: PUBLIC_URL, "X-CSRF": aCsrf, "Content-Type": "application/json" },
    });

    // The finding: A's DELETE reaches B's file. `removed: true` and the file is gone are each
    // proof on their own; a fixed server answers 404 and leaves the file where it is.
    expect(
      attack.status === 200 && attack.body.removed === true,
      `A's traversal DELETE was accepted and removed B's file: ${JSON.stringify(attack.body)}`,
    ).toBe(false);
    expect(existsSync(victimFile), "B's rendered profile file still exists after A's DELETE").toBe(true);
  });
});
