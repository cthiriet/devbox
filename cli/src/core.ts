import { CORE } from "./settings.ts";

/**
 * Running devbox-core, and reading what it answers.
 *
 * devbox-core is the executor and this file is the only door to it. Nothing above composes a
 * command line: every function here takes an argv array and `Bun.spawn` takes no shell,
 * so a machine name or a profile never has to be escaped.
 *
 * **stdin is always closed.** The core prompts for exactly two things — a profile's
 * secrets and the dashboard token — and both are resolved up here before it is spawned
 * (see src/secrets.ts), because Ink holds the terminal in raw mode and a `read -rs` inside
 * a child would read the keystrokes Ink is already consuming. Closing stdin turns a
 * prompt we somehow failed to anticipate into an immediate, legible failure instead of a
 * terminal that has silently stopped echoing.
 */

/** What the core wrote and how it left. */
export type CoreResult = { code: number; stdout: string; stderr: string };

export class CoreError extends Error {
  constructor(
    readonly argv: string[],
    readonly code: number,
    readonly detail: string,
  ) {
    super(detail || `devbox ${argv.join(" ")} exited ${code}`);
    this.name = "CoreError";
  }
}

/**
 * Terminal colour, as the core emits it, removed.
 *
 * The core writes for a terminal it believes it owns: `log` is cyan, `warn` yellow, `die`
 * red. Ink re-colours every line it renders, so leaving the original escapes in would
 * nest one colour inside another and, worse, make the `==>` prefix unmatchable.
 */
export function stripAnsi(line: string): string {
  return line.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
}

