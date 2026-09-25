import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, type Cloud } from "../src/config";
import { database } from "../src/db";
import { clouds, sourcesOf } from "../src/secrets";

/** Whose credentials the list below is about: every caller states one now. */
const OWNER = 1;
import {
  LABEL_MAX,
  LIMITS,
  NAME_MAX,
  checkedCloud,
  checkedFloor,
  checkedLabel,
  checkedMachineName,
  checkedProfile,
  checkedType,
  createArgv,
  validateCreate,
  validateProbe,
} from "../src/validate";

/**
 * The most important tests on this site.
 *
 * Every field checked here ends up as an argument to a command that orders machines
 * billed by the hour. The refused cases matter at least as much as the accepted ones,
 * which is why there are more of them.
 */

const PROFILES = ["claude", "bare"];

/**
 * The clouds a service holding Hetzner's and Scaleway's credentials can order from, stated
 * rather than arranged: since 11/09 every cloud is in clouds() only when its credentials
 * resolve, and the test process holds none. Where a test is about another field, this is
 * the list it validates the cloud against.
 */
const ORDERABLE: readonly Cloud[] = ["hetzner", "scaleway"];

/** clouds() over the fallback alone - a GCP key in `directory`, and the given project. */
function gcpHeld(directory: string, project: string): Cloud[] {
  return clouds(
    sourcesOf({
      db: database,
      owner: OWNER,
      keyring: null,
      env: project === "" ? {} : { DEVBOX_GCP_PROJECT: project },
      secretsDir: directory,
    }),
  );
}

/** What a service holding nothing offers - the list an empty vault and empty fallback give. */
const NOTHING: readonly Cloud[] = [];

describe("machine names", () => {
  test("accepts what devbox accepts", () => {
    for (const name of ["devbox-k7f2q", "s2", "A1", "a_b-c", "9"]) {
      expect(checkedMachineName(name)).toEqual({ ok: true, value: name });
    }
  });

  test("refuses a leading dash, which devbox itself allows", () => {
    // This is the case that matters. devbox's own rule is "letters, digits, dash or
    // underscore", so `--cloud` passes it; handed to `devbox up --name --cloud` its argument
    // loop would read a flag where a name was meant. A text field must not be able to
    // compose flags.
    for (const name of ["-cloud", "--json", "-"]) {
      expect(checkedMachineName(name).ok).toBe(false);
    }
  });

  test("refuses what would not survive as a hostname or a path", () => {
    for (const name of ["", "   ", "a b", "a/b", "../etc", "a;b", "é", "a\u0000b"]) {
      expect(checkedMachineName(name).ok).toBe(false);
    }
  });

  test("refuses a name longer than the ceiling", () => {
    expect(checkedMachineName("a".repeat(NAME_MAX)).ok).toBe(true);
    expect(checkedMachineName("a".repeat(NAME_MAX + 1)).ok).toBe(false);
  });

  test("refuses anything that is not a string", () => {
    for (const value of [undefined, null, 42, [], {}, true]) {
      expect(checkedMachineName(value).ok).toBe(false);
    }
  });

  test("trims, because a form sends what was typed", () => {
    expect(checkedMachineName("  s2  ")).toEqual({ ok: true, value: "s2" });
  });
});

describe("profiles", () => {
  test("accepts one that exists", () => {
    expect(checkedProfile("claude", PROFILES)).toEqual({ ok: true, value: "claude" });
  });

  test("refuses one that does not, however well formed", () => {
    // The list comes from the engine, not from a constant here: a profile added under
    // ~/.config/devbox/profiles must work without touching this file, and one removed must
    // stop working without it either.
    expect(checkedProfile("ghost", PROFILES).ok).toBe(false);
  });

  test("refuses a path before it ever reaches the filesystem", () => {
    for (const value of ["../claude", "profiles/claude", "/etc/passwd"]) {
      expect(checkedProfile(value, PROFILES).ok).toBe(false);
    }
  });
});

