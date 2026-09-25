import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { checkpoint, openDatabase, PRAGMAS } from "../src/database";
import { applySchema, SCHEMA_VERSION } from "../src/schema";

// tests/prepare.ts must have diverted DATA_DIR before any import.
if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const db = openDatabase(join(DATA_DIR, "pragmas.db"));

/**
 * Reads back a setting applied to the connection. The returned column is named
 * differently per pragma, hence reading the first value.
 */
function setting(name: string): unknown {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
  return row === null ? null : Object.values(row)[0];
}

describe("openDatabase", () => {
  test("waits for a lock rather than handing back SQLITE_BUSY", () => {
    expect(setting("busy_timeout")).toBe(10000);
  });

  test("sets busy_timeout before switching to WAL", () => {
    // The order matters: the connection must know how to wait for a lock before the
    // journal mode changes, or it fails outright if another connection switches at that
    // same instant.
    expect(PRAGMAS[0]).toMatch(/^busy_timeout/);
    expect(PRAGMAS.findIndex((p) => p.startsWith("journal_mode"))).toBeGreaterThan(0);
  });

  test("journals in WAL, with a 64 MB ceiling", () => {
    expect(setting("journal_mode")).toBe("wal");
    expect(setting("journal_size_limit")).toBe(67108864);
  });

  test("commits without fsync, which WAL makes safe", () => {
    // 1 is NORMAL, 2 is FULL.
    expect(setting("synchronous")).toBe(1);
  });

  test("checks foreign keys, which SQLite ignores by default", () => {
    expect(setting("foreign_keys")).toBe(1);
  });

  test("keeps temporary tables and the cache in memory", () => {
    // 2 is MEMORY; the cache is a ceiling in kibibytes, hence the sign.
    expect(setting("temp_store")).toBe(2);
    expect(setting("cache_size")).toBe(-16000);
  });

  test("checkpoint moves every commit out of the WAL, which is the fsync NORMAL saved", () => {
    // What makes a secret write survive a power cut under synchronous = NORMAL. The WAL is
    // synced before the checkpoint copies it and truncated after, so zero bytes left in it is
    // the observable half of "on the disk, synced".
    const path = join(DATA_DIR, "checkpoint.db");
    const fresh = openDatabase(path);
    fresh.run("CREATE TABLE t (v TEXT)");
    fresh.run("INSERT INTO t (v) VALUES ('rotated')");
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(checkpoint(fresh)).toBe(true);
    expect(statSync(`${path}-wal`).size).toBe(0);
    fresh.close();
  });

  test("refuses a query with a missing parameter", () => {
    // This is what strict mode buys: without it the absent parameter would be bound to
    // NULL and the row written anyway.
    const query = db.query<{ a: number }, { a: number }>("SELECT $a AS a");
    expect(query.get({ a: 1 })?.a).toBe(1);
    expect(() => query.get({} as { a: number })).toThrow();
  });
});

/**
 * The shape this database had before accounts, as of 11/09, written out rather than imported:
 * the point of the test below is that a file created by THAT version is brought forward, and
 * a copy of today's SCHEMA would only prove today agrees with itself.
 */
const OLD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
     digest     TEXT PRIMARY KEY,
     csrf       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     seen_at    INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS attempts (
     id       INTEGER PRIMARY KEY CHECK (id = 1),
     failures INTEGER NOT NULL,
     last_at  INTEGER NOT NULL
   )`,
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
     ended_at   INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS jobs_started ON jobs (started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS labels (
     machine TEXT PRIMARY KEY,
     label   TEXT NOT NULL,
     set_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS owners (
     id          INTEGER PRIMARY KEY,
     dek         BLOB NOT NULL,
     nonce       BLOB NOT NULL,
     key_version INTEGER NOT NULL,
     created_at  INTEGER NOT NULL
   )`,
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
  `CREATE TABLE IF NOT EXISTS profiles (
     name       TEXT PRIMARY KEY,
     spec       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS secret_events (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_id INTEGER NOT NULL,
     kind     TEXT NOT NULL CHECK (kind IN ('cloud', 'profile')),
     name     TEXT NOT NULL,
     action   TEXT NOT NULL CHECK (action IN ('set', 'delete', 'import')),
     at       INTEGER NOT NULL
   )`,
] as const;

