import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUDS, DATA_DIR } from "../src/config";
import { openDatabase } from "../src/database";
import { applySchema } from "../src/schema";
import {
  CLOUD_FIELDS,
  checkedSecretKind,
  checkedSecretName,
  deleteSecret,
  importLegacy,
  keyringFromEnv,
  listSecrets,
  MAX_SECRET_BYTES,
  newMasterKey,
  readSecret,
  rewrap,
  SecretRefused,
  setSecret,
  setSecrets,
  VaultError,
  vaultStatus,
  type Keyring,
  type SecretKind,
} from "../src/vault";

/**
 * The owner every value below is sealed under. A constant of this file since accounts: the
 * vault takes an owner and has no idea which one is the founder's, which is what lets the
 * cross-owner tests below exist at all.
 */
const OWNER_SELF = 1;

/**
 * The vault holds what orders machines and what reaches every repository a machine clones.
 * What these tests pin is less that it encrypts - node:crypto does that - than that it
 * encrypts the right thing under the right context, refuses loudly when it cannot open what
 * it holds, and never lets a value out through a list, a message or the file on the disk.
 *
 * Every database is a fresh file under .test-data, never the service's.
 */

// tests/prepare.ts must have diverted DATA_DIR before any import.
if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

const ROOT = join(DATA_DIR, "vault-test");
let drawn = 0;

function freshDatabase(): { db: Database; path: string } {
  mkdirSync(ROOT, { recursive: true });
  drawn += 1;
  const path = join(ROOT, `vault-${drawn}.db`);
  const db = openDatabase(path);
  applySchema(db);
  return { db, path };
}

function directory(name: string): string {
  const path = join(ROOT, "dirs", name);
  mkdirSync(path, { recursive: true });
  return path;
}

function ring(current: string, previous?: string): Keyring {
  const keyring = keyringFromEnv({
    DEVBOX_MASTER_KEY: current,
    DEVBOX_MASTER_KEY_PREVIOUS: previous,
  });
  if (keyring === null) throw new Error("expected a keyring");
  return keyring;
}

const text = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

/** What any error thrown by `run` says, so a test can check that no value is in it. */
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  throw new Error("expected a throw");
}

/** Moves one row's sealed value onto another, which is what a write to the table can do. */
function transplant(
  db: Database,
  from: { owner: number; kind: SecretKind; name: string },
  to: { owner: number; kind: SecretKind; name: string },
): void {
  const row = db
    .query<{ ciphertext: Uint8Array; nonce: Uint8Array }, [number, string, string]>(
      "SELECT ciphertext, nonce FROM secrets WHERE owner_id = ? AND kind = ? AND name = ?",
    )
    .get(from.owner, from.kind, from.name);
  if (row === null) throw new Error("no such row");
  db.query<undefined, [Uint8Array, Uint8Array, number, string, string]>(
    "UPDATE secrets SET ciphertext = ?, nonce = ? WHERE owner_id = ? AND kind = ? AND name = ?",
  ).run(row.ciphertext, row.nonce, to.owner, to.kind, to.name);
}

const K1 = newMasterKey(1);
const K1_OTHER = newMasterKey(1);
const K2 = newMasterKey(2);

