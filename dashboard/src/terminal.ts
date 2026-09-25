import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "ssh2";

/**
 * The web terminal: what turns a browser tab into a session on a machine.
 *
 * Everything above the SSH connection itself is a decision, and every decision here is
 * one the rest of this service already makes somewhere - an origin, a token, a host key.
 * They are re-made rather than reused wholesale because a WebSocket handshake is not an
 * ordinary request and gets none of the protections one has:
 *
 *   - CORS does not apply to it. A page on any origin may open a socket to this server
 *     and the browser will not stop it; the `Origin` header is sent, and refusing an
 *     unknown one is OUR job, not the browser's.
 *   - `new WebSocket(url)` sets no headers, so the anti-CSRF token cannot arrive in
 *     `X-CSRF` the way it does on every other write. It travels in the one field the
 *     constructor does control, `Sec-WebSocket-Protocol`, which is a header like any
 *     other on the wire - and unlike a query string it is not written into Caddy's
 *     access log.
 *
 * The verdict itself is src/guard.ts's, unchanged: a session, our origin, that session's
 * token. This file only knows how to find the token in a handshake.
 */

/** Echoed back at the upgrade: a browser fails the connection if the server names none. */
export const SUBPROTOCOL = "devbox-term";

/**
 * The anti-CSRF token, out of `Sec-WebSocket-Protocol: devbox-term, <token>`.
 *
 * Two entries and in that order, because the first is what the server echoes and the
 * second is what it checks. Anything else is refused rather than guessed at: a handshake
 * that named no subprotocol is a client that did not go through lib/api.ts, and this is
 * the one door in this service that opens a root shell.
 */
export function csrfFromProtocol(header: string | null): string | null {
  if (header === null) return null;
  const parts = header.split(",").map((part) => part.trim());
  if (parts.length !== 2) return null;
  if (parts[0] !== SUBPROTOCOL) return null;
  return parts[1] === "" ? null : (parts[1] ?? null);
}

/**
 * The host key, in the form devbox already records it.
 *
 * devbox-core's `host_fingerprint` is `ssh-keyscan -t ed25519 | ssh-keygen -lf -`, whose
 * second field is `SHA256:` and the base64 of the sha256 of the raw key blob, without
 * padding. That is the same computation as this line. Verified on 26/08 against a live
 * cx33: the keyscan and this function name the same key.
 */
export function fingerprintOf(key: Uint8Array): string {
  const digest = createHash("sha256").update(key).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/**
 * The key this dashboard recorded when it created the machine, out of its own known_hosts.
 *
 * NOT `devbox info --json`'s `fingerprint` field, and the distinction is the whole point of
 * this function. That field is a keyscan run at the moment of asking: comparing a
 * connection against a scan taken one second earlier proves that two observations agree,
 * which is precisely what anyone able to sit between this server and the machine could
 * arrange. It is the right thing on a Mac, where a human compares it once with their eyes;
 * it anchors nothing here.
 *
 * devbox-core's `refresh_known_hosts` appends the key at `up`, into the dashboard's own HOME -
 * so for every machine this service created there is a record from before anything could
 * have moved, and it is the only one worth comparing against.
 *
 * ssh-keyscan writes the bare address on port 22 and `[address]:port` on any other, and
 * devbox passes both forms through unchanged. Neither is hashed: HashKnownHosts applies to
 * what ssh itself writes, not to what a keyscan produces.
 */
export function knownHostFingerprints(
  contents: string,
  host: string,
  port: number,
): string[] {
  const wanted = port === 22 ? [host, `[${host}]:22`] : [`[${host}]:${port}`];
  const found: string[] = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const [addresses, type, blob] = trimmed.split(/\s+/);
    if (addresses === undefined || type !== "ssh-ed25519" || blob === undefined) continue;
    if (!addresses.split(",").some((one) => wanted.includes(one))) continue;
    try {
      found.push(fingerprintOf(Buffer.from(blob, "base64")));
    } catch {
      // A mangled line is not an answer, and it is not a reason to ignore the good ones
      // that may follow it either.
      continue;
    }
  }
  return found;
}

/**
 * Whether to go on, and an absent record is a refusal.
 *
 * The Host block devbox writes carries `StrictHostKeyChecking accept-new`, which is right for
 * a Mac: a human is watching the first connection and can compare what `devbox info` printed.
 * Nobody is watching this one. Where this service recorded nothing - a keyscan that timed
 * out at creation, a machine adopted from elsewhere - the honest answer is that it cannot
 * tell, which is the version handshake's rule (`version_gate` in devbox-core) applied to a
 * host key: a doubt must never render as an agreement.
 */
