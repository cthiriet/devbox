import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The window, driven through a real pseudo-terminal.
 *
 * This test exists because of a specific way Ink fails. Measured against ink 7.1.1: some
 * perfectly ordinary layouts — a Box carrying both `borderStyle` and a height, or simply a
 * root Box with four children where three worked — silently stop every `useInput` in the
 * tree from ever firing. Rendering carries on. A ticking counter keeps ticking. The window
 * draws exactly as intended and answers no key, and the only visible symptom is that the
 * terminal begins echoing the keystrokes back, because raw mode was never enabled.
 *
 * Nothing that renders to a string can catch that: `renderToString` has no terminal, so
 * `useInput` is a documented no-op there. It takes a pty, which is what `expect` is for.
 *
 * So if this fails after a change to src/ui/tui/Frame.tsx, the change is the cause. Put
 * the three-child shape back rather than looking for the bug inside a screen.
 */
const ENTRY = join(import.meta.dir, "..", "src", "index.tsx");
const CORE = join(import.meta.dir, "fixtures", "core");
const SCRIPT = join(import.meta.dir, "fixtures", "window.exp");

// macOS ships expect; a CI image may not. Skipped rather than failed, because a missing
// test harness is not a broken window — and the skip is visible in the run.
const hasExpect = Bun.which("expect") !== null;

describe.skipIf(!hasExpect)("the full-screen window", () => {
  test(
    "answers the arrows, and opens what Enter is on",
    async () => {
      const child = Bun.spawn(["expect", SCRIPT], {
        env: {
          ...process.env,
          DEVBOX_ENTRY: ENTRY,
          DEVBOX_CORE: CORE,
          DEVBOX_HOME: join(import.meta.dir, "..", ".."),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [raw, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      const text = raw.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

      // The expect script names its own failure, and that name is worth more than a diff
      // of two screens full of escape codes.
      expect(text).toContain("WINDOW OK");
      expect(code).toBe(0);
    },
    60_000,
  );
});
