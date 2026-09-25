import type { Terminal as Xterm } from "@xterm/xterm"
import { WebglAddon } from "@xterm/addon-webgl"

/**
 * What makes the web terminal feel like the one in the dock, rather than a text area that
 * happens to show a shell.
 *
 * All of it is browser-side and none of it is layout, which is why it is here and not in
 * components/terminal.tsx: that file decides where the box is and what happens to it on a
 * phone, and every function below is about what the box DOES once a finger, a wheel or a
 * key reaches it. They take the terminal and an AbortSignal, and every listener they add
 * dies with the connection that opened them.
 *
 * The one rule they share: nothing here re-implements what xterm already does. A browser
 * that focuses the hidden textarea already pastes on Cmd-V and copies on Cmd-C, because
 * those are the `paste` and `copy` events of any text field and xterm handles both. What
 * is written here is what a BROWSER does not have - a GPU renderer, a clipboard a remote
 * program can reach, a wheel notch worth more than one line, and the three keystrokes a
 * terminal application owns that a browser would otherwise take.
 */

/** The mac is the only platform where the modifier is Cmd; everywhere else it is Ctrl-Shift. */
export const ON_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * The height of one row, in pixels, whatever is painting them.
 *
 * NOT the first child of `.xterm-rows`, which is what this used to be measured from: those
 * row divs are the DOM renderer's, and on the GPU there is a canvas and nothing else - the
 * query returns null, the fallback of 16 px stands in for a cell that may be 17 or 22, and
 * a gesture scrolls by the wrong amount for the rest of the session. The screen's own box
 * divided by the number of rows is the same number, and it is the same number under every
 * renderer.
 */
export function rowHeight(xterm: Xterm): number {
  const screen = xterm.element?.querySelector<HTMLElement>(".xterm-screen")
  const height = screen?.getBoundingClientRect().height ?? 0
  if (height <= 0 || xterm.rows <= 0) return 16
  return height / xterm.rows
}

/**
 * What a synthetic notch has to carry to be worth a notch, given a row that tall.
 *
 * xterm does not read a wheel event's sign alone, and this is the second half of the note
 * in components/terminal.tsx that says it does. `consumeWheelEvent` turns pixels into rows,
 * and then - measured in @xterm/xterm 6.0.0, `Math.abs(ev.deltaY) < 50 && (r *= .3)` -
 * DAMPS anything under 50 px to a third of itself, which is how a trackpad's stream of
 * four-pixel deltas is kept from flying. Under a row's worth the remainder is carried, so
 * nothing is lost; what is lost is the one-event-one-notch relation this whole path is
 * built on. Dispatched at one row's height, a notch came out at 0.3 of a row: measured on
 * 20/09 against a live mouse protocol, 19 notches sent and 7 reports on the wire, and a
 * flick that should have moved 19 lines moved 7.
 *
 * So a notch is sent as at least 51 px, and never less than a row - a row taller than that
 * would otherwise round to nothing and be carried for ever.
 */
export function notchPixels(row: number): number {
  return Math.max(51, row)
}

/**
 * The renderer, on the GPU when there is one.
 *
 * The DOM renderer xterm falls back to builds a `<span>` per run of identical cells and
 * lets the browser lay them out: an 80x50 screen redrawing at the rate a build log arrives
 * is thousands of style recalculations a second, and what it costs is not frames but
 * LATENCY - the keystroke waits behind the layout of the line before it. WebGL draws the
 * same screen as one textured quad per cell in a single pass, which is what every native
 * terminal has done since they stopped being teletypes.
 *
 * Three things can go wrong, and each has one honest answer:
 *
 *   - no WebGL2 at all (an old browser, a blocklisted driver, a VM): loadAddon throws, and
 *     the DOM renderer that is already running stays. Caught, not reported: the terminal
 *     works, it is only slower.
 *   - the context is LOST while running - the machine sleeps, the driver resets, another
 *     tab takes the last context. The addon cannot recover it, and a disposed addon leaves
 *     xterm on the DOM renderer, drawing correctly. Disposing on loss is what the addon's
 *     own documentation asks for; not doing it leaves a black rectangle.
 *   - the canvas is restored later. Not handled: a second addon here would be a renderer
 *     swap under a live session for a frame's worth of gain.
 */
