import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { NEW_ACCOUNT_WINDOW_MS, type Admission, type AdmissionFacts, type Candidate } from "./accounts";
import { DATA_DIR } from "./config";
import { openDatabase } from "./database";
import type { Provider } from "./oauth";
import { applySchema, FOUNDING_ACCOUNT, type Account, type Job, type JobState, type Origin, type Via } from "./schema";
import { newToken, tokenDigest, type Session } from "./sessions";

// DATA_DIR is frozen at first import; tests/prepare.ts diverts it before this runs. The logs
// are not made here any more: they live in the asking account's tree, which accountTree makes.
mkdirSync(DATA_DIR, { recursive: true });

const db = openDatabase(join(DATA_DIR, "devbox.db"));
applySchema(db);

/**
 * The handle itself, for src/secrets.ts alone.
 *
 * Everything else in this file is a named query, and the vault is not: src/vault.ts takes a
 * database rather than opening one, so its tests run on a fresh file each, and the service
 * hands it this one. One connection for the whole process, as before - two would each keep a
 * cache of their own and each hold the WAL for the other's checkpoint.
 */
export { db as database };

/**
 * The statements the sign-in transaction runs, written once and prepared on whichever database it
 * is handed: the service's below, or a test's fresh file (see signInOn). `database.query` caches
 * per connection, so on the service's they are the very statements `queries` holds.
 */
const SQL = {
  // "Ever", and sqlite_sequence is how: it keeps the highest id AUTOINCREMENT drew after the
  // rows are gone. See accountsExist.
  accountsEver: `SELECT EXISTS (SELECT 1 FROM users)
                     OR EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users') AS ever`,

  userByFolded: "SELECT id, email, service_fallback FROM users WHERE email_folded = ?",

  // '' for the digest: no password opens an account any more. See `users` in src/schema.ts.
  insertFounder: `INSERT INTO users (id, email, email_folded, password_hash, service_fallback, created_at)
                    VALUES (?, ?, ?, '', 1, ?)`,

  insertUser: `INSERT INTO users (email, email_folded, password_hash, service_fallback, created_at)
                 VALUES (?, ?, '', 0, ?)
               RETURNING id`,

  insertToken: "INSERT INTO api_tokens (digest, user_id, label, created_at) VALUES (?, ?, ?, ?) RETURNING id",

  identityAccount: `SELECT u.id, u.email
                      FROM identities i JOIN users u ON u.id = i.user_id
                     WHERE i.provider = ? AND i.subject = ?`,

  insertIdentity: "INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)",

  touchIdentity: "UPDATE identities SET email = ? WHERE provider = ? AND subject = ?",

  // The founder is never counted: it is created once, and the cap is about everyone after.
  createdSince: "SELECT COUNT(*) AS created, MIN(created_at) AS oldest FROM users WHERE created_at > ? AND id != ?",
} as const;