describe("the master key", () => {
  test("is absent, not broken, when the variable is unset or empty", () => {
    // The state of every deployment before the vault: the files still answer.
    expect(keyringFromEnv({})).toBeNull();
    expect(keyringFromEnv({ DEVBOX_MASTER_KEY: "" })).toBeNull();
    expect(vaultStatus({})).toEqual({ available: false, reason: "DEVBOX_MASTER_KEY is not set" });
  });

  test("reads v<N>:<base64>, and a bare value as v1", () => {
    expect(ring(K1).current.version).toBe(1);
    expect(ring(K2).current.version).toBe(2);
    expect(ring(K1.slice("v1:".length)).current.version).toBe(1);
    expect(ring(K2, K1).previous?.version).toBe(1);
    expect(vaultStatus({ DEVBOX_MASTER_KEY: K1 })).toEqual({ available: true });
  });

  test("refuses a malformed value by name, without ever quoting it", () => {
    const body = K1.slice("v1:".length);
    const cases = [
      `v1:${Buffer.alloc(31, 7).toString("base64")}`, // 31 bytes
      `v1:${Buffer.alloc(33, 7).toString("base64")}`, // 33 bytes
      `v1:${body.replaceAll("+", "-").replaceAll("/", "_")}x`, // base64url, or garbage
      `v1:${body.slice(0, 20)}%%%${body.slice(23)}`, // not base64 at all
      `v1:${body.slice(0, -2)}B=`, // non-canonical: trailing bits set
      `v0:${body}`, // versions start at 1
      `vx:${body}`,
      `1:${body}`,
      "v1:",
    ];
    for (const value of cases) {
      // A slice of what follows the prefix, which is what a careless message would quote.
      const sample = value.slice(value.indexOf(":") + 1).slice(0, 16);

      const message = messageOf(() => keyringFromEnv({ DEVBOX_MASTER_KEY: value }));
      expect(message).toStartWith("VaultError: DEVBOX_MASTER_KEY ");
      if (sample !== "") expect(message).not.toContain(sample);

      const status = vaultStatus({ DEVBOX_MASTER_KEY: value });
      expect(status.available).toBe(false);
      if (!status.available) {
        expect(status.reason).toContain("DEVBOX_MASTER_KEY");
        if (sample !== "") expect(status.reason).not.toContain(sample);
      }
    }
  });

  test("names the previous key when it is the malformed one", () => {
    const message = messageOf(() =>
      keyringFromEnv({ DEVBOX_MASTER_KEY: K2, DEVBOX_MASTER_KEY_PREVIOUS: "v1:short" }),
    );
    expect(message).toContain("DEVBOX_MASTER_KEY_PREVIOUS");
  });

  test("refuses a previous key without a current one", () => {
    // Read as "no key", this would put the service back on the files with a database full of
    // values it had silently stopped reading.
    expect(() => keyringFromEnv({ DEVBOX_MASTER_KEY_PREVIOUS: K1 })).toThrow(VaultError);
  });

  test("refuses two keys under one version", () => {
    // A row names its key by version and nothing else: two keys under v1 would leave half
    // the rows unopenable depending on which one was tried.
    expect(() => ring(K1, K1_OTHER)).toThrow(/both v1/);
  });

  test("cannot be printed or serialised out of a keyring", () => {
    const keyring = ring(K2, K1);
    const printed = `${JSON.stringify(keyring)} ${Bun.inspect(keyring)}`;
    for (const key of [K1, K2]) {
      const body = key.slice("v1:".length);
      expect(printed).not.toContain(body);
      expect(printed).not.toContain(Buffer.from(body, "base64").toString("hex"));
    }
    expect(JSON.parse(JSON.stringify(keyring))).toEqual({
      current: { version: 2 },
      previous: { version: 1 },
    });
  });

  test("assembled by hand is refused, since only a parsed key carries material", () => {
    const { db } = freshDatabase();
    const forged: Keyring = { current: { version: 1 }, previous: null };
    expect(() => setSecret(db, forged, OWNER_SELF, "profile", "github", "ghp_x", 1)).toThrow(
      VaultError,
    );
  });

  /**
   * `bun --hot` evaluates every module again and keeps globalThis; the key itself was deleted
   * from process.env at the first evaluation, so the keyring kept from then is all there is.
   * A second instance of this module - what a reload makes - must still open with it.
   */
  test("parsed by one evaluation of the module, still opens under the next", async () => {
    const specifier = "../src/vault.ts?reloaded";
    const reloaded = (await import(specifier)) as typeof import("../src/vault");
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_across_a_reload", 1);
    expect(text(reloaded.readSecret(db, keyring, OWNER_SELF, "profile", "github"))).toBe(
      "ghp_across_a_reload",
    );
    // And a keyring forged by hand is still refused by the new instance.
    expect(() =>
      reloaded.readSecret(db, { current: { version: 1 }, previous: null }, OWNER_SELF, "profile", "github"),
    ).toThrow(/did not parse/);
  });
});

describe("setSecret and readSecret", () => {
  test("round-trip a value, text or bytes", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "cloud", "HCLOUD_TOKEN", "hc-token-1", 10);
    expect(text(readSecret(db, keyring, OWNER_SELF, "cloud", "HCLOUD_TOKEN"))).toBe("hc-token-1");

    // Bytes stay bytes: a value is never assumed to be text.
    const binary = new Uint8Array([0, 255, 10, 13, 0, 128]);
    setSecret(db, keyring, OWNER_SELF, "profile", "blob", binary, 11);
    expect(readSecret(db, keyring, OWNER_SELF, "profile", "blob")).toEqual(binary);
  });

  test("answers null for what was never set, and only for that", () => {
    const { db } = freshDatabase();
    expect(readSecret(db, ring(K1), OWNER_SELF, "profile", "github")).toBeNull();
  });

  test("replaces a value and answers its metadata", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_old", 1);
    const meta = setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_newer", 2);
    expect(meta).toMatchObject({ kind: "profile", name: "github", size: 9, updated_at: 2 });
    expect(text(readSecret(db, keyring, OWNER_SELF, "profile", "github"))).toBe("ghp_newer");
  });

  test("removes one trailing newline, and only one", () => {
    // echo, an editor and a textarea all add one, and it would travel into an Authorization
    // header. A second one belongs to the value.
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const cases: [string, string | Uint8Array, string][] = [
      ["lf", "token\n", "token"],
      ["crlf", "token\r\n", "token"],
      ["two", "token\n\n", "token\n"],
      ["cr-alone", "token\r", "token\r"],
      ["bytes", new TextEncoder().encode("token\n"), "token"],
      ["none", "token", "token"],
    ];
    for (const [name, value, expected] of cases) {
      const meta = setSecret(db, keyring, OWNER_SELF, "profile", name, value, 1);
      expect(text(readSecret(db, keyring, OWNER_SELF, "profile", name))).toBe(expected);
      expect(meta.size).toBe(new TextEncoder().encode(expected).length);
    }
  });

  test("refuses an empty value, and one past 64 KiB, and leaves nothing behind", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    for (const value of ["", "\n", "\r\n", "   ", " \t\n", "x".repeat(MAX_SECRET_BYTES + 1)]) {
      expect(() => setSecret(db, keyring, OWNER_SELF, "profile", "github", value, 1)).toThrow(
        SecretRefused,
      );
    }
    // Checked before the transaction: not even the owner's data key was drawn.
    expect(db.query("SELECT COUNT(*) AS n FROM owners").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM secret_events").get()).toEqual({ n: 0 });

    // The bound is on the stored value: 64 KiB exactly is fine, newline or not.
    setSecret(db, keyring, OWNER_SELF, "profile", "big", "x".repeat(MAX_SECRET_BYTES), 1);
    setSecret(db, keyring, OWNER_SELF, "profile", "big-lf", `${"x".repeat(MAX_SECRET_BYTES)}\n`, 1);
    expect(listSecrets(db, OWNER_SELF).map((s) => s.size)).toEqual([
      MAX_SECRET_BYTES,
      MAX_SECRET_BYTES,
    ]);
  });

  test("never quotes the value in a refusal", () => {
    const { db } = freshDatabase();
    const value = `leak-me-${"q".repeat(MAX_SECRET_BYTES)}`;
    const message = messageOf(() => setSecret(db, ring(K1), OWNER_SELF, "profile", "x", value, 1));
    expect(message).not.toContain("leak-me");
  });

  test("creates the owner on the first write, with its own data key", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_x", 5);
    setSecret(db, keyring, 2, "profile", "github", "ghp_y", 6);
    const owners = db
      .query<{ id: number; key_version: number; created_at: number }, []>(
        "SELECT id, key_version, created_at FROM owners ORDER BY id",
      )
      .all();
    expect(owners).toEqual([
      { id: 1, key_version: 1, created_at: 5 },
      { id: 2, key_version: 1, created_at: 6 },
    ]);
    expect(text(readSecret(db, keyring, 2, "profile", "github"))).toBe("ghp_y");
  });

  test("refuses an owner that is not a whole number from 1", () => {
    const { db } = freshDatabase();
    for (const owner of [0, -1, 1.5, Number.NaN]) {
      expect(() => setSecret(db, ring(K1), owner, "profile", "github", "x", 1)).toThrow(VaultError);
    }
  });
});

