import type { Cloud } from "./config";

/**
 * Everything a browser sends that ends up as an argument to `Bun.spawn`.
 *
 * This is the file that matters most on this site. Nothing here reaches a shell (the
 * engine spawns devbox as an argv array, never through `sh -c`), so the risk is not quoting
 * but meaning: a value that survives validation becomes a real flag on a real command
 * that orders real machines. Hence bounds on every number and an allow-list for every
 * name, rather than an escaping pass.
 */

export type Invalid = { ok: false; field: string; reason: string };
export type Checked<T> = { ok: true; value: T } | Invalid;

/**
 * Names, whether of a machine, a profile or an instance type.
 *
 * The first character must be alphanumeric, and that is stricter than devbox itself, which
 * allows a leading dash. It has to be: `devbox up --name --cloud` would hand devbox a value
 * that its own argument loop reads as a flag. A dashboard must not be able to compose
 * flags out of a text field.
 */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Instance types carry dots: `e2-standard-4`, `DEV1-L`, `cx33`. */
const TYPE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Long enough for any real name, short enough to stay a hostname. */
export const NAME_MAX = 32;

/**
 * Floors, in the units devbox's flags use. Bounds, not preferences: they exist only to keep
 * a typo from ordering something absurd, and they are wide on purpose.
 */
export const LIMITS = {
  cpu: { min: 1, max: 64 },
  ram: { min: 1, max: 512 },
  disk: { min: 10, max: 2000 },
} as const;

/** C0 and DEL, built from codepoints so this file holds none of them itself. */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);

function checkedName(value: unknown, field: string): Checked<string> {
  if (typeof value !== "string") return { ok: false, field, reason: "expected a string" };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, field, reason: "empty" };
  if (trimmed.length > NAME_MAX) {
    return { ok: false, field, reason: `longer than ${NAME_MAX} characters` };
  }
  if (!NAME.test(trimmed)) {
    return {
      ok: false,
      field,
      reason: "letters, digits, dash and underscore only, starting with a letter or digit",
    };
  }
  return { ok: true, value: trimmed };
}

/** A label is read by a person, so it may be a sentence. Longer than a name, still short. */
export const LABEL_MAX = 40;

/**
 * The one value in this file that is NOT going to become an argument.
 *
 * A label is stored, returned as JSON and rendered by React, which escapes it: it reaches
 * no shell, no argv, no path and no query. So the rule is not an allow-list of characters
 * but a bound and a floor of sanity - accents, spaces and punctuation are exactly what
 * someone renaming a machine wants, and refusing them would make the field useless.
 *
 * Control characters are refused all the same. They render as nothing, and a label that
 * looks empty in the interface while the database holds something is a row nobody can find
 * again to clear. An empty string is legal and means "remove the label".
 */
export function checkedLabel(value: unknown): Checked<string> {
  if (typeof value !== "string") {
    return { ok: false, field: "label", reason: "expected a string" };
  }
  const trimmed = value.trim();
  if (trimmed.length > LABEL_MAX) {
    return { ok: false, field: "label", reason: `longer than ${LABEL_MAX} characters` };
  }
  if (CONTROL.test(trimmed)) {
    return { ok: false, field: "label", reason: "control characters" };
  }
  return { ok: true, value: trimmed };
}

export function checkedMachineName(value: unknown): Checked<string> {
  return checkedName(value, "name");
}

/** A profile is only valid if it exists: the list comes from the engine, not from here. */
export function checkedProfile(value: unknown, profiles: readonly string[]): Checked<string> {
  const name = checkedName(value, "profile");
  if (!name.ok) return name;
  if (!profiles.includes(name.value)) {
    return { ok: false, field: "profile", reason: `unknown profile: ${name.value}` };
  }
  return name;
}

/**
 * A cloud, checked against what this dashboard can order from TODAY and not against what
 * it implements.
 *
 * The two lists differ by every cloud whose credentials this service does not hold, in the
 * vault or in the fallback - see clouds() in src/secrets.ts. Validating against the wider
 * list would accept a creation the engine then refuses, which turns a field the form could
 * have greyed out into a job that dies after being written to the database.
 *
 * The list is a parameter, and a required one. It depends on WHO is asking - the account's
 * vault, and the service's credentials only when that account holds the fallback - so a
 * default could only ever have been somebody's list, and it was account 1's. The route reads
 * it fresh on every call, from the account's Sources: a token set through the page restarts
 * nothing. Not importing src/secrets.ts also keeps this file out of the import ring src/db.ts
 * describes.
 */
export function checkedCloud(value: unknown, allowed: readonly Cloud[]): Checked<Cloud> {
  if (typeof value !== "string") return { ok: false, field: "cloud", reason: "expected a string" };
  const found = allowed.find((c) => c === value);
  if (found === undefined) {
    // "expected one of" followed by nothing reads as a bug; an empty list is a service with
    // no cloud credential at all, and that is what the refusal should say.
    return {
      ok: false,
      field: "cloud",
      reason:
        allowed.length === 0
          ? "no cloud has its credentials set in this service"
          : `expected one of ${allowed.join(", ")}`,
    };
  }
  return { ok: true, value: found };
}

export function checkedFloor(value: unknown, field: "cpu" | "ram" | "disk"): Checked<number> {
  const { min, max } = LIMITS[field];
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) return { ok: false, field, reason: "expected a whole number" };
  if (n < min || n > max) {
    return { ok: false, field, reason: `expected between ${min} and ${max}` };
  }
  return { ok: true, value: n };
}

