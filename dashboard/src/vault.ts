/**
 * The secrets vault: every credential this service holds, sealed in its own database.
 *
 * Until now a secret was a file in DEVBOX_SECRETS_DIR or a line of the service's environment,
 * and changing one meant a shell on the server. This module is what lets a page set them
 * instead, and it is written so that the page can only ever SET them: `listSecrets` answers
 * names, sizes and fingerprints, and `readSecret` exists for the one consumer that needs the
 * bytes, the engine handing them to devbox-core. A value never travels back to a browser.
 *
 * Two layers, and each does something the other cannot.
 *
 * The master key lives in the service's environment and never in the database, and it seals
 * one thing: a data key per owner. So a copy of devbox.db - a backup, a disk image, a file
 * sent somewhere by mistake - carries ciphertext and nothing to open it with. It does NOT
 * protect against whoever holds the running server: the key and the database sit on the same
 * machine, and no scheme changes that while the service has to decrypt unattended.
 *
 * The data key seals the values. One per owner, because this is ready for more than one
 * person without being built for it: a second owner gets a second key, and deleting an
 * owner's key is enough to make every one of their ciphertexts unreadable. A rotation of the
 * master key REPLACES each owner's data key and reseals their values under the new one - see
 * `rewrap` for why rewrapping the same data key was not a rotation at all.
 *
 * Every seal carries its context as authenticated data - owner, kind and name for a value,
 * owner and master key version for a data key - so a ciphertext copied onto another row does
 * not open there. Without it, anyone able to write the table could swap two values and have
 * the engine push one secret under another's name, without ever reading either.
 *
 * Synchronous throughout, on node:crypto rather than WebCrypto, whose every call is a
 * promise: `listSecrets` has to answer inside functions that are synchronous today, clouds()
 * among them, and bun:sqlite is synchronous anyway.
 *
 * No value reaches a message. Every error below names a variable, an owner, a kind or a name,
 * which are identifiers; the master key itself is held where neither JSON.stringify nor a
 * console.log can reach it.
 */
import type { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Cloud } from "./config";
import type { Checked } from "./validate";

/**
 * 64 KiB. The largest real value is a GCP service account key, around 2.3 KiB. Anything near
 * the ceiling is a file pasted by mistake, and it would otherwise travel into an environment
 * variable or a tmpfs on every job.
 */
export const MAX_SECRET_BYTES = 64 * 1024;

/**
 * The variables that hold the master key, for whoever builds an environment to hand to a
 * child process: devbox-core, terraform and every provider it runs have no use for them, and
 * `engineEnv()` passes the service's environment through whole.
 */
export const MASTER_KEY_VARIABLES = ["DEVBOX_MASTER_KEY", "DEVBOX_MASTER_KEY_PREVIOUS"] as const;

export type SecretKind = "cloud" | "profile";
export const SECRET_KINDS: readonly SecretKind[] = ["cloud", "profile"];

/** What anyone but the engine ever learns about a secret. */
export type SecretMeta = {
  kind: SecretKind;
  name: string;
  fingerprint: string;
  size: number;
  updated_at: number;
};

type Env = Readonly<Record<string, string | undefined>>;

/** The key material, sealed, is wrong or unreachable: the server's fault, never the caller's. */
export class VaultError extends Error {
  override name = "VaultError";
}

/**
 * What a caller sent cannot be stored. Shaped like validate.ts's `Invalid` so the HTTP layer
 * can answer it the same way; `reason` describes the value and never quotes it.
 */
export class SecretRefused extends Error {
  override name = "SecretRefused";
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.field = field;
    this.reason = reason;
  }
}

/* --- the catalogue --------------------------------------------------------- */

export type CloudField = {
  /** The variable devbox-core reads, or for `gcp` the file name under DEVBOX_SECRETS_DIR. */
  readonly name: string;
  readonly label: string;
  readonly multiline: boolean;
  /** Without it, the cloud cannot be ordered from: see CLOUD_FIELDS for the source of each. */
  readonly required: boolean;
  /**
   * Where the value lived before the vault, and where the fallback still looks: a variable of
   * the service's environment, or a file of DEVBOX_SECRETS_DIR under the same name.
   */
  readonly legacy: "env" | "file";
};

/**
 * Every credential a cloud needs, and nothing a profile declares.
 *
 * A fixed list, because devbox-core reads these under these exact names and nowhere else: a
 * cloud field the core does not know would be stored, shown as set, and read by nothing.
 *
 * "Required" means required to ORDER, which is decided at the apply and not at the probe,
 * and for one field the core's own check used to say less than that:
 *
 *   hetzner   hcloud_token() dies without HCLOUD_TOKEN.
 *
 *   scaleway  scw_credentials() checked SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID, and only
 *             exported SCW_ACCESS_KEY; the core's probe authenticates with the secret alone,
 *             so `probe` answered without the access key. Terraform does not. Measured on
 *             11/09 against scaleway provider 2.81.0, offline, SCW_API_URL pointed at a closed
 *             local port: without SCW_ACCESS_KEY the plan stops on "scaleway-sdk-go: access
 *             key cannot be empty"; with it, the plan reaches the network. A form trusting the
 *             core's check would have offered Scaleway and failed every order at the plan.
 *             The core asks for all three since the same day (cli/tests/core-scaleway.test.ts),
 *             and this list is what the form asks for, whatever an older engine checks.
 *
 *   gcp       gcp_token() refuses without DEVBOX_GCP_PROJECT. The key is the `gcp` file that
 *             gcp_key_file() opens under DEVBOX_SECRETS_DIR; the core's other roads,
 *             GOOGLE_APPLICATION_CREDENTIALS and gcloud's browser-refreshed credentials, are
 *             not ones a systemd unit takes - which is why clouds() in secrets.ts asks for both.
 *
 * `satisfies` rather than a declared type, so that a cloud added to CLOUDS without its fields
 * here fails tsc instead of shipping a cloud that can never be configured.
 */
