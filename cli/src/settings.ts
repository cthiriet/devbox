import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The same settings devbox-core resolves, resolved again here.
 *
 * This is a deliberate duplication and it is worth naming, because a second reading of
 * ~/.config/devbox is exactly the kind of thing that drifts. What it buys: the screens can
 * say *where* a profile should go, whether this workstation is pointed at a dashboard,
 * and which secrets are already on disk — before spawning anything. Asking devbox-core each
 * of those would be three subprocesses to draw one footer.
 *
 * The rule that keeps it honest: nothing here may *decide* anything. devbox-core resolves
 * its own settings on every run and remains the only thing that acts on them. If a value
 * below disagreed with the core's, the worst outcome is a footer naming the wrong
 * directory — never a machine ordered on the wrong cloud.
 */

/** The repository root: where devbox-core, profiles/ and tf/ live. Passed by the shim. */
export const HERE = process.env["DEVBOX_HOME"] ?? join(import.meta.dir, "..", "..");

export const CORE = process.env["DEVBOX_CORE"] ?? join(HERE, "devbox-core");

/** Where the Terraform roots and their state live. `TF_ROOT` in devbox-core. */
export const TF_ROOT = process.env["DEVBOX_TF_ROOT"] ?? join(HERE, "tf");

export const CONFIG_DIR = process.env["DEVBOX_CONFIG_DIR"] ?? join(homedir(), ".config", "devbox");

export const SECRETS_DIR = process.env["DEVBOX_SECRETS_DIR"] ?? join(CONFIG_DIR, "secrets");

export const CACHE_DIR = process.env["DEVBOX_CACHE_DIR"] ?? join(homedir(), ".cache", "devbox");

/**
 * DEVBOX_PROFILE, or nothing: there is no default profile since 24/09, as in devbox-core, which
 * refuses `up` and `seed` without one rather than decide what a machine is for.
 */
export const PROFILE_DEFAULT: string | null = process.env["DEVBOX_PROFILE"] || null;

/**
 * The dashboard this workstation is pointed at, or "" for the local state.
 *
 * The environment wins even when it is EMPTY — that is what keeps `DEVBOX_REMOTE= devbox ls`
 * working as the documented way back to the local state once the file exists. The file is
 * read the way the core reads it: last assignment wins, quotes stripped, trailing slash
 * dropped.
 */
export function remote(env: NodeJS.ProcessEnv = process.env): string {
  if ("DEVBOX_REMOTE" in env) return trimSlash(env["DEVBOX_REMOTE"] ?? "");

  const file = join(CONFIG_DIR, ".env");
  if (!existsSync(file)) return "";

  let found = "";
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*DEVBOX_REMOTE\s*=\s*(.*)$/.exec(line);
    if (match) found = (match[1] ?? "").replace(/["']/g, "");
  }
  return trimSlash(found);
}

function trimSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Whether there is a keyboard.
 *
 * The shim only guarantees a terminal on *stdout* — `devbox up < /dev/null` is a perfectly
 * ordinary thing to type — and Ink throws outright if a component asks for raw mode on a
 * stdin that is not a TTY. Every screen that reads a key checks this first, and the ones
 * that need an answer say so instead of crashing.
 */
export const INTERACTIVE = process.stdin.isTTY === true;

/** Where a secret is cached, by the name the profile gave it. */
export function secretPath(name: string): string {
  return join(SECRETS_DIR, name);
}