/**
 * A cloud's credentials are a set, and a set is written whole. The page used to PUT a Scaleway
 * key field by field, and a refusal at the second left a new access key beside the old secret.
 */
describe("setSecrets", () => {
  const SCALEWAY = [
    { kind: "cloud", name: "SCW_ACCESS_KEY", value: "SCWNEWNEWNEWNEWNEWNE" },
    { kind: "cloud", name: "SCW_SECRET_KEY", value: "11111111-1111-4111-8111-111111111111" },
    { kind: "cloud", name: "SCW_DEFAULT_PROJECT_ID", value: "22222222-2222-4222-8222-222222222222" },
  ] as const;

  const eventsOf = (db: Database) =>
    db
      .query<{ name: string; action: string }, []>("SELECT name, action FROM secret_events ORDER BY name")
      .all();

  test("stores every value in one go, each with its own event", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const metas = setSecrets(db, keyring, OWNER_SELF, SCALEWAY, 7);
    expect(metas.map((meta) => meta.name)).toEqual(SCALEWAY.map((write) => write.name));
    for (const write of SCALEWAY) {
      expect(text(readSecret(db, keyring, OWNER_SELF, "cloud", write.name))).toBe(write.value);
    }
    expect(eventsOf(db)).toEqual([
      { name: "SCW_ACCESS_KEY", action: "set" },
      { name: "SCW_DEFAULT_PROJECT_ID", action: "set" },
      { name: "SCW_SECRET_KEY", action: "set" },
    ]);
  });

  test("one refused value refuses the whole set, and leaves nothing behind", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const [access, secret, project] = SCALEWAY;
    // A first write refused: not even the owner's data key is drawn.
    expect(() => setSecrets(db, keyring, OWNER_SELF, [access, { ...secret, value: "\n" }, project], 1)).toThrow(
      SecretRefused,
    );
    expect(listSecrets(db, OWNER_SELF)).toEqual([]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM owners").get()?.n).toBe(0);
    expect(eventsOf(db)).toEqual([]);

    // Over a pair already held: the old access key is still the one held.
    setSecret(db, keyring, OWNER_SELF, "cloud", "SCW_ACCESS_KEY", "SCWOLDOLDOLDOLDOLDOL", 2);
    expect(() =>
      setSecrets(db, keyring, OWNER_SELF, [access, { ...secret, value: "x".repeat(MAX_SECRET_BYTES + 1) }], 3),
    ).toThrow(SecretRefused);
    expect(text(readSecret(db, keyring, OWNER_SELF, "cloud", "SCW_ACCESS_KEY"))).toBe("SCWOLDOLDOLDOLDOLDOL");
    expect(readSecret(db, keyring, OWNER_SELF, "cloud", "SCW_SECRET_KEY")).toBeNull();
  });

  test("refuses nothing to store, a name given twice, and a name outside the catalogue", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const [access] = SCALEWAY;
    expect(() => setSecrets(db, keyring, OWNER_SELF, [], 1)).toThrow(SecretRefused);
    expect(() => setSecrets(db, keyring, OWNER_SELF, [access, access], 1)).toThrow(SecretRefused);
    expect(() =>
      setSecrets(db, keyring, OWNER_SELF, [access, { kind: "cloud", name: "AWS_SECRET_ACCESS_KEY", value: "x" }], 1),
    ).toThrow(SecretRefused);
    expect(listSecrets(db, OWNER_SELF)).toEqual([]);
  });
});

