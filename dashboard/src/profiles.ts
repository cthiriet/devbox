/**
 * A profile composed from a form, and the `.sh` it becomes.
 *
 * devbox-core reads `$CONFIG_DIR/profiles` BEFORE the engine's own, and the dashboard runs
 * the engine with `DEVBOX_CONFIG_DIR` pointing into the asking account's tree. So a file
 * written there is listed by `devbox profiles --json`, offered by /new, streamed to the
 * machine at seed, and survives a redeployment - `data/` is never in the copy. It is also
 * what makes a private profile private: the account's directory comes first, so a profile of
 * its own shadows a published one for it and for nobody else. Nothing in devbox-core changes,
 * and nothing here invents a format: what this file renders is the `# devbox-<key>:` header
 * `profile_meta` already reads and a body of calls into prelude.sh.
 *
 * That is the whole design, and it is what makes everything else free: `missing_secrets` in
 * describeProfiles, the 412 of prepareLaunch, the `used_by` line on /secrets, cmd_seed's
 * GitHub preflight and the greyed card of /new all work on a composed profile without a
 * line of their own.
 *
 * THE DATABASE IS THE AUTHORITY AND THE FILE IS THE RENDER, the same relation devbox-core
 * has with engine/devbox. A row can be re-rendered; a file cannot be un-rendered back into a
 * form. syncProfiles() at an account's first use makes the disk agree with that account's rows
 * again after a restore, or after this renderer itself has moved.
 *
 * NOTHING HERE HOLDS A SECRET VALUE. A spec names secrets; the vault holds them, sealed, and
 * prepareLaunch lays them out for one launch. A profile that carried values would put every
 * token of every machine in a table nothing seals, and in a file `devbox seed` streams.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE_DIR } from "./config";
import { authoredRow, authoredRows, deleteAuthoredRow, writeAuthoredRow, type AuthoredRow } from "./db";
import { resolved, secretsOf, software, SOFTWARE } from "./software";
import type { AccountPaths } from "./tree";
import { checkedFloor, type Checked } from "./validate";
import { checkedSecretName } from "./vault";

/* --- the spec --------------------------------------------------------------------- */

/**
 * One repository to clone. `secret` is null for a public one - and null, not "", because
 * the difference is a decision the form made rather than a field left blank.
 *
 * `dir` is only ever set on an EXTRA repository. The first one is what the header declares,
 * so devbox-core exports it as DEVBOX_REPO_URL and the prelude derives $REPO_DIR from it;
 * a first repository cloned somewhere else would leave $REPO_DIR - which the Claude Code
 * trust gate and `devbox info`'s note both point at - naming a directory that does not exist.
 */
export type ProfileRepo = { url: string; secret: string | null; dir: string | null };

export type ProfileSpec = {
  name: string;
  note: string | null;
  /** Catalogue ids, in any order: resolved() puts them back in the catalogue's. */
  software: string[];
  /**
   * The optional secrets of the chosen software that the form turned on - `github` for the
   * GitHub CLI, today. Declared, and from then on required like any other name; one left off
   * is not declared at all, and install_gh degrades as claude.sh always has. See
   * SoftwareSecret.required in src/software.ts for why "declared but optional" was a lie.
   *
   * A row stored before 13/09 has no such field, and checkedSpec reads its absence as every
   * optional secret turned on: that is what those rows rendered, and a restart must not
   * quietly take a token away from the machines they seed.
   */
  optional: string[];
  /** Names declared beyond what the software and the repositories already ask for. */
  secrets: string[];
  repos: ProfileRepo[];
  /**
   * A script of the FIRST repository, relative to its root, run last by run_setup in prelude.sh:
   * as dev, from the checkout, with sudo and /run/secrets. It is how a profile goes past the
   * catalogue without anyone depositing a file on the server - the particular part of a
   * machine lives in its owner's repository, and this field only names it.
   *
   * A row stored before 17/09 has no such field, and checkedSpec reads its absence as null:
   * what those rows rendered, byte for byte, so no restart rewrites them.
   */
  setup: string | null;
  cpu: number | null;
  ram: number | null;
  disk: number | null;
  /**
   * The ports the machine's app listens on, the first being THE app: one ssh forward each, on
   * the workstation and in Termius (`# devbox-port: 9010 5173`). A list since 24/09. A row
   * stored before has `port`, one number or null, and checkedSpec reads it as a list of one:
   * the header it renders is the same, byte for byte.
   */
  ports: number[];
};