export function hostKeyMatches(expected: string[], key: Uint8Array): boolean {
  if (expected.length === 0) return false;
  return expected.includes(fingerprintOf(key));
}

/* --- what the browser sends between two keystrokes -------------------------- */

/**
 * Two frame kinds, and the split is the protocol.
 *
 * Binary is the stream: every byte the user typed, untouched, in both directions. Text is
 * control, and it is JSON. A terminal transports arbitrary bytes - a paste, a file cat, an
 * escape sequence - so anything that tried to carve control out of the same channel would
 * eventually mistake a payload for a command. Two frame types cost nothing and cannot
 * collide.
 */
export type Control = { type: "resize"; cols: number; rows: number } | { type: "ping" };

/** xterm asks for what it measured; these are the bounds a pty is willing to hear. */
const MAX_COLS = 1000;
const MAX_ROWS = 500;

export function parseControl(raw: string): Control | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;

  if (message.type === "ping") return { type: "ping" };

  if (message.type === "resize") {
    const { cols, rows } = message;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
    const c = cols as number;
    const r = rows as number;
    if (c < 1 || c > MAX_COLS || r < 1 || r > MAX_ROWS) return null;
    return { type: "resize", cols: c, rows: r };
  }

  return null;
}

/* --- the session itself ----------------------------------------------------- */

/**
 * The command a connected socket runs, and it is not a bare shell.
 *
 * `tmux new -A -s devbox` attaches to the session if it exists and creates it otherwise, so a
 * closed tab, a locked phone or a train tunnel costs the view and not the work - which is
 * the one thing a plain SSH client does not do. Ubuntu's cloud image ships tmux (verified on
 * 26/08 on a fresh cx33, /usr/bin/tmux), but a machine is not always Ubuntu and an older
 * one may predate this, hence the fallback: without tmux this is an ordinary login shell,
 * and the terminal works exactly as it would have without this line.
 *
 * `exec` in both branches, so the pty's process IS the shell: without it a Ctrl-D would
 * leave the wrapping `sh` holding a channel the browser has no way to talk to.
 *
 * `set -g mouse on` is what makes a finger scroll. tmux draws on the alternate screen, so
 * xterm's own 5000 lines of scrollback stay empty and there is nothing under the finger to
 * move - reported from a phone on 27/08, and the answer is not on the browser's side. With
 * the mouse on, tmux takes the scroll events xterm sends and walks its OWN history, which
 * is the buffer that actually holds the output.
 *
 * The price is real and falls on the desktop: selecting text becomes tmux's selection
 * rather than the browser's, and reaching the browser's again means holding Shift. That
 * trade is made knowingly - this terminal exists for the phone, where there is no Shift and
 * no other way to read what scrolled past, and a Mac has `devbox ssh`.
 *
 * WHAT THE REST OF THE CHAIN BUYS, and why a terminal without them reads as a web page
 * with a shell in it rather than as a terminal:
 *
 *   `escape-time 10` is the one that is felt without being seen. tmux's default is 500 ms,
 *   and it spends them after every Escape waiting to see whether the byte was the start of
 *   a key sequence - so leaving insert mode in vim takes half a second, every time. A
 *   browser sends Escape as one byte the instant the key goes down and never as the head of
 *   a chord it is still typing, so the wait buys nothing here and 10 ms covers the network.
 *
 *   `set-clipboard on` plus `clipboard` in terminal-features is what makes a tmux selection
 *   land in the reader's own pasteboard: tmux then emits OSC 52, and the browser end
 *   (web/src/lib/terminal-native.ts) puts it in the clipboard. Without the feature declared
 *   tmux stays silent, because it has no termcap to read here - `xterm-256color` does not
 *   claim `Ms`. This is the answer to the price above: the drag that mouse mode took from
 *   the browser gives the text back through the same gesture.
 *
 *   `RGB` is 24-bit colour. xterm.js has always had it, the pty says `xterm-256color`
 *   because that is a name every remote program knows, and tmux quantises to 256 unless
 *   told otherwise - which is why a theme that looks right over `devbox ssh` looked
 *   approximate here. `setenv -g COLORTERM truecolor` is the other half, and the `export`
 *   at the head of this line is NOT it: that one is the environment of the client process
 *   this command execs, and a tmux SERVER that was already running - the usual case, since
 *   the session is the point - hands its own environment to every pane it opens afterwards.
 *   Measured on 20/09 against a live machine: RGB declared, a 24-bit gradient drawn
 *   smoothly, and `COLORTERM` empty in the pane. It is a hint rather than a capability, but
 *   it is the hint half the terminal applications in the world read. New panes only; the
 *   ones already open keep the environment they were born with.
 *
 *   `history-limit 50000` because this terminal's scrollback IS tmux's: the alternate
 *   screen leaves xterm's own 5000 lines empty, so the default 2000 was the whole of what
 *   a finger could scroll back to.
 *
 * All five are `-q`: an older tmux that does not know `terminal-features` says so and
 * carries on rather than printing at a reader who did not ask the question. And they are
 * set on the CHAIN rather than in a config file, because this service does not own the
 * machine's `~/.tmux.conf` - a file the person may be keeping in a repo of their own.
 *
 * WHERE IT OPENS, before any of that. A session born in `$HOME` is a session whose first
 * keystrokes are always `cd /workspace/<something>`, typed by someone who came here to work
 * on the one repository this machine was ordered for. So: the single checkout under
 * `/workspace` when there is exactly one, `/workspace` itself when there are several or
 * none, and `$HOME` on a machine that has none of it.
 *
 * Several is NOT resolved by picking the first - a profile may clone a repository and its
 * infrastructure beside it, and landing in whichever sorts first would be a guess that reads
 * as a decision. `/workspace` is one `ls` away from both, and says so.
 *
 * Asked of the machine rather than remembered here: this service knows the profile's
 * `devbox-repo` line, not what `clone_repo` was called with a third time, and a directory
 * that exists is the only answer that cannot be stale. It also means every machine already
 * running gets this at its next terminal, with no seed and no new machine.
 *
 * `new -A` attaches to a live session and its working directory is whatever it was born
 * with, which is the right behaviour: the `cd` decides where a FIRST session starts, and
 * never moves one that has work in it.
 */
