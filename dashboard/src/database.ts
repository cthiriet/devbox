import { Database } from "bun:sqlite";

/**
 * Connection settings applied to every database of this site, in this order.
 *
 * They do not survive the connection that set them: a PRAGMA is per-connection, so they
 * are re-applied on every open, which is why nothing here ever calls `new Database`
 * directly. The list is the one the hosting platform imposes on every site it runs,
 * modelled on PocketBase.
 *
 * `busy_timeout` comes first deliberately: the connection must already know how to wait
 * for a lock before the journal mode changes, or it fails outright if another connection
 * switches to WAL at that same instant.
 */
export const PRAGMAS = [
  // Wait up to ten seconds for a lock instead of handing back SQLITE_BUSY.
  "busy_timeout = 10000",

  // Reads stop blocking writes, and the database survives an abrupt kill of the service.
  "journal_mode = WAL",

  // 64 MB ceiling for the -wal file, truncated back after each checkpoint. Without it a
  // long read that defers the checkpoint leaves a journal that never shrinks again.
  "journal_size_limit = 67108864",

  // NORMAL is safe under WAL: a crash of the service or the kernel corrupts nothing, and
  // every commit saves an fsync. Only a power cut can lose the last transactions.
  //
  // This is the one setting that trades something away, and the trade was weighed for
  // everything but one kind of row. A dashboard that starts VMs sounds like accounting
  // data, but the truth about what runs and what it costs is the Terraform state and the
  // provider's API; sessions, jobs and labels only keep a trace of it. Losing the last
  // transaction there forgets a log line, not a machine, and `devbox orphans` asks the
  // provider precisely because of that.
  //
  // The secrets are the exception, since 11/09: a value set through the page lives here and
  // nowhere else, and a rotation lost to a power cut is a revoked token the database goes
  // on handing out. The pragma stays - the hosting platform imposes the list - and every
  // secret write is followed by `checkpoint` below instead, which costs one fsync on a write
  // that happens a few times a year.
  "synchronous = NORMAL",

  // SQLite disables them on every new connection: without this line a declared foreign
  // key would never be checked.
  "foreign_keys = ON",

  // Temporary tables and indexes in memory rather than on disk.
  "temp_store = MEMORY",

  // 16 MB cache ceiling (a negative value means kibibytes), against 2 MB by default.
  // A ceiling, not a reservation.
  "cache_size = -16000",
] as const;

/**
 * Opens a SQLite database with this repository's settings.
 *
 * `strict` throws on a missing query parameter instead of silently binding it to NULL
 * and writing an incomplete row.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });

  for (const pragma of PRAGMAS) {
    db.run(`PRAGMA ${pragma}`);
  }

  return db;
}

/**
 * Makes every commit so far survive a power cut, and not only a crash.
 *
 * Under `synchronous = NORMAL` a commit reaches the WAL without an fsync; the WAL is synced
 * before a checkpoint copies it back, and the database file after. So a checkpoint is the
 * fsync the pragma saved, taken on demand - by src/secrets.ts after every write of a secret,
 * the one row this database holds that nothing else does.
 *
 * TRUNCATE rather than PASSIVE: it waits for a reader instead of stopping short of the frames
 * it holds, and it leaves a WAL of zero bytes, which is something a test can see rather than
 * a promise it has to take on trust.
 *
 * False when the checkpoint could not complete - another connection kept it busy past the
 * busy_timeout. The commit stands either way; it is only the power cut it is not yet safe from.
 */
export function checkpoint(db: Database): boolean {
  const row = db
    .query<{ busy: number; log: number; checkpointed: number }, []>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    )
    .get();
  return row !== null && row.busy === 0;
}