/** What a saved profile looks like on the way out: the spec, and when it was written. */
export type Authored = { spec: ProfileSpec; created_at: number; updated_at: number };

/* --- what is refused, and why ------------------------------------------------------ */

/** C0 and DEL, built from codepoints so this file holds none of them itself. */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);

/** devbox-core's own rule for a profile name (profile_path), with a first character. */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const NAME_MAX = 32;

/**
 * An https URL on a closed character set - no quote, no space, no backtick, no `$`.
 *
 * It becomes two things at once: a single-quoted argument in the rendered `.sh`, and
 * `DEVBOX_REPO_URL='<url>'` inside the SSH command line cmd_seed builds. Neither is a place
 * to discover that a URL may hold an apostrophe.
 *
 * https only. clone_repo can hand a credential to an https host and to nothing else, so a
 * private ssh repository would need a deploy key nothing here deposits - refused by saying
 * that, rather than accepted and left to fail inside a seed.
 */
const REPO_URL = /^https:\/\/[a-zA-Z0-9.-]+(:[0-9]{1,5})?\/[a-zA-Z0-9._~/-]+$/;
const URL_MAX = 200;

/** An absolute path on the machine, same closed set, and no `..` segment to read twice. */
const REPO_DIR = /^\/[a-zA-Z0-9._/-]+$/;

/**
 * A path inside the first repository: relative, the same closed set, no empty, `.` or `..`
 * segment. It becomes a single-quoted argument to run_setup, which checks it again on the
 * machine and refuses one that resolves outside the checkout.
 */
const SETUP_PATH = /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+)*$/;

/** A note is one line of a comment header. Long enough to say something, short enough to read. */
export const NOTE_MAX = 200;

const MAX_REPOS = 10;
const MAX_SECRETS = 20;
/** One forward each, on a workstation and in Termius: a handful is the use, eight is plenty. */
const MAX_PORTS = 8;

/** Every name some entry of the catalogue asks for without requiring it: all `optional` may hold. */
const OPTIONAL_NAMES = new Set(
  SOFTWARE.flatMap((one) => one.secrets.filter((secret) => !secret.required).map((secret) => secret.name)),
);

function invalid(field: string, reason: string): Checked<never> {
  return { ok: false, field, reason };
}

/** The profiles the engine ships: a composed one may not take their name. */
export function shippedProfiles(engine: string = ENGINE_DIR): string[] {
  try {
    return readdirSync(join(engine, "profiles"))
      .filter((file) => file.endsWith(".sh"))
      .map((file) => file.slice(0, -3));
  } catch {
    return [];
  }
}

/**
 * Everything a request sends, checked as one.
 *
 * Every value that survives this becomes either a line of a comment header or a
 * single-quoted argument in a file run as ROOT on the machine. So the rule is an allow-list
 * on each field rather than an escaping pass, exactly as src/validate.ts argues for the argv
 * it guards - and render() asserts the allow-list a second time, because the day these two
 * files drift apart is the day the escape gets through.
 */