describe("clouds", () => {
  test("accepts a cloud whose credentials the service holds", () => {
    expect(checkedCloud("hetzner", ORDERABLE).ok).toBe(true);
    expect(checkedCloud("scaleway", ORDERABLE).ok).toBe(true);
  });

  test("refuses every cloud when the service holds no credential, and says so", () => {
    // The state of a fresh deployment before anything is set - and the list is passed in,
    // there being no "the clouds" any more, only the clouds of whoever is asking.
    const refused = checkedCloud("hetzner", NOTHING);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("no cloud has its credentials set in this service");
  });

  /**
   * gcp, whose answer is a question about the disk rather than a constant.
   *
   * It was refused outright until 31/08, and the reason was sound while it lasted:
   * gcp_token() knew one credential, `gcloud auth application-default
   * print-access-token`, whose refresh opens a browser. devbox-core now also signs its own
   * token from a service account key, so what decides is whether the key is deposited AND
   * whether a project is set — and BOTH answers are pinned here, because a list that
   * silently widened would let a creation be accepted that the engine refuses a minute
   * later, on a job already written to the database. That is precisely what the project
   * added on 02/09: the key alone stopped being enough the day devbox-core dropped the
   * default project it used to carry.
   */
  test("refuses gcp with no service account key, accepts it with one", () => {
    const project = "acme-devbox-000000";
    expect(checkedCloud("gcp", gcpHeld(join(DATA_DIR, "absent-gcp-dir"), project)).ok).toBe(false);

    const directory = join(DATA_DIR, "gcp-key-dir");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "gcp"), "{}");
    expect(checkedCloud("gcp", gcpHeld(directory, project)).ok).toBe(true);
    // The key on its own no longer opens it, and the refusal happens HERE rather than in
    // the job: a machine ordered against no project is a job that dies at the apply.
    expect(checkedCloud("gcp", gcpHeld(directory, "")).ok).toBe(false);
  });

  test("names what it would have accepted, so a refusal is readable", () => {
    const refused = checkedCloud("gcp", ORDERABLE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("expected one of hetzner, scaleway");
  });

  test("refuses anything else", () => {
    for (const value of ["", "aws", "HETZNER", 1, null]) {
      expect(checkedCloud(value, ORDERABLE).ok).toBe(false);
    }
  });
});

describe("floors", () => {
  test("accepts a whole number inside the bounds", () => {
    expect(checkedFloor(8, "ram")).toEqual({ ok: true, value: 8 });
    expect(checkedFloor("16", "ram")).toEqual({ ok: true, value: 16 });
  });

  test("refuses outside the bounds, which exist to catch a typo", () => {
    expect(checkedFloor(LIMITS.ram.max + 1, "ram").ok).toBe(false);
    expect(checkedFloor(0, "cpu").ok).toBe(false);
    expect(checkedFloor(-4, "cpu").ok).toBe(false);
  });

  test("refuses what is not a whole number", () => {
    for (const value of ["", "8G", "8.5", 8.5, Number.NaN, Number.POSITIVE_INFINITY, null, []]) {
      expect(checkedFloor(value, "disk").ok).toBe(false);
    }
  });
});

describe("instance types", () => {
  test("accepts the shapes the three catalogues actually use", () => {
    for (const type of ["cx33", "DEV1-L", "e2-standard-4", "n2d.large"]) {
      expect(checkedType(type)).toEqual({ ok: true, value: type });
    }
  });

  test("refuses a leading dash and anything unprintable", () => {
    for (const type of ["-type", "", "a b", "a/b"]) {
      expect(checkedType(type).ok).toBe(false);
    }
  });
});