/** Every table that is not a trace of something held elsewhere, and must survive. */
const KEPT = ["owners", "secrets", "secret_events", "jobs", "labels", "profiles"] as const;

/** Of those, the ones no step touches at all: byte for byte, declaration included. */
const UNTOUCHED = ["owners", "secrets", "secret_events"] as const;

/** And the ones step 2 gives an account: every row kept, and every row account 1's. */
const SCOPED = ["jobs", "labels", "profiles"] as const;

/** A row with its account taken off, to compare with the row it was before it had one. */
const withoutAccount = (rows: unknown[]): unknown[] =>
  rows.map((row) => {
    const { account_id: _, ...rest } = row as Record<string, unknown>;
    return rest;
  });

const accountsOf = (rows: unknown[]): unknown[] => rows.map((row) => (row as { account_id: unknown }).account_id);

const indexesOf = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA index_list(${table})`).all() as { name: string; origin: string }[])
    .filter((row) => row.origin === "c")
    .map((row) => row.name)
    .sort();

/** Each column, with its declared type, whether it is NOT NULL, its default and its place in the key. */
const shapeOf = (db: Database, table: string): unknown[] => db.query(`PRAGMA table_info(${table})`).all();

const rowsOf = (db: Database, table: string): unknown[] =>
  db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();

const declarationOf = (db: Database, name: string): unknown =>
  db.query("SELECT sql FROM sqlite_master WHERE name = ?").get(name);

const version = (db: Database): number =>
  (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

const columns = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

function oldShaped(path: string): Database {
  const db = openDatabase(path);
  for (const statement of OLD_SCHEMA) db.run(statement);

  db.run("INSERT INTO sessions (digest, csrf, created_at, seen_at) VALUES ('d1', 'c1', 1, 2)");
  db.run("INSERT INTO attempts (id, failures, last_at) VALUES (1, 3, 4)");
  db.run(
    `INSERT INTO jobs (verb, machine, cloud, profile, argv, state, exit_code, started_at, ended_at)
       VALUES ('up', 'devbox-old', 'hetzner', 'claude', '["up"]', 'succeeded', 0, 10, 20)`,
  );
  db.run("INSERT INTO labels (machine, label, set_at) VALUES ('devbox-old', 'the old one', 30)");
  db.query("INSERT INTO owners (id, dek, nonce, key_version, created_at) VALUES (1, ?, ?, 1, 40)").run(
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([5, 6, 7]),
  );
  db.query(
    `INSERT INTO secrets (owner_id, kind, name, ciphertext, nonce, fingerprint, size, updated_at)
       VALUES (1, 'cloud', 'HCLOUD_TOKEN', ?, ?, 'a1b2c3d4e5f6', 12, 50)`,
  ).run(new Uint8Array([8, 9, 10]), new Uint8Array([11, 12]));
  db.run(
    "INSERT INTO secret_events (owner_id, kind, name, action, at) VALUES (1, 'cloud', 'HCLOUD_TOKEN', 'set', 60)",
  );
  db.run(
    `INSERT INTO profiles (name, spec, created_at, updated_at)
       VALUES ('composed', '{"name":"composed"}', 70, 80)`,
  );
  return db;
}

/**
 * A database written before accounts, brought forward.
 *
 * The two halves are worth the same. `sessions` and `attempts` are recreated, and that is a
 * decision: a session costs one sign-in to lose and a counter one reset, where migrating them
 * would have meant inventing an account for each. Everything else is the rows that are NOT a
 * trace of something held elsewhere - the sealed secrets above all, the one table whose loss
 * nothing recovers - and they must come through byte for byte, declaration included.
 */
describe("applySchema on a database of the old shape", () => {
  const path = join(DATA_DIR, "old-shape.db");
  const db = oldShaped(path);
  const before = Object.fromEntries(KEPT.map((table) => [table, rowsOf(db, table)]));
  const declarations = Object.fromEntries(KEPT.map((table) => [table, declarationOf(db, table)]));

  expect(version(db)).toBe(0);
  applySchema(db);

  test("records the version it brought the file to", () => {
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
  });

  test("recreates sessions and attempts, empty and in their new shape", () => {
    expect(rowsOf(db, "sessions")).toEqual([]);
    expect(rowsOf(db, "attempts")).toEqual([]);
    expect(columns(db, "sessions")).toEqual(["digest", "user_id", "csrf", "created_at", "seen_at"]);
    expect(columns(db, "attempts")).toEqual(["key", "failures", "last_at"]);
  });

  test("leaves the vault's rows exactly as they were, declaration included", () => {
    for (const table of UNTOUCHED) {
      expect(rowsOf(db, table), table).toEqual(before[table] as unknown[]);
      expect(declarationOf(db, table), table).toEqual(declarations[table]);
    }
    // The sealed value is still the same bytes, which is the row nothing could rebuild.
    const secret = (db.query("SELECT ciphertext, nonce FROM secrets").get() ?? {}) as {
      ciphertext: Uint8Array;
      nonce: Uint8Array;
    };
    expect(secret.ciphertext).toEqual(new Uint8Array([8, 9, 10]));
    expect(secret.nonce).toEqual(new Uint8Array([11, 12]));
  });

  test("keeps every job, label and profile, each now account 1's", () => {
    for (const table of SCOPED) {
      const after = rowsOf(db, table);
      expect(withoutAccount(after), table).toEqual(before[table] as unknown[]);
      expect(accountsOf(after), table).toEqual((before[table] as unknown[]).map(() => 1));
    }
  });

  test("adds the identity tables", () => {
    expect(columns(db, "users")).toEqual([
      "id",
      "email",
      "email_folded",
      "password_hash",
      "service_fallback",
      "created_at",
    ]);
    expect(columns(db, "api_tokens")).toEqual([
      "id",
      "digest",
      "user_id",
      "label",
      "created_at",
      "used_at",
    ]);
  });

  test("a second pass changes nothing at all", () => {
    // Run at every start, by src/db.ts: a step that ran twice would drop a session table an
    // hour into the service's life, or worse, a step 2 would one day drop something else.
    const dump = () => ({
      schema: db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
      tables: Object.fromEntries(
        [...KEPT, "sessions", "attempts", "users", "api_tokens"].map((table) => [
          table,
          rowsOf(db, table),
        ]),
      ),
      version: version(db),
    });
    const settled = dump();
    applySchema(db);
    expect(dump()).toEqual(settled);
  });
});

/**
 * The shape a database had between the two steps: accounts, sessions and tokens already there,
 * and jobs, labels and profiles still one user's. Written out, like OLD_SCHEMA above, because
 * what is under test is a file THAT version wrote.
 */
const V1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     email            TEXT NOT NULL,
     email_folded     TEXT NOT NULL UNIQUE,
     password_hash    TEXT NOT NULL,
     service_fallback INTEGER NOT NULL DEFAULT 0 CHECK (service_fallback IN (0, 1)),
     created_at       INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     digest     TEXT PRIMARY KEY,
     user_id    INTEGER NOT NULL REFERENCES users (id),
     csrf       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     seen_at    INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id)`,
  `CREATE TABLE IF NOT EXISTS attempts (
     key      TEXT PRIMARY KEY,
     failures INTEGER NOT NULL,
     last_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS api_tokens (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     digest     TEXT NOT NULL UNIQUE,
     user_id    INTEGER NOT NULL REFERENCES users (id),
     label      TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     used_at    INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens (user_id)`,
  ...OLD_SCHEMA.filter((statement) => !/TABLE IF NOT EXISTS (sessions|attempts) /.test(statement)),
] as const;

