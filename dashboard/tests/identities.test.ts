import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { admission, foldedEmail, type AdmissionFacts, type Candidate } from "../src/accounts";
import { DATA_DIR } from "../src/config";
import { openDatabase } from "../src/database";
import { signInOn, type VouchedIdentity } from "../src/db";
import type { Provider } from "../src/oauth";
import { applySchema } from "../src/schema";

/**
 * Which account a verified identity opens: the transaction of src/db.ts, on a fresh file per
 * scenario, because the founding is a question about a database no account ever touched.
 *
 * Each row of signInWith's table is stated here - known, linked, founded, created, unfounded,
 * busy - and the two properties that are easy to lose without a test noticing: the subject wins
 * over an address changed at the provider, and a deleted account never brings the founding back.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 15, 9);
const FOUNDER = "Founder@Example.com";

let files = 0;
function fresh(): Database {
  files += 1;
  const db = openDatabase(join(DATA_DIR, `identities-${files}.db`));
  applySchema(db);
  return db;
}

const candidate = (email: string, authoritative = true): Candidate => ({ email, folded: foldedEmail(email), authoritative });

const who = (provider: Provider, subject: string, ...emails: string[]): VouchedIdentity => ({
  provider,
  subject,
  candidates: emails.map((email) => candidate(email)),
});

/** Google outside Gmail and Workspace: one address, verified once, which Google does not vouch for today. */
const unvouched = (subject: string, email: string): VouchedIdentity => ({
  provider: "google",
  subject,
  candidates: [candidate(email, false)],
});

/** The service's policy, as server.ts hands it: the founder's folded address and a cap. */
const policy = (cap = 30, founder = FOUNDER) => (facts: AdmissionFacts) =>
  admission({ ...facts, founderFolded: founder === "" ? "" : foldedEmail(founder), cap });

function signIn(db: Database, identity: VouchedIdentity, now: number, options: { cap?: number; founder?: string; token?: string } = {}) {
  return signInOn(db, identity, now, policy(options.cap, options.founder), options.token ?? null);
}

const rows = (db: Database, sql: string) => db.query(sql).all();

describe("a service no account ever touched", () => {
  test("a stranger is refused, and nothing at all is written", () => {
    const db = fresh();
    expect(signIn(db, who("google", "g-stranger", "stranger@example.com"), T0)).toEqual({ outcome: "unfounded" });
    expect(rows(db, "SELECT * FROM users")).toEqual([]);
    expect(rows(db, "SELECT * FROM identities")).toEqual([]);
    expect(rows(db, "SELECT * FROM sqlite_sequence WHERE name = 'users'")).toEqual([]);
  });

  test("with no founder named, even the right address founds nothing", () => {
    const db = fresh();
    expect(signIn(db, who("google", "g-1", FOUNDER), T0, { founder: "" })).toEqual({ outcome: "unfounded" });
    expect(rows(db, "SELECT * FROM users")).toEqual([]);
  });

  test("the founder's address its provider does not vouch for founds nothing, and writes nothing", () => {
    const db = fresh();
    expect(signIn(db, unvouched("g-founder", FOUNDER), T0, { token: "t" })).toEqual({ outcome: "unvouched" });
    expect(rows(db, "SELECT * FROM users")).toEqual([]);
    expect(rows(db, "SELECT * FROM identities")).toEqual([]);
    expect(rows(db, "SELECT * FROM api_tokens")).toEqual([]);
  });

  test("the founder's address founds account 1 - a secondary verified one too - and adopts the token", () => {
    const db = fresh();
    const founded = signIn(db, who("github", "4242", "primary@example.com", "founder@example.com"), T0, { token: "digest-of-the-remote-token" });
    // Under the address that matched, as the provider spelled it.
    expect(founded).toEqual({ outcome: "founded", account: { id: 1, email: "founder@example.com" } });
    expect(rows(db, "SELECT id, email, email_folded, password_hash, service_fallback, created_at FROM users")).toEqual([
      { id: 1, email: "founder@example.com", email_folded: "founder@example.com", password_hash: "", service_fallback: 1, created_at: T0 },
    ]);
    expect(rows(db, "SELECT provider, subject, user_id, email, created_at FROM identities")).toEqual([
      { provider: "github", subject: "4242", user_id: 1, email: "founder@example.com", created_at: T0 },
    ]);
    expect(rows(db, "SELECT digest, user_id, label FROM api_tokens")).toEqual([
      { digest: "digest-of-the-remote-token", user_id: 1, label: "DEVBOX_REMOTE_TOKEN" },
    ]);
  });
});