describe("validateCreate", () => {
  test("accepts the smallest complete form", () => {
    const result = validateCreate({ profile: "claude", cloud: "hetzner" }, PROFILES, ORDERABLE);
    expect(result).toEqual({
      ok: true,
      value: { profile: "claude", cloud: "hetzner" },
    });
  });

  test("leaves an untouched field out rather than defaulting it", () => {
    // The profile header carries the defaults. Re-deciding them here would be a second
    // place for them to live, and the two would drift.
    const result = validateCreate(
      { profile: "claude", cloud: "hetzner", name: "", cpu: "", ram: "", disk: "" },
      PROFILES,
      ORDERABLE,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cpu).toBeUndefined();
      expect(result.value.name).toBeUndefined();
    }
  });

  test("refuses a request that asks to skip phase 2", () => {
    // The dashboard always runs phase 2. devbox keeps --no-seed, which is right on a
    // workstation, but through here it produced a machine on the meter with nothing on it
    // and no way to finish it from a phone. Refused rather than ignored, so
    // `devbox up --no-seed` against a remote does not quietly do the opposite.
    for (const value of [false, "false"]) {
      const refused = validateCreate(
        { profile: "claude", cloud: "hetzner", seed: value },
        PROFILES,
        ORDERABLE,
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.field).toBe("seed");
    }
  });

  test("refuses a repository in the request, wherever it comes from", () => {
    // The repository is a property of the profile. One field could name exactly one, and
    // a profile cloning two has no way to say so: each repository travels with ITS secret
    // and ITS host, which only clone_repo can express. Refused rather than ignored, so
    // `devbox up --repo X` against a remote does not quietly drop it.
    const refused = validateCreate(
      { profile: "claude", cloud: "hetzner", repo: "https://github.com/me/mine.git" },
      PROFILES,
      ORDERABLE,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.field).toBe("repo");
  });

  test("accepts a profile that declares no repository", () => {
    // bare is that case, and it yields exactly what its header promises: a machine, and
    // nothing else. It used to call clone_repo unconditionally and die on a missing
    // repository; the profile now clones only when there is something to clone.
    expect(validateCreate({ profile: "bare", cloud: "hetzner" }, PROFILES, ORDERABLE).ok).toBe(true);
  });

  test("accepts a profile that declares its own", () => {
    expect(validateCreate({ profile: "claude", cloud: "hetzner" }, PROFILES, ORDERABLE).ok).toBe(true);
  });

  test("names the field that was refused", () => {
    const result = validateCreate({ profile: "claude", cloud: "aws" }, PROFILES, ORDERABLE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe("cloud");
  });

  test("refuses the whole form on one bad field", () => {
    const result = validateCreate(
      { profile: "claude", cloud: "hetzner", name: "--no-seed" },
      PROFILES,
      ORDERABLE,
    );
    expect(result.ok).toBe(false);
  });
});

describe("createArgv", () => {
  test("passes only what was given", () => {
    expect(createArgv({ profile: "claude", cloud: "hetzner" })).toEqual([
      "up",
      "--quiet",
      "--profile",
      "claude",
      "--cloud",
      "hetzner",
    ]);
  });

  test("carries every optional field under the flag devbox expects", () => {
    expect(
      createArgv({
        profile: "bare",
        cloud: "scaleway",
        name: "s2",
        cpu: 8,
        ram: 16,
        disk: 160,
        type: "DEV1-L",
      }),
    ).toEqual([
      "up",
      "--quiet",
      "--profile",
      "bare",
      "--cloud",
      "scaleway",
      "--name",
      "s2",
      "--min-cpu",
      "8",
      "--min-ram",
      "16",
      "--min-disk",
      "160",
      "--type",
      "DEV1-L",
    ]);
  });

  test("asks devbox to keep quiet, because the card it would print is not ours", () => {
    // The server's Termius card carries the server's own local forward port. A reader on
    // a phone would copy a number that forwards nothing.
    expect(createArgv({ profile: "bare", cloud: "hetzner" })).toContain("--quiet");
  });

  test("every element is a separate argument, never a joined string", () => {
    // Bun.spawn takes an argv array and no shell, so a value is never re-parsed. This
    // test exists so that a future refactor towards a single command string fails here
    // rather than in production.
    const argv = createArgv({ profile: "bare", cloud: "hetzner" });
    for (const argument of argv) {
      expect(argument).not.toContain(" ");
    }
  });
});

/**
 * The query string of /api/probe.
 *
 * Probing spends no money, and that is exactly why the temptation is to check it loosely.
 * These four values still become `--min-cpu`, `--min-ram`, `--min-disk` and `--cloud` on a
 * real invocation of a real devbox, so the difference between this and a creation is one verb,
 * not one level of care.
 */