describe("the sealed context", () => {
  // Each case moves a ciphertext onto a row it was not sealed for, which anyone able to write
  // the table can do without reading anything. Without the context as authenticated data the
  // engine would push one secret under another's name.

  test("a value moved to another name does not open there", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_one", 1);
    setSecret(db, keyring, OWNER_SELF, "profile", "claude", "sk_two", 1);
    transplant(
      db,
      { owner: 1, kind: "profile", name: "github" },
      { owner: 1, kind: "profile", name: "claude" },
    );
    const message = messageOf(() => readSecret(db, keyring, OWNER_SELF, "profile", "claude"));
    expect(message).toStartWith("VaultError:");
    expect(message).not.toContain("ghp_one");
    // The source still opens: the refusal is about the row, not the key.
    expect(text(readSecret(db, keyring, OWNER_SELF, "profile", "github"))).toBe("ghp_one");
  });

  test("a value moved to another kind does not open there", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "cloud", "HCLOUD_TOKEN", "hc-real", 1);
    setSecret(db, keyring, OWNER_SELF, "profile", "HCLOUD_TOKEN", "decoy", 1);
    transplant(
      db,
      { owner: 1, kind: "cloud", name: "HCLOUD_TOKEN" },
      { owner: 1, kind: "profile", name: "HCLOUD_TOKEN" },
    );
    expect(() => readSecret(db, keyring, OWNER_SELF, "profile", "HCLOUD_TOKEN")).toThrow(VaultError);
  });

  test("a value moved to another owner does not open there, even with its data key", () => {
    // The strongest copy: owner 1's sealed data key AND its ciphertext, both moved onto owner
    // 2. Same key, same bytes - only the context differs, and it is enough.
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, 1, "profile", "github", "ghp_owner_one", 1);
    setSecret(db, keyring, 2, "profile", "github", "ghp_owner_two", 1);
    transplant(db, { owner: 1, kind: "profile", name: "github" }, { owner: 2, kind: "profile", name: "github" });
    expect(() => readSecret(db, keyring, 2, "profile", "github")).toThrow(VaultError);

    db.run(
      "UPDATE owners SET dek = (SELECT dek FROM owners WHERE id = 1)," +
        " nonce = (SELECT nonce FROM owners WHERE id = 1) WHERE id = 2",
    );
    expect(() => readSecret(db, keyring, 2, "profile", "github")).toThrow(/owner 2's data key/);
  });

  test("an altered byte is an error, never a null", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_x", 1);
    const row = db
      .query<{ ciphertext: Uint8Array }, []>("SELECT ciphertext FROM secrets")
      .get() as { ciphertext: Uint8Array };
    const altered = Uint8Array.from(row.ciphertext);
    altered[0] = (altered[0] ?? 0) ^ 1;
    db.query<undefined, [Uint8Array]>("UPDATE secrets SET ciphertext = ?").run(altered);
    expect(() => readSecret(db, keyring, OWNER_SELF, "profile", "github")).toThrow(VaultError);
  });

  test("a data key whose version was edited does not open under the key it now names", () => {
    const { db } = freshDatabase();
    setSecret(db, ring(K1), OWNER_SELF, "profile", "github", "ghp_x", 1);
    db.run("UPDATE owners SET key_version = 2");
    expect(() => readSecret(db, ring(K2), OWNER_SELF, "profile", "github")).toThrow(VaultError);
  });

  /**
   * Found on 11/09. The context binds a ciphertext to its row
   * and not to a moment, so the row's OLDER ciphertext authenticates perfectly: it opened, a
   * job was handed the revoked token, and the page showed the rotated value's fingerprint.
   */
  test("an older ciphertext put back in its row is an error, never the old value", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp-leaked-and-revoked", 1);
    const old = db
      .query<{ ciphertext: Uint8Array; nonce: Uint8Array }, []>("SELECT ciphertext, nonce FROM secrets")
      .get() as { ciphertext: Uint8Array; nonce: Uint8Array };
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp-rotated", 2);
    db.query<undefined, [Uint8Array, Uint8Array]>("UPDATE secrets SET ciphertext = ?, nonce = ?").run(
      old.ciphertext,
      old.nonce,
    );

    const message = messageOf(() => readSecret(db, keyring, OWNER_SELF, "profile", "github"));
    expect(message).toStartWith("VaultError:");
    expect(message).toContain("fingerprint does not record");
    expect(message).not.toContain("ghp-");
  });

  test("a fingerprint edited in the row is found the same way", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_x", 1);
    db.run("UPDATE secrets SET fingerprint = '000000000000'");
    expect(() => readSecret(db, keyring, OWNER_SELF, "profile", "github")).toThrow(/fingerprint/);
    db.run("UPDATE secrets SET fingerprint = 'short'");
    expect(() => readSecret(db, keyring, OWNER_SELF, "profile", "github")).toThrow(/fingerprint/);
  });
});

describe("a wrong master key", () => {
  test("is an error naming the version, and never quoting a key", () => {
    const { db } = freshDatabase();
    setSecret(db, ring(K1), OWNER_SELF, "profile", "github", "ghp_x", 1);

    const wrong = messageOf(() => readSecret(db, ring(K1_OTHER), OWNER_SELF, "profile", "github"));
    expect(wrong).toStartWith("VaultError:");
    expect(wrong).toContain("v1");
    expect(wrong).not.toContain(K1_OTHER.slice(3));
    expect(wrong).not.toContain("ghp_x");

    // A keyring that does not hold the version at all says which one it would need.
    const missing = messageOf(() => readSecret(db, ring(K2), OWNER_SELF, "profile", "github"));
    expect(missing).toContain("sealed under master key v1");
    expect(missing).toContain("holds v2");
  });

  test("cannot write either, rather than sealing new values under a key nobody can open", () => {
    const { db } = freshDatabase();
    setSecret(db, ring(K1), OWNER_SELF, "profile", "github", "ghp_x", 1);
    expect(() => setSecret(db, ring(K1_OTHER), OWNER_SELF, "profile", "claude", "sk", 2)).toThrow(
      VaultError,
    );
    expect(listSecrets(db, OWNER_SELF).map((s) => s.name)).toEqual(["github"]);
  });
});