export function checkedSpec(
  name: unknown,
  input: unknown,
  shipped: readonly string[] = shippedProfiles(),
): Checked<ProfileSpec> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalid("spec", "expected a JSON object");
  }
  const body = input as Record<string, unknown>;

  if (typeof name !== "string") return invalid("name", "expected a string");
  if (name === "") return invalid("name", "empty");
  if (name.length > NAME_MAX) return invalid("name", `longer than ${NAME_MAX} characters`);
  if (!NAME.test(name)) {
    return invalid(
      "name",
      "letters, digits, dash and underscore only, starting with a letter or digit",
    );
  }
  // A name the engine ships would be SHADOWED rather than refused by devbox-core, since
  // $CONFIG_DIR comes first in PROFILE_DIRS: `claude` composed here would silently replace
  // the published one for every order and every seed, on the page and on the CLI alike.
  if (shipped.includes(name)) {
    return invalid("name", `${name} is a published profile: composing one under that name would shadow it`);
  }

  let note: string | null = null;
  if (body.note !== undefined && body.note !== null && body.note !== "") {
    if (typeof body.note !== "string") return invalid("note", "expected a string");
    const trimmed = body.note.trim();
    if (trimmed.length > NOTE_MAX) return invalid("note", `longer than ${NOTE_MAX} characters`);
    // A note is ONE comment line. A newline in it would open a second line inside the
    // header, and a header is not decoration: `# devbox-repo:` written twice makes
    // profile_path refuse the whole profile, and a forged `# devbox-secrets:` would declare
    // a name nobody asked for and push whatever this service holds under it into a machine.
    if (CONTROL.test(trimmed)) return invalid("note", "one line, without control characters");
    if (trimmed !== "") note = trimmed;
  }

  if (!Array.isArray(body.software)) return invalid("software", "expected an array of ids");
  const chosen: string[] = [];
  for (const id of body.software) {
    if (typeof id !== "string" || software(id) === undefined) {
      return invalid("software", `unknown software: ${JSON.stringify(id)}`);
    }
    if (!chosen.includes(id)) chosen.push(id);
  }

  // The optional secrets the chosen software may use. A name outside the catalogue's optional
  // ones is refused, like an unknown software id: this list is a whitelist, and it reaches
  // the header. One the chosen software does not ask for - gh unticked after its token was
  // turned on - is dropped rather than refused: the form keeps the switch, the profile does
  // not declare what nothing installed will read.
  const offered = secretsOf(chosen)
    .filter((secret) => !secret.required)
    .map((secret) => secret.name);
  let optional: string[];
  if (body.optional === undefined || body.optional === null) {
    // A row written before the field existed, or a page from before it: what it rendered then.
    optional = offered;
  } else {
    if (!Array.isArray(body.optional)) return invalid("optional", "expected an array of names");
    optional = [];
    for (const raw of body.optional) {
      if (typeof raw !== "string" || !OPTIONAL_NAMES.has(raw)) {
        return invalid("optional", `not an optional secret of the catalogue: ${JSON.stringify(raw)}`);
      }
      if (offered.includes(raw) && !optional.includes(raw)) optional.push(raw);
    }
  }

  if (!Array.isArray(body.repos)) return invalid("repos", "expected an array");
  if (body.repos.length > MAX_REPOS) return invalid("repos", `more than ${MAX_REPOS}`);
  const repos: ProfileRepo[] = [];
  for (const [index, raw] of body.repos.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return invalid("repos", `repository ${index + 1}: expected an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.url !== "string") return invalid("repos", `repository ${index + 1}: expected a url`);
    const url = entry.url.trim();
    if (url.length > URL_MAX) return invalid("repos", `repository ${index + 1}: longer than ${URL_MAX} characters`);
    if (!REPO_URL.test(url)) {
      // Two refusals, not one: "this is not https" and "this is not a url" send a reader to
      // two different places, and one sentence covering both sends them to neither.
      return invalid(
        "repos",
        url.startsWith("https://")
          ? `repository ${index + 1}: letters, digits, dot, dash, underscore, tilde and slash only — a url becomes a shell word here, and this one carries something else`
          : `repository ${index + 1}: expected https://host/path. clone_repo can hand a credential to an https host and to nothing else, so a private ssh url would need a deploy key this service does not deposit`,
      );
    }

    let secret: string | null = null;
    if (entry.secret !== undefined && entry.secret !== null && entry.secret !== "") {
      const checked = checkedSecretName("profile", entry.secret);
      if (!checked.ok) return invalid("repos", `repository ${index + 1}: ${checked.reason}`);
      secret = checked.value;
    }

    let dir: string | null = null;
    if (entry.dir !== undefined && entry.dir !== null && entry.dir !== "") {
      if (typeof entry.dir !== "string") return invalid("repos", `repository ${index + 1}: expected a path`);
      const path = entry.dir.trim();
      if (path.length > URL_MAX) return invalid("repos", `repository ${index + 1}: path longer than ${URL_MAX} characters`);
      if (!REPO_DIR.test(path) || path.split("/").includes("..")) {
        return invalid("repos", `repository ${index + 1}: expected an absolute path, letters, digits, dot, dash and slash`);
      }
      // See ProfileRepo: the first repository is the header's, and $REPO_DIR is derived
      // from its url. Cloning it elsewhere would leave every reader of $REPO_DIR - the
      // trust gate, the note, the profile's own echo - pointing at nothing.
      if (index === 0) {
        return invalid("repos", "the first repository is the one the header declares: it is cloned at /workspace/<name>, which is what $REPO_DIR names");
      }
      dir = path;
    }

    repos.push({ url, secret, dir });
  }

  let setup: string | null = null;
  if (body.setup !== undefined && body.setup !== null && body.setup !== "") {
    if (typeof body.setup !== "string") return invalid("setup", "expected a path");
    // `./scripts/x.sh` is how a path inside a repository is usually typed, and it names the
    // same file: the prefix goes, once, rather than a refusal over two characters.
    const path = body.setup.trim().replace(/^\.\//, "");
    if (path.length > URL_MAX) return invalid("setup", `longer than ${URL_MAX} characters`);
    if (
      !SETUP_PATH.test(path) ||
      path.split("/").some((segment) => segment === "." || segment === "..")
    ) {
      return invalid(
        "setup",
        "expected a path inside the repository, like scripts/devbox-setup.sh: letters, digits, dot, dash, underscore and slash, without .. or a leading /",
      );
    }
    // Read from the first repository, whose checkout is $REPO_DIR: without one there is no
    // directory to read it from, and the seed would die on it minutes after the order.
    if (repos.length === 0) {
      return invalid("setup", "a setup script is read from the profile's repository: add one first");
    }
    setup = path;
  }

  if (!Array.isArray(body.secrets)) return invalid("secrets", "expected an array of names");
  if (body.secrets.length > MAX_SECRETS) return invalid("secrets", `more than ${MAX_SECRETS}`);
  const extra: string[] = [];
  for (const raw of body.secrets) {
    const checked = checkedSecretName("profile", raw);
    if (!checked.ok) return invalid("secrets", checked.reason);
    if (!extra.includes(checked.value)) extra.push(checked.value);
  }

  const floors: { cpu: number | null; ram: number | null; disk: number | null } = {
    cpu: null,
    ram: null,
    disk: null,
  };
  for (const field of ["cpu", "ram", "disk"] as const) {
    const value = body[field];
    if (value === undefined || value === null || value === "") continue;
    const checked = checkedFloor(value, field);
    if (!checked.ok) return checked;
    floors[field] = checked.value;
  }

  // `ports`, or the `port` of a row stored before the list. Each becomes a LocalForward line
  // on a workstation, where ssh refuses the ENTIRE config on a bad one, so each is checked
  // here and again by devbox-core.
  const given =
    body.ports !== undefined && body.ports !== null
      ? body.ports
      : body.port !== undefined && body.port !== null && body.port !== ""
        ? [body.port]
        : [];
  if (!Array.isArray(given)) return invalid("ports", "expected a list of ports");
  if (given.length > MAX_PORTS) return invalid("ports", `more than ${MAX_PORTS}`);
  const ports: number[] = [];
  for (const raw of given) {
    const n = typeof raw === "number" ? raw : typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return invalid("ports", "expected whole numbers between 1 and 65535");
    }
    if (!ports.includes(n)) ports.push(n);
  }

  return {
    ok: true,
    value: { name, note, software: chosen, optional, secrets: extra, repos, setup, ...floors, ports },
  };
}