export const CLOUD_FIELDS = {
  hetzner: [
    { name: "HCLOUD_TOKEN", label: "API token", multiline: false, required: true, legacy: "env" },
  ],
  scaleway: [
    { name: "SCW_ACCESS_KEY", label: "Access key", multiline: false, required: true, legacy: "env" },
    { name: "SCW_SECRET_KEY", label: "Secret key", multiline: false, required: true, legacy: "env" },
    {
      name: "SCW_DEFAULT_PROJECT_ID",
      label: "Project ID",
      multiline: false,
      required: true,
      legacy: "env",
    },
  ],
  gcp: [
    {
      name: "gcp",
      label: "Service account key (JSON)",
      multiline: true,
      required: true,
      legacy: "file",
    },
    {
      name: "DEVBOX_GCP_PROJECT",
      label: "Project ID",
      multiline: false,
      required: true,
      legacy: "env",
    },
  ],
} as const satisfies Record<Cloud, readonly CloudField[]>;

/**
 * A cloud as a person names it, for the sentences a refusal hands back to a page. `gcp` stays
 * the name of the data - a directory, a variable prefix, an argument - and is never shown.
 * The page keeps the same three words in web/src/lib/clouds.ts, for the screens no answer of
 * the server describes.
 */
export const CLOUD_NAMES = {
  hetzner: "Hetzner",
  scaleway: "Scaleway",
  gcp: "Google Cloud",
} as const satisfies Record<Cloud, string>;

const CATALOGUE: readonly CloudField[] = Object.values(CLOUD_FIELDS).flat();
const CATALOGUE_NAMES = new Set(CATALOGUE.map((field) => field.name));

/* --- names ------------------------------------------------------------------ */

/**
 * The rule devbox-core applies to every name of a `# devbox-secrets:` header, in cmd_seed,
 * before it reads a single value: `*[!a-zA-Z0-9_-]*|''` refused as "invalid secret name".
 * The same, because a name stored here that the core then refuses is a secret that can be
 * set and never used. The core has its reason too: the name becomes a path under
 * /run/secrets and part of a shell variable name.
 */
const PROFILE_SECRET = /^[A-Za-z0-9_-]+$/;

/** Not in the core, which has no bound: a name is a file name and a variable, not a text. */
export const SECRET_NAME_MAX = 64;

/**
 * Names devbox-core already reads under DEVBOX_SECRETS_DIR for something other than a
 * profile: a profile secret by either name would share its file.
 *
 * Compared case-insensitively, because the directory may be on a case-insensitive disk - a
 * Mac's, in development - where `GCP` and `gcp` are one file.
 */
const RESERVED = new Map([
  ["gcp", "the GCP service account key has this file name; set it as a cloud credential"],
  ["remote", "devbox-core reads its dashboard token under this file name"],
]);

export function checkedSecretKind(value: unknown): Checked<SecretKind> {
  const found = SECRET_KINDS.find((kind) => kind === value);
  return found === undefined
    ? { ok: false, field: "kind", reason: `expected one of ${SECRET_KINDS.join(", ")}` }
    : { ok: true, value: found };
}

/**
 * Exact, never trimmed: a name is an identifier, and one that differs from what the profile
 * declares by a space is a secret the seed will not find.
 */
export function checkedSecretName(kind: SecretKind, name: unknown): Checked<string> {
  if (typeof name !== "string") return { ok: false, field: "name", reason: "expected a string" };

  if (kind === "cloud") {
    if (CATALOGUE_NAMES.has(name)) return { ok: true, value: name };
    return {
      ok: false,
      field: "name",
      reason: `not a cloud credential devbox reads: expected one of ${[...CATALOGUE_NAMES].join(", ")}`,
    };
  }

  if (kind === "profile") {
    if (name === "") return { ok: false, field: "name", reason: "empty" };
    if (name.length > SECRET_NAME_MAX) {
      return { ok: false, field: "name", reason: `longer than ${SECRET_NAME_MAX} characters` };
    }
    if (!PROFILE_SECRET.test(name)) {
      return { ok: false, field: "name", reason: "letters, digits, dash and underscore only" };
    }
    const reserved = RESERVED.get(name.toLowerCase());
    if (reserved !== undefined) return { ok: false, field: "name", reason: `reserved: ${reserved}` };
    return { ok: true, value: name };
  }

  return { ok: false, field: "kind", reason: `expected one of ${SECRET_KINDS.join(", ")}` };
}