describe("rewrap", () => {
  test("moves a rotation through, and a second pass writes nothing", () => {
    const { db } = freshDatabase();
    const before = setSecret(db, ring(K1), OWNER_SELF, "cloud", "HCLOUD_TOKEN", "hc-rotated", 1);
    setSecret(db, ring(K1), 2, "profile", "github", "ghp_two", 1);

    // v2 alone cannot open what v1 sealed, until the rotation has run.
    expect(() => readSecret(db, ring(K2), OWNER_SELF, "cloud", "HCLOUD_TOKEN")).toThrow(VaultError);

    // During the rotation both keys are there, and reads carry on before rewrap.
    const rotating = ring(K2, K1);
    expect(text(readSecret(db, rotating, OWNER_SELF, "cloud", "HCLOUD_TOKEN"))).toBe("hc-rotated");

    expect(rewrap(db, rotating)).toBe(2);
    expect(rewrap(db, rotating)).toBe(0);
    expect(
      db.query<{ key_version: number }, []>("SELECT DISTINCT key_version FROM owners").all(),
    ).toEqual([{ key_version: 2 }]);

    // v2 alone now reads everything, and v1 alone reads nothing.
    expect(text(readSecret(db, ring(K2), OWNER_SELF, "cloud", "HCLOUD_TOKEN"))).toBe("hc-rotated");
    expect(text(readSecret(db, ring(K2), 2, "profile", "github"))).toBe("ghp_two");
    expect(() => readSecret(db, ring(K1), OWNER_SELF, "cloud", "HCLOUD_TOKEN")).toThrow(VaultError);

    // The data key changed with the master key, so the fingerprint - keyed by it - moved once,
    // with no value having changed. Size and date describe the value, and stayed.
    const after = listSecrets(db, OWNER_SELF)[0];
    expect(after?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(after?.fingerprint).not.toBe(before.fingerprint);
    expect(after?.size).toBe(before.size);
    expect(after?.updated_at).toBe(before.updated_at);
  });

  /**
   * Found on 11/09, and kept as a test. The rotation is what runs
   * after the master key LEAKED; if the data key only got a new envelope, the old master key
   * and a backup from before the rotation opened every value written after it.
   */
  test("draws a new data key, so the old master key and an old backup open nothing written after", () => {
    const { db, path } = freshDatabase();
    setSecret(db, ring(K1), OWNER_SELF, "profile", "github", "ghp-before", 1);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const backup = `${path}.backup`;
    writeFileSync(backup, readFileSync(path)); // a nightly backup, under v1

    expect(rewrap(db, ring(K2, K1))).toBe(1);
    setSecret(db, ring(K2), OWNER_SELF, "profile", "claude", "sk-written-after-the-rotation", 2);
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");

    // The attacker: K1, the backup's owners row, and the secrets rows of a later copy.
    const attacker = openDatabase(backup);
    attacker.run("DELETE FROM secrets");
    attacker.run(`ATTACH '${path}' AS later`);
    attacker.run("INSERT INTO secrets SELECT * FROM later.secrets");
    expect(() => readSecret(attacker, ring(K1), OWNER_SELF, "profile", "claude")).toThrow(VaultError);
    // Resealed too, what was there before the rotation: the old data key opens neither.
    expect(() => readSecret(attacker, ring(K1), OWNER_SELF, "profile", "github")).toThrow(VaultError);
    attacker.close();

    // And the service itself reads both under the new key alone.
    expect(text(readSecret(db, ring(K2), OWNER_SELF, "profile", "github"))).toBe("ghp-before");
    expect(text(readSecret(db, ring(K2), OWNER_SELF, "profile", "claude"))).toBe(
      "sk-written-after-the-rotation",
    );
  });

  test("reseals every value with a nonce of its own, in one transaction", () => {
    const { db } = freshDatabase();
    for (const name of ["a", "b", "c"]) setSecret(db, ring(K1), OWNER_SELF, "profile", name, `v-${name}`, 1);
    const nonces = () =>
      db
        .query<{ nonce: Uint8Array }, []>("SELECT nonce FROM secrets ORDER BY name")
        .all()
        .map((row) => Buffer.from(row.nonce).toString("hex"));
    const before = nonces();

    rewrap(db, ring(K2, K1));
    const after = nonces();
    expect(after).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) expect(after[i]).not.toBe(before[i]);
    expect(new Set(after).size).toBe(3);
  });

  test("stops on a value it cannot open, names it, and rotates nothing", () => {
    // Resealed as it is, a replayed ciphertext would come out laundered; left behind, it would
    // sit under a data key that no longer exists. Neither: the operator deletes or restores it.
    const { db } = freshDatabase();
    setSecret(db, ring(K1), OWNER_SELF, "profile", "github", "ghp_x", 1);
    setSecret(db, ring(K1), OWNER_SELF, "profile", "claude", "sk_y", 1);
    db.run("UPDATE secrets SET nonce = zeroblob(12) WHERE name = 'claude'");
    const before = db.query("SELECT dek, key_version FROM owners").get();

    expect(() => rewrap(db, ring(K2, K1))).toThrow(/profile\/claude of owner 1 does not open/);
    expect(db.query("SELECT dek, key_version FROM owners").get()).toEqual(before);
    expect(text(readSecret(db, ring(K1), OWNER_SELF, "profile", "github"))).toBe("ghp_x");

    // Deleted - which needs no key - the rotation goes through.
    deleteSecret(db, OWNER_SELF, "profile", "claude", 2);
    expect(rewrap(db, ring(K2, K1))).toBe(1);
  });

  test("a write that finds its owner under the previous key rotates it first", () => {
    // openVault runs rewrap before anything is served; a caller that skipped it must still not
    // seal a new value under the data key the rotation retires.
    const { db } = freshDatabase();
    setSecret(db, ring(K1), OWNER_SELF, "profile", "github", "ghp_old", 1);
    setSecret(db, ring(K2, K1), OWNER_SELF, "profile", "claude", "sk_new", 2);
    expect(db.query("SELECT key_version FROM owners").get()).toEqual({ key_version: 2 });
    expect(text(readSecret(db, ring(K2), OWNER_SELF, "profile", "github"))).toBe("ghp_old");
    expect(text(readSecret(db, ring(K2), OWNER_SELF, "profile", "claude"))).toBe("sk_new");
    expect(rewrap(db, ring(K2, K1))).toBe(0);
  });

  test("refuses a keyring that cannot open a row, and changes nothing", () => {
    const { db } = freshDatabase();
    setSecret(db, ring(K1), OWNER_SELF, "profile", "github", "ghp_x", 1);
    const K3 = newMasterKey(3);
    expect(() => rewrap(db, ring(K3, K2))).toThrow(/sealed under master key v1/);
    expect(db.query("SELECT key_version FROM owners").get()).toEqual({ key_version: 1 });
  });

  test("opens every row, so a wrong current key is found at startup", () => {
    const { db } = freshDatabase();
    setSecret(db, ring(K1), OWNER_SELF, "profile", "github", "ghp_x", 1);
    expect(() => rewrap(db, ring(K1_OTHER))).toThrow(VaultError);
  });
});