/* --- what the profile declares ----------------------------------------------------- */

/**
 * Every secret name the header will carry: what the software requires, the optional ones
 * the form turned on, what the repositories clone with, and what was added by hand. Sorted,
 * so two saves of the same profile render the same file.
 */
export function declaredSecrets(spec: ProfileSpec): string[] {
  const names = new Set<string>();
  for (const secret of secretsOf(spec.software)) {
    if (secret.required || spec.optional.includes(secret.name)) names.add(secret.name);
  }
  for (const repo of spec.repos) if (repo.secret !== null) names.add(repo.secret);
  for (const name of spec.secrets) names.add(name);
  return [...names].sort();
}

/**
 * Those the seed cannot start without: a required software secret, or the credential of a
 * private repository. They become one `require_secrets` at the top of the profile, which
 * is the difference between a seed that fails in two seconds and one that fails five
 * minutes in, on a machine already ordered and already billing.
 *
 * An optional one stays out even when turned on. It is declared, so a launch without it is
 * refused with a 412 before anything is ordered; but `install_gh` checks for
 * /run/secrets/github itself and degrades, exactly as profiles/claude.sh has always done, and
 * a `devbox seed` run by hand past that refusal still yields a machine.
 */
export function requiredSecrets(spec: ProfileSpec): string[] {
  const names = new Set<string>();
  for (const secret of secretsOf(spec.software)) if (secret.required) names.add(secret.name);
  for (const repo of spec.repos) if (repo.secret !== null) names.add(repo.secret);
  return [...names].sort();
}