/** Prepared once: `db.query` caches, `db.prepare` does not. */
const queries = {
  /* --- accounts ------------------------------------------------------------ */

  accountsEver: db.query<{ ever: number }, []>(SQL.accountsEver),

  userByFolded: db.query<UserRow, [string]>(SQL.userByFolded),

  userById: db.query<UserRow, [number]>("SELECT id, email, service_fallback FROM users WHERE id = ?"),

  // The accounts no identity opens yet: those of the password era, until each signs in once.
  accountsWithoutIdentity: db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM users u WHERE NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id)",
  ),

  listAccounts: db.query<UserRow & { created_at: number }, []>(
    "SELECT id, email, service_fallback, created_at FROM users ORDER BY id",
  ),

  /* --- tokens ---------------------------------------------------------------- */

  accountByToken: db.query<UserRow & { token: number }, [string]>(
    `SELECT u.id, u.email, u.service_fallback, t.id AS token
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.digest = ?`,
  ),

  touchToken: db.query<undefined, [number, number]>("UPDATE api_tokens SET used_at = ? WHERE id = ?"),

  insertToken: db.query<{ id: number }, [string, number, string, number]>(SQL.insertToken),

  revokeToken: db.query<undefined, [number, number]>("DELETE FROM api_tokens WHERE id = ? AND user_id = ?"),

  tokensOf: db.query<TokenRow, [number]>(
    "SELECT id, label, created_at, used_at FROM api_tokens WHERE user_id = ? ORDER BY id",
  ),

  /* --- sessions ---------------------------------------------------------------- */

  sessionByDigest: db.query<
    { digest: string; user_id: number; csrf: string; created_at: number; seen_at: number } & UserRow,
    [string]
  >(
    `SELECT s.digest, s.user_id, s.csrf, s.created_at, s.seen_at,
            u.id, u.email, u.service_fallback
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.digest = ?`,
  ),

  createSession: db.query<undefined, [string, number, string, number, number]>(
    "INSERT INTO sessions (digest, user_id, csrf, created_at, seen_at) VALUES (?, ?, ?, ?, ?)",
  ),

  touchSession: db.query<undefined, [number, string]>(
    "UPDATE sessions SET seen_at = ? WHERE digest = ?",
  ),

  deleteSession: db.query<undefined, [string]>("DELETE FROM sessions WHERE digest = ?"),

  deleteSessionsOf: db.query<undefined, [number, string]>(
    "DELETE FROM sessions WHERE user_id = ? AND digest != ?",
  ),

  purgeSessions: db.query<undefined, [number]>("DELETE FROM sessions WHERE created_at < ?"),

  /* --- jobs -------------------------------------------------------------- */

  // EVERY STATEMENT BELOW NAMES THE ACCOUNT, and the first `?` of each is it. Job ids, machine
  // names and profile names are unique inside one account and nowhere else, so a statement on
  // any of the three without `account_id` is a statement that answers for whoever asked with
  // whatever another account holds under the same number or the same word. tests/scoping.test.ts
  // reads this file and fails on one - interruptRunning, the startup sweep, is the one it names.

  insertJob: db.query<
    { id: number },
    [number, string, string | null, string | null, string | null, string, number]
  >(
    `INSERT INTO jobs (account_id, verb, machine, cloud, profile, argv, state, started_at,
                       ended_at, exit_code)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, NULL, NULL)
     RETURNING id`,
  ),

  finishJob: db.query<undefined, [JobState, number, number, number, number]>(
    "UPDATE jobs SET state = ?, exit_code = ?, ended_at = ? WHERE account_id = ? AND id = ?",
  ),

  job: db.query<Job, [number, number]>("SELECT * FROM jobs WHERE account_id = ? AND id = ?"),

  recentJobs: db.query<Job, [number, number]>(
    "SELECT * FROM jobs WHERE account_id = ? ORDER BY started_at DESC, id DESC LIMIT ?",
  ),

  runningJobs: db.query<Job, [number]>(
    "SELECT * FROM jobs WHERE account_id = ? AND state = 'running' ORDER BY id",
  ),

  labels: db.query<{ machine: string; label: string }, [number]>(
    "SELECT machine, label FROM labels WHERE account_id = ?",
  ),

  setLabel: db.query<undefined, [number, string, string, number]>(
    "INSERT INTO labels (account_id, machine, label, set_at) VALUES (?, ?, ?, ?)" +
      " ON CONFLICT(account_id, machine) DO UPDATE SET label = excluded.label, set_at = excluded.set_at",
  ),

  clearLabel: db.query<undefined, [number, string]>(
    "DELETE FROM labels WHERE account_id = ? AND machine = ?",
  ),

  /**
   * When a machine was ordered, out of the job that ordered it.
   *
   * ANY state, and not just a succeeded one, which looks wrong until you read devbox-core:
   * the provider apply comes FIRST and the profile runs after it, so a job that died in
   * phase 2 left a machine behind all the same. A machine ordered here is exactly that case on
   * 27/08 - `up` failed on a 404, the machine existed, and its only succeeded job was the
   * seed that came after. Asking for a succeeded `up` would answer "no age" for the one
   * machine whose age was worth knowing.
   *
   * The latest, because a name can be destroyed and taken again - and the asking account's,
   * because another account may have drawn the same name.
   */
  orderedAt: db.query<{ started_at: number }, [number, string]>(
    "SELECT started_at FROM jobs WHERE account_id = ? AND machine = ? AND verb = 'up'" +
      " ORDER BY started_at DESC LIMIT 1",
  ),

  /** Where a machine was ordered: see machine_origins in src/schema.ts. The latest order wins. */
  recordOrigin: db.query<undefined, [number, string, string, Via, number]>(
    `INSERT INTO machine_origins (account_id, machine, cloud, via, ordered_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, machine) DO UPDATE SET cloud = excluded.cloud, via = excluded.via,
                                                    ordered_at = excluded.ordered_at`,
  ),

  origin: db.query<Origin, [number, string]>(
    "SELECT cloud, via, ordered_at FROM machine_origins WHERE account_id = ? AND machine = ?",
  ),

  /**
   * The one read of machine_origins across accounts, and it still names one: the asking account,
   * left out. For the founder's orphans, which ask whether any OTHER account holds a machine on its
   * cloud accounts, on which cloud - never which machine, nor whose.
   */
  serviceOriginClouds: db.query<{ cloud: string }, [number]>(
    "SELECT DISTINCT cloud FROM machine_origins WHERE account_id != ? AND via = 'service' ORDER BY cloud",
  ),

  /**
   * THE ONE STATEMENT HERE THAT NAMES NO ACCOUNT, and it is the startup sweep: a job left
   * `running` belonged to a process that is gone, whoever's job it was. It shares nothing with
   * the per-account read above any more - they were one query, and a query that answered for
   * every account was one argument away from answering a route.
   */
  interruptRunning: db.query<undefined, [number]>(
    "UPDATE jobs SET state = 'interrupted', ended_at = ? WHERE state = 'running'",
  ),

  /* --- composed profiles ------------------------------------------------- */

  authored: db.query<AuthoredRow, [number]>(
    "SELECT name, spec, created_at, updated_at FROM profiles WHERE account_id = ? ORDER BY name",
  ),

  authoredByName: db.query<AuthoredRow, [number, string]>(
    "SELECT name, spec, created_at, updated_at FROM profiles WHERE account_id = ? AND name = ?",
  ),

  // created_at is kept on a replace: a profile edited five times is still the profile that
  // was composed on the day it was composed, and the page says so.
  saveAuthored: db.query<undefined, [number, string, string, number, number]>(
    `INSERT INTO profiles (account_id, name, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id, name) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at`,
  ),

  deleteAuthored: db.query<undefined, [number, string]>(
    "DELETE FROM profiles WHERE account_id = ? AND name = ?",
  ),
};