describe("the fingerprint", () => {
  test("is twelve hex characters, and not the bare SHA-256 of the value", () => {
    // A bare digest in a stolen copy of the database would let a short token be guessed
    // offline.
    const { db } = freshDatabase();
    const value = "ghp_short";
    const meta = setSecret(db, ring(K1), OWNER_SELF, "profile", "github", value, 1);
    expect(meta.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    const bare = createHash("sha256").update(value).digest("hex");
    expect(bare).not.toContain(meta.fingerprint);
  });

  test("is stable for one value, and moves when the value does", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const a = setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_same", 1);
    const b = setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_same\n", 2);
    const c = setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_other", 3);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
  });

  test("is keyed per owner, so it does not say who shares a value", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const one = setSecret(db, keyring, 1, "profile", "github", "ghp_shared", 1);
    const two = setSecret(db, keyring, 2, "profile", "github", "ghp_shared", 1);
    expect(one.fingerprint).not.toBe(two.fingerprint);
  });
});

describe("listSecrets", () => {
  test("names what is set and carries no byte of any value", () => {
    const { db, path } = freshDatabase();
    const keyring = ring(K1);
    const value = `hc-${"7f3a9c".repeat(8)}`;
    setSecret(db, keyring, OWNER_SELF, "cloud", "HCLOUD_TOKEN", value, 3);
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_listed", 4);

    const list = listSecrets(db, OWNER_SELF);
    expect(list.map((s) => [s.kind, s.name])).toEqual([
      ["cloud", "HCLOUD_TOKEN"],
      ["profile", "github"],
    ]);
    for (const meta of list) {
      expect(Object.keys(meta).sort()).toEqual(["fingerprint", "kind", "name", "size", "updated_at"]);
    }
    const serialised = JSON.stringify(list);
    expect(serialised).not.toContain(value);
    expect(serialised).not.toContain("7f3a9c");
    expect(serialised).not.toContain("ghp_listed");

    // Nor is it anywhere on the disk: the plaintext never passes through SQLite at all.
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    for (const file of [path, `${path}-wal`]) {
      if (!existsSync(file)) continue;
      const bytes = readFileSync(file);
      expect(bytes.indexOf(value)).toBe(-1);
      expect(bytes.indexOf("ghp_listed")).toBe(-1);
    }
  });

  test("is one owner's, and answers without a key", () => {
    const { db } = freshDatabase();
    setSecret(db, ring(K1), 1, "profile", "github", "ghp_1", 1);
    setSecret(db, ring(K1), 2, "profile", "claude", "sk_2", 1);
    expect(listSecrets(db, 1).map((s) => s.name)).toEqual(["github"]);
    expect(listSecrets(db, 3)).toEqual([]);
  });
});

describe("deleteSecret", () => {
  test("removes a value and says whether there was one", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_x", 1);
    expect(deleteSecret(db, OWNER_SELF, "profile", "github", 2)).toBe(true);
    expect(deleteSecret(db, OWNER_SELF, "profile", "github", 3)).toBe(false);
    expect(readSecret(db, keyring, OWNER_SELF, "profile", "github")).toBeNull();
  });

  test("removes a row whatever its name, so a rule tightened later strands nothing", () => {
    const { db } = freshDatabase();
    setSecret(db, ring(K1), OWNER_SELF, "profile", "github", "ghp_x", 1);
    db.run("UPDATE secrets SET name = 'gcp'");
    expect(deleteSecret(db, OWNER_SELF, "profile", "gcp", 2)).toBe(true);
  });
});

describe("the history", () => {
  test("has no column that could hold a value", () => {
    const { db } = freshDatabase();
    const columns = db
      .query<{ name: string }, []>("PRAGMA table_info(secret_events)")
      .all()
      .map((c) => c.name);
    expect(columns).toEqual(["id", "owner_id", "kind", "name", "action", "at"]);
  });

  test("records every set, delete and import, and nothing for a delete of nothing", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const secrets = directory("history");
    writeFileSync(join(secrets, "claude"), "sk_imported");
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_x", 1);
    deleteSecret(db, OWNER_SELF, "profile", "github", 2);
    deleteSecret(db, OWNER_SELF, "profile", "github", 3);
    importLegacy(db, keyring, OWNER_SELF, { env: {}, secretsDir: secrets }, 4);
    expect(
      db.query("SELECT owner_id, kind, name, action, at FROM secret_events ORDER BY id").all(),
    ).toEqual([
      { owner_id: 1, kind: "profile", name: "github", action: "set", at: 1 },
      { owner_id: 1, kind: "profile", name: "github", action: "delete", at: 2 },
      { owner_id: 1, kind: "profile", name: "claude", action: "import", at: 4 },
    ]);
  });
});