describe("validateProbe", () => {
  test("accepts a query that names nothing at all", () => {
    // The first call the wizard makes: no floors yet, so devbox-core's template applies and
    // /api/probe says in `floors` which numbers it searched above.
    expect(validateProbe({}, NOTHING)).toEqual({ ok: true, value: {} });
  });

  test("reads the three floors as numbers, even though a query string is text", () => {
    expect(validateProbe({ cpu: "8", ram: "16", disk: "160" }, NOTHING)).toEqual({
      ok: true,
      value: { cpu: 8, ram: 16, disk: 160 },
    });
  });

  test("treats an empty parameter as absent", () => {
    // `?cpu=&ram=` is what a form with untouched fields sends, and URLSearchParams answers
    // "" for it. Read as a number that would be 0, and a floor of 0 is not a floor.
    expect(validateProbe({ cpu: "", ram: "", disk: "", cloud: "" }, NOTHING)).toEqual({
      ok: true,
      value: {},
    });
  });

  test("refuses a floor outside the bounds, naming the field", () => {
    for (const [field, value] of [
      ["cpu", LIMITS.cpu.max + 1],
      ["cpu", 0],
      ["ram", LIMITS.ram.max + 1],
      ["disk", LIMITS.disk.min - 1],
    ] as const) {
      const checked = validateProbe({ [field]: String(value) }, NOTHING);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.field).toBe(field);
    }
  });

  test("refuses a floor that is not a whole number", () => {
    for (const value of ["4.5", "quatre", "1e3x", "-", "NaN"]) {
      expect(validateProbe({ cpu: value }, NOTHING).ok).toBe(false);
    }
  });

  test("refuses a cloud this service cannot order from", () => {
    // Refused here for the reason the block above pins: the test process holds no
    // credential for any cloud, so the list it is checked against is empty - and a cloud
    // devbox-core does not implement is refused whatever anyone holds.
    for (const cloud of ["gcp", "aws", "hetzner-ish", ""]) {
      const checked = validateProbe({ cloud }, NOTHING);
      if (cloud === "") {
        expect(checked.ok).toBe(true); // absent, not wrong
        continue;
      }
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.field).toBe("cloud");
    }
  });

  test("refuses a cloud that would compose a flag", () => {
    // The allow-list is what stops `?cloud=--type` becoming an argument devbox reads as a
    // flag. Nothing here is escaped, because nothing here reaches a shell: it is refused.
    for (const cloud of ["--type", "-c", "hetzner --refresh"]) {
      expect(validateProbe({ cloud }, NOTHING).ok).toBe(false);
    }
  });

  test("stops at the first bad field rather than reporting the last", () => {
    // One field per answer, and it is the one a form can highlight.
    const checked = validateProbe({ cpu: "999", cloud: "aws" }, NOTHING);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.field).toBe("cpu");
  });
});

describe("checkedLabel", () => {
  /**
   * The only value in validate.ts that never becomes an argument, so the only one whose
   * rule is a bound rather than an allow-list. A label reaches no shell, no argv and no
   * path: refusing accents or spaces would make the field useless for the one thing it is
   * for, which is calling a machine what you call it.
   */
  test("keeps a sentence, and trims it", () => {
    expect(checkedLabel("  Le serveur d'Alice  ")).toEqual({
      ok: true,
      value: "Le serveur d'Alice",
    });
  });

  test("takes the empty string, which is how a label is removed", () => {
    expect(checkedLabel("")).toEqual({ ok: true, value: "" });
    expect(checkedLabel("   ")).toEqual({ ok: true, value: "" });
  });

  test("refuses what is not a string", () => {
    for (const value of [undefined, null, 42, {}, ["a"]]) {
      expect(checkedLabel(value).ok).toBe(false);
    }
  });

  test("refuses a label longer than the bound", () => {
    expect(checkedLabel("x".repeat(LABEL_MAX)).ok).toBe(true);
    expect(checkedLabel("x".repeat(LABEL_MAX + 1))).toEqual({
      ok: false,
      field: "label",
      reason: `longer than ${LABEL_MAX} characters`,
    });
  });

  /**
   * A label that renders as nothing while the database holds something is a row nobody can
   * find again to clear.
   */
  test("refuses control characters, which render as nothing", () => {
    for (const code of [0, 7, 13, 27, 31, 127]) {
      const verdict = checkedLabel(`a${String.fromCharCode(code)}b`);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("control characters");
    }
  });
});