export const COMMAND =
  "export COLORTERM=truecolor; " +
  "d=$HOME; [ -d /workspace ] && d=/workspace; " +
  "set -- /workspace/*/.git; " +
  '[ $# -eq 1 ] && [ -d "$1" ] && d="${1%/.git}"; ' +
  'cd "$d" 2>/dev/null; ' +
  "if command -v tmux >/dev/null 2>&1; then " +
  "exec tmux set -gq history-limit 50000 " +
  "\\; set -sgq escape-time 10 " +
  "\\; new -A -s devbox " +
  "\\; set -gq mouse on " +
  "\\; set -gq set-clipboard on " +
  "\\; setenv -g COLORTERM truecolor " +
  "\\; set -asq terminal-features ',*:RGB:clipboard'; " +
  'else exec "${SHELL:-/bin/bash}" -l; fi';

export type TerminalTarget = {
  host: string;
  port: number;
  user: string;
  /**
   * Every ed25519 key known_hosts records for this address, in the order the file holds
   * them. Empty means nothing was recorded, and that is a refusal.
   *
   * A list and not one key, because ssh itself accepts any line recorded for a host, and
   * because a file that holds two of them is a file this service must not resolve by
   * picking one. It held two on 27/08: `ssh-keygen -R` ignores HOME and had been purging
   * the wrong file since the service was born, so a Scaleway address rented twice carried
   * the dead machine's key ahead of the live one, and the terminal refused the machine it
   * had created itself. devbox-core now passes -f; this reads what such a file already says.
   */
  fingerprints: string[];
};

export type TerminalHooks = {
  onData: (chunk: Uint8Array) => void;
  /** A sentence for the human, in the terminal itself: this is where a refusal is read. */
  onNotice: (text: string) => void;
  onClose: (reason: string | null) => void;
};