export type AuthoredRow = { name: string; spec: string; created_at: number; updated_at: number };

/**
 * An account's row as every query reads it. Without `password_hash` since 15/09: nothing selects
 * the column any more, which is the whole of what keeping it costs.
 */
type UserRow = { id: number; email: string; service_fallback: number };

export type TokenRow = { id: number; label: string; created_at: number; used_at: number | null };

const accountOf = (row: UserRow): Account => ({
  id: row.id,
  email: row.email,
});

/* --- accounts ---------------------------------------------------------------- */

/**
 * Whether an account has EVER existed here, rather than whether one exists now.
 *
 * The difference is the founder's secrets. The founding hands the sign-in whose verified address
 * is DEVBOX_FOUNDER_EMAIL the id 1 - and every value the vault seals under owner 1 - on the
 * strength of no account having existed. With every account deleted, a count would arm it again,
 * and the next founding would take id 1 back. sqlite_sequence remembers what AUTOINCREMENT drew.
 */
export function accountsExist(): boolean {
  return (queries.accountsEver.get()?.ever ?? 0) === 1;
}

export function userById(id: number): Account | null {
  const row = queries.userById.get(id);
  return row === null ? null : accountOf(row);
}

/* --- identities ----------------------------------------------------------------- */

/** A Google or GitHub identity, as src/oauth.ts read it and server.ts checked its addresses. */
export type VouchedIdentity = { provider: Provider; subject: string; candidates: readonly Candidate[] };