describe("names", () => {
  test("of a cloud credential come from the catalogue, exactly", () => {
    for (const name of ["HCLOUD_TOKEN", "SCW_SECRET_KEY", "gcp", "DEVBOX_GCP_PROJECT"]) {
      expect(checkedSecretName("cloud", name)).toEqual({ ok: true, value: name });
    }
    for (const name of ["hcloud_token", "HCLOUD_TOKEN ", "AWS_SECRET_ACCESS_KEY", "github", ""]) {
      expect(checkedSecretName("cloud", name).ok).toBe(false);
    }
  });

  test("of a profile secret follow devbox-core's rule, and refuse what the core would", () => {
    for (const name of ["github", "claude", "my-repo_2", "A"]) {
      expect(checkedSecretName("profile", name)).toEqual({ ok: true, value: name });
    }
    for (const name of ["", "../x", "a/b", "with space", " github", "dot.ted", "é", "a\nb"]) {
      expect(checkedSecretName("profile", name).ok).toBe(false);
    }
    expect(checkedSecretName("profile", "x".repeat(65)).ok).toBe(false);
    expect(checkedSecretName("profile", 42).ok).toBe(false);
  });

  test("gcp and remote are reserved, in any case", () => {
    // Both are files devbox-core already reads under DEVBOX_SECRETS_DIR, and on a Mac's
    // case-insensitive disk GCP and gcp are one file.
    for (const name of ["gcp", "GCP", "Gcp", "remote", "REMOTE"]) {
      const checked = checkedSecretName("profile", name);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.reason).toStartWith("reserved:");
    }
  });

  test("an invalid one is refused by setSecret, before anything is written", () => {
    const { db } = freshDatabase();
    for (const [kind, name] of [
      ["profile", "gcp"],
      ["profile", "../x"],
      ["profile", "with space"],
      ["cloud", "NOT_A_FIELD"],
    ] as const) {
      const message = messageOf(() => setSecret(db, ring(K1), OWNER_SELF, kind, name, "v4lue", 1));
      expect(message).toStartWith("SecretRefused: name:");
      expect(message).not.toContain("v4lue");
    }
    expect(db.query("SELECT COUNT(*) AS n FROM owners").get()).toEqual({ n: 0 });
  });

  test("of a kind are cloud or profile", () => {
    expect(checkedSecretKind("cloud")).toEqual({ ok: true, value: "cloud" });
    expect(checkedSecretKind("profile")).toEqual({ ok: true, value: "profile" });
    expect(checkedSecretKind("env").ok).toBe(false);
  });
});

describe("the catalogue", () => {
  test("covers every cloud devbox-core implements, and no other", () => {
    expect(Object.keys(CLOUD_FIELDS).sort()).toEqual([...CLOUDS].sort());
  });

  test("keeps the GCP key a file and a multiline field, and everything else a variable", () => {
    // devbox-core opens the key as $DEVBOX_SECRETS_DIR/gcp, and it is JSON over many lines.
    const fields = Object.values(CLOUD_FIELDS).flat();
    for (const field of fields) {
      expect(field.legacy).toBe(field.name === "gcp" ? "file" : "env");
      expect(field.multiline).toBe(field.name === "gcp");
    }
  });

  test("asks Scaleway for the access key too, which terraform refuses to plan without", () => {
    // The core's own check names two of the three; the provider wants all three.
    expect(CLOUD_FIELDS.scaleway.filter((f) => f.required).map((f) => f.name)).toEqual([
      "SCW_ACCESS_KEY",
      "SCW_SECRET_KEY",
      "SCW_DEFAULT_PROJECT_ID",
    ]);
  });
});

