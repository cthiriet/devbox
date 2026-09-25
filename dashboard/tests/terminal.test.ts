import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND,
  csrfFromProtocol,
  fingerprintOf,
  hostKeyMatches,
  knownHostFingerprints,
  parseControl,
  SUBPROTOCOL,
} from "../src/terminal";

/**
 * The web terminal opens a root prompt on a machine holding unpushed work. What is
 * exercised here is everything that decides whether it opens at all, and it is exercised
 * without a socket and without an SSH connection - the same separation as src/guard.ts.
 */

/**
 * A real ed25519 host key, as `ssh-keyscan -t ed25519` writes it, with the fingerprint
 * `ssh-keygen -lf` prints for it. Both were read off a live Hetzner cx33 on 26/08: this
 * pair is the contract between devbox-core's `host_fingerprint` and this file, and inventing
 * either half would test our arithmetic against itself.
 */
const KEY_BASE64 = "AAAAC3NzaC1lZDI1NTE5AAAAIK5SMV8ItDyejkjDb14OxRxtpNy7eMiHnOlrEgJqnfN4";
const FINGERPRINT = "SHA256:euh2yjwOGV0ABmi/F8Y6JhLX7Vg4SFbh03H46K8MbuE";
const KEY = new Uint8Array(Buffer.from(KEY_BASE64, "base64"));

describe("fingerprintOf", () => {
  test("names a key exactly as ssh-keygen -lf does", () => {
    expect(fingerprintOf(KEY)).toBe(FINGERPRINT);
  });

  test("carries no base64 padding, which ssh-keygen does not print either", () => {
    expect(fingerprintOf(KEY)).not.toContain("=");
  });
});

describe("hostKeyMatches", () => {
  test("accepts the key it recorded", () => {
    expect(hostKeyMatches([FINGERPRINT], KEY)).toBe(true);
  });

  test("refuses another key", () => {
    const other = new Uint8Array(KEY);
    other.set([(other.at(-1) ?? 0) ^ 1], other.length - 1);
    expect(hostKeyMatches([FINGERPRINT], other)).toBe(false);
  });

  /**
   * The rule this whole file exists for: a machine this service recorded nothing about is
   * refused, never adopted. An unknown host key that connects anyway is a machine that
   * could be anyone's.
   */
  test("refuses when nothing was recorded", () => {
    expect(hostKeyMatches([], KEY)).toBe(false);
    expect(hostKeyMatches([""], KEY)).toBe(false);
  });
});

describe("knownHostFingerprints", () => {
  const file = [
    "# 198.51.100.7:22 SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.1",
    "198.51.100.7 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPIEefqegAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "# 203.0.113.39:22 SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.18",
    `203.0.113.39 ssh-ed25519 ${KEY_BASE64}`,
  ].join("\n");

  test("finds the key recorded for a machine on port 22", () => {
    expect(knownHostFingerprints(file, "203.0.113.39", 22)).toEqual([FINGERPRINT]);
  });

  test("answers nothing for an address it never saw", () => {
    expect(knownHostFingerprints(file, "203.0.113.7", 22)).toEqual([]);
  });

  /**
   * A machine on a port other than 22 is written `[address]:port` by ssh-keyscan, and the
   * bare address on 22. Reading one form for the other would hand back the key of a
   * DIFFERENT sshd on the same host - which is exactly the substitution the comparison
   * exists to catch.
   */
  test("keeps the two address forms apart", () => {
    const other = `[203.0.113.39]:2222 ssh-ed25519 ${KEY_BASE64}`;
    expect(knownHostFingerprints(other, "203.0.113.39", 22)).toEqual([]);
    expect(knownHostFingerprints(other, "203.0.113.39", 2222)).toEqual([FINGERPRINT]);
    expect(knownHostFingerprints(file, "203.0.113.39", 2222)).toEqual([]);
  });

  test("reads an address that shares a line with others", () => {
    const shared = `10.0.0.1,203.0.113.39 ssh-ed25519 ${KEY_BASE64}`;
    expect(knownHostFingerprints(shared, "203.0.113.39", 22)).toEqual([FINGERPRINT]);
  });

  test("ignores a key of another type, which is not what devbox records", () => {
    const rsa = "203.0.113.39 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ";
    expect(knownHostFingerprints(rsa, "203.0.113.39", 22)).toEqual([]);
  });

  /**
   * The failure of 27/08, in one test.
   *
   * `ssh-keygen -R` ignores HOME and resolves the file by getpwuid, so the dashboard's
   * known_hosts was never purged while the keyscan kept appending to it. Scaleway rents an
   * address out again, and the file ends up holding the dead machine's key ABOVE the live
   * one - the reader took the first and refused a machine this service had created itself.
   *
   * Reading every line is what ssh does with its own file, and it is the only answer that
   * does not amount to picking one of two records at random.
   */
  test("reads every key recorded for one address, not the first", () => {
    const relet = [
      "# 203.0.113.39:22 SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.15",
      "203.0.113.39 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPIEefqegAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "# 203.0.113.39:22 SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.18",
      `203.0.113.39 ssh-ed25519 ${KEY_BASE64}`,
    ].join("\n");
    const found = knownHostFingerprints(relet, "203.0.113.39", 22);
    expect(found).toHaveLength(2);
    expect(found[1]).toBe(FINGERPRINT);
    expect(hostKeyMatches(found, KEY)).toBe(true);
  });

  test("keeps reading past a line it cannot decode", () => {
    const mangled = ["203.0.113.39 ssh-ed25519 !!!!", `203.0.113.39 ssh-ed25519 ${KEY_BASE64}`].join(
      "\n",
    );
    expect(knownHostFingerprints(mangled, "203.0.113.39", 22)).toContain(FINGERPRINT);
  });

  test("answers nothing rather than throwing on an empty or mangled file", () => {
    expect(knownHostFingerprints("", "203.0.113.39", 22)).toEqual([]);
    expect(knownHostFingerprints("203.0.113.39 ssh-ed25519", "203.0.113.39", 22)).toEqual([]);
  });
});

