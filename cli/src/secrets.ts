import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { has, stringFlag, type Parsed } from "./args.ts";
import { coreJson } from "./core.ts";
import { PROFILE_DEFAULT, remote, SECRETS_DIR, secretPath } from "./settings.ts";
import type { Machine, Profile } from "./types.ts";

/**
 * The tokens a run will need, asked for before the run starts.
 *
 * devbox-core prompts with `read -rs` for two things: a profile's secrets, and the dashboard
 * token. Both prompts are unusable underneath Ink — the terminal is in raw mode and every
 * keystroke is already being consumed up here — so the core is spawned with stdin closed
 * and the values are put on disk first, in the same files and with the same permissions
 * the core itself would have written.
 *
 * That means predicting what the core is about to want, which is duplication, and the
 * risk is real: predict wrong and the core dies on an empty read. Two things bound it.
 * The prediction reads the same sources the core reads — `profiles --json` for the secret
 * names, the machine's recorded profile for a re-seed — and a prompt that happens anyway
 * is *detected* rather than ignored (see src/ui/Run.tsx), so the failure names the missing
 * secret instead of reading as a mysterious exit.
 */

/** A secret already answered: cached on disk, or handed over by the environment. */
export function held(name: string): boolean {
  if (envValue(name)) return true;
  try {
    return statSync(secretPath(name)).size > 0;
  } catch {
    return false;
  }
}

/**
 * The environment variable the core reads for a given secret.
 *
 * `DEVBOX_<NAME>_TOKEN`, uppercased with dashes turned into underscores — the core builds the
 * same name with `tr 'a-z-' 'A-Z_'`. The dashboard token is the exception, and is spelled
 * DEVBOX_REMOTE_TOKEN.
 */
export function envName(name: string): string {
  if (name === "remote") return "DEVBOX_REMOTE_TOKEN";
  return `DEVBOX_${name.toUpperCase().replace(/-/g, "_")}_TOKEN`;
}

function envValue(name: string): string {
  return process.env[envName(name)] ?? "";
}

/**
 * Written the way `secret_value` writes it: 0700 directory, 0600 file, no trailing
 * newline. A newline would be sent to /run/secrets and every consumer would carry it into
 * an Authorization header.
 */
export function store(name: string, value: string): void {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(secretPath(name), value, { mode: 0o600 });
}

/** What this invocation is going to be asked for, in the order it will be asked. */
export async function needed(parsed: Parsed): Promise<string[]> {
  // The dashboard token is NOT here. Every verb needs it when DEVBOX_REMOTE is set, `ls`
  // included, so it is asked for by src/ui/Gate.tsx in front of every screen rather than
  // by the two that happen to run something.
  if (parsed.command !== "up" && parsed.command !== "seed") return [];

  // The secrets stay on the server when the dashboard is the executor: with it seeding,
  // this workstation has no reason to hold a Claude or a GitHub token at all.
  if (remote() !== "") return [];

  const names = await profileSecrets(parsed);
  return names.filter((name, index) => names.indexOf(name) === index);
}

/** Of those, the ones nothing has answered yet. */
export async function missing(parsed: Parsed): Promise<string[]> {
  return (await needed(parsed)).filter((name) => !held(name));
}

/**
 * The secret names of the profile this run will use.
 *
 * `up --no-seed` stops at the machine and needs none. A `seed` with no --profile
 * re-uses the profile the machine was provisioned with, exactly as the core does: seeding
 * a `claude` machine as `opencode` because a flag was forgotten would be a silent swap,
 * and asking for the wrong tokens is how that swap would first show. With no profile named
 * at all, nothing is predicted: the core refuses with its own sentence.
 */
async function profileSecrets(parsed: Parsed): Promise<string[]> {
  if (parsed.command === "up" && has(parsed, "--no-seed")) return [];

  let wanted = stringFlag(parsed, "--profile");

  if (!wanted && parsed.command === "seed") {
    // A re-seed with no --profile re-uses the profile the machine was provisioned with,
    // and that is only knowable once the machine is. When it is not — no machine, or
    // several and no name — nothing is predicted at all: the core is about to refuse to
    // guess, and "the secret 'claude' is missing" is a worse thing to say first than
    // "name one of them". Falling back to the default profile here would ask for the
    // tokens of a machine that may not even have that profile.
    const recorded = await recordedProfile(parsed.positionals[0]);
    if (recorded === null) return [];
    wanted = recorded;
  }
  wanted = wanted ?? PROFILE_DEFAULT ?? undefined;
  if (!wanted) return [];

  try {
    const profiles = await coreJson<Profile[]>(["profiles"], 30_000);
    return profiles.find((profile) => profile.name === wanted)?.secrets ?? [];
  } catch {
    // A profile directory that cannot be read is the core's problem to report, with its
    // own message. Asking for nothing here simply lets it get that far.
    return [];
  }
}

/** What ~/.ssh/config records for a machine, which is where `profile_of` reads it too. */
async function recordedProfile(name: string | undefined): Promise<string | null> {
  try {
    const machines = await coreJson<Machine[]>(["ls"], 60_000);
    // With one machine there is nothing to disambiguate; with several and no name, the
    // core will refuse rather than guess, so there is nothing to predict either.
    const machine = name ? machines.find((m) => m.name === name) : machines[0];
    return machines.length === 1 || name ? (machine?.profile ?? null) : null;
  } catch {
    return null;
  }
}
