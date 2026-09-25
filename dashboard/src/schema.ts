import type { Database } from "bun:sqlite";

/**
 * The tables, and nothing else.
 *
 * What runs and what it costs is not in here: that lives in the Terraform state and, in
 * the last resort, in the provider's API. This database holds a session, a failure
 * counter, a trace of the jobs that were run and the labels given to machines. Confusing
 * the two would make a lost transaction look like a lost machine.
 *
 * The secrets are the exception, and the only rows here that are not a trace of something
 * held elsewhere: since 11/09 the database is where they are kept. Sealed, always - see
 * src/vault.ts - so that this file, copied anywhere, carries nothing that opens without the
 * master key, which lives in the service's environment and never in a table.
 */
export const SCHEMA = [
  // An account: an address, and the Google or GitHub identities that open it (`identities` below).
  //
  // `id` IS `owners.id` in the vault, and AUTOINCREMENT is what makes that safe. Without it
  // SQLite draws max(rowid) + 1, so with the only account deleted the next one would be drawn
  // id 1 again - and would open every secret sealed under it. AUTOINCREMENT never draws an id
  // twice, sqlite_sequence remembering the highest one even once the table is empty.
  //
  // No foreign key to `owners`, in either direction. An account exists before its data key -
  // the vault draws one at the first write, and may be closed when someone signs up - and
  // `owners` holds the sealed data keys, the one table whose loss nothing recovers: it is not
  // rebuilt to gain a declaration. The rule lives in one place instead, sourcesFor() in
  // src/secrets.ts.
  //
  // `email` as typed, for display; `email_folded` is what is looked up and what is unique:
  // NFKC and lower case, see src/accounts.ts. COLLATE NOCASE would fold ASCII alone, and make
  // the search and the uniqueness two different rules.
  //
  // `service_fallback` is read by nothing since 13/09. It was a privilege account 1 granted:
  // whether an account's credentials fell back on the service's. Every account orders on the
  // service's cloud accounts now, unless it connects its own (src/secrets.ts#sourcesFor). The
  // column stays rather than a table being rebuilt for it: `users` is the one table whose ids
  // the vault's owners are.
  //
  // `password_hash` stays too, NOT NULL, and for the same reason. Since 15/09 an account opens
  // through an identity a provider verified, an account created that way writes '' here - no
  // password - and nothing reads the column: the digests of the password era open nothing. Making the
  // column nullable, or dropping it, is a rebuild of `users` - its declaration, every foreign key
  // that points at it, and the sqlite_sequence high-water mark that keeps id 1 from being drawn
  // twice, with `PRAGMA foreign_keys` a no-op inside the transaction that would do it. Nothing is
  // worth that: a column read by nothing costs one empty string a row.
  `CREATE TABLE IF NOT EXISTS users (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     email            TEXT NOT NULL,
     email_folded     TEXT NOT NULL UNIQUE,
     password_hash    TEXT NOT NULL,
     service_fallback INTEGER NOT NULL DEFAULT 0 CHECK (service_fallback IN (0, 1)),
     created_at       INTEGER NOT NULL
   )`,

  // The trace of a cookie, and whose it is. Recreated rather than altered when accounts
  // arrived: losing them costs one sign-in, once, where a column added with a default would
  // have handed every open session to whichever account the default named.
  `CREATE TABLE IF NOT EXISTS sessions (
     digest     TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users (id),
     csrf       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     seen_at    INTEGER NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,

  // One row per address SUBMITTED, folded - and not per account found. A failure against an
  // address nobody holds would otherwise have no row to write and answer faster than one
  // against a real account: an oracle, one timing away. Per address rather than per IP, as
  // before: an attacker who changes IP would sidestep a per-IP counter for free.
  //
  // Two keys are not addresses, and cannot be mistaken for one, having no `@`: `signup`
  // counted refused invitation codes and `claim` refused passwords while account 1 was still
  // unclaimed.
  //
  // READ BY NOTHING SINCE 15/09, when sign-in moved to Google and GitHub and there was no password
  // left to guess. Kept, like the digests in `users`, so that a rollback to the password code
  // finds the table it expects; a later step drops it once production has signed in through a
  // provider.
  `CREATE TABLE IF NOT EXISTS attempts (
     key      TEXT PRIMARY KEY,
     failures INTEGER NOT NULL,
     last_at  INTEGER NOT NULL
   )`,

  // The CLI's tokens, each an account's. Found by its digest, never compared in a loop: N
  // tokens compared one at a time say which one matched by the moment the loop stops. The
  // digest alone is stored, like a session's, so a copy of this file opens nothing.
  `CREATE TABLE IF NOT EXISTS api_tokens (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     digest     TEXT NOT NULL UNIQUE,
     user_id    INTEGER NOT NULL REFERENCES users (id),
     label      TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     used_at    INTEGER
   )`,

  `CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens (user_id)`,

  // What opens an account since 15/09: a Google or GitHub identity, as the provider names it.
  //
  // `(provider, subject)` is the identity, and it is unique: `subject` is Google's `sub` and
  // GitHub's numeric user id - never an address and never a GitHub login, both of which their
  // owner can change and someone else can then take. An identity found here opens its account
  // whatever address the provider says today; an identity not found links to the account whose
  // folded address one of its VERIFIED addresses is (signInWith in src/db.ts), and only then is a
  // new account considered. So one account may hold several identities, two of one provider
  // included, and an identity belongs to one account for good.
  //
  // `email` is the address the provider verified at the latest sign-in, as it spelled it, and it
  // is informational: nothing looks an account up by it, and `users.email` never follows it. An
  // account's address is the one it was created with, whatever its identities say later.
  //
  // REFERENCES users, and nothing cascades, like `secrets` on `owners`: an account cannot go while
  // an identity still opens it, and taking its ways in away has to be a decision someone takes,
  // not a side effect of tidying a table.
  `CREATE TABLE IF NOT EXISTS identities (
     provider   TEXT NOT NULL CHECK (provider IN ('google', 'github')),
     subject    TEXT NOT NULL,
     user_id    INTEGER NOT NULL REFERENCES users (id),
     email      TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE (provider, subject)
   )`,

  `CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id)`,

  // `argv` keeps exactly what was spawned, as JSON. Not for replay: so that a job whose
  // log is unhelpful can still be told apart from the one before it.
  //
  // There is no column for the log. Its path is the asking account's logs/<id>.log, derived by
  // jobs.ts#logPath, and a column that could only ever hold that same value would be a
  // second place to get it wrong.
  //
  // `account_id` is whose job it is, and every query of src/db.ts that reads or writes a row
  // here names it - tests/scoping.test.ts reads the file and fails on one that does not. The
  // ids stay global, drawn from one sequence, which is exactly why the column matters: an id
  // alone says nothing about whose it is, and a route answering `GET /api/jobs/7` on the id
  // alone would hand one account the apply of another.
  //
  // Last, with a DEFAULT and without REFERENCES, and neither is taste. The column arrived on
  // a table that already had rows, through `ALTER TABLE ... ADD COLUMN`, which appends and
  // demands a default for a NOT NULL column; and SQLite refuses that same ALTER when the
  // column also declares a foreign key while `foreign_keys = ON`, which src/database.ts sets
  // on every connection. A fresh file declares it the same way, so that a database has one
  // shape whichever road it took. The default is never relied upon: insertJob names the
  // column, and the default would otherwise be a job quietly filed under account 1.
  `CREATE TABLE IF NOT EXISTS jobs (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     verb       TEXT NOT NULL,
     machine    TEXT,
     cloud      TEXT,
     profile    TEXT,
     argv       TEXT NOT NULL,
     state      TEXT NOT NULL,
     exit_code  INTEGER,
     started_at INTEGER NOT NULL,
     ended_at   INTEGER,
     account_id INTEGER NOT NULL DEFAULT 1
   )`,

  // One account's jobs, newest first: the list, and the per-account read of what runs.
  `CREATE INDEX IF NOT EXISTS jobs_account ON jobs (account_id, started_at DESC)`,

  // A name a person gave a machine, and the ONLY place a machine is named twice.
  //
  // The real name is an identifier before it is a word: devbox-core draws it once and it
  // becomes the Terraform workspace, the ssh Host alias, the resource at the provider and
  // the machine's own hostname, all at once and on purpose. Renaming it here would rename
  // three of those and leave two behind, which is the drift this repository spends its
  // comments closing.
  //
  // So this is a label and never an identity: nothing reads it, nothing resolves it, no
  // request carries it. It is displayed, and the real name is displayed beside it, because
  // `ssh <name>` still wants the real one.
  //
  // No foreign key and no cleanup on destroy: the row is two short strings, and a machine
  // taken down and ordered again under the same name is a machine that most likely wants
  // its label back.
  //
  // Keyed by the account AND the machine. A machine name is only unique inside one account's
  // tree - devbox-core draws five characters, and two accounts may well both hold a
  // `devbox-web01` - so a label keyed by the name alone would let one account rename, on its
  // own page, the machine another account sees.
  `CREATE TABLE IF NOT EXISTS labels (
     account_id INTEGER NOT NULL,
     machine    TEXT NOT NULL,
     label      TEXT NOT NULL,
     set_at     INTEGER NOT NULL,
     PRIMARY KEY (account_id, machine)
   )`,

  // Where a machine was ordered: its cloud, and whose credentials it was ordered with - this
  // account's own, or the service's cloud accounts an extension put it on (src/extension.ts).
  //
  // The one question a destroy cannot ask the state, nor today's resolution. A machine lives in
  // the provider account it was ordered in, and a `down` handed another account's token for that
  // cloud is refused by nobody: the provider answers 404 for a server of another project,
  // terraform may read that as a server already gone and drop it from the state, and the job
  // succeeds on a machine that bills on with nothing left to reach it. Today's resolution is the
  // wrong witness both ways: an extension may have taken the account off the service's cloud
  // accounts since the order, or the account may have deleted the token of its own it ordered
  // with - and then resolves the SERVICE's, for a server in its own project. So the answer is
  // written down at the order, out of the resolution that laid the order's credentials out, and
  // read back by destroySourcesFor in src/secrets.ts.
  //
  // One row per name, the latest order's: a name ordered again is a new machine, perhaps on other
  // credentials. Kept after a destroy, like a label, and not by neglect: a `down` that succeeded on
  // a state the provider had already lost leaves the machine on the meter all the same, and a
  // `service` row is then what keeps it out of the founder's orphans.
  //
  // `cloud` has no CHECK, the list of clouds growing with the roots; `via` has one, being the rule.
  // Keyed by the account and the machine for the reason `labels` is. No foreign key either.
  `CREATE TABLE IF NOT EXISTS machine_origins (
     account_id INTEGER NOT NULL,
     machine    TEXT NOT NULL,
     cloud      TEXT NOT NULL,
     via        TEXT NOT NULL CHECK (via IN ('own', 'service')),
     ordered_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, machine)
   )`,

  // One row per owner, holding that owner's data key sealed under the master key.
  //
  // `key_version` says WHICH master key sealed it, and it is part of what the seal
  // authenticates. That is what lets a rotation run with the old key and the new one side by
  // side: a row still under the previous version is opened with the previous key, rewrapped,
  // and a restart halfway through loses nothing.
  //
  // There is one owner today, and the table exists anyway. Adding it the day a second person
  // appears would mean a migration re-sealing every stored value under a key of its own;
  // declaring it now costs one row and an integer per secret.
  `CREATE TABLE IF NOT EXISTS owners (
     id          INTEGER PRIMARY KEY,
     dek         BLOB NOT NULL,
     nonce       BLOB NOT NULL,
     key_version INTEGER NOT NULL,
     created_at  INTEGER NOT NULL
   )`,

  // The values, each sealed under its owner's data key, with its owner, kind and name as
  // authenticated data: a ciphertext copied onto another row does not open there.
  //
  // Nothing that serves a page selects `ciphertext`. `fingerprint` is what the interface shows
  // instead, and it is an HMAC under a key derived from the data key, never a bare SHA-256: a
  // bare digest in a stolen copy of this file would let anyone test guesses against a short
  // token offline, and it would show which rows hold the same value. `size` gives away nothing
  // the ciphertext's own length does not already, GCM adding a fixed sixteen bytes.
  //
  // The foreign key cascades nothing, so an owner cannot be deleted while it still has values.
  // Its row going away would make every one of them unreadable at once, and that has to be a
  // decision someone takes, not a side effect of tidying a table.
  `CREATE TABLE IF NOT EXISTS secrets (
     owner_id    INTEGER NOT NULL REFERENCES owners (id),
     kind        TEXT NOT NULL CHECK (kind IN ('cloud', 'profile')),
     name        TEXT NOT NULL,
     ciphertext  BLOB NOT NULL,
     nonce       BLOB NOT NULL,
     fingerprint TEXT NOT NULL,
     size        INTEGER NOT NULL,
     updated_at  INTEGER NOT NULL,
     PRIMARY KEY (owner_id, kind, name)
   )`,

  // A profile composed from the form, as the form answered it.
  //
  // The second table that is not a trace of something held elsewhere, and the reason is the
  // same as the vault's, taken from the other end: the rendered `.sh` under the account's
  // config/profiles IS held elsewhere, and a file cannot be read back into a form.
  // So the spec is the authority and the file is its render - the relation devbox-core has
  // with engine/devbox - and src/profiles.ts#syncProfiles makes the disk agree again at an
  // account's first use, after a restore or after the renderer itself has moved.
  //
  // `spec` is JSON and holds NO VALUE: names of secrets, urls of repositories, ids from the
  // software catalogue. The values stay in `secrets` above, sealed. A profile that carried
  // them would put every token of every machine in a table nothing seals, and in a file
  // `devbox seed` streams onto the machine.
  //
  // The name is in the primary key because it is the profile's identity everywhere else: the
  // file name devbox-core resolves, the `--profile` of a job, the string recorded in the
  // machine's ssh config. Renaming one is composing another.
  //
  // The account is the other half of the key, and the file says why: a composed profile is
  // rendered into accounts/<id>/config/profiles, which devbox-core searches before its own
  // directory - for THAT account. Two accounts composing a `web` compose two profiles, and a
  // key on the name alone would have the second save overwrite the first account's spec, and
  // the first account's next start render the second one's into its tree.
  `CREATE TABLE IF NOT EXISTS profiles (
     account_id INTEGER NOT NULL,
     name       TEXT NOT NULL,
     spec       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, name)
   )`,

  // What was done to which secret and when, never what it was set to: an audit trail that
  // held values would be a second copy of every secret, kept forever, and outside the seal.
  //
  // No foreign key, like `labels`: a trace outlives what it traces, and a deleted secret is
  // precisely the one whose history someone will ask for.
  `CREATE TABLE IF NOT EXISTS secret_events (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_id INTEGER NOT NULL,
     kind     TEXT NOT NULL CHECK (kind IN ('cloud', 'profile')),
     name     TEXT NOT NULL,
     action   TEXT NOT NULL CHECK (action IN ('set', 'delete', 'import')),
     at       INTEGER NOT NULL
   )`,
] as const;

/**
 * What `PRAGMA user_version` reads once applySchema has run. One counter for every step, so
 * a database says in one integer which of them it has been through.
 */
export const SCHEMA_VERSION = 4;

/**
 * The tables as SCHEMA declares them, and the steps an older file needs to get there.
 *
 * `CREATE TABLE IF NOT EXISTS` alone cannot change a table that exists, so a shape that moved
 * takes a numbered step, run once and recorded in `user_version` - inside the same transaction
 * as the CREATEs, so a process killed halfway leaves the old version and the old tables, and
 * the next start replays the whole step rather than half of it.
 *
 *   1  sessions and attempts, dropped and recreated: a session gained its account, and the
 *      failure counter its address. Neither is worth migrating - a session costs one sign-in,
 *      a counter one reset - and NOTHING ELSE is touched: owners, secrets, jobs, labels and
 *      profiles are the rows that are not a trace of something held elsewhere.
 *   2  jobs, labels and profiles gain their account, and every row they held is account 1's:
 *      the service had one user, and account 1 is the account that becomes it. See
 *      accountStep below for how each table gets there.
 *   3  machine_origins, which SCHEMA creates like any new table: there is no step to run, and
 *      NOTHING is brought forward into it. No row is invented for a machine ordered before it:
 *      `jobs` names the cloud of an `up`, never whose credentials it ran with, and a guess there
 *      is exactly the mistake the table exists to prevent. A machine without a row is decided
 *      by the rule for those, in destroySourcesFor.
 *   4  identities, created the same way and empty, on 15/09. No account is given an identity
 *      it never signed in with: an account of the password era opens at the first sign-in whose
 *      verified address folds to its own, which is the same link any account gets. `users`,
 *      `sessions` and `attempts` are left exactly as they are, digests included, so that a
 *      rollback to the password code still signs everyone in.
 *
 * The steps run BEFORE the CREATEs, and step 2 is why the order matters: SCHEMA indexes
 * `jobs (account_id, ...)`, which an old `jobs` table has no column for. On a fresh file the
 * step finds no table to bring forward and SCHEMA creates them in their new shape.
 *
 * No `migrate()` beside this: the vault's tests and src/db.ts call applySchema and nothing
 * else, and a second entry point is a second place for a step to be forgotten.
 */
export function applySchema(db: Database): void {
  db.transaction(() => {
    const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;

    if (version < 1) {
      db.run("DROP TABLE IF EXISTS sessions");
      db.run("DROP TABLE IF EXISTS attempts");
    }

    if (version < 2) accountStep(db);

    for (const statement of SCHEMA) {
      db.run(statement);
    }

    if (version < SCHEMA_VERSION) db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}

/**
 * Step 2: the three tables that were one user's become account 1's.
 *
 * `jobs` is ALTERED, and keeps its rows where they are: its ids are AUTOINCREMENT, a log file is
 * named after each one, and a rebuild would have to carry sqlite_sequence across by hand for no
 * gain. The column is appended with DEFAULT 1, which fills every existing row in the same
 * statement - and without REFERENCES, which SQLite refuses on that ALTER under
 * `foreign_keys = ON`. Its old index goes: SCHEMA declares the one keyed by account.
 *
 * `labels` and `profiles` are REBUILT, because what moved is their primary key and no ALTER
 * changes a key. SQLite's own procedure for that: create the new table, copy every row with
 * account 1, drop the old one, rename the new one into its place. Nothing references either
 * table, so the drop checks no foreign key and the rename rewrites no other declaration.
 *
 * Each table is asked for before it is touched: a fresh file at version 0 has none of them,
 * and SCHEMA creates them next, already in this shape.
 */
function accountStep(db: Database): void {
  const exists = (table: string) =>
    db.query<{ found: number }, [string]>("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;

  if (exists("jobs")) {
    db.run("ALTER TABLE jobs ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1");
    db.run("DROP INDEX IF EXISTS jobs_started");
  }

  if (exists("labels")) {
    db.run(`CREATE TABLE labels_v2 (
       account_id INTEGER NOT NULL,
       machine    TEXT NOT NULL,
       label      TEXT NOT NULL,
       set_at     INTEGER NOT NULL,
       PRIMARY KEY (account_id, machine)
     )`);
    db.run(
      `INSERT INTO labels_v2 (account_id, machine, label, set_at)
         SELECT ${FOUNDING_ACCOUNT}, machine, label, set_at FROM labels`,
    );
    db.run("DROP TABLE labels");
    db.run("ALTER TABLE labels_v2 RENAME TO labels");
  }

  if (exists("profiles")) {
    db.run(`CREATE TABLE profiles_v2 (
       account_id INTEGER NOT NULL,
       name       TEXT NOT NULL,
       spec       TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       PRIMARY KEY (account_id, name)
     )`);
    db.run(
      `INSERT INTO profiles_v2 (account_id, name, spec, created_at, updated_at)
         SELECT ${FOUNDING_ACCOUNT}, name, spec, created_at, updated_at FROM profiles`,
    );
    db.run("DROP TABLE profiles");
    db.run("ALTER TABLE profiles_v2 RENAME TO profiles");
  }
}

/**
 * The account the service had before it had accounts: the first one to exist - claimed with
 * PASSWORD_HASH or signed up for before 15/09, founded by DEVBOX_FOUNDER_EMAIL's verified address
 * since. Its id is fixed because the vault already seals
 * the service's secrets under owner 1 - see firstImport in src/secrets.ts.
 *
 * Declared here rather than in src/accounts.ts, which re-exports it, so that src/db.ts can
 * insert it while staying a leaf.
 */
export const FOUNDING_ACCOUNT = 1;

/** Who is asking, once a session or a token has said so. */
export type Account = {
  id: number;
  email: string;
};

/**
 * `running` is the only state a restart can leave behind wrongly, and it is never taken
 * at face value on the way back up. A service killed mid-apply may have left a machine
 * with the provider that no state records, which is what `devbox orphans` is for.
 */
export type JobState = "running" | "succeeded" | "failed" | "interrupted";

/** Whose credentials a machine was ordered with: its account's own, or the service's cloud accounts. */
export type Via = "own" | "service";

/** A row of machine_origins, as a destroy reads it back. */
export type Origin = { cloud: string; via: Via; ordered_at: number };

export type Job = {
  id: number;
  /** Whose job it is. Every read that hands one back was already asked for that account. */
  account_id: number;
  verb: string;
  machine: string | null;
  cloud: string | null;
  profile: string | null;
  argv: string;
  state: JobState;
  exit_code: number | null;
  started_at: number;
  ended_at: number | null;
};
