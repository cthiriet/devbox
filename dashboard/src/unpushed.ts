import { readFileSync } from "node:fs";
import { Client } from "ssh2";

import { hostKeyMatches, type TerminalTarget } from "./terminal";

/**
 * What a machine is holding that nowhere else has, asked before it is destroyed.
 *
 * `src/guard.ts` has said it since the first write was guarded: every gesture here "orders a
 * machine that bills by the hour or destroys one that holds unpushed work". The first half
 * has had a net for months - a probe before ordering, a 412 with the name of what is missing.
 * The second half had a typed name and a sentence, which is a check that the reader MEANT it
 * and no check at all on what it costs: the dialog said "whatever was not pushed goes with
 * it" and then failed to name a single file, on the one screen where the answer is three
 * seconds away over a connection this service already knows how to open.
 *
 * So it asks. The machine counts, in each checkout under `/workspace`, what `git status`
 * shows and what the upstream does not have, and the dialog writes it above the button.
 *
 * NOTHING IS BLOCKED BY IT. A machine whose disk is already lost, a checkout with a lock
 * file left by a killed git, an sshd that has stopped answering - each of those is a reason
 * to destroy the machine, not a reason to be refused. A doubt is drawn as a doubt (see
 * `Unpushed`), which is the rule of the version handshake (`version_gate` in devbox-core) and
 * of the host key check: a doubt must never render as an agreement, in either direction.
 */

/** One checkout on the machine, counted by the machine itself. */
export type Checkout = {
  /** The directory as the shell found it, `/workspace/<name>`. */
  dir: string;
  branch: string;
  /**
   * Lines of `git status --porcelain`: modified, staged and NEVER ADDED alike.
   *
   * Untracked files are counted with the rest on purpose. A file that was never committed is
   * the one this machine is the only copy of, and a count that left it out would answer
   * "nothing to lose" about the exact case where everything is.
   */
  changed: number;
  /**
   * Commits the upstream branch does not have, or null where the branch HAS no upstream.
   *
   * Null is not zero and must never be drawn as it: a branch that was never pushed has every
   * one of its commits living on this disk alone, and `rev-list @{u}..HEAD` on it is not a
   * small number, it is an error. The page says "never pushed" for it.
   */
  ahead: number | null;
};

/** The answer, or the reason there is none. Never an empty list standing in for a failure. */
export type Unpushed =
  | { known: true; checkouts: Checkout[] }
  | { known: false; why: string };

/**
 * What runs on the machine, as `dev` - the user devbox creates and the one that owns the
 * clones, so nothing here needs `safe.directory` and nothing runs as root.
 *
 * `--no-optional-locks` on the status alone: `git status` refreshes the index when it can,
 * which takes `index.lock` and writes. An agent may well be mid-commit in that checkout while
 * a phone opens this dialog, and a read that can make a write fail is not a read. The other
 * two commands only ever read.
 *
 * `--is-inside-work-tree` decides whether this is a checkout at all, and NOT `HEAD`: a
 * repository with no commit yet is one git answers nothing about, and it is also exactly
 * where a first afternoon's work sits, untracked. It is counted like any other, with `-` for
 * the branch it has not got and `0` ahead, which is true - there is no commit to push, and
 * `status` is the whole of what it can lose. A directory with a `.git` git will not open at
 * all is dropped: a line saying `0 changed` about it would be a lie in the reassuring
 * direction.
 *
 * One line per checkout, tab separated, and no `jq` on the far side - a machine has whatever
 * a profile put on it, and this has to answer on a bare one.
 */
export const UNPUSHED_COMMAND = [
  "for g in /workspace/*/.git; do",
  '[ -d "$g" ] || continue;',
  "d=${g%/.git};",
  'git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue;',
  'c=$(git --no-optional-locks -C "$d" status --porcelain 2>/dev/null | wc -l);',
  'if git -C "$d" rev-parse -q --verify HEAD >/dev/null 2>&1;',
  'then b=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null);',
  'if git -C "$d" rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1;',
  'then a=$(git -C "$d" rev-list --count @{u}..HEAD 2>/dev/null); else a=-; fi;',
  "else b=-; a=0; fi;",
  "printf '%s\\t%s\\t%s\\t%s\\n' \"$d\" \"$b\" \"$c\" \"$a\";",
  "done",
].join(" ");