/**
 * A name as it may appear in a message. Stored names are checked, but read and delete accept
 * whatever is asked for, and a file name met during an import can hold anything - a newline
 * included, which would forge a line in whatever log this ends up in.
 */
function shown(name: string): string {
  return PROFILE_SECRET.test(name) ? name : JSON.stringify(name);
}

/* --- the master key ----------------------------------------------------------- */

/** A master key as the rest of the program sees it: a version, and no bytes. */
export type MasterKey = { readonly version: number };
export type Keyring = { readonly current: MasterKey; readonly previous: MasterKey | null };

/**
 * The bytes live here and nowhere a caller can print. A keyring passed to a logger, spread
 * into a response or serialised by mistake shows `{ version: 1 }`, and a keyring assembled by
 * hand is refused rather than trusted, since only this module ever filled the map.
 *
 * One map per PROCESS, not per evaluation of this module, and the difference is `bun --hot`:
 * a reload evaluates every module again while globalThis survives, and the key was deleted
 * from process.env at the first evaluation. A map of this evaluation's own would leave the
 * keyring kept by src/secrets.ts pointing at material the new module cannot find, and the
 * vault closed after every save of a file. A WeakMap's entries are not enumerable, so
 * the slot gives nothing to whoever inspects globalThis.
 */
const MATERIAL_SLOT = Symbol.for("devbox.dashboard.vault.material");
const MATERIAL: WeakMap<MasterKey, Uint8Array> = ((
  globalThis as { [MATERIAL_SLOT]?: WeakMap<MasterKey, Uint8Array> }
)[MATERIAL_SLOT] ??= new WeakMap());

const KEY_BYTES = 32;
const VERSION = /^v([1-9][0-9]{0,8})$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function material(key: MasterKey): Uint8Array {
  const bytes = MATERIAL.get(key);
  if (bytes === undefined) throw new VaultError("a master key this module did not parse");
  return bytes;
}

/**
 * Every refusal names the variable and what is wrong with it, and none quotes it: this is
 * the one error a service prints at startup, into a journal that outlives the key.
 */
function parsedMasterKey(variable: string, raw: string): MasterKey {
  const text = raw.trim();
  const colon = text.indexOf(":");
  let version = 1;
  let encoded = text;
  if (colon !== -1) {
    const prefix = VERSION.exec(text.slice(0, colon));
    if (prefix === null) {
      throw new VaultError(`${variable} must read v<N>:<base64>, N a whole number from 1`);
    }
    version = Number(prefix[1]);
    encoded = text.slice(colon + 1);
  }
  if (!BASE64.test(encoded)) {
    throw new VaultError(`${variable} is not standard base64 (A-Z, a-z, 0-9, + and /)`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== KEY_BYTES) {
    throw new VaultError(`${variable} decodes to ${bytes.length} bytes, and a master key is ${KEY_BYTES}`);
  }
  // Node's decoder skips what it cannot read instead of refusing it. Re-encoding is what
  // catches a value that only looked like base64, a truncated copy among them.
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new VaultError(`${variable} is not canonical base64: was it copied whole?`);
  }
  const key: MasterKey = Object.freeze({ version });
  MATERIAL.set(key, new Uint8Array(bytes));
  bytes.fill(0);
  return key;
}

/**
 * The keyring, or null when there is no master key at all - which is not an error, it is the
 * state of every deployment before this one, and the files and the environment still answer.
 *
 * Empty counts as absent, as missing() in secrets.ts counts it: a systemd environment file
 * line `DEVBOX_MASTER_KEY=` sets the variable to nothing.
 *
 * Anything present and wrong throws. A malformed key read as "no key" would put the service
 * back on the files with the database full of values it silently stopped reading.
 */
export function keyringFromEnv(env: Env = process.env): Keyring | null {
  const current = (env.DEVBOX_MASTER_KEY ?? "").trim();
  const previous = (env.DEVBOX_MASTER_KEY_PREVIOUS ?? "").trim();

  if (current === "") {
    if (previous !== "") {
      throw new VaultError(
        "DEVBOX_MASTER_KEY_PREVIOUS is set and DEVBOX_MASTER_KEY is not: a rotation keeps the old key beside the new one, never instead of it",
      );
    }
    return null;
  }

  const keyring: Keyring = {
    current: parsedMasterKey("DEVBOX_MASTER_KEY", current),
    previous: previous === "" ? null : parsedMasterKey("DEVBOX_MASTER_KEY_PREVIOUS", previous),
  };
  // A row records the version it was sealed under, and that is the only way it names its
  // key. Two keys under one version would leave half the rows unopenable, depending on which
  // one happened to be tried.
  if (keyring.previous !== null && keyring.previous.version === keyring.current.version) {
    throw new VaultError(
      `DEVBOX_MASTER_KEY and DEVBOX_MASTER_KEY_PREVIOUS are both v${keyring.current.version}: the new key needs a new version`,
    );
  }
  return Object.freeze(keyring);
}

export type VaultStatus = { available: true } | { available: false; reason: string };

export function vaultStatus(env: Env = process.env): VaultStatus {
  try {
    return keyringFromEnv(env) === null
      ? { available: false, reason: "DEVBOX_MASTER_KEY is not set" }
      : { available: true };
  } catch (error) {
    if (error instanceof VaultError) return { available: false, reason: error.message };
    throw error;
  }
}

