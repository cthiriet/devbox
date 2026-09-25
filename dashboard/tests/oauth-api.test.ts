import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import {
  beginSignIn,
  call,
  codeFor,
  returnFrom,
  signIn,
  startServer,
  stopServer,
  type Provider,
  type Returned,
  type Server,
  type Who,
} from "./server-harness";

/**
 * Signing in with Google and GitHub against the real server.ts, the providers answered by
 * tests/fixtures/oauth-providers.ts inside the server child.
 *
 * What only a running server shows: that the state cookie binds a callback to the browser that
 * started it, and a callback without it opens nothing and writes nothing; that an identity links
 * by an address its provider vouches for and is then known by its subject, and that a Google
 * address outside Gmail and Workspace links to nothing; that the path a sign-in began at is where
 * it lands, and never another origin; that the state cookie leaves on every answer; that no
 * address and no code ever reaches a Location or the journal; and that the routes of the password
 * era are gone.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const PUBLIC_URL = "http://devbox.test";
const FOUNDER = "founder@example.com";

/** Every address and every code this file sends: none may appear in a Location or the journal. */
const ADDRESSES = new Set<string>();
const CODES = new Set<string>();

function rows<T>(root: string, sql: string): T[] {
  const db = new Database(join(root, "data", "devbox.db"), { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

/**
 * signIn from the harness, step by step, so that the very code sent and every address are
 * remembered: the journal is searched for them at the end.
 */
async function through(base: string, provider: Provider, who: Who, from?: string) {
  if (who.email !== undefined) ADDRESSES.add(who.email);
  for (const one of who.emails ?? []) ADDRESSES.add(one.email);
  const begun = await beginSignIn(base, provider, from);
  const code = codeFor(who, begun.challenge);
  CODES.add(code);
  const back = await returnFrom(base, provider, { code, state: begun.state }, begun.cookie);
  const session = back.cookie === "" ? null : await call(base, "/api/session", { headers: { Cookie: back.cookie } });
  return {
    status: back.status,
    location: back.location,
    cookie: back.cookie,
    account: (session?.body.account as { id: number; email: string } | undefined) ?? null,
  };
}

const refusedAs = (location: string) => new URL(location, PUBLIC_URL).searchParams.get("refused");

const stateCleared = (back: Returned) =>
  back.setCookies.some((line) => /^oauth=;/.test(line) && /Max-Age=0/.test(line));

describe("signing in through the providers", () => {
  const ROOT = join(DATA_DIR, "oauth-api");
  let server: Server | null = null;
  let base = "";
  const said = () => `${server?.out.stdout ?? ""}${server?.out.stderr ?? ""}`;

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    server = await startServer({ root: ROOT, env: { PUBLIC_URL, DEVBOX_FOUNDER_EMAIL: FOUNDER } });
    base = server.base;
    ADDRESSES.add(FOUNDER);
    // A Workspace account's address: Google vouches for it, so it may found.
    const founded = await through(base, "google", { sub: "g-founder", email: FOUNDER, hd: "example.com" });
    expect(founded.account).toEqual({ id: 1, email: FOUNDER });
  }, 30_000);

  afterAll(() => stopServer(server));

  test("says which providers it signs in with", () => {
    expect(server?.out.stdout).toContain("sign-in: google, github");
    expect(server?.out.stdout).toContain("account 1 founded with google as DEVBOX_FOUNDER_EMAIL");
  });

  test("the start redirects to the provider's fixed address, with a Lax state cookie and no secret", async () => {
    const begun = await beginSignIn(base, "github", "/jobs");
    expect(begun.status).toBe(302);
    expect(begun.location.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
    expect(begun.location).not.toContain("secret");
    expect(begun.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const response = await fetch(`${base}/api/auth/google`, { redirect: "manual" });
    const line = response.headers.getSetCookie().find((one) => one.startsWith("oauth=")) ?? "";
    expect(line).toContain("SameSite=Lax");
    expect(line).toContain("HttpOnly");
    expect(line).toContain("Max-Age=600");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("a provider this service does not know is unavailable, not a route error", async () => {
    const begun = await beginSignIn(base, "gitlab");
    expect(begun.status).toBe(303);
    expect(begun.location).toBe("/login?refused=unavailable");
  });

  describe("a callback without its browser's state opens nothing and writes nothing", () => {
    const who: Who = { sub: "g-intruder", email: "intruder@example.com" };
    ADDRESSES.add("intruder@example.com");

    const refusedWith = async (cookie: (begun: Awaited<ReturnType<typeof beginSignIn>>) => string | null, state?: string) => {
      const begun = await beginSignIn(base, "google");
      const code = codeFor(who, begun.challenge);
      CODES.add(code);
      const back = await returnFrom(base, "google", { code, state: state ?? begun.state }, cookie(begun));
      expect(back.status).toBe(303);
      expect(refusedAs(back.location)).toBe("state");
      expect(back.cookie).toBe("");
      expect(stateCleared(back)).toBe(true);
      return back;
    };

    test("no cookie", async () => {
      await refusedWith(() => null);
    });

    test("another flow's state", async () => {
      await refusedWith((begun) => begun.cookie, "A".repeat(43));
    });

    test("a cookie the other provider's start wrote", async () => {
      const github = await beginSignIn(base, "github");
      await refusedWith(() => github.cookie, github.state);
    });

    test("and not a row was written for it", () => {
      expect(rows(ROOT, "SELECT * FROM identities WHERE subject = 'g-intruder'")).toEqual([]);
      expect(rows(ROOT, "SELECT * FROM users WHERE email_folded = 'intruder@example.com'")).toEqual([]);
    });
  });

  test("a sign-in the person declined at the provider is `denied`", async () => {
    const begun = await beginSignIn(base, "github");
    const back = await returnFrom(base, "github", { error: "access_denied", state: begun.state }, begun.cookie);
    expect(back.location).toBe("/login?refused=denied&provider=github");
    expect(stateCleared(back)).toBe(true);
  });

  test("a code the provider refuses is `provider`", async () => {
    const refused = await through(base, "google", { sub: "g-x", email: "x@example.com", error: "invalid_grant" });
    expect(refused.cookie).toBe("");
    expect(refusedAs(refused.location)).toBe("provider");
    expect(said()).toContain("google sign-in refused: the token endpoint answered 400 (invalid_grant)");
  });

  test("an address that is not verified is `unverified`, at either provider", async () => {
    for (const [provider, who] of [
      ["google", { sub: "g-unverified", email: "u1@example.com", email_verified: false }],
      ["google", { sub: "g-stringly", email: "u2@example.com", email_verified: "true" }],
      ["github", { sub: "9001", emails: [{ email: "u3@example.com", verified: false, primary: true }] }],
      ["github", { sub: "9002", emails: [{ email: "9002+someone@users.noreply.github.com", verified: true, primary: true }] }],
    ] as const) {
      const refused = await through(base, provider, who);
      expect(refused.cookie, who.sub).toBe("");
      expect(refusedAs(refused.location), who.sub).toBe("unverified");
    }
    expect(rows(ROOT, "SELECT subject FROM identities WHERE subject IN ('g-unverified', 'g-stringly', '9001', '9002')")).toEqual([]);
  });

  test("Google then GitHub with the same verified address: one account, two identities", async () => {
    const google = await through(base, "google", { sub: "g-alice", email: "alice@example.com" });
    expect(google.account).toMatchObject({ email: "alice@example.com" });
    const github = await through(base, "github", { sub: "4242", email: "Alice@Example.com" });
    expect(github.account).toEqual(google.account);
    expect(said()).toContain(`github identity linked to account ${google.account?.id}`);
    expect(
      rows(ROOT, `SELECT provider, subject FROM identities WHERE user_id = ${google.account?.id} ORDER BY provider`),
    ).toEqual([
      { provider: "github", subject: "4242" },
      { provider: "google", subject: "g-alice" },
    ]);
  });

  test("a secondary verified GitHub address links to the founder's account", async () => {
    const linked = await through(base, "github", {
      sub: "5151",
      emails: [
        { email: "work@example.com", verified: true, primary: true },
        { email: FOUNDER, verified: true, primary: false },
      ],
    });
    expect(linked.account).toEqual({ id: 1, email: FOUNDER });
  });

  test("the subject wins: a changed primary address opens the same account, which keeps its own", async () => {
    const before = await through(base, "github", { sub: "7777", email: "bob@example.com" });
    const after = await through(base, "github", { sub: "7777", email: "bob.renamed@example.com" });
    expect(after.account).toEqual(before.account);
    expect(rows(ROOT, `SELECT email FROM users WHERE id = ${before.account?.id}`)).toEqual([{ email: "bob@example.com" }]);
    expect(rows(ROOT, "SELECT email FROM identities WHERE provider = 'github' AND subject = '7777'")).toEqual([
      { email: "bob.renamed@example.com" },
    ]);
  });

  test("a sign-in lands where it began, and never on another origin", async () => {
    const deep = await through(base, "google", { sub: "g-founder", email: FOUNDER }, "/secrets#secret-github");
    expect(deep.status).toBe(303);
    expect(deep.location).toBe("/secrets#secret-github");
    for (const from of ["//evil.example", "https://evil.example/", "/\\evil.example", "/login"]) {
      expect((await through(base, "google", { sub: "g-founder", email: FOUNDER }, from)).location, from).toBe("/");
    }
  });

  test("a session opened this way is Strict, and its anti-CSRF token comes from /api/session", async () => {
    const begun = await beginSignIn(base, "google");
    const code = codeFor({ sub: "g-founder", email: FOUNDER }, begun.challenge);
    CODES.add(code);
    const back = await returnFrom(base, "google", { code, state: begun.state }, begun.cookie);
    const line = back.setCookies.find((one) => one.startsWith("session=")) ?? "";
    expect(line).toContain("SameSite=Strict");
    expect(line).toContain("HttpOnly");
    expect(stateCleared(back)).toBe(true);

    const session = await call(base, "/api/session", { headers: { Cookie: back.cookie } });
    expect(session.body).toMatchObject({ authenticated: true, account: { id: 1 }, doors: { claim: false, providers: ["google", "github"] } });
    // And it works as one: a guarded write with that token passes.
    const token = await call(base, "/api/account/tokens", {
      method: "POST",
      headers: { Cookie: back.cookie, Origin: PUBLIC_URL, "X-CSRF": String(session.body.csrf), "Content-Type": "application/json" },
      body: JSON.stringify({ label: "from a provider's session" }),
    });
    expect(token.status).toBe(201);
  });

  describe("a Google address outside Gmail and Workspace", () => {
    test("equal to an account's, links to nothing: unvouched, no identity, no session", async () => {
      const held = await through(base, "github", { sub: "6060", email: "carol@example.com" });
      expect(held.account).toMatchObject({ email: "carol@example.com" });

      const refused = await through(base, "google", { sub: "g-carol", email: "Carol@Example.com" });
      expect(refused.status).toBe(303);
      expect(refused.location).toBe("/login?refused=unvouched&provider=google");
      expect(refused.cookie).toBe("");
      expect(rows(ROOT, "SELECT * FROM identities WHERE subject = 'g-carol'")).toEqual([]);
    });

    test("the same address from a Workspace account links", async () => {
      const linked = await through(base, "google", { sub: "g-carol", email: "Carol@Example.com", hd: "example.com" });
      expect(linked.account).toMatchObject({ email: "carol@example.com" });
      expect(rows(ROOT, "SELECT provider FROM identities WHERE subject = 'g-carol'")).toEqual([{ provider: "google" }]);
    });

    test("a Gmail address, which Google hosts, links", async () => {
      const held = await through(base, "github", { sub: "7070", email: "dora.test@gmail.com" });
      const linked = await through(base, "google", { sub: "g-dora", email: "Dora.Test@gmail.com" });
      expect(linked.account).toEqual(held.account);
    });

    test("held by nobody, creates an account", async () => {
      const created = await through(base, "google", { sub: "g-erin", email: "erin@example.com" });
      expect(created.account).toMatchObject({ email: "erin@example.com" });
      expect(said()).toContain(`account ${created.account?.id} created with google`);
    });
  });

  test("a sign-in that throws after its state was checked still clears the state cookie", async () => {
    // The database refusing the identity's row, as a busy or full one would refuse it: a trigger
    // written through a second connection, which the server's own sees at its next statement.
    const db = new Database(join(ROOT, "data", "devbox.db"));
    db.run("CREATE TRIGGER refuse_identities BEFORE INSERT ON identities BEGIN SELECT RAISE(ABORT, 'refused by the test'); END");
    try {
      const begun = await beginSignIn(base, "github");
      const who: Who = { sub: "9090", email: "frank@example.com" };
      ADDRESSES.add("frank@example.com");
      const code = codeFor(who, begun.challenge);
      CODES.add(code);
      const back = await returnFrom(base, "github", { code, state: begun.state }, begun.cookie);
      expect(back.status).toBe(303);
      expect(back.location).toBe("/login?refused=failed&provider=github");
      expect(back.cookie).toBe("");
      expect(stateCleared(back)).toBe(true);
      expect(said()).toContain("github sign-in failed after its state was checked (");
      expect(said()).not.toContain("refused by the test");
      // The transaction rolled back whole: no account was left without its identity.
      expect(rows(ROOT, "SELECT * FROM users WHERE email_folded = 'frank@example.com'")).toEqual([]);
    } finally {
      db.run("DROP TRIGGER refuse_identities");
      db.close();
    }
  });

  test("the routes of the password era are gone", async () => {
    for (const path of ["/api/login", "/api/signup", "/api/account/password"]) {
      const answer = await call(base, path, { method: "POST", headers: { Origin: PUBLIC_URL, "Content-Type": "application/json" }, body: "{}" });
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).toEqual({ error: `no such route: ${path}` });
    }
  });

  test("no Location and no line of the journal carries an address or a code", async () => {
    // Every refusal above went through /login?refused=..., which is all a Location ever holds.
    const begun = await beginSignIn(base, "google");
    expect(begun.location).not.toContain("@");
    for (const address of ADDRESSES) expect(said(), address).not.toContain(address);
    for (const code of CODES) expect(said()).not.toContain(code);
    expect(said()).not.toContain("secret-of-the-tests");
  });
});

describe("the hourly cap on new accounts", () => {
  const ROOT = join(DATA_DIR, "oauth-api-cap");
  let server: Server | null = null;
  let base = "";

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    server = await startServer({
      root: ROOT,
      env: { PUBLIC_URL, DEVBOX_FOUNDER_EMAIL: FOUNDER, DEVBOX_MAX_NEW_ACCOUNTS_PER_HOUR: "2" },
    });
    base = server.base;
  }, 30_000);

  afterAll(() => stopServer(server));

  test("refuses the third new account of the hour, founder aside, and lets everyone known in", async () => {
    expect(server?.out.stdout).toContain("accounts: at most 2 new per hour");
    expect((await signIn(base, "google", { sub: "founder", email: FOUNDER, hd: "example.com" })).account).toMatchObject({ id: 1 });
    expect((await signIn(base, "google", { sub: "one", email: "one@example.com" })).account).toMatchObject({ id: 2 });
    expect((await signIn(base, "github", { sub: "2", email: "two@example.com" })).account).toMatchObject({ id: 3 });

    const busy = await signIn(base, "github", { sub: "3", email: "three@example.com" });
    expect(busy.cookie).toBe("");
    const query = new URL(busy.location, PUBLIC_URL).searchParams;
    expect(query.get("refused")).toBe("busy");
    expect(query.get("provider")).toBe("github");
    expect(Number(query.get("minutes"))).toBeGreaterThanOrEqual(59);
    expect(server?.out.stderr).toContain("github sign-in refused: 2 account(s) were created in the last hour");

    // Known identities, and links, still pass.
    expect((await signIn(base, "google", { sub: "one", email: "one@example.com" })).account).toMatchObject({ id: 2 });
    expect((await signIn(base, "github", { sub: "22", email: "one@example.com" })).account).toMatchObject({ id: 2 });
    expect((await signIn(base, "google", { sub: "founder", email: FOUNDER })).account).toMatchObject({ id: 1 });
  });
});