/** Every table of version 1 that step 2 must not touch, the identity tables included. */
const V1_UNTOUCHED = [...UNTOUCHED, "users", "sessions", "attempts", "api_tokens"] as const;

function v1Shaped(path: string): Database {
  const db = openDatabase(path);
  for (const statement of V1_SCHEMA) db.run(statement);
  db.run(
    `INSERT INTO users (id, email, email_folded, password_hash, service_fallback, created_at)
       VALUES (1, 'Founder@devbox.test', 'founder@devbox.test', '$argon2id$x', 1, 1)`,
  );
  db.run("INSERT INTO sessions (digest, user_id, csrf, created_at, seen_at) VALUES ('d1', 1, 'c1', 2, 3)");
  db.run("INSERT INTO attempts (key, failures, last_at) VALUES ('founder@devbox.test', 2, 4)");
  db.run("INSERT INTO api_tokens (digest, user_id, label, created_at, used_at) VALUES ('t1', 1, 'CLI', 5, NULL)");
  db.run(
    `INSERT INTO jobs (verb, machine, cloud, profile, argv, state, exit_code, started_at, ended_at)
       VALUES ('up', 'devbox-one', 'hetzner', 'bare', '["up"]', 'succeeded', 0, 10, 20),
              ('down', 'devbox-one', NULL, NULL, '["down"]', 'failed', 1, 30, 40)`,
  );
  db.run("INSERT INTO labels (machine, label, set_at) VALUES ('devbox-one', 'the first', 50)");
  db.run(
    `INSERT INTO profiles (name, spec, created_at, updated_at)
       VALUES ('web', '{"name":"web"}', 60, 70), ('api', '{"name":"api"}', 80, 90)`,
  );
  db.run("PRAGMA user_version = 1");
  return db;
}