/** `v<N>:<base64>`, drawn from the system's CSPRNG. What scripts/master-key.ts prints. */
export function newMasterKey(version = 1): string {
  if (!VERSION.test(`v${version}`)) throw new VaultError("a version is a whole number from 1");
  return `v${version}:${randomBytes(KEY_BYTES).toString("base64")}`;
}

function held(keyring: Keyring): string {
  return keyring.previous === null
    ? `v${keyring.current.version}`
    : `v${keyring.current.version} and v${keyring.previous.version}`;
}

/* --- sealing ------------------------------------------------------------------- */

const CIPHER = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * A fresh random nonce per seal. GCM fails catastrophically on a repeated nonce under one
 * key, and a counter would have to survive restarts and restores; at 2^32 seals per key the
 * random draw stays safe, and a data key here seals a few dozen values in its life.
 */
function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: new Uint8Array(body), nonce: new Uint8Array(nonce) };
}

/** Null for anything that does not authenticate: callers turn it into an error with context. */
function unseal(key: Uint8Array, ciphertext: Uint8Array, nonce: Uint8Array, aad: string): Buffer | null {
  if (nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(CIPHER, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, -TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

/**
 * The version is in the data key's context, so a row whose `key_version` was edited does not
 * open under the key it now names - it could otherwise be pointed at a key the attacker holds.
 * No part of either context can contain a colon, which keeps them unambiguous.
 */
const dekContext = (owner: number, version: number) => `devbox:dek:${owner}:${version}`;
const valueContext = (owner: number, kind: string, name: string) =>
  `devbox:secret:${owner}:${kind}:${name}`;

/**
 * HMAC and not a hash, under a key derived from the data key rather than the data key itself,
 * so that the one key never serves two purposes. A bare SHA-256 in a stolen copy of the
 * database would let a short token be guessed offline, and would show which owners share a
 * value; this one needs the master key to compute at all.
 *
 * Twelve hex characters: enough to tell a changed value from an unchanged one, which is all a
 * fingerprint is for.
 */
function fingerprintOf(dek: Uint8Array, value: Uint8Array): string {
  const key = Buffer.from(hkdfSync("sha256", dek, new Uint8Array(0), "devbox:fingerprint", 32));
  const digest = createHmac("sha256", key).update(value).digest("hex").slice(0, 12);
  key.fill(0);
  return digest;
}

/** In constant time, and false rather than a throw for two lengths that differ. */
function sameFingerprint(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

type ValueRow = {
  kind: string;
  name: string;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  fingerprint: string;
};

/**
 * One value, opened under its owner's data key and checked against the fingerprint its row
 * records. Every read goes through here: readSecret, and the rotation in `rewrap`.
 *
 * THE FINGERPRINT CHECK is what the context alone does not give. The authenticated data binds
 * a ciphertext to its owner, kind and name, and nothing to WHEN it was sealed: an older
 * ciphertext of the same row, put back by whoever can write the table, authenticates
 * perfectly. Found on 11/09 by putting a revoked token's ciphertext back over its rotation:
 * it opened without a word, a job was handed the revoked token, and the page went on showing
 * the rotated value's fingerprint - which is what an operator checks to know the rotation
 * took. Recomputed here, the fingerprint no longer matches, and the replay is an error.
 *
 * WHAT IT DOES NOT STOP, and this is an accepted risk rather than an oversight: a replay of
 * the WHOLE row - ciphertext, nonce, fingerprint, size and date together, copied from an older
 * copy of the database - is self-consistent and opens. Refusing it would take a counter kept
 * somewhere the database's writer cannot reach, and on this service there is no such place:
 * whoever can write devbox.db runs as the account that holds the master key. The page then at
 * least shows the OLD fingerprint and date, so the rollback is visible to whoever looks.
 *
 * The caller owns the buffer it gets, and zeroes it when done.
 */
function openValue(dek: Uint8Array, owner: number, row: ValueRow): Buffer {
  const label = `${row.kind}/${shown(row.name)} of owner ${owner}`;
  const value = unseal(dek, row.ciphertext, row.nonce, valueContext(owner, row.kind, row.name));
  if (value === null) {
    throw new VaultError(
      `${label} does not open: the row was altered, or its ciphertext belongs to another row`,
    );
  }
  if (!sameFingerprint(fingerprintOf(dek, value), row.fingerprint)) {
    value.fill(0);
    throw new VaultError(
      `${label} opens to a value its fingerprint does not record: an older ciphertext was put back in the row. Set the value again, or delete it`,
    );
  }
  return value;
}

/* --- owners and their data keys ---------------------------------------------------- */

type OwnerRow = { id: number; dek: Uint8Array; nonce: Uint8Array; key_version: number };

function checkedOwner(owner: number): number {
  if (!Number.isSafeInteger(owner) || owner < 1) {
    throw new VaultError("an owner is a whole number from 1");
  }
  return owner;
}

/**
 * Opened with whichever key sealed it, current or previous, so that reads and writes carry on
 * through a rotation before `rewrap` has run.
 */
function openedDek(keyring: Keyring, row: OwnerRow): Buffer {
  const key =
    row.key_version === keyring.current.version
      ? keyring.current
      : keyring.previous !== null && row.key_version === keyring.previous.version
        ? keyring.previous
        : null;
  if (key === null) {
    throw new VaultError(
      `owner ${row.id}'s data key is sealed under master key v${row.key_version}, and the keyring holds ${held(keyring)}: set that key as DEVBOX_MASTER_KEY or DEVBOX_MASTER_KEY_PREVIOUS`,
    );
  }
  const dek = unseal(material(key), row.dek, row.nonce, dekContext(row.id, row.key_version));
  if (dek === null || dek.length !== KEY_BYTES) {
    throw new VaultError(
      `owner ${row.id}'s data key does not open under master key v${key.version}: another key was set under that version, or the row was altered`,
    );
  }
  return dek;
}

function ownerRow(db: Database, owner: number): OwnerRow | null {
  return db
    .query<OwnerRow, [number]>("SELECT id, dek, nonce, key_version FROM owners WHERE id = ?")
    .get(owner);
}

/**
 * A NEW data key for an owner sealed under an older master key, every one of their values
 * resealed under it, and the new key sealed under the current master key. Answers the new
 * data key, which the caller zeroes. Only ever called inside a write transaction: a rotation
 * is all of it or none of it.
 *
 * Why the data key itself changes, and not only its envelope. The rotation is what an
 * operator runs after the master key LEAKED, and rewrapping the same data key under the new
 * master key left the leak open: measured on 11/09, whoever held the old master key and any
 * copy of devbox.db from before the rotation - a nightly backup - unsealed the old data key
 * from the backup's `owners` row, and with it opened every value written AFTER the rotation,
 * from a later copy of `secrets`, without ever touching the new master key. With a data key
 * drawn fresh here, the old master key opens only the values as they stood in the backup,
 * which it could open anyway.
 *
 * Every value is opened through openValue, so a row that does not open, or opens to a value
 * its fingerprint does not record, stops the rotation with its name - rather than being
 * resealed as it is, which would launder a replayed ciphertext into a valid one, or left
 * under a data key that no longer exists, which would lose it without a word. Such a row can
 * be deleted with the vault closed: deleteSecret needs no key.
 *
 * New nonces, from seal; new fingerprints, since the fingerprint key derives from the data
 * key - which is also why every fingerprint on the page moves once, at a rotation, with no
 * value having changed. `size` and `updated_at` stay: they describe the value, not its seal.
 */
function rotatedDek(db: Database, keyring: Keyring, row: OwnerRow): Buffer {
  const old = openedDek(keyring, row);
  const fresh = randomBytes(KEY_BYTES);
  try {
    const values = db
      .query<ValueRow, [number]>(
        "SELECT kind, name, ciphertext, nonce, fingerprint FROM secrets WHERE owner_id = ?",
      )
      .all(row.id);
    for (const value of values) {
      const plain = openValue(old, row.id, value);
      try {
        const sealed = seal(fresh, plain, valueContext(row.id, value.kind, value.name));
        db.query<undefined, [Uint8Array, Uint8Array, string, number, string, string]>(
          `UPDATE secrets SET ciphertext = ?, nonce = ?, fingerprint = ?
            WHERE owner_id = ? AND kind = ? AND name = ?`,
        ).run(sealed.ciphertext, sealed.nonce, fingerprintOf(fresh, plain), row.id, value.kind, value.name);
      } finally {
        plain.fill(0);
      }
    }
    const sealed = seal(material(keyring.current), fresh, dekContext(row.id, keyring.current.version));
    db.query<undefined, [Uint8Array, Uint8Array, number, number]>(
      "UPDATE owners SET dek = ?, nonce = ?, key_version = ? WHERE id = ?",
    ).run(sealed.ciphertext, sealed.nonce, keyring.current.version, row.id);
    return fresh;
  } catch (error) {
    fresh.fill(0);
    throw error;
  } finally {
    old.fill(0);
  }
}

/**
 * Only ever called inside a write transaction, so two first writes cannot draw two keys.
 *
 * An owner still under the previous master key is rotated first, here, rather than written
 * under a data key the rotation is about to retire: openVault runs `rewrap` before anything
 * is served, so this only happens to a caller that skipped it - but a value sealed under the
 * old data key after the new master key was set would be exactly the leak the rotation is for.
 */
function ensuredDek(db: Database, keyring: Keyring, owner: number, now: number): Buffer {
  const row = ownerRow(db, owner);
  if (row !== null) {
    return row.key_version === keyring.current.version
      ? openedDek(keyring, row)
      : rotatedDek(db, keyring, row);
  }

  const dek = randomBytes(KEY_BYTES);
  const sealed = seal(material(keyring.current), dek, dekContext(owner, keyring.current.version));
  db.query<undefined, [number, Uint8Array, Uint8Array, number, number]>(
    "INSERT INTO owners (id, dek, nonce, key_version, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(owner, sealed.ciphertext, sealed.nonce, keyring.current.version, now);
  return dek;
}

/**
 * Finishes a rotation: every owner whose data key is still sealed under
 * DEVBOX_MASTER_KEY_PREVIOUS gets a new data key under DEVBOX_MASTER_KEY, and every one of
 * their values is resealed under it - see rotatedDek for why the data key has to change.
 * Answers how many owners it rotated.
 *
 * Every data key is opened, the ones already under the current key included. Meant to run at
 * startup, this is where a wrong key is found - before a job needs a secret, not three
 * minutes into one. A row under a version the keyring does not hold, or a value the rotation
 * cannot open, is an error, and the whole pass rolls back rather than leaving a rotation half
 * done without saying so.
 *
 * Idempotent: once every owner is under the current version, a second pass writes nothing.
 * Only then can DEVBOX_MASTER_KEY_PREVIOUS be dropped.
 */
export function rewrap(db: Database, keyring: Keyring): number {
  return db
    .transaction(() => {
      const rows = db
        .query<OwnerRow, []>("SELECT id, dek, nonce, key_version FROM owners ORDER BY id")
        .all();
      let moved = 0;
      for (const row of rows) {
        const behind = row.key_version !== keyring.current.version;
        const dek = behind ? rotatedDek(db, keyring, row) : openedDek(keyring, row);
        dek.fill(0);
        if (behind) moved += 1;
      }
      return moved;
    })
    .immediate();
}

/* --- values ---------------------------------------------------------------------- */

const encoder = new TextEncoder();

/**
 * One trailing newline removed, `\n` or `\r\n`, and only one: `echo`, an editor and a
 * textarea all add one, and it would travel as far as an Authorization header - where a
 * token followed by a newline is a malformed header, refused by an API that then reads as a
 * revoked token. Only one, because a value may legitimately end in a newline of its own.
 * The script that used to deposit the files stripped it the same way.
 *
 * Bytes stay bytes. A value is not assumed to be text, and nothing here decodes one.
 *
 * Exported for the one caller that must see a value exactly as the vault would store it
 * without storing it: the credential test of POST /api/clouds/:cloud/test, which would
 * otherwise try one set of bytes and save another.
 */
export function normalizedValue(value: string | Uint8Array): Uint8Array {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) {
    throw new SecretRefused("value", "expected a string or bytes");
  }
  const bytes = typeof value === "string" ? encoder.encode(value) : Uint8Array.from(value);
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0a) {
    end -= 1;
    if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  }
  // Empty is refused rather than stored: devbox-core treats an empty secret as absent and
  // would prompt for it, and a service has no keyboard. See secrets.ts for the file version.
  if (end === 0) throw new SecretRefused("value", "empty");
  // Blank is empty with extra steps: a paste that caught only the spaces around a token
  // would be stored, fingerprinted and pushed to /run/secrets as a valid secret, and fail
  // later as an authentication, on a machine already billing.
  if (bytes.subarray(0, end).every((byte) => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d))) {
    throw new SecretRefused("value", "blank");
  }
  if (end > MAX_SECRET_BYTES) {
    throw new SecretRefused("value", `larger than ${MAX_SECRET_BYTES / 1024} KiB`);
  }
  return bytes.subarray(0, end);
}

type Action = "set" | "delete" | "import";

function recordEvent(
  db: Database,
  owner: number,
  kind: SecretKind,
  name: string,
  action: Action,
  now: number,
): void {
  db.query<undefined, [number, string, string, string, number]>(
    "INSERT INTO secret_events (owner_id, kind, name, action, at) VALUES (?, ?, ?, ?, ?)",
  ).run(owner, kind, name, action, now);
}

function store(
  db: Database,
  dek: Uint8Array,
  owner: number,
  kind: SecretKind,
  name: string,
  value: Uint8Array,
  now: number,
  action: Action,
): SecretMeta {
  const sealed = seal(dek, value, valueContext(owner, kind, name));
  const meta: SecretMeta = {
    kind,
    name,
    fingerprint: fingerprintOf(dek, value),
    size: value.length,
    updated_at: now,
  };
  db.query<undefined, [number, string, string, Uint8Array, Uint8Array, string, number, number]>(
    `INSERT INTO secrets (owner_id, kind, name, ciphertext, nonce, fingerprint, size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_id, kind, name) DO UPDATE SET
       ciphertext = excluded.ciphertext, nonce = excluded.nonce,
       fingerprint = excluded.fingerprint, size = excluded.size,
       updated_at = excluded.updated_at`,
  ).run(owner, kind, name, sealed.ciphertext, sealed.nonce, meta.fingerprint, meta.size, now);
  recordEvent(db, owner, kind, name, action, now);
  return meta;
}

/**
 * Stores a value, replacing any previous one, and answers what may be shown of it.
 *
 * Everything is checked before the transaction opens, so a refused value leaves nothing
 * behind - not even the owner's data key on a first write.
 */
export function setSecret(
  db: Database,
  keyring: Keyring,
  owner: number,
  kind: SecretKind,
  name: string,
  value: string | Uint8Array,
  now: number,
): SecretMeta {
  const [meta] = setSecrets(db, keyring, owner, [{ kind, name, value }], now);
  if (meta === undefined) throw new VaultError("a write of one value stored none");
  return meta;
}

export type SecretWrite = { kind: SecretKind; name: string; value: string | Uint8Array };

/**
 * Several values under one owner, in ONE transaction: every one of them, or none.
 *
 * For a cloud, whose credentials are a set. The page used to save a Scaleway key one PUT per
 * field, and a refusal at the second left the first written: a new access key beside the old
 * secret, a pair that answers nothing, and a cloud that had worked a minute before. Every
 * name and every value is checked before the transaction opens, like setSecret's, and each
 * gets its own `set` event inside it.
 */
export function setSecrets(
  db: Database,
  keyring: Keyring,
  owner: number,
  writes: readonly SecretWrite[],
  now: number,
): SecretMeta[] {
  checkedOwner(owner);
  if (writes.length === 0) throw new SecretRefused("values", "nothing to store");
  const seen = new Set<string>();
  const checked = writes.map((write) => {
    const name = checkedSecretName(write.kind, write.name);
    if (!name.ok) throw new SecretRefused(name.field, name.reason);
    const key = `${write.kind}/${name.value}`;
    if (seen.has(key)) throw new SecretRefused("name", `${shown(name.value)} is given twice`);
    seen.add(key);
    return { kind: write.kind, name: name.value, bytes: normalizedValue(write.value) };
  });

  return db
    .transaction(() => {
      const dek = ensuredDek(db, keyring, owner, now);
      try {
        return checked.map((one) => store(db, dek, owner, one.kind, one.name, one.bytes, now, "set"));
      } finally {
        dek.fill(0);
      }
    })
    .immediate();
}

/**
 * The bytes, for the engine and nothing that answers a request.
 *
 * Null means "never set", and only that. A row that does not open throws: a null there would
 * read as absent, and the fallback would quietly serve the stale file in its place. So does a
 * row that opens to a value its fingerprint does not record - see openValue.
 *
 * The name is looked up as given and not checked, here and in deleteSecret: the check guards
 * what enters, and a rule tightened later must not strand a row that can then be neither
 * read nor removed.
 */
export function readSecret(
  db: Database,
  keyring: Keyring,
  owner: number,
  kind: SecretKind,
  name: string,
): Uint8Array | null {
  checkedOwner(owner);
  const row = db
    .query<ValueRow, [number, string, string]>(
      `SELECT kind, name, ciphertext, nonce, fingerprint FROM secrets
        WHERE owner_id = ? AND kind = ? AND name = ?`,
    )
    .get(owner, kind, name);
  if (row === null) return null;

  const owned = ownerRow(db, owner);
  if (owned === null) {
    throw new VaultError(`owner ${owner} holds ${kind}/${shown(name)} and no data key`);
  }
  const dek = openedDek(keyring, owned);
  try {
    const value = openValue(dek, owner, row);
    const copy = new Uint8Array(value);
    value.fill(0);
    return copy;
  } finally {
    dek.fill(0);
  }
}

/** False when there was nothing to delete, which records no event. Needs no key. */
export function deleteSecret(
  db: Database,
  owner: number,
  kind: SecretKind,
  name: string,
  now: number,
): boolean {
  checkedOwner(owner);
  return db
    .transaction(() => {
      const { changes } = db
        .query<undefined, [number, string, string]>(
          "DELETE FROM secrets WHERE owner_id = ? AND kind = ? AND name = ?",
        )
        .run(owner, kind, name);
      if (changes === 0) return false;
      recordEvent(db, owner, kind, name, "delete", now);
      return true;
    })
    .immediate();
}

/**
 * What is set, never what it is set to: the query does not select the ciphertext, so no
 * change to a caller can make it serve one. Needs no key, so a page can say what is present
 * even while the master key is missing or wrong.
 */
export function listSecrets(db: Database, owner: number): SecretMeta[] {
  checkedOwner(owner);
  return db
    .query<SecretMeta, [number]>(
      `SELECT kind, name, fingerprint, size, updated_at FROM secrets
        WHERE owner_id = ? ORDER BY kind, name`,
    )
    .all(owner);
}

/* --- the files and the environment, before the vault -------------------------------------- */

/** `secretsDir` null: no directory to read, for an account the service's files are not for. */
export type LegacySources = { env: Env; secretsDir: string | null };
export type ImportResult = { imported: string[]; skipped: string[] };

type Candidate = { kind: SecretKind; name: string; value: Uint8Array };

/**
 * A legacy file as secrets.ts reads it: absent, not a regular file, or empty all count as
 * absent. Anything present and unusable is said in `skipped`, never thrown: one bad file must
 * not keep the rest out.
 */
function legacyFile(path: string, label: string, skipped: string[]): Uint8Array | null {
  const unreadable = (error: unknown) =>
    skipped.push(`${label}: unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`);

  let found: Stats | undefined;
  try {
    // throwIfNoEntry covers ENOENT alone; EACCES and ENOTDIR still throw, and are reported.
    found = statSync(path, { throwIfNoEntry: false });
  } catch (error) {
    unreadable(error);
    return null;
  }
  if (found === undefined || !found.isFile() || found.size === 0) return null;
  // Two bytes of slack for the one newline normalizedValue removes. Checked on the size and
  // not on the content, so a file pasted by mistake is never read into memory at all.
  if (found.size > MAX_SECRET_BYTES + 2) {
    skipped.push(`${label}: larger than ${MAX_SECRET_BYTES / 1024} KiB`);
    return null;
  }
  try {
    return new Uint8Array(readFileSync(path));
  } catch (error) {
    unreadable(error);
    return null;
  }
}

function offer(
  candidates: Candidate[],
  skipped: string[],
  kind: SecretKind,
  name: string,
  raw: string | Uint8Array,
): void {
  try {
    candidates.push({ kind, name, value: normalizedValue(raw) });
  } catch (error) {
    if (!(error instanceof SecretRefused)) throw error;
    skipped.push(`${kind}/${shown(name)}: ${error.reason}`);
  }
}

/**
 * Copies into the database whatever the service held before it: the catalogue's variables
 * from `env`, the GCP key and every profile secret from the files of `secretsDir`.
 *
 * It never overwrites. Once a value is in the database, the database is what holds it, and a
 * file left behind on the disk is at best a copy and at worst the value from before a
 * rotation - replaying it on a restart would silently undo the rotation. When a value
 * already stored differs from its legacy copy, `skipped` says so, which is the one thing an
 * operator needs to know before removing the file.
 *
 * Nor does it bring back a name the vault has already decided about. Found on 11/09: a token
 * rotated through the page, then deleted from the vault - which hands the next job the file
 * again, and the page says so - and then an Import, which copied that same stale file into
 * the database as though it were the value set there, under a fresh date. The page then
 * showed a value held by the vault where there was only the copy from before the rotation.
 * So a name with a `set` or `delete` in secret_events is never imported: from the first time
 * the page decided about it, only the page decides. Its reason is said in `skipped`.
 *
 * Idempotent: a second run imports nothing and says why for each.
 *
 * Profile secrets are what the directory holds - none at all without one - and not what the
 * profiles declare: the question
 * is what this service already has, and private profiles under DEVBOX_CONFIG_DIR may declare
 * names that the engine's copy of profiles/ has never heard of.
 */
export function importLegacy(
  db: Database,
  keyring: Keyring,
  owner: number,
  sources: LegacySources,
  now: number,
): ImportResult {
  checkedOwner(owner);
  const candidates: Candidate[] = [];
  const skipped: string[] = [];

  for (const field of CATALOGUE) {
    if (field.legacy === "env") {
      const raw = sources.env[field.name];
      if (raw !== undefined && raw !== "") offer(candidates, skipped, "cloud", field.name, raw);
    } else {
      if (sources.secretsDir === null) continue;
      const label = `cloud/${field.name}`;
      const raw = legacyFile(join(sources.secretsDir, field.name), label, skipped);
      if (raw !== null) offer(candidates, skipped, "cloud", field.name, raw);
    }
  }

  let entries: string[] = [];
  const directory = sources.secretsDir;
  try {
    if (directory !== null) entries = readdirSync(directory).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Absent is the ordinary case, on a workstation and on a unit deployed before anything
    // was deposited. Present and unlistable is not, and saying nothing would pass for "no
    // profile secrets" while every file sat there unread.
    if (code !== "ENOENT") skipped.push(`profile/*: the directory cannot be listed (${code ?? "error"})`);
  }
  const files = new Set(CATALOGUE.filter((field) => field.legacy === "file").map((f) => f.name));
  for (const entry of entries) {
    if (files.has(entry)) continue;
    const label = `profile/${shown(entry)}`;
    if (directory === null) break;
    const raw = legacyFile(join(directory, entry), label, skipped);
    if (raw === null) continue;
    const checked = checkedSecretName("profile", entry);
    if (!checked.ok) {
      skipped.push(`${label}: ${checked.reason}`);
      continue;
    }
    offer(candidates, skipped, "profile", entry, raw);
  }

  if (candidates.length === 0) return { imported: [], skipped };

  return db
    .transaction(() => {
      const imported: string[] = [];
      const dek = ensuredDek(db, keyring, owner, now);
      try {
        for (const candidate of candidates) {
          const label = `${candidate.kind}/${candidate.name}`;
          const existing = db
            .query<{ fingerprint: string }, [number, string, string]>(
              "SELECT fingerprint FROM secrets WHERE owner_id = ? AND kind = ? AND name = ?",
            )
            .get(owner, candidate.kind, candidate.name);
          if (existing !== null) {
            // Compared by fingerprint rather than by opening the stored value: the answer only
            // has to tell "same" from "different", and it never needs the old bytes for that.
            const same = fingerprintOf(dek, candidate.value) === existing.fingerprint;
            skipped.push(
              same
                ? `${label}: already in the database, same value`
                : `${label}: already in the database with another value, which is the one kept`,
            );
            continue;
          }
          const decided = db
            .query<{ action: string }, [number, string, string]>(
              `SELECT action FROM secret_events
                WHERE owner_id = ? AND kind = ? AND name = ? AND action IN ('set', 'delete')
                ORDER BY id DESC LIMIT 1`,
            )
            .get(owner, candidate.kind, candidate.name);
          if (decided !== null) {
            skipped.push(
              `${label}: ${decided.action === "delete" ? "deleted from" : "set in"} the vault before, and a copy from outside it never goes back in over that: set it on the page if it is still wanted`,
            );
            continue;
          }
          store(db, dek, owner, candidate.kind, candidate.name, candidate.value, now, "import");
          imported.push(label);
        }
      } finally {
        dek.fill(0);
      }
      return { imported, skipped };
    })
    .immediate();
}
