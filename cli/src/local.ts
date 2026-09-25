import { createConnection } from "node:net";
import { platform } from "node:os";

/**
 * The two things the screens need to know about THIS machine.
 *
 * Both are about the far end of a tunnel, which is the one piece of state neither devbox-core
 * nor the dashboard can answer for: whether a forward is open here, and putting a browser
 * on it.
 */

/**
 * Whether anything is listening on a local port.
 *
 * devbox-core asks `lsof`, which is absent on some minimal images and needs no argument to be
 * wrong about a port it cannot see. A connection attempt asks the kernel instead: refused
 * means nothing is listening, connected means something is. The socket is destroyed at
 * once and nothing is written to it, so a tunnel is never disturbed by being looked at.
 *
 * `node:net` rather than `Bun.connect`, and that is a measurement rather than a
 * preference: a `Bun.connect` to a closed port neither resolved nor rejected here, and
 * racing it against a timer did not help — the pending socket stayed in the loop and the
 * whole window stopped redrawing, spinner included. A socket that is explicitly destroyed
 * on every one of its three outcomes leaves nothing behind.
 */
export function listening(port: number, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };

    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    // Timed out rather than refused: something is there and not answering — a firewall, a
    // half-open forward. "Open" is the safer reading, because the alternative invites a
    // second `ssh -fN` onto a port that is already taken.
    socket.once("timeout", () => done(true));
  });
}

/**
 * The app, in whatever the desktop calls a browser.
 *
 * Detached and with its streams thrown away: `open` on macOS returns at once, but
 * `xdg-open` on a Linux desktop can sit in the foreground for as long as the browser
 * lives, and a window whose keystrokes stop arriving is indistinguishable from one that
 * has crashed.
 */
export function openInBrowser(url: string): void {
  const opener = platform() === "darwin" ? "open" : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // A desktop with no opener is a perfectly ordinary machine to be sitting at. The URL
    // is on the screen either way, which is what the key was really for.
  }
}