describe("a founded service", () => {
  const db = fresh();
  signIn(db, who("google", "g-founder", FOUNDER), T0, { token: "t" });

  test("the same identity again is known, and opens account 1", () => {
    expect(signIn(db, who("google", "g-founder", FOUNDER), T0 + 1)).toEqual({ outcome: "known", account: { id: 1, email: FOUNDER } });
  });

  test("the other provider with the same verified address links to the same account", () => {
    expect(signIn(db, who("github", "1001", "FOUNDER@example.com"), T0 + 2)).toEqual({
      outcome: "linked",
      account: { id: 1, email: FOUNDER },
    });
    expect(rows(db, "SELECT provider, user_id FROM identities ORDER BY provider")).toEqual([
      { provider: "github", user_id: 1 },
      { provider: "google", user_id: 1 },
    ]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 1 }]);
  });

  test("the subject wins: a changed address at the provider opens the same account, which keeps its own", () => {
    expect(signIn(db, who("google", "g-founder", "renamed@example.com"), T0 + 3)).toEqual({
      outcome: "known",
      account: { id: 1, email: FOUNDER },
    });
    expect(rows(db, "SELECT email FROM users WHERE id = 1")).toEqual([{ email: FOUNDER }]);
    expect(rows(db, "SELECT email FROM identities WHERE provider = 'google'")).toEqual([{ email: "renamed@example.com" }]);
  });

  test("a secondary verified address links, primary first", () => {
    const linked = signIn(db, who("github", "2002", "someone-new@example.com", "founder@example.com"), T0 + 4);
    expect(linked).toEqual({ outcome: "linked", account: { id: 1, email: FOUNDER } });
    // Two identities of one provider on one account: nothing refuses it.
    expect(rows(db, "SELECT subject FROM identities WHERE provider = 'github' ORDER BY subject")).toEqual([
      { subject: "1001" },
      { subject: "2002" },
    ]);
  });

  test("a new identity with an unknown address creates the next account, with no password and no token", () => {
    const created = signIn(db, who("google", "g-second", "second@example.com"), T0 + 5);
    expect(created).toEqual({ outcome: "created", account: { id: 2, email: "second@example.com" } });
    expect(rows(db, "SELECT id, password_hash, service_fallback FROM users WHERE id = 2")).toEqual([
      { id: 2, password_hash: "", service_fallback: 0 },
    ]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = 2")).toEqual([{ n: 0 }]);
    // Adopted at the founding only, never at a creation.
    expect(signIn(db, who("github", "3003", "third@example.com"), T0 + 6, { token: "again" })).toMatchObject({ outcome: "created" });
    expect(rows(db, "SELECT COUNT(*) AS n FROM api_tokens WHERE digest = 'again'")).toEqual([{ n: 0 }]);
  });

  test("an address its provider does not vouch for never links: unvouched, and nothing is written", () => {
    const before = rows(db, "SELECT provider, subject, user_id FROM identities ORDER BY provider, subject");
    expect(signIn(db, unvouched("g-taker", "founder@example.com"), T0 + 7)).toEqual({ outcome: "unvouched" });
    expect(signIn(db, unvouched("g-taker", "SECOND@example.com"), T0 + 8)).toEqual({ outcome: "unvouched" });
    expect(rows(db, "SELECT provider, subject, user_id FROM identities ORDER BY provider, subject")).toEqual(before);
    expect(rows(db, "SELECT COUNT(*) AS n FROM users WHERE email_folded = 'founder@example.com'")).toEqual([{ n: 1 }]);
  });

  test("an address its provider does not vouch for, held by nobody, creates an account", () => {
    expect(signIn(db, unvouched("g-fresh", "fresh@example.com"), T0 + 9)).toMatchObject({ outcome: "created", account: { email: "fresh@example.com" } });
    // And that identity is then known by its subject, like any other.
    expect(signIn(db, unvouched("g-fresh", "fresh@example.com"), T0 + 10)).toMatchObject({ outcome: "known" });
  });

  test("a known identity signs in whatever its provider vouches for today", () => {
    const known: VouchedIdentity = { provider: "google", subject: "g-founder", candidates: [candidate("elsewhere@example.com", false)] };
    expect(signIn(db, known, T0 + 11)).toEqual({ outcome: "known", account: { id: 1, email: FOUNDER } });
  });

  test("an unvouched candidate is passed over when a later one links with the provider's word", () => {
    const mixed: VouchedIdentity = {
      provider: "github",
      subject: "mixed",
      candidates: [candidate("second@example.com", false), candidate("founder@example.com", true)],
    };
    expect(signIn(db, mixed, T0 + 12)).toMatchObject({ outcome: "linked", account: { id: 1 } });
  });

  test("an identity belongs to one account for good: (provider, subject) is unique", () => {
    expect(() =>
      db.run("INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES ('google', 'g-second', 1, 'x@example.com', 1)"),
    ).toThrow();
    expect(() =>
      db.run("INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES ('gitlab', 'x', 1, 'x@example.com', 1)"),
    ).toThrow();
    // No identity of an account that does not exist.
    expect(() =>
      db.run("INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES ('google', 'orphan', 99, 'x@example.com', 1)"),
    ).toThrow();
  });
});