describe("csrfFromProtocol", () => {
  test("reads the token from behind the subprotocol", () => {
    expect(csrfFromProtocol(`${SUBPROTOCOL}, a-token`)).toBe("a-token");
    expect(csrfFromProtocol(`${SUBPROTOCOL},a-token`)).toBe("a-token");
  });

  /**
   * Every one of these is a handshake that did not come from lib/terminal.ts. They are
   * refused rather than read generously: this is the door that opens a root shell, and a
   * token found in the wrong place is a client we cannot account for.
   */
  test("refuses anything that is not exactly the two entries", () => {
    for (const header of [
      null,
      "",
      "a-token",
      SUBPROTOCOL,
      `${SUBPROTOCOL}, `,
      `${SUBPROTOCOL}, a-token, extra`,
      `chat, a-token`,
      `devbox-term-x, a-token`,
    ]) {
      expect(csrfFromProtocol(header)).toBeNull();
    }
  });
});

describe("parseControl", () => {
  test("reads a resize", () => {
    expect(parseControl('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
    });
  });

  test("reads a ping, which is what keeps a quiet prompt from being closed", () => {
    expect(parseControl('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  /**
   * A pty is asked for these numbers directly. Zero, a negative, a fraction or something
   * absurd is refused here rather than handed to ssh2 - and the last two lines are the
   * reason this is not a `Number()`: `1e9` and `"80"` both look like sizes.
   */
  test("refuses a size a terminal cannot have", () => {
    for (const raw of [
      '{"type":"resize","cols":0,"rows":24}',
      '{"type":"resize","cols":80,"rows":0}',
      '{"type":"resize","cols":-1,"rows":24}',
      '{"type":"resize","cols":80.5,"rows":24}',
      '{"type":"resize","cols":1000000000,"rows":24}',
      '{"type":"resize","cols":80,"rows":100000}',
      '{"type":"resize","cols":"80","rows":"24"}',
      '{"type":"resize"}',
    ]) {
      expect(parseControl(raw)).toBeNull();
    }
  });

  test("refuses anything that is not one of the two messages", () => {
    for (const raw of [
      "",
      "not json",
      "null",
      "[]",
      '"resize"',
      '{"type":"exec","cmd":"rm -rf /"}',
      '{"cols":80,"rows":24}',
    ]) {
      expect(parseControl(raw)).toBeNull();
    }
  });
});

/**
 * The command the socket runs, which is a shell string and therefore unreadable by the
 * type checker.
 *
 * The separator between tmux's two commands must reach tmux as `\;`, and it is written in a
 * JavaScript string literal where a lone backslash before a `;` is simply DROPPED - JS has
 * no `\;` escape, so `"\;"` is `";"`. Written that way, the shell sees `exec tmux new -A -s
 * devbox ; set -g mouse on`: exec replaces the shell with tmux and the second command never
 * runs, silently, forever. Cost three attempts on 27/08 before this test existed.
 */
describe("COMMAND", () => {
  test("hands tmux an escaped separator, not a shell one", () => {
    expect(COMMAND).toContain(String.raw`new -A -s devbox \; set -gq mouse on`);
    // Every separator in the chain, and not only the first: the failure is silent and
    // identical whichever one is written as a bare `;` - tmux is exec'd, the shell it
    // replaced never runs the rest, and the terminal simply behaves as it did before the
    // setting was added.
    const branch = COMMAND.slice(COMMAND.indexOf("exec tmux"), COMMAND.indexOf("; else"));
    expect(branch.split(";").length - 1).toBe(branch.split(String.raw`\;`).length - 1);
    expect(COMMAND).not.toContain("devbox ; set");
  });

  test("execs in both branches, so the pty's process is the shell", () => {
    expect(COMMAND).toContain("exec tmux");
    expect(COMMAND).toContain('exec "${SHELL:-/bin/bash}" -l');
  });

  test("falls back to a login shell where tmux is missing", () => {
    expect(COMMAND).toContain("command -v tmux");
  });

  /**
   * The four settings that decide how the session FEELS, each asserted by name because
   * each is invisible when it goes missing: nothing fails, the terminal is merely slower,
   * or duller, or shorter, or stops answering a copy.
   */
  test("asks tmux for what a native terminal does", () => {
    expect(COMMAND).toContain("escape-time 10");
    expect(COMMAND).toContain("set-clipboard on");
    expect(COMMAND).toContain("RGB");
    expect(COMMAND).toContain("clipboard'");
    expect(COMMAND).toContain("history-limit 50000");
    // The variable, and not only the capability: `export` at the head of the command reaches
    // the client process alone, and a tmux server that was already running opens every later
    // pane with its OWN environment.
    expect(COMMAND).toContain("setenv -g COLORTERM truecolor");
  });

  /**
   * WHERE the session opens, against a real `sh` rather than against the string.
   *
   * The head of COMMAND is four tests and a `cd` in POSIX shell, and every way it can be
   * wrong is silent: a glob that does not match expands to itself, `set --` with no match
   * leaves `$1` holding a pattern, and a `cd` that fails lands the reader in `$HOME` with no
   * word about it. So the real shell answers, with `/workspace` pointed at a temporary
   * directory - the one substitution, and the rest of the line is the deployed one.
   */
  describe("the directory it opens in", () => {
    const head = COMMAND.slice(0, COMMAND.indexOf("if command -v tmux"));

    const opensIn = (root: string, home: string) => {
      const line = head.replaceAll("/workspace", `${root}/workspace`);
      const answer = spawnSync("sh", ["-c", `${line} pwd`], { env: { HOME: home }, encoding: "utf8" });
      expect(answer.status).toBe(0);
      return answer.stdout.trim();
    };

    test("the checkout, when the machine holds exactly one", () => {
      const root = mkdtempSync(join(tmpdir(), "devbox-term-"));
      mkdirSync(join(root, "workspace", "mine", ".git"), { recursive: true });
      expect(opensIn(root, root)).toBe(join(root, "workspace", "mine"));
    });

    test("their parent, when a profile cloned two: never a guess at which", () => {
      const root = mkdtempSync(join(tmpdir(), "devbox-term-"));
      mkdirSync(join(root, "workspace", "app", ".git"), { recursive: true });
      mkdirSync(join(root, "workspace", "infra", ".git"), { recursive: true });
      expect(opensIn(root, root)).toBe(join(root, "workspace"));
    });

    test("/workspace itself, when nothing was cloned into it", () => {
      const root = mkdtempSync(join(tmpdir(), "devbox-term-"));
      mkdirSync(join(root, "workspace"), { recursive: true });
      expect(opensIn(root, root)).toBe(join(root, "workspace"));
    });

    test("HOME, on a machine that has no /workspace at all", () => {
      const root = mkdtempSync(join(tmpdir(), "devbox-term-"));
      const home = mkdtempSync(join(tmpdir(), "devbox-home-"));
      expect(opensIn(root, home)).toBe(home);
    });
  });

  /**
   * The size of the scrollback is decided when the session is CREATED, so the option has
   * to be set before `new`. After it, the first window - the only one most sessions ever
   * have - keeps tmux's default 2000 lines and nothing says so.
   */
  test("sets the history limit before the session exists", () => {
    expect(COMMAND.indexOf("history-limit")).toBeLessThan(COMMAND.indexOf("new -A"));
  });

  /**
   * Quiet, because this string is run against whatever tmux the machine has: an older one
   * refuses `terminal-features` by name, and an error printed over the first prompt is a
   * terminal that opens looking broken.
   */
  test("suppresses what an older tmux does not know", () => {
    for (const set of COMMAND.split(String.raw`\; `).slice(1)) {
      if (!set.startsWith("set ")) continue;
      expect(set.split(" ")[1]).toContain("q");
    }
  });
});