export function paintOnGpu(xterm: Xterm): void {
  let webgl: WebglAddon
  try {
    webgl = new WebglAddon()
  } catch {
    return
  }
  webgl.onContextLoss(() => webgl.dispose())
  try {
    xterm.loadAddon(webgl)
  } catch {
    // No WebGL2 on this machine. The DOM renderer is already drawing; nothing to undo.
    webgl.dispose()
  }
}

/**
 * OSC 52, which is how a program on the machine reaches the clipboard of the person
 * reading it.
 *
 * `tmux` with `set-clipboard on` emits it whenever a selection is copied, so dragging
 * across a tmux pane - which is tmux's selection, not the browser's, since `mouse on` takes
 * the drag - lands in the Mac's pasteboard exactly as it would in iTerm. `pbcopy` over
 * `devbox ssh` has no equivalent; this is the one that works through a browser.
 *
 * Two refusals, and they are the whole security of accepting this sequence at all:
 *
 *   - A QUERY (`\x1b]52;c;?\x07`) is answered with silence rather than with the clipboard.
 *     Replying would let anything running on the machine - including something that arrived
 *     in a dependency - read what the person last copied on their own laptop, which may be
 *     the password they were pasting into another tab. It is handled (true) rather than
 *     passed on, so nothing further tries to answer it either.
 *   - A payload over 64 KiB is dropped. A clipboard write is not a channel for exfiltrating
 *     a file to the reader's laptop, and nothing a human copies out of a terminal is that
 *     long.
 *
 * The write itself can be refused by the browser - Safari wants a user gesture for
 * `writeText` and this has none - and a refusal is silent by design: the alternative is a
 * terminal that interrupts with a dialog because a shell ran `tmux copy`.
 */
export function acceptRemoteCopies(xterm: Xterm): void {
  const LIMIT = 64 * 1024
  xterm.parser.registerOscHandler(52, (payload: string) => {
    const semicolon = payload.indexOf(";")
    if (semicolon < 0) return true
    const data = payload.slice(semicolon + 1)
    if (data === "?" || data === "") return true
    if (data.length > LIMIT) return true
    let text: string
    try {
      // atob gives bytes, one per code unit; the terminal's own decoder turns them back
      // into the characters they were - a path an accented word takes and `atob` alone
      // would mangle.
      const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
      text = new TextDecoder().decode(bytes)
    } catch {
      return true
    }
    void navigator.clipboard?.writeText(text).catch(() => {})
    return true
  })
}

/**
 * The selection, in the clipboard, without a keystroke - and only the selection a HAND made.
 *
 * It is what iTerm and Terminal.app do out of the box, and on a screen whose only other copy
 * gesture is a modifier a phone does not have it is the difference between reading an address
 * and using it. The tmux half of the same behaviour arrives through OSC 52 above; this is the
 * half for a machine with no tmux, where the selection is xterm's own.
 *
 * Hung on the mouse and NOT on `onSelectionChange`, which is where this started and which was
 * wrong in two ways that both stomp on something the reader owns. `findNext` selects each match
 * it lands on, so walking a search with Enter would have left the last match in the clipboard -
 * and what was in it is usually what the search is for. Cmd-A selects the whole buffer, which
 * would have put a screenful of build log over it. Neither is a copy anybody asked for. A drag,
 * a double click and a triple click are, and they all end in a `mouseup`.
 *
 * On the NEXT task rather than in the handler: xterm finishes its selection in its own mouseup
 * listener, which may run after this one, and a timeout of zero reads what the gesture actually
 * left. And on the document, because a drag that started in the grid regularly ends outside it -
 * that is what dragging past the last line is.
 *
 * Only when the document has the focus. A background tab writing to the clipboard is what the
 * permission exists to stop, and Chrome refuses it anyway; asking first keeps the console clean.
 */