describe("the hourly cap", () => {
  test("counts creations in the hour, founder aside, and says how long to wait", () => {
    const db = fresh();
    // Founded in the same hour, and not counted: two more creations pass under a cap of two.
    signIn(db, who("google", "founder", FOUNDER), T0 - 1, { cap: 2 });
    expect(signIn(db, who("google", "a", "a@example.com"), T0, { cap: 2 })).toMatchObject({ outcome: "created" });
    expect(signIn(db, who("google", "b", "b@example.com"), T0 + 10 * 60_000, { cap: 2 })).toMatchObject({ outcome: "created" });

    const busy = signIn(db, who("github", "c", "c@example.com"), T0 + 20 * 60_000, { cap: 2 });
    // The oldest of the hour, created at T0, leaves it forty minutes later.
    expect(busy).toEqual({ outcome: "busy", minutes: 40 });
    expect(rows(db, "SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 3 }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM identities WHERE subject = 'c'")).toEqual([{ n: 0 }]);

    // Known identities and links always pass: the cap refuses creation, and nothing else.
    expect(signIn(db, who("google", "a", "a@example.com"), T0 + 21 * 60_000, { cap: 2 })).toMatchObject({ outcome: "known" });
    expect(signIn(db, who("github", "b-gh", "b@example.com"), T0 + 22 * 60_000, { cap: 2 })).toMatchObject({ outcome: "linked" });

    // Once the oldest has left the hour, a creation passes again.
    expect(signIn(db, who("github", "c", "c@example.com"), T0 + HOUR + 1, { cap: 2 })).toMatchObject({ outcome: "created" });
  });
});

describe("the sequence", () => {
  test("the founding's explicit id 1 moves it, and the next account is 2", () => {
    const db = fresh();
    signIn(db, who("google", "founder", FOUNDER), T0);
    expect(rows(db, "SELECT seq FROM sqlite_sequence WHERE name = 'users'")).toEqual([{ seq: 1 }]);
    expect(signIn(db, who("google", "next", "next@example.com"), T0 + 1)).toMatchObject({ account: { id: 2 } });
  });

  test("deleting every account does not bring the founding back: the founder's address creates a new id", () => {
    const db = fresh();
    signIn(db, who("google", "founder", FOUNDER), T0, { token: "t" });
    db.run("DELETE FROM api_tokens");
    db.run("DELETE FROM identities");
    db.run("DELETE FROM users");
    const again = signIn(db, who("google", "founder", FOUNDER), T0 + 1, { token: "t2" });
    expect(again).toEqual({ outcome: "created", account: { id: 2, email: FOUNDER } });
    expect(rows(db, "SELECT COUNT(*) AS n FROM api_tokens")).toEqual([{ n: 0 }]);
  });
});