describe("importLegacy", () => {
  test("takes the variables, the GCP key and the profile secrets, and ignores empty files", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const secrets = directory("legacy-first");
    writeFileSync(join(secrets, "github"), "ghp_from_file\n");
    writeFileSync(join(secrets, "claude"), ""); // a vault line left blank: absent
    writeFileSync(join(secrets, "gcp"), '{\n  "client_email": "x@example.com"\n}\n');
    writeFileSync(join(secrets, "remote"), "dashboard-token");
    writeFileSync(join(secrets, "bad name"), "whatever");
    mkdirSync(join(secrets, "a-directory"), { recursive: true });

    const result = importLegacy(
      db,
      keyring,
      OWNER_SELF,
      {
        env: { HCLOUD_TOKEN: "hc-from-env", SCW_SECRET_KEY: "", UNRELATED: "not-a-field" },
        secretsDir: secrets,
      },
      7,
    );

    expect(result.imported).toEqual(["cloud/HCLOUD_TOKEN", "cloud/gcp", "profile/github"]);
    expect(result.skipped).toEqual([
      'profile/"bad name": letters, digits, dash and underscore only',
      "profile/remote: reserved: devbox-core reads its dashboard token under this file name",
    ]);
    expect(text(readSecret(db, keyring, OWNER_SELF, "profile", "github"))).toBe("ghp_from_file");
    expect(text(readSecret(db, keyring, OWNER_SELF, "cloud", "gcp"))).toBe(
      '{\n  "client_email": "x@example.com"\n}',
    );
    expect(readSecret(db, keyring, OWNER_SELF, "profile", "claude")).toBeNull();
    expect(readSecret(db, keyring, OWNER_SELF, "cloud", "SCW_SECRET_KEY")).toBeNull();
    expect(JSON.stringify(result)).not.toContain("ghp_from_file");
    expect(JSON.stringify(result)).not.toContain("dashboard-token");
  });

  test("never overwrites what the database holds, and says whether the copy differs", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const secrets = directory("legacy-conflict");
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_rotated_in_db", 1);
    setSecret(db, keyring, OWNER_SELF, "cloud", "HCLOUD_TOKEN", "hc-same", 1);
    writeFileSync(join(secrets, "github"), "ghp_stale_on_disk");

    const result = importLegacy(
      db,
      keyring,
      OWNER_SELF,
      { env: { HCLOUD_TOKEN: "hc-same\n" }, secretsDir: secrets },
      2,
    );
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([
      "cloud/HCLOUD_TOKEN: already in the database, same value",
      "profile/github: already in the database with another value, which is the one kept",
    ]);
    // Replaying the file would silently undo a rotation made through the page.
    expect(text(readSecret(db, keyring, OWNER_SELF, "profile", "github"))).toBe("ghp_rotated_in_db");
  });

  test("is idempotent", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const secrets = directory("legacy-twice");
    writeFileSync(join(secrets, "github"), "ghp_once");
    const sources = { env: { DEVBOX_GCP_PROJECT: "acme-devbox-000000" }, secretsDir: secrets };

    const first = importLegacy(db, keyring, OWNER_SELF, sources, 1);
    const second = importLegacy(db, keyring, OWNER_SELF, sources, 2);
    expect(first.imported).toEqual(["cloud/DEVBOX_GCP_PROJECT", "profile/github"]);
    expect(second.imported).toEqual([]);
    expect(second.skipped.every((line) => line.endsWith("already in the database, same value"))).toBe(
      true,
    );
    expect(listSecrets(db, OWNER_SELF).map((s) => s.updated_at)).toEqual([1, 1]);
  });

  /**
   * The scenario found on 11/09, which secrets-api.test.ts used to validate: a token rotated through
   * the page, deleted from the vault - the file takes over again - then imported, which put the
   * stale file into the database as though it had been set there.
   */
  test("never brings back a name the vault has already set or deleted, and says why", () => {
    const { db } = freshDatabase();
    const keyring = ring(K1);
    const secrets = directory("legacy-decided");
    writeFileSync(join(secrets, "github"), "ghp_stale_from_before_the_rotation");
    writeFileSync(join(secrets, "claude"), "sk_never_decided");
    setSecret(db, keyring, OWNER_SELF, "profile", "github", "ghp_rotated_on_the_page", 1);
    deleteSecret(db, OWNER_SELF, "profile", "github", 2);
    setSecret(db, keyring, OWNER_SELF, "cloud", "HCLOUD_TOKEN", "hc-page", 3);
    deleteSecret(db, OWNER_SELF, "cloud", "HCLOUD_TOKEN", 4);

    const result = importLegacy(
      db,
      keyring,
      OWNER_SELF,
      { env: { HCLOUD_TOKEN: "hc-stale-unit" }, secretsDir: secrets },
      5,
    );
    expect(result.imported).toEqual(["profile/claude"]);
    expect(result.skipped).toEqual([
      "cloud/HCLOUD_TOKEN: deleted from the vault before, and a copy from outside it never goes back in over that: set it on the page if it is still wanted",
      "profile/github: deleted from the vault before, and a copy from outside it never goes back in over that: set it on the page if it is still wanted",
    ]);
    expect(readSecret(db, keyring, OWNER_SELF, "profile", "github")).toBeNull();
    expect(readSecret(db, keyring, OWNER_SELF, "cloud", "HCLOUD_TOKEN")).toBeNull();
    expect(JSON.stringify(result)).not.toContain("stale");
  });

  test("reads nothing when there is nothing, and creates no owner for it", () => {
    const { db } = freshDatabase();
    const result = importLegacy(
      db,
      ring(K1),
      OWNER_SELF,
      { env: {}, secretsDir: join(ROOT, "dirs", "never-created") },
      1,
    );
    expect(result).toEqual({ imported: [], skipped: [] });
    expect(db.query("SELECT COUNT(*) AS n FROM owners").get()).toEqual({ n: 0 });
  });

  test("skips a file past the ceiling without reading it, and a blank line with a reason", () => {
    const { db } = freshDatabase();
    const secrets = directory("legacy-bounds");
    writeFileSync(join(secrets, "huge"), "x".repeat(MAX_SECRET_BYTES + 3));
    writeFileSync(join(secrets, "blank"), "\n");
    const result = importLegacy(db, ring(K1), OWNER_SELF, { env: {}, secretsDir: secrets }, 1);
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual(["profile/blank: empty", "profile/huge: larger than 64 KiB"]);
  });
});

describe("scripts/master-key.ts", () => {
  test("prints a key that parses, alone on stdout, and the warning on stderr", () => {
    const script = join(import.meta.dir, "..", "scripts", "master-key.ts");
    const run = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const key = run.stdout.toString().trim();
    expect(key).toMatch(/^v1:[A-Za-z0-9+/]{43}=$/);
    expect(ring(key).current.version).toBe(1);
    expect(run.stderr.toString()).toContain("password manager");
    expect(run.stderr.toString()).not.toContain(key);

    const rotation = Bun.spawnSync([process.execPath, script, "2"], { stdout: "pipe" });
    expect(rotation.stdout.toString()).toStartWith("v2:");

    const refused = Bun.spawnSync([process.execPath, script, "0x2"], { stdout: "pipe", stderr: "pipe" });
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout.toString()).toBe("");
  });
});
