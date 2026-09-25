/**
 * The command line, read twice.
 *
 * devbox-core parses its own flags and remains the authority on them: whatever this file
 * fails to understand is forwarded verbatim, so an unknown flag produces the core's error
 * and not a second one invented here. What is parsed is only what a *screen* needs to
 * draw itself — the floors `probe` prints under its table, the `--all` that lifts the
 * twelve-row cap, the machine name a confirmation has to repeat back.
 *
 * The consequence worth stating: this parser must never reject anything. It has no
 * opinion about correctness, only about what it recognises.
 */

/** Flags that swallow the next argument. Anything else is a switch or a positional. */
const TAKES_VALUE = new Set([
  "--cloud",
  "--name",
  "--profile",
  "--repo",
  "--type",
  "--min-cpu",
  "--cpu",
  "--min-ram",
  "--ram",
  "--min-disk",
  "--disk",
  "--port",
  "--kube",
]);

export type Parsed = {
  /** The verb, or "" when there was none. */
  command: string;
  /** Everything after the verb, untouched, for forwarding to devbox-core. */
  rest: string[];
  /** What this layer recognised. A switch maps to `true`. */
  flags: Map<string, string | true>;
  /** Bare words after the verb: in practice, a machine name. */
  positionals: string[];
};

export function parse(argv: string[]): Parsed {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index++) {
    const token = rest[index] ?? "";
    if (token === "") continue;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (TAKES_VALUE.has(token)) {
      flags.set(token, rest[index + 1] ?? "");
      index++;
      continue;
    }
    flags.set(token, true);
  }

  return { command, rest, flags, positionals };
}

/** A numeric flag under any of its spellings, or the environment, or the built-in floor. */
export function numberFlag(
  parsed: Parsed,
  names: string[],
  envName: string,
  fallback: number,
): number {
  for (const name of names) {
    const value = parsed.flags.get(name);
    if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  const fromEnv = process.env[envName];
  if (fromEnv && Number.isFinite(Number(fromEnv))) return Number(fromEnv);
  return fallback;
}

export function has(parsed: Parsed, ...names: string[]): boolean {
  return names.some((name) => parsed.flags.has(name));
}

export function stringFlag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}