/**
 * The tab-separated lines, back into checkouts.
 *
 * A line this does not understand is dropped rather than guessed at, and the ones around it
 * still count: the command prints a motd-free stream on its own channel, but a machine with
 * something chatty in `~/.bashrc` - which is the person's file, not this service's - can put
 * a line in front of it. Dropping is safe in the direction that matters, because a dropped
 * line can only ever make this show LESS than there is, and `known: true` with fewer rows
 * still says "there is work here" as loudly as the count it lost.
 */
export function parseUnpushed(stdout: string): Checkout[] {
  const checkouts: Checkout[] = [];
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t");
    if (parts.length !== 4) continue;
    const [dir, branch, changed, ahead] = parts as [string, string, string, string];
    // `-` is the branch of a repository with no commit yet, which the command reports rather
    // than hides: see UNPUSHED_COMMAND.
    if (!dir.startsWith("/") || branch.trim() === "") continue;
    const count = Number.parseInt(changed.trim(), 10);
    if (!Number.isInteger(count) || count < 0) continue;
    const upstream = ahead.trim() === "-" ? null : Number.parseInt(ahead.trim(), 10);
    if (upstream !== null && (!Number.isInteger(upstream) || upstream < 0)) continue;
    checkouts.push({ dir, branch: branch.trim(), changed: count, ahead: upstream });
  }
  return checkouts;
}

/** Whether a machine holds anything a destroy would take with it. */
export function holdsWork(checkouts: readonly Checkout[]): boolean {
  return checkouts.some((one) => one.changed > 0 || one.ahead === null || one.ahead > 0);
}

/** Said before any connection is made, and the one refusal this module owns. */
const NO_HOST_KEY = "no host key was recorded for this machine";

/** What a run on the machine may return before it is cut off: a status is a few hundred bytes. */
const MAX_OUTPUT = 64 * 1024;

/** Long enough for `git status` on a large checkout over the internet, short enough for a dialog. */
const TIMEOUT_MS = 20_000;

/**
 * Opens a connection, runs the one command, and hands back what it printed.
 *
 * The same host key rule as the terminal, and deliberately the same refusal: where this
 * service recorded nothing at `up`, it cannot tell who is answering, and an answer from a
 * machine it cannot identify is worth nothing here either - `known: false`, with the reason.
 * There is no pty, so the shell reads nothing from the far end and this cannot hang on a
 * prompt.
 *
 * Every failure is a sentence and never a throw: the caller is a dialog with a red button in
 * it, and the one thing that must not happen is that a machine becomes undestroyable because
 * the question about it failed.
 */
export function askUnpushed(target: TerminalTarget, keyPath: string): Promise<Unpushed> {
  return new Promise((resolve) => {
    // Before a packet leaves: an address this service recorded no key for is one it cannot
    // identify, and the terminal refuses it for the same reason. Said in words here rather
    // than left to the handshake, which would fail with ssh2's own sentence about
    // authentication and send the reader looking at their key.
    if (target.fingerprints.length === 0) {
      resolve({ known: false, why: NO_HOST_KEY });
      return;
    }

    let key: Buffer;
    try {
      key = readFileSync(keyPath);
    } catch {
      resolve({ known: false, why: `no ssh key at ${keyPath}` });
      return;
    }

    const connection = new Client();
    let settled = false;
    let out = "";

    const finish = (answer: Unpushed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.end();
      resolve(answer);
    };

    const timer = setTimeout(
      () => finish({ known: false, why: "the machine did not answer in time" }),
      TIMEOUT_MS,
    );

    connection.on("ready", () => {
      connection.exec(UNPUSHED_COMMAND, (error, stream) => {
        if (error !== undefined && error !== null) {
          finish({ known: false, why: error.message });
          return;
        }
        stream.on("data", (chunk: Buffer) => {
          if (out.length < MAX_OUTPUT) out += chunk.toString("utf8");
        });
        // Kept out of the count: git writes its own complaints there, and a warning about
        // a detached HEAD is not a checkout.
        stream.stderr.on("data", () => {});
        stream.on("close", () => finish({ known: true, checkouts: parseUnpushed(out) }));
      });
    });

    connection.on("error", (error) => finish({ known: false, why: error.message }));
    connection.on("end", () => finish({ known: false, why: "the connection ended" }));
    connection.on("close", () => finish({ known: false, why: "the connection closed" }));

    connection.connect({
      host: target.host,
      port: target.port,
      username: target.user,
      privateKey: key,
      algorithms: { serverHostKey: ["ssh-ed25519"] },
      hostVerifier: (hostKey: Buffer) => hostKeyMatches(target.fingerprints, hostKey),
      readyTimeout: 15_000,
    });
  });
}