export function copyOnSelect(
  xterm: Xterm,
  container: HTMLElement,
  signal: AbortSignal
): void {
  let dragging = false
  container.addEventListener("mousedown", () => (dragging = true), { signal })
  document.addEventListener(
    "mouseup",
    () => {
      if (!dragging) return
      dragging = false
      setTimeout(() => {
        const text = xterm.getSelection()
        if (text === "" || !document.hasFocus()) return
        void navigator.clipboard?.writeText(text).catch(() => {})
      }, 0)
    },
    { signal }
  )
}

/**
 * The middle button pastes, as it has on every terminal since X11.
 *
 * What it pastes is the terminal's own selection when there is one, and the clipboard
 * otherwise. The web has no access to the PRIMARY selection - the thing a middle click
 * actually pastes on Linux - so this is the closest honest equivalent: the text the reader
 * has just highlighted is the text they expect.
 *
 * `auxclick` and not `mouseup`: the middle button's click event is `auxclick` in every
 * browser since 2017, and `mousedown` would paste before the button is released.
 * preventDefault stops Chrome's own autoscroll, which otherwise turns the pointer into a
 * scroll puck over the grid.
 */
export function middleClickPastes(
  xterm: Xterm,
  container: HTMLElement,
  paste: (text: string) => void,
  signal: AbortSignal
): void {
  container.addEventListener(
    "auxclick",
    (event: MouseEvent) => {
      if (event.button !== 1) return
      event.preventDefault()
      const selected = xterm.getSelection()
      if (selected !== "") {
        paste(selected)
        return
      }
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text !== "") paste(text)
        })
        .catch(() => {})
    },
    { signal }
  )
  // Without this the browser's own middle-click behaviours (autoscroll on Windows and
  // Linux, nothing at all on a Mac) fire on the way down, before auxclick.
  container.addEventListener(
    "mousedown",
    (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault()
    },
    { signal }
  )
}

/**
 * A wheel notch worth what a wheel notch is worth, while an application is tracking the
 * mouse.
 *
 * The mouse protocol has no magnitude: xterm reads the SIGN of a wheel event and sends one
 * notch, and tmux answers a notch with one line. So the fastest flick of a mouse walks a
 * tmux history one line at a time, which is the desk-bound half of the report a finger
 * already had an answer for in components/terminal.tsx - and the answer is the same one,
 * the same synthetic notches, measured here from the wheel's own delta instead of from the
 * travel of a thumb.
 *
 * Only while tracking. Without it the grid is xterm's own buffer, the event carries its
 * pixels all the way into xterm's scroll arithmetic, and it already scrolls by as much as
 * the page would - to multiply there would be to make the terminal the one box on this
 * dashboard that scrolls at a different speed from everything else.
 *
 * The original event is stopped rather than let through and topped up, because stopping it
 * is what makes this function the only thing deciding: xterm's listener sits on `.xterm`,
 * a descendant, so a capturing listener here is reached first and `stopPropagation` is all
 * it takes. The notches that go out carry the pointer's own coordinates, which is what the
 * application reads to know WHICH pane the wheel turned over.
 */