/* --- the render --------------------------------------------------------------------- */

/**
 * The first line after the shebang, and the only thing that tells this service which files
 * in that directory are its own.
 *
 * The same directory is where a real deployment deposits the profiles it writes by hand -
 * docs/deploy.md says so, and they are the ones that name what this repository may not. So a
 * save refuses a file that does not carry this line, and a delete removes nothing else.
 *
 * Deliberately NOT shaped like `# devbox-<key>:`: profile_path refuses a header key that
 * appears twice, and a marker that looked like one would join that count for no reason.
 */
export const SENTINEL = "# devbox dashboard: composed profile, rewritten whole at each save.";

/**
 * A value on its way into single quotes. Nothing should ever reach here that checkedSpec
 * did not already clear - which is exactly why it throws rather than escapes: an escape
 * would let a field the validator stopped guarding pass silently, and this file writes a
 * script that runs as root on the machine.
 */
function quoted(value: string): string {
  if (value.includes("'") || CONTROL.test(value)) {
    throw new Error("a composed profile may not carry a quote or a control character");
  }
  return `'${value}'`;
}

/**
 * A header line's value. One line, always: a newline would open a second line inside the
 * header, and a header is read by `profile_meta` rather than looked at.
 */
function header(value: string): string {
  if (CONTROL.test(value)) {
    throw new Error("a composed profile's header may not carry a control character");
  }
  return value;
}

/**
 * A header value that is ALSO going to be a shell word, which is only the repository url.
 *
 * `# devbox-repo:` is not just a comment: cmd_seed reads it back and spends it as
 * `sudo env DEVBOX_REPO_URL='<url>' /usr/local/bin/devbox-profile.sh` inside the command it
 * sends over SSH. A quote there closes that assignment and everything after it runs as root
 * on the machine. Measured here rather than discovered there: the first version of this file
 * checked the quote on the arguments and not on the header, and a url carrying one came out
 * of the renderer intact.
 */
function headerWord(value: string): string {
  if (value.includes("'")) {
    throw new Error("a composed profile's repository url may not carry a quote");
  }
  return header(value);
}

/**
 * The file, whole. Deterministic for a given spec and date: syncProfiles compares what is on
 * disk with what this returns, so anything that varied between two calls - a timestamp taken
 * here, a Set iterated in insertion order - would make every start rewrite every profile.
 */