export function checkedType(value: unknown): Checked<string> {
  if (typeof value !== "string") return { ok: false, field: "type", reason: "expected a string" };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, field: "type", reason: "empty" };
  if (trimmed.length > NAME_MAX) {
    return { ok: false, field: "type", reason: `longer than ${NAME_MAX} characters` };
  }
  if (!TYPE.test(trimmed)) {
    return { ok: false, field: "type", reason: "letters, digits, dot, dash and underscore only" };
  }
  return { ok: true, value: trimmed };
}

export type CreateRequest = {
  profile: string;
  cloud: Cloud;
  name?: string;
  cpu?: number;
  ram?: number;
  disk?: number;
  type?: string;
};

/** An HTML form sends "" for an untouched field; JSON sends null or nothing at all. */
function present(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/**
 * The whole creation form, validated as one.
 *
 * An absent optional field is left out entirely rather than defaulted here: the profile
 * header already carries the defaults, and re-deciding them in a second place is how the
 * two drift apart.
 */
export function validateCreate(
  input: Record<string, unknown>,
  profiles: readonly string[],
  allowed: readonly Cloud[],
): Checked<CreateRequest> {
  const profile = checkedProfile(input.profile, profiles);
  if (!profile.ok) return profile;

  const cloud = checkedCloud(input.cloud, allowed);
  if (!cloud.ok) return cloud;

  // Phase 2 always runs here, and a request asking otherwise is refused rather than
  // ignored. devbox keeps --no-seed, which is right on a workstation: it is how you look at
  // what phase 1 left behind when a seed failed. Through the dashboard it produced a
  // machine on the meter with nothing on it and no way to finish it from a phone, the
  // page having no control for phase 2. Refusing is what keeps `devbox up --no-seed` against
  // a remote from quietly doing the opposite of what it was asked.
  // The repository is a property of the profile and not of a launch. It used to be a
  // field here, mirroring devbox's --repo, and it could name exactly one: a profile cloning
  // two repositories has no way to say so, because each one travels with ITS secret and
  // ITS host and only `clone_repo <secret> <url> [dir]` can express that. One field that
  // handles the easy half and silently cannot do the other is worse than no field.
  //
  // Refused rather than ignored, for the same reason as seed below.
  if (present(input.repo)) {
    return {
      ok: false,
      field: "repo",
      reason: "the repository belongs in the profile: add a devbox-repo line, or call clone_repo",
    };
  }

  if (input.seed === false || input.seed === "false") {
    return {
      ok: false,
      field: "seed",
      reason: "the dashboard always runs phase 2; use devbox locally for a bare machine",
    };
  }

  const request: CreateRequest = {
    profile: profile.value,
    cloud: cloud.value,
  };

  if (present(input.name)) {
    const name = checkedMachineName(input.name);
    if (!name.ok) return name;
    request.name = name.value;
  }

  for (const field of ["cpu", "ram", "disk"] as const) {
    if (!present(input[field])) continue;
    const floor = checkedFloor(input[field], field);
    if (!floor.ok) return floor;
    request[field] = floor.value;
  }

  if (present(input.type)) {
    const type = checkedType(input.type);
    if (!type.ok) return type;
    request.type = type.value;
  }

  return { ok: true, value: request };
}

export type ProbeRequest = {
  cpu?: number;
  ram?: number;
  disk?: number;
  cloud?: Cloud;
};

/**
 * The query string of /api/probe, where every field is optional.
 *
 * Optional, but checked by exactly the same rules as a creation: these four values become
 * `--min-cpu`, `--min-ram`, `--min-disk` and `--cloud` on a real devbox invocation, and the
 * only difference between probing and ordering is that one of them stops before spending
 * money. A read-only verb is not a reason to relax an allow-list - `?cloud=--type` reaching
 * an argv is the same defect whichever verb it lands on.
 *
 * Absent and empty are the same case. A URLSearchParams answers "" for `?cpu=`, which is
 * what a form with an untouched field sends, and it means "no floor of mine" rather than
 * "a floor of zero": the answer then carries devbox-core's own template, and /api/probe says
 * in `floors` which numbers it actually searched above.
 */
export function validateProbe(
  input: Record<string, unknown>,
  allowed: readonly Cloud[],
): Checked<ProbeRequest> {
  const request: ProbeRequest = {};

  for (const field of ["cpu", "ram", "disk"] as const) {
    if (!present(input[field])) continue;
    const floor = checkedFloor(input[field], field);
    if (!floor.ok) return floor;
    request[field] = floor.value;
  }

  if (present(input.cloud)) {
    const cloud = checkedCloud(input.cloud, allowed);
    if (!cloud.ok) return cloud;
    request.cloud = cloud.value;
  }

  return { ok: true, value: request };
}

/**
 * The argv devbox is spawned with. Built here, beside the validation, so that no field can
 * reach a command line without having passed through the checks above.
 */
export function createArgv(request: CreateRequest): string[] {
  // --quiet suppresses devbox's closing connection card. It would carry the SERVER's local
  // forward port, read from the server's ssh config, which is not the port the reader's
  // machine allocated: printing it advises a port that reaches nothing. The card belongs
  // to the machine page, and to `devbox` on the workstation, which each compute their own.
  const argv = ["up", "--quiet", "--profile", request.profile, "--cloud", request.cloud];
  if (request.name !== undefined) argv.push("--name", request.name);
  if (request.cpu !== undefined) argv.push("--min-cpu", String(request.cpu));
  if (request.ram !== undefined) argv.push("--min-ram", String(request.ram));
  if (request.disk !== undefined) argv.push("--min-disk", String(request.disk));
  if (request.type !== undefined) argv.push("--type", request.type);
  return argv;
}