/**
 * A database written by the first half of the accounts work, brought through the second.
 *
 * Step 1 must NOT run again here - a version 1 file already has its sessions and its counter,
 * and dropping them an hour into a service's life would sign every account out - and step 2
 * must keep every job, label and profile, under the one account that existed when they were
 * written.
 */
describe("applySchema on a database of version 1", () => {
  const path = join(DATA_DIR, "v1-shape.db");
  const db = v1Shaped(path);
  const before = Object.fromEntries(
    [...V1_UNTOUCHED, ...SCOPED].map((table) => [table, rowsOf(db, table)]),
  );
  const declarations = Object.fromEntries(V1_UNTOUCHED.map((table) => [table, declarationOf(db, table)]));
  applySchema(db);

  test("reaches the current version", () => {
    expect(version(db)).toBe(SCHEMA_VERSION);
  });

  test("touches neither the vault nor the identity tables: no session is lost", () => {
    for (const table of V1_UNTOUCHED) {
      expect(rowsOf(db, table), table).toEqual(before[table] as unknown[]);
      expect(declarationOf(db, table), table).toEqual(declarations[table]);
    }
    expect(rowsOf(db, "sessions")).toHaveLength(1);
  });

  test("keeps every job, label and profile under account 1, ids included", () => {
    for (const table of SCOPED) {
      const after = rowsOf(db, table);
      expect(withoutAccount(after), table).toEqual(before[table] as unknown[]);
      expect(accountsOf(after), table).toEqual((before[table] as unknown[]).map(() => 1));
    }
    // The job ids are what the log files are named after: they must not have been redrawn.
    expect((rowsOf(db, "jobs") as { id: number }[]).map((row) => row.id)).toEqual([1, 2]);
  });

  test("keys labels and profiles by account, so a second account can hold the same name", () => {
    db.run("INSERT INTO labels (account_id, machine, label, set_at) VALUES (2, 'devbox-one', 'theirs', 51)");
    db.run(
      "INSERT INTO profiles (account_id, name, spec, created_at, updated_at) VALUES (2, 'web', '{}', 61, 71)",
    );
    // And the same account still cannot hold it twice.
    expect(() =>
      db.run("INSERT INTO labels (account_id, machine, label, set_at) VALUES (1, 'devbox-one', 'again', 52)"),
    ).toThrow();
    expect(() =>
      db.run("INSERT INTO profiles (account_id, name, spec, created_at, updated_at) VALUES (1, 'web', '{}', 62, 72)"),
    ).toThrow();
    db.run("DELETE FROM labels WHERE account_id = 2");
    db.run("DELETE FROM profiles WHERE account_id = 2");
  });

  test("indexes jobs by account, and drops the index that had none", () => {
    expect(indexesOf(db, "jobs")).toEqual(["jobs_account"]);
  });

  test("a second pass changes nothing at all", () => {
    const dump = () => ({
      schema: db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
      tables: Object.fromEntries([...V1_UNTOUCHED, ...SCOPED].map((table) => [table, rowsOf(db, table)])),
      version: version(db),
    });
    const settled = dump();
    applySchema(db);
    expect(dump()).toEqual(settled);
  });
});