export function renderProfile(spec: ProfileSpec, updatedAt: number): string {
  const lines: string[] = ["#!/bin/bash", SENTINEL];
  lines.push(
    `# Composed on the dashboard, last saved ${new Date(updatedAt).toISOString().slice(0, 10)}.`,
    "# Edit it there: a save rewrites this file entirely, and an edit made here is lost at the",
    "# next one. A profile of your own that nothing overwrites is a file in this directory",
    "# WITHOUT the line above.",
    "#",
  );

  const first = spec.repos[0];
  if (first !== undefined) lines.push(`# devbox-repo:     ${headerWord(first.url)}`);
  const declared = declaredSecrets(spec);
  if (declared.length > 0) lines.push(`# devbox-secrets:  ${header(declared.join(" "))}`);
  if (spec.cpu !== null) lines.push(`# devbox-min-cpu:  ${spec.cpu}`);
  if (spec.ram !== null) lines.push(`# devbox-min-ram:  ${spec.ram}`);
  if (spec.disk !== null) lines.push(`# devbox-min-disk: ${spec.disk}`);
  if (spec.ports.length > 0) lines.push(`# devbox-port:     ${spec.ports.join(" ")}`);
  if (spec.note !== null) lines.push(`# devbox-note:     ${header(spec.note)}`);

  lines.push("set -euxo pipefail", ". /usr/local/lib/devbox/prelude.sh");

  // One paragraph per step, joined at the end: a blank line between sections and never two,
  // whichever sections a spec happens to have.
  const sections: string[][] = [];

  const required = requiredSecrets(spec);
  if (required.length > 0) {
    sections.push([
      "# Before anything is downloaded: a seed that cannot finish must fail here rather than",
      "# five minutes in, on a machine that is already ordered and already billing.",
      `require_secrets ${required.map(quoted).join(" ")}`,
    ]);
  }

  const chosen = resolved(spec.software);
  // What downloads comes first and the repositories last, which is the order
  // profiles/claude.sh settled on - except for the agents, which want $REPO_DIR to exist:
  // Claude Code's trust gate is written for the directory the clone left behind.
  for (const one of chosen.filter((entry) => !entry.afterRepos)) {
    sections.push([`step ${quoted(one.step)}`, ...one.install]);
  }

  if (spec.repos.length > 0) {
    const clones = [`step ${quoted(spec.repos.length === 1 ? "repository" : "repositories")}`];
    for (const [index, repo] of spec.repos.entries()) {
      // An empty first argument is how clone_repo is told this one is public - see the
      // `${1-github}` in prelude.sh. The first repository takes its url and its directory
      // from the header, so $REPO_DIR names what was cloned.
      const secret = quoted(repo.secret ?? "");
      if (index === 0) clones.push(`clone_repo ${secret}`);
      else if (repo.dir === null) clones.push(`clone_repo ${secret} ${quoted(repo.url)}`);
      else clones.push(`clone_repo ${secret} ${quoted(repo.url)} ${quoted(repo.dir)}`);
    }
    sections.push(clones);
  }

  for (const one of chosen.filter((entry) => entry.afterRepos)) {
    sections.push([`step ${quoted(one.step)}`, ...one.install]);
  }

  // Last, after every tool and every clone: the owner's script may use any of them.
  if (spec.setup !== null) {
    if (!SETUP_PATH.test(spec.setup) || spec.setup.split("/").includes("..")) {
      throw new Error("a composed profile's setup script must be a path inside its repository");
    }
    sections.push([`step ${quoted("setup script")}`, `run_setup ${quoted(spec.setup)}`]);
  }

  sections.push([`step ${quoted("done")}`]);
  for (const section of sections) lines.push("", ...section);
  return `${lines.join("\n")}\n`;
}

/* --- the file ----------------------------------------------------------------------- */

/**
 * WHICH DIRECTORY IS ALWAYS SAID, and there is no default left anywhere in this file.
 *
 * There used to be one constant, DATA_DIR/config/profiles, and every function here fell back
 * to it. Since 12/09 a profile directory belongs to an account - accountTree(id).profilesDir -
 * and a default would have gone on answering for account 1 in silence: one account's form
 * opening on another's spec, or a save refused because a THIRD account had a file of that
 * name. The callers name it, and `tsc` asks them to.
 */
/**
 * Whether a string can be a profile's name at all: devbox-core's charset, and a length.
 *
 * Exported for the routes that take a name straight from the URL. Measured on 13/09 by the
 * cross-account review: `DELETE /api/profiles/:name` checked nothing but emptiness, Bun
 * decodes `%2f` inside a path parameter, and `..%2f..%2f..%2f2%2fconfig%2fprofiles%2fvictim`
 * climbed out of account 1's directory into account 2's and removed its rendered profile. The
 * row survived - its query is bound and scoped - but the file did not, and nothing renders it
 * again before a restart.
 */
export function isProfileName(name: string): boolean {
  return name.length <= NAME_MAX && NAME.test(name);
}

/**
 * The one place a profile's file name is formed, and it refuses rather than joins.
 *
 * A second lock on the door the route already shuts: the next caller to hand this a name from
 * a request would otherwise reopen the traversal above, and `join` normalises `..` without a
 * word.
 */
const pathOf = (name: string, dir: string) => {
  if (!isProfileName(name)) throw new Error(`not a profile name: ${JSON.stringify(name)}`);
  return join(dir, `${name}.sh`);
};

/** Whether this service wrote it: the sentinel, on the second line, and nowhere else. */
export function isAuthored(path: string): boolean {
  try {
    return readFileSync(path, "utf8").split("\n")[1] === SENTINEL;
  } catch {
    return false;
  }
}

/** A file of that name in the directory that this service did NOT write. */
export function strangerAt(name: string, dir: string): boolean {
  const path = pathOf(name, dir);
  return existsSync(path) && !isAuthored(path);
}

/**
 * Written whole, through a temporary name in the same directory and a rename: devbox-core
 * may be reading this very file for another job, and a rename is the only way it either
 * sees the old one or the new one and never half of either.
 *
 * 0600, and the directory is 0700: the file names repositories and secret names, which is
 * exactly what this repository keeps out of itself.
 */
