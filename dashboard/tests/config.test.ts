import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capFrom, CLOUDS, DATA_DIR, GCP_KEY, MAX_JOBS, MAX_JOBS_PER_ACCOUNT, SECRETS_DIR } from "../src/config";
import { database } from "../src/db";
import { clouds, sourcesOf, type Sources } from "../src/secrets";

/** Whose vault the answers below are about: stated, like every Sources since accounts. */
const OWNER = 1;

/**
 * Which clouds this dashboard can order from, which is a question about what it holds.
 *
 * The list is computed rather than written down: a cloud is in it exactly when its every
 * required credential resolves. These tests pin the fallback half - the environment and the
 * disk, which is all a service without a master key has. The vault half is in
 * tests/secrets.test.ts, where a database is opened for it.
 */

afterEach(() => rmSync(GCP_KEY, { force: true }));

/** The fallback alone: no key, so the database is not a source at all. */
function fallback(env: Record<string, string>, secretsDir = SECRETS_DIR): Sources {
  return sourcesOf({ db: database, owner: OWNER, keyring: null, env, secretsDir });
}

const PROJECT = "acme-devbox-000000";
const SCALEWAY = {
  SCW_ACCESS_KEY: "SCWXXXXXXXXXXXXXXXXX",
  SCW_SECRET_KEY: "11111111-2222-3333-4444-555555555555",
  SCW_DEFAULT_PROJECT_ID: "66666666-7777-8888-9999-000000000000",
};

describe("clouds", () => {
  test("names none when nothing is held, rather than three that would fail", () => {
    // Hetzner and Scaleway used to be listed whatever the service held. Their tokens can
    // now be set and removed from a page, and a cloud that cannot be ordered from must be
    // absent from the form rather than present and broken.
    expect(clouds(fallback({}))).toEqual([]);
  });

  test("names hetzner from its token, scaleway from all three of its fields", () => {
    expect(clouds(fallback({ HCLOUD_TOKEN: "hc-token" }))).toEqual(["hetzner"]);
    // The access key is the one devbox-core's own check did not ask for, and terraform
    // refuses to plan without: two of three is not Scaleway.
    const { SCW_ACCESS_KEY: _, ...twoOfThree } = SCALEWAY;
    expect(clouds(fallback(twoOfThree))).toEqual([]);
    expect(clouds(fallback(SCALEWAY))).toEqual(["scaleway"]);
  });

  test("treats an empty variable as absent, as a systemd `NAME=` line sets it", () => {
    expect(clouds(fallback({ HCLOUD_TOKEN: "" }))).toEqual([]);
  });

  test("adds gcp exactly when the key is there, and drops it again when it is not", () => {
    expect(clouds(fallback({ DEVBOX_GCP_PROJECT: PROJECT }))).not.toContain("gcp");

    mkdirSync(dirname(GCP_KEY), { recursive: true });
    writeFileSync(GCP_KEY, "{}");
    // Read on every call, and this is the assertion that says so: a key deposited on the
    // server restarts nothing, so a list frozen at import would go on answering "no GCP"
    // until the next deployment.
    expect(clouds(fallback({ DEVBOX_GCP_PROJECT: PROJECT }))).toContain("gcp");

    rmSync(GCP_KEY);
    expect(clouds(fallback({ DEVBOX_GCP_PROJECT: PROJECT }))).not.toContain("gcp");
  });

  test("reads an empty key file as no key, as devbox-core's `[ -s ]` does", () => {
    mkdirSync(dirname(GCP_KEY), { recursive: true });
    writeFileSync(GCP_KEY, "");
    expect(clouds(fallback({ DEVBOX_GCP_PROJECT: PROJECT }))).not.toContain("gcp");
  });

  test("wants the project too, and a key without one does not put gcp on the form", () => {
    // The half-answer this guards against: devbox-core carried a default project until the
    // repository was published, so "the key is here" used to be the whole question. Without
    // one, gcp_token refuses — and a form that offered GCP anyway would take the order,
    // start a job and die at the apply, which is worse than not offering it at all.
    mkdirSync(dirname(GCP_KEY), { recursive: true });
    writeFileSync(GCP_KEY, "{}");

    const held = fallback({ HCLOUD_TOKEN: "hc-token", ...SCALEWAY });
    expect(clouds(held)).not.toContain("gcp");
    // And the two other clouds are untouched by it: one unconfigured provider must not
    // hide the ones that are.
    expect(clouds(held)).toEqual(["hetzner", "scaleway"]);
  });

  test("never widens past what devbox-core implements", () => {
    mkdirSync(dirname(GCP_KEY), { recursive: true });
    writeFileSync(GCP_KEY, "{}");
    const everything = fallback({ HCLOUD_TOKEN: "x", ...SCALEWAY, DEVBOX_GCP_PROJECT: PROJECT });
    expect(clouds(everything)).toEqual([...CLOUDS]);
  });

  test("looks for the key in the directory it is told, not only the service's", () => {
    const elsewhere = join(DATA_DIR, "config-test-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "gcp"), "{}");
    expect(clouds(fallback({ DEVBOX_GCP_PROJECT: PROJECT }, elsewhere))).toEqual(["gcp"]);
  });
});

describe("where the key is looked for", () => {
  test("is the secrets directory, under the exact name the vault deposits", () => {
    // The name is spelled in four places that cannot import from one another: two in the
    // deployment, outside this repository - what deposits the key, and what declares where
    // it lands - then devbox-core's gcp_key_file, and here. A rename that moved three of
    // them and not the fourth would show as a cloud that is simply never offered, with
    // nothing anywhere saying why.
    expect(GCP_KEY).toBe(`${SECRETS_DIR}/gcp`);
  });
});

/**
 * How many jobs run at once. A malformed value falls back to the default rather than stopping
 * the service - a unit that dies at startup loops on Restart=always without saying why - and
 * says what it passed over, which server.ts writes to the journal.
 */
describe("the job caps", () => {
  test("default to 4 for the service and 3 per account, tests/prepare.ts having cleared the unit's", () => {
    expect(MAX_JOBS).toBe(4);
    expect(MAX_JOBS_PER_ACCOUNT).toBe(3);
  });

  test("take a whole number of at least 1, and nothing else", () => {
    expect(capFrom("DEVBOX_MAX_JOBS", undefined, 4)).toEqual({ value: 4, refused: null });
    expect(capFrom("DEVBOX_MAX_JOBS", "", 4)).toEqual({ value: 4, refused: null });
    expect(capFrom("DEVBOX_MAX_JOBS", " 6 ", 4)).toEqual({ value: 6, refused: null });
    for (const raw of ["0", "-1", "2.5", "many", "1e3x"]) {
      const cap = capFrom("DEVBOX_MAX_JOBS", raw, 4);
      expect(cap.value, raw).toBe(4);
      expect(cap.refused, raw).toContain("DEVBOX_MAX_JOBS=");
    }
  });
});