/**
 * One shape, whichever road a file took. A column that a fresh database declared one way and a
 * migrated one another - a default here, a key there - would be a difference nobody reads until
 * a query behaves differently on the server than on the workstation.
 */
describe("a fresh database and a brought-forward one", () => {
  test("have the same columns, defaults, keys and indexes on every table step 2 touched", () => {
    const fresh = openDatabase(join(DATA_DIR, "fresh-shape.db"));
    applySchema(fresh);
    const migrated = v1Shaped(join(DATA_DIR, "v1-shape-compare.db"));
    applySchema(migrated);

    for (const table of [...SCOPED, "machine_origins", "identities"]) {
      expect(shapeOf(migrated, table), table).toEqual(shapeOf(fresh, table));
      expect(indexesOf(migrated, table), table).toEqual(indexesOf(fresh, table));
    }
  });
});

/**
 * The shape a database had at version 2, as of 15/09: every table an account scopes, and no
 * machine_origins. Built out of V1_SCHEMA with its three pre-account tables written out again in
 * the shape step 2 left them - not imported from SCHEMA, for the reason the two above are not.
 */
const V2_SCHEMA = [
  ...V1_SCHEMA.filter((statement) => !/(TABLE IF NOT EXISTS (jobs|labels|profiles)|INDEX IF NOT EXISTS jobs_started) /.test(statement)),
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
  `CREATE INDEX IF NOT EXISTS jobs_account ON jobs (account_id, started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS labels (
     account_id INTEGER NOT NULL,
     machine    TEXT NOT NULL,
     label      TEXT NOT NULL,
     set_at     INTEGER NOT NULL,
     PRIMARY KEY (account_id, machine)
   )`,
  `CREATE TABLE IF NOT EXISTS profiles (
     account_id INTEGER NOT NULL,
     name       TEXT NOT NULL,
     spec       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, name)
   )`,
] as const;

/** Every table and index of version 2, each of which step 3 must leave exactly as it found it. */
const V2_TABLES = ["users", "sessions", "attempts", "api_tokens", "jobs", "labels", "owners", "secrets", "profiles", "secret_events"] as const;
const V2_INDEXES = ["sessions_user", "api_tokens_user", "jobs_account"] as const;