export function writeAuthored(spec: ProfileSpec, updatedAt: number, dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = renderProfile(spec, updatedAt);
  const temporary = join(dir, `.${spec.name}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, body, { mode: 0o600 });
    renameSync(temporary, pathOf(spec.name, dir));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return body;
}

/** Removes the rendered file, and only one this service wrote. */
export function removeAuthored(name: string, dir: string): boolean {
  const path = pathOf(name, dir);
  if (!existsSync(path) || !isAuthored(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function renderedAt(name: string, dir: string): string | null {
  try {
    return readFileSync(pathOf(name, dir), "utf8");
  } catch {
    return null;
  }
}

export type Sync = { written: string[]; kept: string[] };

/**
 * The disk made to agree with the table, once per process, for one account: accountTree hands
 * it that account's rows and that account's directory, and nothing else.
 *
 * The table is the authority and the file is its render, so a data directory restored from a
 * backup, a file removed by hand, or this renderer itself having moved, all converge here
 * rather than at the next order - where the difference would show as a machine provisioned
 * by a profile nobody can read any more.
 *
 * A file that is NOT this service's is left alone and named: the row loses to it, because
 * devbox-core would read that file and because overwriting it is the one thing the sentinel
 * exists to prevent.
 */
export function syncProfiles(rows: readonly Authored[], dir: string): Sync {
  const written: string[] = [];
  const kept: string[] = [];
  for (const row of rows) {
    const path = pathOf(row.spec.name, dir);
    if (existsSync(path) && !isAuthored(path)) {
      kept.push(row.spec.name);
      continue;
    }
    let current: string | null = null;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = null;
    }
    if (current === renderProfile(row.spec, row.updated_at)) continue;
    writeAuthored(row.spec, row.updated_at, dir);
    written.push(row.spec.name);
  }
  return { written, kept };
}

/* --- the table, read as specs -------------------------------------------------- */

/**
 * A stored row, parsed and checked again on the way out.
 *
 * Checked AGAIN, and not out of suspicion of the database: the rules in this file are
 * allowed to tighten, and a row written under a looser one must not be rendered into a
 * script on the strength of having once been acceptable. A row that no longer passes is
 * SKIPPED and named - never thrown on - because the callers are a listing and a startup
 * sync, and one unreadable row taking the fleet page, or the service, down with it is the
 * failure mode this whole file is written against.
 */
export function storedProfiles(account: number): { rows: Authored[]; unreadable: string[] } {
  const rows: Authored[] = [];
  const unreadable: string[] = [];
  for (const row of authoredRows(account)) {
    const parsed = parseRow(row);
    if (parsed === null) unreadable.push(row.name);
    else rows.push(parsed);
  }
  return { rows, unreadable };
}

export function storedProfile(account: number, name: string): Authored | null {
  const row = authoredRow(account, name);
  return row === null ? null : parseRow(row);
}

function parseRow(row: AuthoredRow): Authored | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.spec);
  } catch {
    return null;
  }
  const checked = checkedSpec(row.name, parsed);
  if (!checked.ok) return null;
  return { spec: checked.value, created_at: row.created_at, updated_at: row.updated_at };
}

/**
 * The row, then the file, in that order: the table is the authority, so a crash between the
 * two leaves a profile that syncProfiles renders at the next start. The other order would
 * leave a file no form can edit.
 *
 * The account and the directory come out of ONE AccountPaths, and that is the point of taking
 * one: a row stored under one account and rendered into another's directory would be a profile
 * the first account can edit and the second one runs.
 */
export function storeProfile(
  paths: AccountPaths,
  spec: ProfileSpec,
  now: number,
): { saved: Authored; script: string } {
  writeAuthoredRow(paths.account, spec.name, JSON.stringify(spec), now);
  const saved = storedProfile(paths.account, spec.name);
  if (saved === null) throw new Error("the profile could not be recorded");
  const script = writeAuthored(saved.spec, saved.updated_at, paths.profilesDir);
  return { saved, script };
}

/** The row, then the file - and the file only if this service wrote it. Same pairing as above. */
export function forgetProfile(paths: AccountPaths, name: string): { deleted: boolean; removed: boolean } {
  const deleted = deleteAuthoredRow(paths.account, name);
  return { deleted, removed: removeAuthored(name, paths.profilesDir) };
}
