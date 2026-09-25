import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { newMasterKey } from "../src/vault";
import { beginSignIn, call, signIn, startServer, stopServer, type Server, type ServerOptions } from "./server-harness";

/**
 * How a service gets its first account, and what it refuses until it has one.
 *
 * This is the half of the accounts work that no unit test can show: the founding spans a
 * startup, a journal line, a provider's answer, a database transaction and a token adopted from
 * the unit's environment. What it has to prove is that NOTHING IS LOST - a deployment keeps its
 * secrets, its CLI token and, for an account of the password era, its way in through a verified
 * address - and that nothing is gained either: only the named founder founds, and the variables
 * of the password era open nothing at all.
 *
 * Three services, three data directories, because the state under test is precisely which
 * accounts a database has ever had.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const PUBLIC_URL = "http://devbox.test";
const TOKEN = "the-bearer-token-of-this-test";
const HCLOUD = "hc-from-the-unit";
const FOUNDER = "founder@example.com";

const bearer = { Authorization: `Bearer ${TOKEN}` };

const session = (base: string, cookie?: string) =>
  call(base, "/api/session", cookie === undefined ? {} : { headers: { Cookie: cookie } });

const said = (server: Server | null) => `${server?.out.stdout ?? ""}${server?.out.stderr ?? ""}`;

const refusedAs = (location: string) => new URL(location, PUBLIC_URL).searchParams.get("refused");

/** A devbox that records every invocation, so "nothing was spawned" can be a measurement. */
function recordingEngine(seen: string) {
  return (directory: string): void => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "devbox"),
      ["#!/usr/bin/env bash", `printf '%s\\n' "$*" >> ${JSON.stringify(seen)}`, "printf '[]'", ""].join("\n"),
      { mode: 0o755 },
    );
    mkdirSync(join(directory, "tf"), { recursive: true });
  };
}

const ran = (seen: string): string => (existsSync(seen) ? readFileSync(seen, "utf8") : "");