export type Terminal = {
  write: (data: Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  /** Pauses and resumes the shell's output, so a slow socket loses nothing. */
  pause: () => void;
  resume: () => void;
  close: () => void;
};

/**
 * Opens the connection, and hands back the four things a socket does to it.
 *
 * The private key is read from disk on every connection rather than held in a module
 * variable: it is a few hundred bytes, this happens once per terminal, and a long-lived
 * copy of the key that reaches every machine in the fleet is worth avoiding for the price
 * of a read.
 */
export function openTerminal(
  target: TerminalTarget,
  keyPath: string,
  size: { cols: number; rows: number },
  hooks: TerminalHooks,
): Terminal {
  const connection = new Client();
  let channel: import("ssh2").ClientChannel | null = null;
  let closed = false;

  /**
   * The size, kept here rather than only on the channel.
   *
   * The browser measures its terminal and says so in the first control frame, which arrives
   * within milliseconds of the socket opening - and the SSH connection takes a second or
   * more to authenticate before there is any channel to tell. Held only on the channel, that
   * first resize lands on a null and is lost, and the session stays at the 80x24 a pty is
   * born with: measured on 26/08, tmux drew its status bar across the middle of a window
   * twice that tall. So the size is remembered, applied to the pty at the moment it is
   * requested, and forwarded from then on.
   */
  let wanted = { ...size };

  const finish = (reason: string | null) => {
    if (closed) return;
    closed = true;
    hooks.onClose(reason);
    connection.end();
  };

  let key: Buffer;
  try {
    key = readFileSync(keyPath);
  } catch {
    // Named, because the answer is a path to check and not a retry. DEVBOX_KEY is the same
    // key devbox hands the provider: without it this service could not have created the
    // machine either.
    hooks.onNotice(`no ssh key at ${keyPath}.`);
    queueMicrotask(() => finish("no key"));
    return dead();
  }

  connection.on("ready", () => {
    /**
     * Nagle off, and it is the largest single thing in this file for how the terminal
     * FEELS.
     *
     * ssh2 never touches the option, so the socket carrying this session is a default Node
     * socket: Nagle's algorithm holds a small write back until the previous one is
     * acknowledged. A terminal is nothing but small writes - one keystroke out, one echoed
     * cell back - so each of them waits a round trip that the keystroke after it would
     * have filled. Against a machine 20 ms away that is the difference between typing and
     * watching yourself type, and against delayed ACKs at the other end it is up to 40 ms
     * of it. The algorithm exists for a program that writes a byte at a time and does not
     * care when it arrives; this is the other kind.
     *
     * Here rather than on `connect`: ssh2 makes the socket itself, and `ready` is the first
     * moment it exists and the last before anything can be typed into it.
     */
    connection.setNoDelay(true);
    connection.exec(
      COMMAND,
      { pty: { term: "xterm-256color", cols: wanted.cols, rows: wanted.rows } },
      (error, stream) => {
        if (error !== undefined && error !== null) {
          hooks.onNotice(`the machine refused a shell: ${error.message}`);
          finish("no shell");
          return;
        }
        channel = stream;
        stream.on("data", (chunk: Buffer) => hooks.onData(chunk));
        // A pty folds stderr into the same stream; this catches the case where it does not.
        stream.stderr.on("data", (chunk: Buffer) => hooks.onData(chunk));
        stream.on("close", () => finish("shell ended"));
      },
    );
  });

  connection.on("error", (error) => {
    hooks.onNotice(error.message);
    finish(error.message);
  });

  connection.on("end", () => finish(null));
  connection.on("close", () => finish(null));

  connection.connect({
    host: target.host,
    port: target.port,
    username: target.user,
    privateKey: key,
    // Pinned, and not a preference: what devbox recorded is a keyscan of the ed25519 key
    // alone. Letting the negotiation land on any other type would compare that
    // fingerprint against a key it was never computed from, and refuse a machine that is
    // exactly who it says it is.
    algorithms: { serverHostKey: ["ssh-ed25519"] },
    hostVerifier: (hostKey: Buffer) => {
      if (hostKeyMatches(target.fingerprints, hostKey)) return true;
      hooks.onNotice(
        target.fingerprints.length === 0
          ? "no host key recorded for this machine. Refused rather than guessed."
          : `host key changed. Expected ${target.fingerprints.join(",\r\n         ")},\r\n` +
              `got ${fingerprintOf(hostKey)}. Refused.`,
      );
      return false;
    },
    // The machine is on the other side of the internet and has just been created; the
    // default 20 s is a refusal on a first boot that is still opening its firewall.
    readyTimeout: 30_000,
    keepaliveInterval: 20_000,
  });

  return {
    write: (data) => channel?.write(Buffer.from(data)),
    resize: (cols, rows) => {
      wanted = { cols, rows };
      channel?.setWindow(rows, cols, 0, 0);
    },
    pause: () => channel?.pause(),
    resume: () => channel?.resume(),
    close: () => finish(null),
  };
}

/** A terminal that never opened: the caller's four calls have to be safe anyway. */
function dead(): Terminal {
  return {
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    close: () => {},
  };
}