export function wheelsScrollLikeAWheel(
  xterm: Xterm,
  container: HTMLElement,
  signal: AbortSignal
): void {
  /** Ours, so the listener below does not multiply what it has just dispatched. */
  const mine = new WeakSet<WheelEvent>()
  /** Pixels that have not yet amounted to a line: a trackpad hands over three at a time. */
  let carried = 0

  container.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      if (mine.has(event)) return
      if (xterm.modes.mouseTrackingMode === "none") return
      const element = xterm.element
      if (!element) return

      const line = rowHeight(xterm)
      // Three deltaModes, and only the first is what a browser normally sends. DOM_DELTA_LINE
      // comes from some Windows mice and DOM_DELTA_PAGE from almost nothing, but reading
      // either as pixels would make one notch scroll three lines and the other three
      // thousand.
      const pixels =
        event.deltaMode === 1
          ? event.deltaY * line
          : event.deltaMode === 2
            ? event.deltaY * xterm.rows * line
            : event.deltaY

      event.stopPropagation()
      event.preventDefault()

      const reach = notchPixels(line)
      carried += pixels
      let notches = Math.trunc(carried / line)
      if (notches === 0) return
      carried -= notches * line
      // A flick of a free-spinning wheel hands over thousands of pixels in one event, and
      // every notch is a round trip and a redraw at the other end.
      notches = Math.max(-24, Math.min(24, notches))

      for (let done = 0; done < Math.abs(notches); done += 1) {
        const notch = new WheelEvent("wheel", {
          deltaY: notches < 0 ? -reach : reach,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
        })
        mine.add(notch)
        element.dispatchEvent(notch)
      }
    },
    // Not passive: this one calls preventDefault, and a passive listener that does is a
    // console warning and a page that scrolls under the terminal.
    { capture: true, passive: false, signal }
  )
}

/** What the three keystrokes a browser would otherwise take are asked to do instead. */
export type Shortcuts = {
  /** Cmd-F, or Ctrl-Shift-F: the search bar. */
  find: () => void
  /** Ctrl-Shift-C, where Cmd-C is not a thing. */
  copy: () => void
  /** Ctrl-Shift-V, same. */
  paste: () => void
}

/**
 * The keys this page claims, and the far longer list it deliberately does not.
 *
 * Everything a terminal owns stays with the terminal, which is why this handler is written
 * as four cases and a `true`: Ctrl-C is an interrupt and not a copy, Ctrl-A is the start of
 * the line and not a select-all, Ctrl-W deletes a word and must never close the tab. The
 * modifier that reaches this dashboard instead is the platform's own - Cmd on a Mac, where
 * the terminal has never had a claim on it, and Ctrl-SHIFT everywhere else, which is the
 * pair every Linux terminal has used for exactly this reason.
 *
 * Cmd-K clears, and what that means depends on which screen is in front. On the normal
 * screen it is xterm's own buffer, scrollback included, which is what Cmd-K does in iTerm.
 * On the ALTERNATE screen - tmux, vim, a pager - the buffer holds nothing to clear and the
 * application owns the grid, so what goes out is Ctrl-L, the redraw those same programs
 * answer to. Clearing xterm there would have looked like a key that does nothing.
 *
 * Returning false is what stops the browser: xterm asks this handler before it encodes the
 * key, and a false keeps it from sending anything AND lets us preventDefault so Chrome does
 * not open its own find bar over the grid.
 */
export function claimKeys(xterm: Xterm, shortcuts: Shortcuts, type: (text: string) => void): void {
  xterm.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true
    const ours = ON_MAC
      ? event.metaKey && !event.ctrlKey && !event.altKey
      : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey
    if (!ours) return true

    const key = event.key.toLowerCase()
    const done = () => {
      event.preventDefault()
      return false
    }

    if (key === "f") {
      shortcuts.find()
      return done()
    }
    if (key === "k") {
      if (xterm.buffer.active.type === "normal") {
        xterm.clear()
      } else {
        type("\x0c")
      }
      return done()
    }
    // On a Mac these two are the browser's own and they already do the right thing in a
    // text field: xterm's `copy` and `paste` handlers are what answer them, so claiming
    // them here would replace a working path with a clipboard permission prompt.
    if (!ON_MAC && key === "c" && xterm.hasSelection()) {
      shortcuts.copy()
      return done()
    }
    if (!ON_MAC && key === "v") {
      shortcuts.paste()
      return done()
    }
    if (ON_MAC && key === "a") {
      xterm.selectAll()
      return done()
    }
    return true
  })
}