function v2Shaped(path: string): Database {
  const db = openDatabase(path);
  for (const statement of V2_SCHEMA) db.run(statement);
  db.run(
    `INSERT INTO users (id, email, email_folded, password_hash, service_fallback, created_at)
       VALUES (1, 'Founder@devbox.test', 'founder@devbox.test', '$argon2id$x', 1, 1),
              (2, 'other@devbox.test', 'other@devbox.test', '$argon2id$y', 0, 2)`,
  );
  db.run("INSERT INTO sessions (digest, user_id, csrf, created_at, seen_at) VALUES ('d2', 2, 'c2', 3, 4)");
  db.run("INSERT INTO attempts (key, failures, last_at) VALUES ('other@devbox.test', 1, 5)");
  db.run("INSERT INTO api_tokens (digest, user_id, label, created_at, used_at) VALUES ('t2', 2, 'CLI', 6, 7)");
  db.run(
    `INSERT INTO jobs (verb, machine, cloud, profile, argv, state, exit_code, started_at, ended_at, account_id)
       VALUES ('up', 'devbox-two', 'hetzner', 'bare', '["up"]', 'succeeded', 0, 10, 20, 2),
              ('down', 'devbox-one', NULL, NULL, '["down"]', 'failed', 1, 30, 40, 1)`,
  );
  db.run("INSERT INTO labels (account_id, machine, label, set_at) VALUES (2, 'devbox-two', 'theirs', 50)");
  db.query("INSERT INTO owners (id, dek, nonce, key_version, created_at) VALUES (2, ?, ?, 1, 40)").run(
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([5, 6, 7]),
  );
  db.query(
    `INSERT INTO secrets (owner_id, kind, name, ciphertext, nonce, fingerprint, size, updated_at)
       VALUES (2, 'cloud', 'HCLOUD_TOKEN', ?, ?, 'a1b2c3d4e5f6', 12, 50)`,
  ).run(new Uint8Array([8, 9, 10]), new Uint8Array([11, 12]));
  db.run("INSERT INTO secret_events (owner_id, kind, name, action, at) VALUES (2, 'cloud', 'HCLOUD_TOKEN', 'set', 60)");
  db.run(
    `INSERT INTO profiles (account_id, name, spec, created_at, updated_at)
       VALUES (2, 'web', '{"name":"web"}', 60, 70)`,
  );
  db.run("PRAGMA user_version = 2");
  return db;
}

/**
 * A database of version 2 brought to 3. The step adds a table and runs nothing, and what is under
 * test is that "nothing": every row of every table - the sealed ones, the sessions, the job ids the
 * logs are named after - and every declaration, as they were.
 */
describe("applySchema on a database of version 2", () => {
  const db = v2Shaped(join(DATA_DIR, "v2-shape.db"));
  const before = Object.fromEntries(V2_TABLES.map((table) => [table, rowsOf(db, table)]));
  const declarations = Object.fromEntries([...V2_TABLES, ...V2_INDEXES].map((name) => [name, declarationOf(db, name)]));
  applySchema(db);

  test("reaches the current version", () => {
    expect(version(db)).toBe(SCHEMA_VERSION);
  });

  test("keeps every row and every declaration it had", () => {
    for (const table of V2_TABLES) expect(rowsOf(db, table), table).toEqual(before[table] as unknown[]);
    for (const name of [...V2_TABLES, ...V2_INDEXES]) expect(declarationOf(db, name), name).toEqual(declarations[name]);
    expect((rowsOf(db, "jobs") as { id: number }[]).map((row) => row.id)).toEqual([1, 2]);
  });

  test("adds machine_origins, empty: no origin is invented for a machine ordered before it", () => {
    expect(rowsOf(db, "machine_origins")).toEqual([]);
    expect(columns(db, "machine_origins")).toEqual(["account_id", "machine", "cloud", "via", "ordered_at"]);
  });

  test("keys an origin by account and machine, and knows two ways a machine was ordered", () => {
    const insert = db.query("INSERT INTO machine_origins (account_id, machine, cloud, via, ordered_at) VALUES (?, 'devbox-two', 'hetzner', ?, ?)");
    insert.run(2, "service", 1);
    // Another account's machine of the same name is another machine.
    insert.run(1, "own", 2);
    expect(() => insert.run(2, "own", 3)).toThrow();
    expect(() => insert.run(3, "shared", 4)).toThrow();
    db.run("DELETE FROM machine_origins");
  });

  test("a second pass changes nothing at all", () => {
    const dump = () => ({
      schema: db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
      tables: Object.fromEntries([...V2_TABLES, "machine_origins"].map((table) => [table, rowsOf(db, table)])),
      version: version(db),
    });
    const settled = dump();
    applySchema(db);
    expect(dump()).toEqual(settled);
  });
});

/**
 * The shape a database had at version 3, as of 15/09: version 2 and machine_origins, and no
 * identities. Written out from V2_SCHEMA plus the one table step 3 created, for the reason the
 * shapes above are.
 */
