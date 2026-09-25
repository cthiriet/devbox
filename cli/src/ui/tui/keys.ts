import { useInput } from "ink";

/**
 * One keystroke at a time, whatever the terminal handed over.
 *
 * Ink parses a *chunk* of stdin, not a key. When two keystrokes land in the same read —
 * typing quickly, holding a key down, or pasting — it sees `"k\r"`, recognises neither,
 * and reports it as ordinary text with every key flag false. Measured through a pty: a `k`
 * followed a full second later by Enter arrived as one chunk, and the window ignored both
 * of them. The same shape is why a pasted token has to be split in AskSecret.
 *
 * So a chunk is taken apart here, once, and every screen above receives named presses. The
 * alternative — each screen testing `input === "k"` and hoping — is how a full-screen
 * program becomes intermittently deaf.
 */
export type Press =
  | { name: "up" | "down" | "left" | "right" | "enter" | "escape" | "quit" }
  | { name: "char"; ch: string };

export function useKeys(on: (press: Press) => void, isActive = true): void {
  useInput(
    (input, key) => {
      // Ctrl-C first, and never as a character: Ink is told not to exit on it, so every
      // screen that takes the keyboard has to honour it or there is no way out.
      if (key.ctrl && input === "c") return on({ name: "quit" });

      // A key Ink did recognise. These arrive alone, with `input` empty.
      if (key.upArrow) return on({ name: "up" });
      if (key.downArrow) return on({ name: "down" });
      if (key.leftArrow) return on({ name: "left" });
      if (key.rightArrow) return on({ name: "right" });
      if (key.return) return on({ name: "enter" });
      if (key.escape) return on({ name: "escape" });
      if (key.ctrl || key.meta) return;

      // Anything else is text, and may be more than one keystroke of it.
      for (const ch of input) {
        if (ch === "\r" || ch === "\n") on({ name: "enter" });
        else if (ch === "\u001B") on({ name: "escape" });
        else on({ name: "char", ch });
      }
    },
    { isActive },
  );
}