describe("a service with a founder named and no account: the founding", () => {
  const ROOT = join(DATA_DIR, "bootstrap-founding");
  const SEEN = join(ROOT, "devbox-ran");
  const options: ServerOptions = {
    root: ROOT,
    engine: recordingEngine(SEEN),
    env: {
      PUBLIC_URL,
      DEVBOX_FOUNDER_EMAIL: FOUNDER,
      DEVBOX_REMOTE_TOKEN: TOKEN,
      DEVBOX_MASTER_KEY: newMasterKey(1),
      // The service's cloud accounts are an extension's to share (src/extension.ts).
      DEVBOX_EXTENSION: join(import.meta.dir, "fixtures", "extension-service.ts"),
      HCLOUD_TOKEN: HCLOUD,
      // What a unit of the password era still carries: warned about, and opening nothing.
      PASSWORD_HASH: "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$ZGlnZXN0",
      DEVBOX_INVITE_CODE: "an-invitation-code-of-the-password-era",
    },
  };
  let server: Server | null = null;
  let base = "";

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(join(ROOT, "legacy"), { recursive: true });
    // What the service already held: a token in its unit, a secret on its disk. Both are
    // taken into the vault at the first opening, under owner 1 - the account about to exist.
    writeFileSync(join(ROOT, "legacy", "github"), "ghp-from-the-disk");
    server = await startServer(options);
    base = server.base;
  }, 30_000);

  afterAll(() => stopServer(server));

  test("says at startup who founds account 1, and that the password era's variables open nothing", () => {
    expect(server?.out.stdout).toContain("sign-in: google, github");
    expect(server?.out.stdout).toContain(
      "no account yet: the first sign-in whose verified address is DEVBOX_FOUNDER_EMAIL founds account 1",
    );
    for (const name of ["PASSWORD_HASH", "DEVBOX_INVITE_CODE"]) {
      expect(server?.out.stderr).toContain(
        `/!\\ ${name} is set and read by nothing since sign-in moved to Google and GitHub: it can leave the service's environment`,
      );
    }
    // Never the address itself: a journal is read by whoever reads the unit's logs.
    expect(said(server)).not.toContain(FOUNDER);
  });

  test("tells an anonymous caller which door is open, and nothing about what it holds", async () => {
    const answer = await session(base);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      authenticated: false,
      account: null,
      doors: { claim: true, providers: ["google", "github"] },
      clouds: [],
      configured: null,
      missing: [],
      secrets_dir: null,
      disabled: null,
    });
  });

  test("answers the CLI 503 with what to do, and spawns nothing", async () => {
    const refused = await call(base, "/api/machines", { headers: bearer });
    expect(refused.status).toBe(503);
    expect(String(refused.body.error)).toContain("no account has been founded");
    expect(String(refused.body.error)).toContain("DEVBOX_FOUNDER_EMAIL");
    expect(String(refused.body.error)).toContain("DEVBOX_REMOTE_TOKEN");
    expect(ran(SEEN)).toBe("");
  });

  test("a stranger's verified identity founds nothing: it would have drawn id 1", async () => {
    for (const provider of ["google", "github"] as const) {
      const refused = await signIn(base, provider, { sub: "1234", email: "stranger@example.com" });
      expect(refused.status).toBe(303);
      expect(refused.cookie).toBe("");
      expect(refusedAs(refused.location)).toBe("unfounded");
    }
    expect((await session(base)).body).toMatchObject({ doors: { claim: true } });
    expect((await call(base, "/api/machines", { headers: bearer })).status).toBe(503);
  });

  test("an unverified founder's address founds nothing either", async () => {
    const refused = await signIn(base, "google", { sub: "g-founder", email: FOUNDER, email_verified: false });
    expect(refusedAs(refused.location)).toBe("unverified");
    expect((await session(base)).body).toMatchObject({ doors: { claim: true } });
  });

  test("the founder's address from Google outside Gmail and Workspace founds nothing: Google does not vouch for it", async () => {
    // Verified once, perhaps on a mailbox that has changed hands: account 1 is the last account to hand to it.
    const refused = await signIn(base, "google", { sub: "g-founder", email: FOUNDER });
    expect(refused.cookie).toBe("");
    expect(refusedAs(refused.location)).toBe("unvouched");
    expect((await session(base)).body).toMatchObject({ doors: { claim: true } });
    expect((await call(base, "/api/machines", { headers: bearer })).status).toBe(503);
  });

  test("the password era's routes are gone, the right password or not", async () => {
    for (const path of ["/api/login", "/api/signup"]) {
      const answer = await call(base, path, {
        method: "POST",
        headers: { Origin: PUBLIC_URL, "Content-Type": "application/json" },
        body: JSON.stringify({ email: FOUNDER, password: "anything", code: "an-invitation-code-of-the-password-era" }),
      });
      expect(answer.status, path).toBe(404);
    }
  });

  test("the founder's secondary verified GitHub address founds account 1, under that address", async () => {
    const founded = await signIn(base, "github", {
      sub: "31337",
      emails: [
        { email: "work@example.com", verified: true, primary: true },
        { email: "Founder@Example.com", verified: true, primary: false },
      ],
    });
    expect(founded.status).toBe(303);
    expect(founded.location).toBe("/");
    // As the provider spelled it: the comparison folds, the stored address does not.
    expect(founded.account).toEqual({ id: 1, email: "Founder@Example.com" });

    // Both lines, so an operator reading the journal knows the variables are spent.
    expect(server?.out.stdout).toContain("account 1 founded with github as DEVBOX_FOUNDER_EMAIL");
    expect(server?.out.stdout).toContain("DEVBOX_REMOTE_TOKEN adopted as account 1's first token");

    expect((await session(base, founded.cookie)).body).toMatchObject({
      authenticated: true,
      account: { id: 1, email: "Founder@Example.com" },
      doors: { claim: false, providers: ["google", "github"] },
      clouds: ["hetzner"],
      configured: true,
      disabled: null,
    });
  });

  test("nothing was lost: the token answers, and both secrets are the vault's, sealed under owner 1", async () => {
    const version = await call(base, "/api/version", { headers: bearer });
    expect(version.status).toBe(200);

    const secrets = await call(base, "/api/secrets", { headers: bearer });
    expect(secrets.status).toBe(200);
    const clouds = secrets.body.clouds as { cloud: string; fields: { source: string | null }[] }[];
    expect(clouds[0]?.fields[0]?.source).toBe("db");
    const profile = secrets.body.profile as { name: string; source: string | null }[];
    expect(profile.find((one) => one.name === "github")?.source).toBe("db");
    // Names and places, never a value - the vault's rule, unchanged by accounts.
    expect(secrets.text).not.toContain(HCLOUD);
    expect(secrets.text).not.toContain("ghp-from-the-disk");
  });

  test("the next identity creates account 2, which orders on the service's cloud with none of the founder's profile secrets", async () => {
    const second = await signIn(base, "google", { sub: "g-second", email: "second@example.com" });
    expect(second.account).toEqual({ id: 2, email: "second@example.com" });
    expect(server?.out.stdout).toContain("account 2 created with google");

    const mine = await session(base, second.cookie);
    expect(mine.body).toMatchObject({ account: { id: 2 }, clouds: ["hetzner"], secrets_dir: null });

    const secrets = await call(base, "/api/secrets", { headers: { Cookie: second.cookie } });
    const clouds = secrets.body.clouds as { cloud: string; usable: boolean; via: string | null; fields: { set: boolean }[] }[];
    expect(clouds.find((cloud) => cloud.cloud === "hetzner")).toMatchObject({ usable: true, via: "service" });
    expect(clouds.every((cloud) => cloud.fields.every((field) => !field.set))).toBe(true);
    const profile = secrets.body.profile as { name: string; set: boolean }[];
    expect(profile.every((one) => !one.set)).toBe(true);
    expect(secrets.text).not.toContain(HCLOUD);

    // Nor may it import what the service holds: that is the founding account's vault to fill.
    const refused = await call(base, "/api/secrets/import", {
      method: "POST",
      headers: { Cookie: second.cookie, Origin: PUBLIC_URL, "X-CSRF": second.csrf },
    });
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toContain("only the founding account");
  });

  test("restarted: the founder's variable is said to be spent, and an account of the password era waits for its address", async () => {
    await stopServer(server);
    server = null;
    // An account created before 15/09, as a database of that era holds one: a digest, no identity.
    const db = new Database(join(ROOT, "data", "devbox.db"));
    try {
      db.run(
        `INSERT INTO users (email, email_folded, password_hash, service_fallback, created_at)
           VALUES ('Old@Example.com', 'old@example.com', '$argon2id$v=19$m=65536,t=2,p=1$b2xk$b2xk', 0, 1)`,
      );
    } finally {
      db.close();
    }

    server = await startServer(options);
    base = server.base;
    expect(server.out.stdout).toContain("DEVBOX_FOUNDER_EMAIL is set and read by nothing: account 1 exists");
    expect(server.out.stdout).toContain("DEVBOX_REMOTE_TOKEN is set and read by nothing any more");
    expect(server.out.stdout).toContain(
      "1 account(s) have no Google or GitHub identity yet: each opens at the first sign-in whose verified address is its own",
    );
    expect(said(server)).not.toContain("old@example.com");

    // Its password opens nothing. Its address from Google outside Gmail and Workspace opens nothing
    // either; the same address, verified by GitHub, opens it.
    const unvouched = await signIn(base, "google", { sub: "g-old", email: "OLD@example.com" });
    expect(refusedAs(unvouched.location)).toBe("unvouched");
    const linked = await signIn(base, "github", { sub: "4040", email: "OLD@example.com" });
    expect(linked.account).toEqual({ id: 3, email: "Old@Example.com" });
    expect(server.out.stdout).toContain("github identity linked to account 3");

    // And the founder signs in again with the identity that founded it, the token still answering.
    expect((await signIn(base, "github", { sub: "31337", email: "work@example.com" })).account).toMatchObject({ id: 1 });
    expect((await call(base, "/api/version", { headers: bearer })).status).toBe(200);
  }, 30_000);
});