const V3_SCHEMA = [
  ...V2_SCHEMA,
  `CREATE TABLE IF NOT EXISTS machine_origins (
     account_id INTEGER NOT NULL,
     machine    TEXT NOT NULL,
     cloud      TEXT NOT NULL,
     via        TEXT NOT NULL CHECK (via IN ('own', 'service')),
     ordered_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, machine)
   )`,
] as const;

/** Every table of version 3, each of which step 4 must leave exactly as it found it. */
const V3_TABLES = [...V2_TABLES, "machine_origins"] as const;

function v3Shaped(path: string): Database {
  const db = v2Shaped(path);
  db.run(V3_SCHEMA[V3_SCHEMA.length - 1] ?? "");
  db.run(
    "INSERT INTO machine_origins (account_id, machine, cloud, via, ordered_at) VALUES (2, 'devbox-two', 'hetzner', 'service', 10)",
  );
  db.run("PRAGMA user_version = 3");
  return db;
}

/**
 * A database of version 3 brought to 4, which is the production database of the password era.
 * The step adds `identities` and runs nothing: every account, its digest, its sessions, its
 * counter row and its tokens stay as they were - a rollback to the password code must still sign
 * everyone in - and no account is handed an identity it never signed in with.
 */
describe("applySchema on a database of version 3", () => {
  const db = v3Shaped(join(DATA_DIR, "v3-shape.db"));
  const before = Object.fromEntries(V3_TABLES.map((table) => [table, rowsOf(db, table)]));
  const declarations = Object.fromEntries([...V3_TABLES, ...V2_INDEXES].map((name) => [name, declarationOf(db, name)]));
  applySchema(db);

  test("reaches the current version", () => {
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
  });

  test("keeps every row and every declaration it had, digests and sessions included", () => {
    for (const table of V3_TABLES) expect(rowsOf(db, table), table).toEqual(before[table] as unknown[]);
    for (const name of [...V3_TABLES, ...V2_INDEXES]) expect(declarationOf(db, name), name).toEqual(declarations[name]);
    expect((rowsOf(db, "jobs") as { id: number }[]).map((row) => row.id)).toEqual([1, 2]);
    expect(rowsOf(db, "sessions")).toHaveLength(1);
    expect((rowsOf(db, "users") as { password_hash: string }[]).map((row) => row.password_hash)).toEqual(["$argon2id$x", "$argon2id$y"]);
  });

  test("adds identities, empty, with its index", () => {
    expect(rowsOf(db, "identities")).toEqual([]);
    expect(columns(db, "identities")).toEqual(["provider", "subject", "user_id", "email", "created_at"]);
    expect(indexesOf(db, "identities")).toContain("identities_user");
  });

  test("keys an identity by provider and subject, for a known provider and an existing account", () => {
    const insert = db.query("INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, 'x@devbox.test', 1)");
    insert.run("google", "110", 1);
    // The same subject at the other provider is another identity, and may open another account.
    insert.run("github", "110", 2);
    expect(() => insert.run("google", "110", 2)).toThrow();
    expect(() => insert.run("gitlab", "111", 1)).toThrow();
    // No identity of an account that does not exist, and no account deleted from under one.
    expect(() => insert.run("google", "112", 99)).toThrow();
    expect(() => db.run("DELETE FROM users WHERE id = 1")).toThrow();
    db.run("DELETE FROM identities");
  });

  test("a second pass changes nothing at all", () => {
    const dump = () => ({
      schema: db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
      tables: Object.fromEntries([...V3_TABLES, "identities"].map((table) => [table, rowsOf(db, table)])),
      version: version(db),
    });
    const settled = dump();
    applySchema(db);
    expect(dump()).toEqual(settled);
  });

  test("has the shape a fresh database has", () => {
    const fresh = openDatabase(join(DATA_DIR, "fresh-shape-v4.db"));
    applySchema(fresh);
    for (const table of [...V3_TABLES, "identities"]) {
      expect(shapeOf(db, table), table).toEqual(shapeOf(fresh, table));
      expect(indexesOf(db, table), table).toEqual(indexesOf(fresh, table));
    }
  });
});