export type SignedIn =
  | { outcome: "known" | "linked" | "founded" | "created"; account: Account }
  | { outcome: "unfounded" }
  | { outcome: "unvouched" }
  | { outcome: "busy"; minutes: number };

/**
 * Which account a verified identity opens, in ONE immediate transaction - whatever it has to
 * create on the way. Two sign-ins of one new identity at once would otherwise both find nothing
 * and both create; serialised, the second finds the first's row and is `known`.
 *
 *   1  known    the identity is recorded: its account, whatever address the provider says today.
 *               The subject wins, so a primary address changed at the provider opens the same
 *               account, and `identities.email` follows while `users.email` never does.
 *   2  linked   an account's folded address is one of the candidates, tried in order - GitHub's
 *               primary first, then every other VERIFIED one, since the address an account was
 *               made with may be a secondary address today. The identity is recorded against it,
 *               even beside another identity of the same provider. Only a candidate its provider
 *               is AUTHORITATIVE for links: an account holding one that is not answers
 *               `unvouched`, and nothing is written (see googleIdentity in src/oauth.ts).
 *   3  decide   neither: `decide` - admission() in src/accounts.ts, with the founder and the cap -
 *               is handed what this transaction read, and its answer is carried out here:
 *               account 1 founded (DEVBOX_REMOTE_TOKEN, when given, adopted in the same breath, as
 *               the claim did), an account created, or nothing at all.
 *
 * An account created here writes '' as its password digest: see `users` in src/schema.ts. Its
 * address is the candidate's as the provider spelled it, and no route changes an address later.
 */
export function signInWith(
  identity: VouchedIdentity,
  now: number,
  decide: (facts: AdmissionFacts) => Admission,
  adoptedTokenDigest: string | null,
): SignedIn {
  return signInOn(db, identity, now, decide, adoptedTokenDigest);
}

/**
 * signInWith on a database of the caller's. For tests/identities.test.ts, whose founding needs a
 * file no account ever touched - the service's own is shared by every test that imports this one.
 */
export function signInOn(
  database: Database,
  identity: VouchedIdentity,
  now: number,
  decide: (facts: AdmissionFacts) => Admission,
  adoptedTokenDigest: string | null,
): SignedIn {
  const first = identity.candidates[0];
  if (first === undefined) throw new Error("an identity with no candidate address reached signInWith");

  return database
    .transaction((): SignedIn => {
      const { provider, subject } = identity;
      const known = database.query<{ id: number; email: string }, [string, string]>(SQL.identityAccount).get(provider, subject);
      if (known !== null) {
        database.query<undefined, [string, string, string]>(SQL.touchIdentity).run(first.email, provider, subject);
        return { outcome: "known", account: { id: known.id, email: known.email } };
      }

      const record = (userId: number, email: string) =>
        database
          .query<undefined, [string, string, number, string, number]>(SQL.insertIdentity)
          .run(provider, subject, userId, email, now);

      // An address its provider is not authoritative for never links, whoever holds it: its
      // verification may date from a mailbox that has changed hands since. Tried past, in case a
      // later candidate is one the provider vouches for; and if none links, nothing is created
      // either - the address is an account's, and a second account under it could not exist.
      let unvouched = false;
      for (const candidate of identity.candidates) {
        const holder = database.query<UserRow, [string]>(SQL.userByFolded).get(candidate.folded);
        if (holder === null) continue;
        if (!candidate.authoritative) {
          unvouched = true;
          continue;
        }
        record(holder.id, candidate.email);
        return { outcome: "linked", account: accountOf(holder) };
      }
      if (unvouched) return { outcome: "unvouched" };

      const ever = (database.query<{ ever: number }, []>(SQL.accountsEver).get()?.ever ?? 0) === 1;
      const hour = database
        .query<{ created: number; oldest: number | null }, [number, number]>(SQL.createdSince)
        .get(now - NEW_ACCOUNT_WINDOW_MS, FOUNDING_ACCOUNT);
      const decided = decide({
        ever,
        createdLastHour: hour?.created ?? 0,
        oldestInHour: hour?.oldest ?? null,
        now,
        candidates: identity.candidates,
      });

      switch (decided.decision) {
        case "unfounded":
          return { outcome: "unfounded" };
        case "unvouched":
          return { outcome: "unvouched" };
        case "busy":
          return { outcome: "busy", minutes: decided.minutes };
        case "found": {
          const { email, folded } = decided.candidate;
          database
            .query<undefined, [number, string, string, number]>(SQL.insertFounder)
            .run(FOUNDING_ACCOUNT, email, folded, now);
          record(FOUNDING_ACCOUNT, email);
          if (adoptedTokenDigest !== null) {
            database
              .query<{ id: number }, [string, number, string, number]>(SQL.insertToken)
              .get(adoptedTokenDigest, FOUNDING_ACCOUNT, "DEVBOX_REMOTE_TOKEN", now);
          }
          return { outcome: "founded", account: { id: FOUNDING_ACCOUNT, email } };
        }
        case "create": {
          const { email, folded } = decided.candidate;
          const row = database
            .query<{ id: number }, [string, string, number]>(SQL.insertUser)
            .get(email, folded, now);
          if (row === null) throw new Error("the account could not be recorded");
          record(row.id, email);
          return { outcome: "created", account: { id: row.id, email } };
        }
      }
    })
    .immediate();
}