export async function coreRunToEnd(argv: string[], timeoutMs = 120_000): Promise<CoreResult> {
  const child = Bun.spawn([CORE, ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A read-only verb that answers JSON.
 *
 * `--json` is the contract these screens are built on, and it is the core's contract
 * rather than this layer's: the dashboard consumes the same five verbs. A screen here
 * therefore never parses a table that was aligned for a human — if a column is missing
 * from the JSON, the fix belongs in devbox-core.
 */
export async function coreJson<T>(argv: string[], timeoutMs?: number): Promise<T> {
  const result = await coreJsonDetailed<T>(argv, timeoutMs);
  noticed(result.stderr);
  return result.data;
}

/**
 * What the core warned about on the way, kept for a screen to show.
 *
 * coreJson throws stderr away, which is right for everything the core says about its own
 * progress and wrong for exactly one thing: the version gate. Its warning — that the
 * dashboard is not running this core — would be invisible on `ls`, `info`, `profiles` and
 * `orphans`, the four verbs typed most, and an invisible warning renders exactly like
 * agreement. That is the failure the gate exists to remove, reintroduced one layer up.
 *
 * Probe already reads stderr back for a neighbouring reason, through coreJsonDetailed;
 * this is that idea with one mount point instead of one per screen. The streaming verbs
 * are untouched: Run.tsx reads both streams itself, and collection happens in coreJson
 * rather than in coreStream, so nothing is rendered twice.
 */
/** Exactly what devbox-core's `warn` prints, once stripAnsi has taken the colour off. */
const WARNED = /^\/!\\ (.*)$/;

const seen = new Set<string>();
// A NEW array on change and the SAME one otherwise: useSyncExternalStore re-renders
// forever if getSnapshot hands back a fresh object every call.
let snapshot: readonly string[] = [];
const listeners = new Set<() => void>();

export function noticed(stderr: string): void {
  let fresh = false;
  for (const line of stripAnsi(stderr).split("\n")) {
    const warned = WARNED.exec(line.trimEnd());
    const text = warned?.[1]?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    fresh = true;
  }
  if (!fresh) return;
  snapshot = [...seen];
  for (const listener of listeners) listener();
}

export function subscribeNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNotices(): readonly string[] {
  return snapshot;
}

/**
 * Claimed by a screen that is drawing this line itself.
 *
 * `devbox down` spawns the core twice in one invocation — once through coreJson to name the
 * machine a confirmation has to repeat back, once through coreStream for the run — and
 * both children are remote verbs, so both emit the gate's warning. Run.tsx already draws
 * every warn it reads off the stream, so it takes those lines out of the store rather
 * than letting Notices draw them a second time underneath its own log.
 */
export function claimNotice(text: string): void {
  if (!seen.delete(text)) return;
  snapshot = [...seen];
  for (const listener of listeners) listener();
}

/**
 * The same read, keeping what the core wrote to stderr on the way.
 *
 * Only `probe` needs it. Its JSON is an array of offers and nothing else — that array is
 * the contract, and a cloud that could not be asked has no row to appear in — so devbox-core
 * names the skipped clouds on stderr instead. Reading it back here is what stops one
 * unconfigured provider from silently looking like an expensive market.
 */
export async function coreJsonDetailed<T>(
  argv: string[],
  timeoutMs?: number,
): Promise<{ data: T; stderr: string }> {
  const result = await coreRunToEnd([...argv, "--json"], timeoutMs);
  if (result.code !== 0) {
    throw new CoreError(argv, result.code, verdictOf(result.stderr));
  }
  try {
    return { data: JSON.parse(result.stdout) as T, stderr: stripAnsi(result.stderr) };
  } catch {
    throw new CoreError(
      argv,
      0,
      `devbox ${argv.join(" ")} did not answer JSON:\n${result.stdout.slice(0, 400)}`,
    );
  }
}

/**
 * What a failure was about, with the warnings lifted out of it.
 *
 * Failure renders line 0 as the verdict in red and everything after it as that verdict's
 * advice. A warning printed before the `x` line therefore stole the headline: a dashboard
 * that refused the token showed "runs core 7e2a1c9, this file is 1108254" as the error,
 * and the 401 that actually stopped the command as a dim footnote under it. The warnings
 * are collected here instead, so Notices draws them and the verdict stays the verdict.
 */
function verdictOf(stderr: string): string {
  const clean = stripAnsi(stderr);
  noticed(clean);
  return clean
    .split("\n")
    .filter((line) => !WARNED.test(line.trimEnd()))
    .join("\n")
    .trim();
}

/** One line of the core's output, and which stream it came from. */
export type CoreLine = { stream: "out" | "err"; text: string };

/**
 * The core, streamed line by line while it runs.
 *
 * Both streams are read concurrently and tagged rather than merged into one pipe: `warn`
 * and `die` go to stderr, and a screen that cannot tell them from ordinary progress would
 * have to guess at the wording. Interleaving between the two is therefore approximate,
 * which is the price, and it costs nothing here because the ordering that matters —
 * within stdout — is preserved exactly.
 */
export function coreStream(
  argv: string[],
  onLine: (line: CoreLine) => void,
): { done: Promise<number>; kill: () => void } {
  const child = Bun.spawn([CORE, ...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const pump = async (stream: ReadableStream<Uint8Array>, tag: "out" | "err") => {
    const decoder = new TextDecoder();
    // A chunk boundary is not a line boundary, and the dashboard's log follower makes
    // that routine: `remote_follow` prints whatever a poll returned, which cuts lines in
    // half about as often as not. The remainder is carried to the next chunk.
    let rest = "";
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const text of lines) onLine({ stream: tag, text: stripAnsi(text) });
    }
    if (rest) onLine({ stream: tag, text: stripAnsi(rest) });
  };

  const drained = Promise.all([pump(child.stdout, "out"), pump(child.stderr, "err")]);

  const done = (async () => {
    const code = await child.exited;
    // The pipes can outlive the process that was writing to them. `devbox tunnel` is the
    // case that proves it: it runs `ssh -fN`, which forks a daemon and exits, and the
    // daemon inherits stdout and stderr and holds them for as long as the tunnel lives.
    // Waiting for the readers to finish would therefore mean waiting for the tunnel to be
    // closed — measured as a `devbox tunnel` that opened the forwards and then hung forever.
    //
    // So the exit is what ends the run, and the readers get a grace period to deliver
    // what is already in flight. 150ms is far more than a kernel pipe needs to hand over
    // buffered bytes, and it is a delay nobody can perceive on a command that has just
    // spent minutes in cloud-init.
    await Promise.race([drained, Bun.sleep(150)]);
    return code;
  })();

  return { done, kill: () => child.kill() };
}

/**
 * The core, run for its effect rather than for its output.
 *
 * For the actions a full-screen list takes on the machine under the cursor: open a
 * tunnel, close it. Both streams are discarded — deliberately, and not only to keep them
 * off a screen that is drawing something else. `devbox tunnel` leaves an `ssh -fN` daemon
 * behind holding whatever it inherited, so a pipe here would be a pipe nobody ever closes.
 *
 * The verdict is therefore the exit status, and the truth is what the caller checks
 * afterwards: whether the port is listening. That is a better answer than the text would
 * have been anyway — it is the thing the reader actually wanted to know.
 */
export async function coreQuiet(argv: string[]): Promise<number> {
  const child = Bun.spawn([CORE, ...argv], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return child.exited;
}

/**
 * The core, given the terminal outright.
 *
 * For the verbs this layer has no screen for. Ink is never mounted on this path, so the
 * core writes to the real stdout and behaves exactly as `devbox-core` does when run by hand —
 * which is the point: an unknown flag must produce the core's own error message, not a
 * second one written here that could disagree with it.
 */
export async function corePassthrough(argv: string[]): Promise<number> {
  // Giving the terminal away means giving up READING it, and the two are not the same
  // gesture. Ink restores the tty on unmount — measured at the handoff, `isRaw=false`,
  // zero listeners on `process.stdin` — but the read Bun already had in flight on
  // descriptor 0 outlives all of that, and this process stays alive here awaiting the
  // child. Two readers on one tty, and the kernel hands each byte to exactly one of them:
  // measured through a pty, 40 characters typed into `devbox` > machines > Enter came back as
  // 20, `bdfhjlnprtvxz` — every second one, swallowed by a parent that had nothing left to
  // do with it. It reads as lag and as a dropped letter, which is how it was reported.
  //
  // `pause()` and not `destroy()`, though both were measured to fix it: destroy tears down
  // the stream that owns descriptor 0, and the child is about to inherit that descriptor.
  // It happened to work; it is the kind of thing a Bun upgrade takes back.
  //
  // Here and not in `ask()`, which is where the reader is actually left, because a pause
  // there is undone by the next screen: Ink resumes stdin when it mounts. Measured — the
  // fix applied at the source lost the same half. The last moment is the only one that
  // holds.
  process.stdin.pause();
  const child = Bun.spawn([CORE, ...argv], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}