describe("a service with providers, no account and no founder", () => {
  const ROOT = join(DATA_DIR, "bootstrap-no-founder");
  let server: Server | null = null;
  let base = "";

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    server = await startServer({ root: ROOT, env: { PUBLIC_URL, DEVBOX_REMOTE_TOKEN: TOKEN } });
    base = server.base;
  }, 30_000);

  afterAll(() => stopServer(server));

  test("says so at startup rather than dying, and says so on the page", async () => {
    // Dying would loop on Restart=always without ever saying why.
    expect(server?.out.stderr).toContain("/!\\ no account yet and no DEVBOX_FOUNDER_EMAIL: this service can open no session at all");
    expect((await session(base)).body).toMatchObject({
      doors: { claim: false, providers: ["google", "github"] },
      disabled: "This service has never had an account and names no founder: it can open no session at all.",
    });
  });

  test("first-come is exactly what is refused: every identity is unfounded, and nothing is written", async () => {
    const refused = await signIn(base, "google", { sub: "g-first", email: "first@example.com" });
    expect(refusedAs(refused.location)).toBe("unfounded");
    const db = new Database(join(ROOT, "data", "devbox.db"), { readonly: true });
    try {
      expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  test("a token is a plain 401: nobody's, and no founding ahead to wait for", async () => {
    expect((await call(base, "/api/machines", { headers: bearer })).status).toBe(401);
  });
});

describe("a service with no sign-in provider", () => {
  const ROOT = join(DATA_DIR, "bootstrap-closed");
  let server: Server | null = null;
  let base = "";

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true });
    server = await startServer({
      root: ROOT,
      providers: false,
      // Half of GitHub: said, and not offered. A founder named, which nothing can sign in.
      env: {
        PUBLIC_URL,
        DEVBOX_FOUNDER_EMAIL: FOUNDER,
        DEVBOX_REMOTE_TOKEN: TOKEN,
        GITHUB_CLIENT_ID: "an-id-without-its-secret",
      },
    });
    base = server.base;
  }, 30_000);

  afterAll(() => stopServer(server));

  test("says so at startup rather than dying, and says so on the page", async () => {
    expect(server?.out.stderr).toContain(
      "/!\\ no sign-in provider (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET): this service can open no session at all; CLI tokens still answer",
    );
    expect(server?.out.stderr).toContain(
      "/!\\ GITHUB_CLIENT_ID is set without GITHUB_CLIENT_SECRET: GitHub sign-in is not offered",
    );
    expect(server?.out.stdout).not.toContain("sign-in: ");
    // No founding promised, the founder named or not: nothing could sign it in.
    expect(server?.out.stdout).not.toContain("founds account 1");
    expect((await session(base)).body).toMatchObject({
      doors: { claim: false, providers: [] },
      disabled: "No sign-in provider is configured: this service can open no session at all.",
    });
  });

  test("a token is a plain 401, not a 503 waiting for a founding nothing can perform", async () => {
    const refused = await call(base, "/api/machines", { headers: bearer });
    expect(refused.status).toBe(401);
    expect(refused.text).not.toContain("DEVBOX_FOUNDER_EMAIL");
  });

  test("a sign-in is refused as unavailable before any provider is asked", async () => {
    const begun = await beginSignIn(base, "github");
    expect(begun.status).toBe(303);
    expect(begun.location).toBe("/login?refused=unavailable&provider=github");
    expect(begun.cookie).toBe("");
  });
});