/** How many accounts no identity opens yet: a count for the startup line, never an address. */
export function accountsWithoutIdentity(): number {
  return queries.accountsWithoutIdentity.get()?.count ?? 0;
}

export function listAccounts(): (Account & { createdAt: number })[] {
  return queries.listAccounts.all().map((row) => ({ ...accountOf(row), createdAt: row.created_at }));
}

/* --- tokens ------------------------------------------------------------------- */

/** The account a token's digest belongs to, and the hour it was last used - null when none. */
export function accountByToken(digest: string, now: number = Date.now()): Account | null {
  const row = queries.accountByToken.get(digest);
  if (row === null) return null;
  queries.touchToken.run(now, row.token);
  return accountOf(row);
}

export function createToken(userId: number, digest: string, label: string, now: number): number {
  const row = queries.insertToken.get(digest, userId, label, now);
  if (row === null) throw new Error("the token could not be recorded");
  return row.id;
}

/** Scoped by account in the query itself: zero rows is the same answer for "not yours" and "none". */
export function revokeToken(userId: number, id: number): boolean {
  return queries.revokeToken.run(id, userId).changes > 0;
}

export function tokensOf(userId: number): TokenRow[] {
  return queries.tokensOf.all(userId);
}

/* --- sessions -------------------------------------------------------------- */

export async function openSession(userId: number, now: number): Promise<{ token: string; csrf: string }> {
  const token = newToken();
  const csrf = newToken();
  queries.createSession.run(await tokenDigest(token), userId, csrf, now, now);
  return { token, csrf };
}

/** The session and the account it belongs to, in one query: a session is never read without it. */
export async function readSession(token: string): Promise<{ session: Session; account: Account } | null> {
  const row = queries.sessionByDigest.get(await tokenDigest(token));
  if (row === null) return null;
  return {
    session: {
      digest: row.digest,
      userId: row.user_id,
      csrf: row.csrf,
      createdAt: row.created_at,
      seenAt: row.seen_at,
    },
    account: accountOf(row),
  };
}

export function touchSession(digest: string, now: number): void {
  queries.touchSession.run(now, digest);
}

export function closeSession(digest: string): void {
  queries.deleteSession.run(digest);
}

/** Every session of an account but one - or all of them, given null. Answers how many went. */
export function closeSessionsOf(userId: number, exceptDigest: string | null): number {
  return queries.deleteSessionsOf.run(userId, exceptDigest ?? "").changes;
}

/** Called at each sign-in, not on a timer. */
export function purgeSessions(before: number): void {
  queries.purgeSessions.run(before);
}

/* --- jobs ------------------------------------------------------------------- */

/*
 * The account first, in every function below, and never defaulted. A job id is global and a
 * machine name is not unique across accounts, so each of these is one forgotten argument away
 * from reading someone else's row - which is why there is no argument to forget: the account is
 * part of every statement, and tsc asks every caller for it.
 */

export function insertJob(
  account: number,
  input: {
    verb: string;
    machine: string | null;
    cloud: string | null;
    profile: string | null;
    argv: readonly string[];
    startedAt: number;
  },
): number {
  const row = queries.insertJob.get(
    account,
    input.verb,
    input.machine,
    input.cloud,
    input.profile,
    JSON.stringify(input.argv),
    input.startedAt,
  );
  if (row === null) throw new Error("the job could not be recorded");
  return row.id;
}

export function finishJob(account: number, id: number, state: JobState, exitCode: number, endedAt: number): void {
  queries.finishJob.run(state, exitCode, endedAt, account, id);
}

/**
 * Null for an id no job of THIS account holds - another account's included, and on purpose:
 * the route answers both with the same 404, which is what keeps job ids from being a way to
 * count, or to confirm, what other accounts run.
 */
export function readJob(account: number, id: number): Job | null {
  return queries.job.get(account, id);
}

export function recentJobs(account: number, limit: number): Job[] {
  return queries.recentJobs.all(account, limit);
}

/** Every label of one account at once: the fleet draws a list, and one query beats one per row. */
export function labels(account: number): Map<string, string> {
  return new Map(queries.labels.all(account).map((row) => [row.machine, row.label]));
}

/** An empty label is a removal, so the one control both sets and clears. */
export function setLabel(account: number, machine: string, label: string, now: number): void {
  if (label === "") queries.clearLabel.run(account, machine);
  else queries.setLabel.run(account, machine, label, now);
}

/** Null for a machine this account never ordered here: adopted, or older than the database. */
export function orderedAt(account: number, machine: string): number | null {
  return queries.orderedAt.get(account, machine)?.started_at ?? null;
}

/** Written by POST /api/machines once its job has started: replaces any row of that name. */
export function recordOrigin(
  account: number,
  input: { machine: string; cloud: string; via: Via; orderedAt: number },
): void {
  queries.recordOrigin.run(account, input.machine, input.cloud, input.via, input.orderedAt);
}

/** Null for a machine this account never ordered since machine_origins exists. */
export function machineOrigin(account: number, machine: string): Origin | null {
  return queries.origin.get(account, machine);
}

/** The clouds on which an account other than this one ordered a machine on the service's cloud accounts. */
export function serviceOriginClouds(account: number): Set<string> {
  return new Set(queries.serviceOriginClouds.all(account).map((row) => row.cloud));
}

/** One account's jobs still marked running. Never the sweep's count: see interruptRunning. */
export function runningJobs(account: number): Job[] {
  return queries.runningJobs.all(account);
}

/**
 * Called once at startup. A job found `running` belonged to a process this one did not
 * start, so it is marked interrupted rather than assumed finished: a service restarted
 * mid-apply may have left a machine billing that no state records.
 *
 * Every account's, and the only function here that takes none: a restart kills every job of
 * the cgroup, whoever ordered it. The count is the UPDATE's own, so no read is shared with the
 * per-account one.
 */
export function interruptRunning(now: number): number {
  return queries.interruptRunning.run(now).changes;
}

/* --- composed profiles ------------------------------------------------------- */

/**
 * The rows, as stored. NOT parsed here, and that is a rule about direction rather than
 * taste: src/profiles.ts imports src/validate.ts, which imports src/secrets.ts, which opens
 * its database through this file. A parse in here would close that ring - the same collision
 * that moved clouds() out of config.ts on 11/09. This file stays a leaf, and the module that
 * knows what a spec is turns these rows into one.
 *
 * One account's, always: a profile is rendered into that account's tree and nobody else's.
 */
export function authoredRows(account: number): AuthoredRow[] {
  return queries.authored.all(account);
}

export function authoredRow(account: number, name: string): AuthoredRow | null {
  return queries.authoredByName.get(account, name);
}

export function writeAuthoredRow(account: number, name: string, spec: string, now: number): void {
  queries.saveAuthored.run(account, name, spec, now, now);
}

export function deleteAuthoredRow(account: number, name: string): boolean {
  return queries.deleteAuthored.run(account, name).changes > 0;
}
