import * as React from "react"
import {
  ChevronDownIcon,
  ChevronUpIcon,
  MaximizeIcon,
  MinimizeIcon,
  SearchIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal as Xterm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import { useSession } from "@/components/session"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { connect, whyRefused, type Wire } from "@/lib/terminal"
import {
  acceptRemoteCopies,
  claimKeys,
  copyOnSelect,
  middleClickPastes,
  notchPixels,
  ON_MAC,
  paintOnGpu,
  rowHeight,
  wheelsScrollLikeAWheel,
} from "@/lib/terminal-native"
import { cn } from "@/lib/utils"

/**
 * A shell on the machine, in this page.
 *
 * WHY IT DOES NOT CONNECT ON ITS OWN. This screen is opened as often to read a price or
 * copy an address as to work on the machine, and every connection costs one of the four
 * the server holds. So the card is a button until it is asked.
 *
 * What runs on the other end is `tmux new -A -s devbox`, chosen in src/terminal.ts: a closed
 * tab, a locked phone or a tunnel costs the view and not the work, and the next connection
 * lands back in the same session. It is the one thing a plain SSH client does not do.
 *
 * The colours are GitHub Dark Dimmed, Primer's own values, written out rather than read
 * from the theme's variables - and that is not laziness twice over. The dashboard's tokens
 * are `oklch()`, which xterm's colour parser does not know; and a terminal is not a card,
 * it keeps one surface in both themes the way a code block does.
 *
 * WHICH surface is what changed on 27/08. It was #0a0a0a, the page's own near-black, so the
 * terminal disappeared into the card holding it - a hole rather than a panel. Dimmed sits a
 * shade above the page, blue-grey rather than black, and reads as a thing set into it.
 *
 * To change it, change this object AND the two `bg-[#22272e]` below - full page's own
 * surface and the blind behind it. Tailwind reads class names as literals before this file
 * ever runs, so those two cannot say SURFACE; they are the only places that repeat it, and
 * they are marked. Everything else takes it from here.
 */
const SURFACE = "#22272e"

const THEME = {
  background: SURFACE,
  foreground: "#adbac7",
  cursor: "#539bf5",
  cursorAccent: SURFACE,
  // Eight digits: the last two are the alpha a selection needs to keep its text readable.
  selectionBackground: "#539bf54d",
  // Dimmer while the terminal does not have the focus, which is what every native terminal
  // does and what tells a selection you have just made from one left behind an hour ago.
  selectionInactiveBackground: "#539bf526",
  black: "#545d68",
  red: "#f47067",
  green: "#57ab5a",
  yellow: "#c69026",
  blue: "#539bf5",
  magenta: "#b083f0",
  cyan: "#39c5cf",
  white: "#909dab",
  brightBlack: "#636e7b",
  brightRed: "#ff938a",
  brightGreen: "#6bc46d",
  brightYellow: "#daaa3f",
  brightBlue: "#6cb6ff",
  brightMagenta: "#dcbdfb",
  brightCyan: "#56d4dd",
  brightWhite: "#cdd9e5",
}

/**
 * Under this, the screen is a phone's and this component stops offering choices it cannot
 * honour. 480 px, which is the width the font size was already measured against.
 */
const PHONE = 480

/**
 * The font size, from the width alone.
 *
 * Measured in a 390 px viewport, which is an iPhone's: 13 px leaves 28 columns, and 28
 * columns is where `ls -l` and a git status start wrapping into nonsense. 11 px buys
 * forty-odd, which is what a mobile SSH client gives.
 */
const fontFor = (width: number): number => (width < PHONE ? 11 : 13)

/**
 * fit(), and then the columns fit() refused to count.
 *
 * FitAddon subtracts a flat 14 px from the width before dividing by the cell, whenever
 * `scrollback` is not 0 - it is holding room for the overview ruler, which this terminal
 * does not enable and which therefore draws nothing there. Read it in
 * @xterm/addon-fit's proposeDimensions: `options.overviewRuler?.width || 14`, and note the
 * `|| 14` - declaring a width of 0 asks for 14, so the option cannot turn it off.
 *
 * Those 14 px, plus what is left of a cell that does not divide the width, are what the
 * report of 29/08 was: a grey band down the right-hand side of full page. Measured on a
 * 390 px viewport, 56 columns where 58 fit, and 19 px of THEME.background beside a TUI
 * painting its own. The eye reads that as a frame; it is unclaimed grid.
 *
 * Reclaimed by measuring rather than by adding 14 back. The cell width comes from the grid
 * the addon has just laid out, so whatever it holds back - now, or after an upgrade that
 * changes the number - what is asked for is what fits. And the scrollbar is subtracted as
 * the browser actually charges for it: `overflow-y: scroll` in xterm's own CSS costs 15 px
 * of client width where scrollbars are classic, and nothing at all where they overlay,
 * which is every iPhone and most Macs. Reclaiming a fixed 19 px would have put two columns
 * under the scrollbar on Windows.
 */
function fitFully(fit: FitAddon, xterm: Xterm, container: HTMLElement): void {
  fit.fit()
  const element = xterm.element
  if (!element) return
  const screen = element.querySelector<HTMLElement>(".xterm-screen")
  const viewport = element.querySelector<HTMLElement>(".xterm-viewport")
  if (screen === null || xterm.cols <= 0) return
  const grid = screen.getBoundingClientRect().width
  if (grid <= 0) return
  const scrollbar =
    viewport === null ? 0 : viewport.offsetWidth - viewport.clientWidth
  const spare = container.getBoundingClientRect().width - grid - scrollbar
  const extra = Math.floor(spare / (grid / xterm.cols))
  if (extra > 0) xterm.resize(xterm.cols + extra, xterm.rows)
}

/**
 * How many lines the history moves per line the finger travels.
 *
 * In mouse mode one wheel event is ONE notch whatever its delta - xterm reads the sign and
 * nothing else - and tmux answers a notch with a line. So the history moved exactly as far
 * as the finger: a full swipe for one screenful, which is what "very slow" meant when this
 * was first measured. Three is the ratio a native list scrolls at, and it makes one swipe
 * three screens.
 */
const SCROLL_SPEED = 4

/**
 * What is left of the glide's speed after 16 ms, once the finger is off.
 *
 * 0.95 runs for roughly a second and a half from a firm flick, which is what a list on this
 * phone does. Lower stops sooner and reads as friction; higher overshoots and the thumb
 * spends its time catching the terminal.
 */
const FRICTION = 0.95

/** What the server's sentences are written in, so they are not mistaken for output. */
const NOTICE = (text: string) => `\r\n\x1b[33m${text}\x1b[0m\r\n`

/**
 * A match, and the one the bar is standing on.
 *
 * Yellow rather than the selection's blue: a search runs while a selection may still be on
 * screen, and two things highlighted the same colour is a bar that says 3/9 over a screen
 * where nothing can be counted. The overview ruler colours are not decoration either -
 * they are the only way to see that the other six matches are above the fold.
 *
 * What it can find is what xterm holds, which on the alternate screen - tmux, vim, a pager
 * - is the visible grid and nothing more. The history is tmux's there, and tmux has its own
 * search over it; this is the one for a machine without it, and for the screen in front.
 */
const FOUND = {
  decorations: {
    matchBackground: "#c6902640",
    matchBorder: "#c6902600",
    matchOverviewRuler: "#c69026",
    activeMatchBackground: "#c69026a0",
    activeMatchBorder: "#daaa3f",
    activeMatchColorOverviewRuler: "#daaa3f",
  },
}

type State = "idle" | "connecting" | "open" | "closed"

export function MachineTerminal({ machine }: { machine: string }) {
  const { session } = useSession()
  const csrf = session?.csrf ?? ""

  const host = React.useRef<HTMLDivElement | null>(null)
  /** The full-page layer itself, which the visual viewport drives. See the effect below. */
  const layer = React.useRef<HTMLDivElement | null>(null)
  const term = React.useRef<Xterm | null>(null)
  const wire = React.useRef<Wire | null>(null)
  const watcher = React.useRef<ResizeObserver | null>(null)
  const fitter = React.useRef<FitAddon | null>(null)
  const finder = React.useRef<SearchAddon | null>(null)
  /** The search bar's field, so Cmd-F reaches it from inside the grid. */
  const needle = React.useRef<HTMLInputElement | null>(null)
  /** Ctrl is a modifier nobody has on a phone, so it is a key that arms the next one. */
  const ctrl = React.useRef(false)
  /**
   * Which connection is the current one.
   *
   * A socket closes a moment AFTER it is asked to, and by then the button that asked may
   * already have opened another. Without this the first one's `onClose` arrives late and
   * writes "Disconnected." over a session that is connecting - measured on 26/08, where
   * Disconnect left the card showing Reconnect instead of Connect.
   */
  const generation = React.useRef(0)

  /**
   * The last size the pty was told, so it is not told again for nothing.
   *
   * visualViewport fires in a burst for the whole 300 ms an iOS keyboard takes to rise.
   * Without this each tick is a SIGWINCH, and vim redraws itself thirty times on the way up.
   */
  const sent = React.useRef({ cols: 0, rows: 0 })

  /** Removes the touch listeners of the connection being torn down. */
  const fingers = React.useRef<AbortController | null>(null)

  /** Whether the reader has used the toggle. From then on, `open` stops deciding for them. */
  const decided = React.useRef(false)

  const [state, setState] = React.useState<State>("idle")
  const [armed, setArmed] = React.useState(false)
  const [full, setFull] = React.useState(false)
  /** What the shell calls itself, out of OSC 0/2: a native terminal names its tab. */
  const [title, setTitle] = React.useState<string | null>(null)
  const [finding, setFinding] = React.useState(false)
  const [query, setQuery] = React.useState("")
  /** The bar's own count: xterm reports it, this only renders it. */
  const [hits, setHits] = React.useState({ index: -1, count: 0 })

  /** Tells the pty its size, and only when it changed. */
  const tell = React.useCallback(() => {
    const xterm = term.current
    if (xterm === null) return
    if (xterm.cols === sent.current.cols && xterm.rows === sent.current.rows)
      return
    sent.current = { cols: xterm.cols, rows: xterm.rows }
    wire.current?.resize(xterm.cols, xterm.rows)
  }, [])

  const teardown = React.useCallback(() => {
    generation.current += 1
    watcher.current?.disconnect()
    watcher.current = null
    fingers.current?.abort()
    fingers.current = null
    fitter.current = null
    // Not disposed: xterm.dispose() disposes the addons it loaded, and a second dispose on
    // the search addon throws on its own decorations.
    finder.current = null
    setFinding(false)
    setHits({ index: -1, count: 0 })
    setTitle(null)
    wire.current?.close()
    wire.current = null
    term.current?.dispose()
    term.current = null
  }, [])

  React.useEffect(() => teardown, [teardown])

  /**
   * Full page, in CSS and not through the Fullscreen API.
   *
   * `requestFullscreen` does not exist on an iPhone for anything but a video, and the phone
   * is where a terminal most needs the whole screen. A fixed layer costs nothing anywhere
   * else and behaves identically in both themes.
   *
   * Escape does NOT leave it: in a terminal Escape belongs to whatever is running - vim, a
   * pager, a menu - and stealing it would make the one key you cannot type the one that
   * closes your screen. The button is the way out, and it stays visible.
   */
  React.useEffect(() => {
    if (!full) return
    const root = document.documentElement
    const previous = document.body.style.overflow
    const chaining = root.style.overscrollBehavior
    document.body.style.overflow = "hidden"
    // `overflow: hidden` alone is not a scroll lock on iOS, measured 27/08: the document
    // behind this layer kept 682 px of scroll range. What actually reaches it is the
    // rubber-band out of .xterm-viewport - a scrolling box holding 5000 lines - and this
    // is what cuts the chain. index.css does the same on the viewport itself, since the
    // chaining starts there.
    root.style.overscrollBehavior = "none"
    // And this is what makes those 682 px harmless whatever iOS does with the layer's
    // frame: while this attribute is set, #root is not painted. See index.css.
    root.dataset.terminalFull = ""
    return () => {
      document.body.style.overflow = previous
      root.style.overscrollBehavior = chaining
      delete root.dataset.terminalFull
    }
  }, [full])

  /**
   * The layer is measured against the VISUAL viewport, and this is what makes it usable on
   * a phone at all.
   *
   * `position: fixed` resolves against the layout viewport, and an iOS keyboard does not
   * shrink that one - it shrinks the visual viewport and slides it, leaving the fixed layer
   * where it was. Measured on 27/08 at 390x844: of a layer 844 px tall, a 336 px keyboard
   * hides the bottom 40%, half the terminal, and the caret line entirely. You type blind,
   * the header with the only way out is pushed off the top, and what shows around the edges
   * is the page underneath. Every symptom of that report is this one fact.
   *
   * So the geometry is read rather than declared. `scroll` matters as much as `resize`:
   * Safari slides the visual viewport inside the layout one to keep the caret above the
   * keyboard, and a layer that only tracked the height would be the right size in the wrong
   * place.
   *
   * `top`/`left` and not `transform`: a transform would make this layer a containing block
   * for its own fixed descendants. There are none today; there is no reason to lay the trap.
   *
   * No fit() here. Changing the layer's height changes the host's, which the ResizeObserver
   * in `open` already watches - and that observer is exactly what never fired before, since
   * nothing in the layout moved when the keyboard arrived.
   */
  React.useEffect(() => {
    const view = window.visualViewport
    const box = layer.current
    if (!full || box === null || !view) return

    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        box.style.height = `${view.height}px`
        box.style.width = `${view.width}px`
        box.style.top = `${view.offsetTop}px`
        box.style.left = `${view.offsetLeft}px`
      })
    }

    view.addEventListener("resize", sync)
    view.addEventListener("scroll", sync)
    sync()
    return () => {
      cancelAnimationFrame(frame)
      view.removeEventListener("resize", sync)
      view.removeEventListener("scroll", sync)
      box.style.height = box.style.width = box.style.top = box.style.left = ""
    }
  }, [full])

  // The size changed under xterm without the container being resized by a layout it can
  // observe: refit on the next frame, once the fixed layer has been laid out.
  React.useEffect(() => {
    if (term.current === null) return
    const frame = requestAnimationFrame(() => {
      const fit = fitter.current
      const xterm = term.current
      const container = host.current
      if (fit !== null && xterm !== null && container !== null) {
        fitFully(fit, xterm, container)
      }
      tell()
    })
    return () => cancelAnimationFrame(frame)
  }, [full, tell])

  const open = React.useCallback(() => {
    const container = host.current
    if (container === null || term.current !== null) return

    const mine = ++generation.current
    // Ctrl is a mode, and it survived a teardown: the button came back already lit and the
    // first key of the NEXT session went through control() - a `c` became a SIGINT on a
    // shell nobody had finished attaching to.
    ctrl.current = false
    setArmed(false)
    setState("connecting")
    // A phone goes straight to full page, and it is not a convenience. Measured 27/08: the
    // card mode runs 34 px past the fold on a 390x844 screen and 114 px on a 375x667 one,
    // so on a phone it is a terminal you scroll to see - and scrolling to see the bottom is
    // what takes the buttons off the top. There is no size of phone where that mode works.
    // Only until the reader has said otherwise. `open` is also what Reconnect calls, so
    // without the guard a dropped line put someone back into full page every time, undoing
    // a choice they had made explicitly.
    if (!decided.current && window.innerWidth < PHONE) setFull(true)
    const xterm = new Xterm({
      theme: THEME,
      // Measured in a 390 px viewport, which is an iPhone's: 13 px leaves 28 columns, and
      // 28 columns is where `ls -l` and a git status start wrapping into nonsense. 11 px
      // buys forty-odd, which is what a mobile SSH client gives.
      fontSize: fontFor(window.innerWidth),
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      cursorBlink: true,
      // A block, and an empty one when the focus is elsewhere. That pair is how a terminal
      // on this machine says whether the next key lands in it, and on a page where the
      // focus can be in a search field, a button or the grid it is the only thing that
      // does - there is no title bar here to go grey.
      cursorStyle: "block",
      cursorInactiveStyle: "outline",
      // Unicode 11 needs it, and it is the only proposed API this file touches.
      allowProposedApi: true,
      // What a Mac does: the word under the pointer is selected before the menu opens, so
      // right-clicking a path and copying it is two gestures rather than a drag.
      rightClickSelectsWord: true,
      // NOT `macOptionIsMeta`, which is where this stopped being a copy of iTerm's defaults
      // on purpose. iTerm ships Option as "normal" for the same reason: on a French Mac
      // keyboard `{`, `}`, `[`, `]`, `|`, `\` and `@` are all Option chords, and sending
      // ESC before them instead would take the six characters a shell is written with off
      // the keyboard. Option-Left and Option-Right still walk words - an arrow is not a
      // printable key, so xterm encodes the modifier whatever this option says.
      macOptionIsMeta: false,
      // A held-down arrow key in a pager arrives faster than a frame, and a terminal that
      // animated each line would be a terminal permanently one screen behind the key.
      smoothScrollDuration: 0,
      // A terminal that scrolls is a terminal one can read backwards; tmux has its own
      // buffer, but a plain shell on a machine without it has only this one.
      scrollback: 5000,
      // iOS shows no keyboard for a canvas: xterm's hidden textarea is what summons it.
      screenReaderMode: false,
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    fitter.current = fit

    /**
     * Unicode 11, before anything is written.
     *
     * Without it xterm measures a string the way a browser's `length` does, and everything
     * a modern shell prints is two cells wide where it counts one: a starship prompt, the
     * green tick of a test run, a CJK path. The symptom is not a glyph but a LINE - the
     * cursor sits one column left of where the machine believes it is, and every redraw
     * after it lands in the wrong place.
     */
    const unicode = new Unicode11Addon()
    xterm.loadAddon(unicode)
    xterm.unicode.activeVersion = "11"

    /**
     * A URL is a link, which is the one thing a terminal in a browser can do that the one
     * in the dock cannot.
     *
     * `noopener,noreferrer` and not the addon's default: what is being clicked came out of
     * a machine, and a page opened from here must not hold a handle on this one - a
     * dashboard with a live session and a CSRF token in it.
     */
    xterm.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        window.open(uri, "_blank", "noopener,noreferrer")
      })
    )

    const search = new SearchAddon()
    xterm.loadAddon(search)
    finder.current = search
    search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setHits({ index: resultIndex, count: resultCount })
    )

    xterm.open(container)
    // After open(), which is where there is a canvas to take a context on.
    paintOnGpu(xterm)
    fitFully(fit, xterm, container)
    term.current = xterm

    // What the shell says it is, in the card's title. tmux keeps it up to date with the
    // running command, which is how a terminal says `vim` without being asked.
    xterm.onTitleChange((said) => {
      if (generation.current === mine) setTitle(said.trim() === "" ? null : said)
    })
    // Said in the terminal, because full page has no title and a phone is put into it
    // before the session exists: what it showed between Connect and the first prompt was a
    // black rectangle naming no machine. The yellow channel already exists for this.
    xterm.write(NOTICE(`Connecting to ${machine}…`))

    const socket = connect(machine, csrf, {
      onOpen: () => {
        // The same guard onClose carries. Reconnect tears down and opens in one go, and a
        // dying socket's onopen was still able to land: the UI went to "open" while the new
        // connection was still connecting, and every key fell into a socket that drops what
        // it is given before it is OPEN.
        if (generation.current !== mine) return
        setState("open")
        // What the browser measured, before the first prompt is drawn on 80x24.
        sent.current = { cols: xterm.cols, rows: xterm.rows }
        socket.resize(xterm.cols, xterm.rows)
        // Not on a phone. focus() puts the caret in xterm's hidden textarea, iOS answers
        // with the keyboard and a scroll to reveal it, and both land before the full-page
        // layer has been laid out. The first tap on the terminal opens it, at the moment
        // someone means to type.
        if (window.innerWidth >= PHONE) xterm.focus()
      },
      // Through `term.current` and not the local `xterm`: frames already in flight are
      // still delivered while a socket closes, and xterm's write has no disposed guard -
      // it would write into services that have been torn down.
      onData: (chunk) => {
        if (generation.current === mine) term.current?.write(chunk)
      },
      onNotice: (text) => {
        if (generation.current === mine) term.current?.write(NOTICE(text))
      },
      onClose: async (reason) => {
        if (generation.current !== mine) return
        setState("closed")
        // Refused before it opened: the browser knows nothing about why, so ask the
        // address itself. See lib/terminal.ts#whyRefused.
        const said = reason ?? (await whyRefused(machine, csrf))
        if (generation.current !== mine) return
        term.current?.write(NOTICE(said ?? "Disconnected."))
      },
    })
    wire.current = socket

    xterm.onData((text) => {
      if (ctrl.current) {
        ctrl.current = false
        setArmed(false)
        socket.type(control(text))
        return
      }
      socket.type(text)
    })

    // The window, the phone turning, the keyboard arriving and leaving: all of them change
    // the number of columns, and a pty that is not told draws the last line over the one
    // before it. This is the whole reason the server speaks ssh2 rather than spawning
    // `ssh -tt`, which has no local terminal whose size it could propagate.
    const observer = new ResizeObserver(() => {
      if (term.current === null) return
      // The font is decided by the width, and the width changes when the phone turns.
      // Measured 27/08: rotating to landscape left 11 px on a viewport the code would have
      // given 13, because this was read once inside `open` and never again.
      const wanted = fontFor(window.innerWidth)
      if (xterm.options.fontSize !== wanted) xterm.options.fontSize = wanted
      fitFully(fit, xterm, container)
      tell()
    })
    observer.observe(container)
    watcher.current = observer

    /**
     * A finger, turned into the wheel xterm already knows how to send.
     *
     * Measured 27/08 against a live tmux: a synthetic `wheel` walks tmux's history, a
     * synthetic touch changes nothing at all. xterm converts `mousedown`, `mouseup`,
     * `mousemove` and `wheel` into mouse reports and nothing else - there is no touch path
     * in it - so on a phone the whole mouse protocol is unreachable, and `set -g mouse on`
     * alone buys nothing. Meanwhile tmux draws on the alternate screen, so xterm's own
     * scrollback stays empty and there is nothing local to drag either: measured, the
     * viewport's scrollHeight equals its clientHeight. The finger had nothing to move on
     * either side.
     *
     * A wheel event rather than an escape sequence written here: xterm owns the encoding
     * the application asked for, the cell arithmetic and the coordinates, and reproducing
     * any of that would be a second implementation of it that drifts.
     *
     * Only while the application is tracking the mouse. Without that, xterm's own touch
     * handling scrolls its scrollback, which is the right behaviour on a machine with no
     * tmux, and this must not steal the gesture from it.
     */
    const gestures = new AbortController()

    /**
     * Everything a desk has and a phone does not, wired in one place: lib/terminal-native.ts
     * says why each of these exists. They all die with `gestures`, which is aborted by the
     * teardown, so a reconnect does not leave two of any of them on the same container.
     */
    acceptRemoteCopies(xterm)
    copyOnSelect(xterm, container, gestures.signal)
    middleClickPastes(xterm, container, (text) => socket.type(text), gestures.signal)
    wheelsScrollLikeAWheel(xterm, container, gestures.signal)
    claimKeys(
      xterm,
      {
        find: () => {
          setFinding(true)
          // On the next frame, because the field does not exist until this render lands.
          requestAnimationFrame(() => needle.current?.select())
        },
        copy: () => {
          const text = xterm.getSelection()
          if (text !== "") void navigator.clipboard?.writeText(text).catch(() => {})
        },
        paste: () => {
          void navigator.clipboard
            ?.readText()
            .then((text) => {
              if (text !== "") socket.type(text)
            })
            .catch(() => {})
        },
      },
      (text) => socket.type(text)
    )

    let held: number | null = null
    /** Travel that has not yet amounted to a notch, so a slow drag is not lost. */
    let carried = 0
    /** The height of one row, measured per gesture rather than assumed. */
    let line = 16
    /** Pixels per millisecond, smoothed, in the same sign as `carried`. */
    let speed = 0
    let stamped = 0
    let glide = 0

    /** Turns accumulated travel into notches, and sends them. */
    const roll = (x: number, y: number) => {
      const per = line / SCROLL_SPEED
      let notches = Math.trunc(carried / per)
      if (notches === 0) return
      carried -= notches * per
      // A flick hands over hundreds of pixels in one frame, and every notch is a round
      // trip and a full redraw at the other end.
      notches = Math.max(-24, Math.min(24, notches))

      // Down the screen is back through the history, which is the direction a wheel turns
      // for the same movement.
      //
      // On xterm's own element and not on the host that holds it: xterm listens on
      // `.xterm`, an event dispatched on its parent only bubbles upwards, and the listener
      // never sees it. Measured 27/08 - ten touchmoves became ten wheels that reached
      // nobody, which looks exactly like a gesture that does nothing.
      const target = xterm.element ?? container
      // The magnitude is not free after all: under 50 px xterm keeps three tenths of it.
      // See notchPixels, and the measurement of 20/09 in its note.
      const reach = notchPixels(line)
      for (let done = 0; done < Math.abs(notches); done += 1) {
        target.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY: notches < 0 ? -reach : reach,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
          })
        )
      }
    }

    const halt = () => {
      if (glide !== 0) cancelAnimationFrame(glide)
      glide = 0
      speed = 0
    }

    /**
     * What a released finger leaves behind, and it is most of what "native" means.
     *
     * Without it the history stops the instant the thumb lifts, so reading back a long
     * output is one swipe per screenful and the gesture feels heavy however fast it
     * tracks. Here the last measured speed keeps rolling and decays, which is the same
     * shape iOS gives its own lists.
     *
     * FRICTION is per 16 ms and raised to the frame's real duration, so a dropped frame
     * slows the glide by as much as it lasted rather than by one step.
     */
    const coast = (x: number, y: number) => {
      let previous = performance.now()
      const tick = (now: number) => {
        const dt = Math.min(now - previous, 50)
        previous = now
        speed *= Math.pow(FRICTION, dt / 16)
        carried += speed * dt
        roll(x, y)
        if (Math.abs(speed) < 0.02) return halt()
        glide = requestAnimationFrame(tick)
      }
      glide = requestAnimationFrame(tick)
    }

    container.addEventListener(
      "touchstart",
      (event: TouchEvent) => {
        // A finger down stops a glide, as it does everywhere else on this phone.
        halt()
        held =
          event.touches.length === 1
            ? (event.touches[0]?.clientY ?? null)
            : null
        carried = 0
        stamped = event.timeStamp
        line = rowHeight(xterm)
      },
      { capture: true, passive: true, signal: gestures.signal }
    )
    container.addEventListener(
      "touchmove",
      (event: TouchEvent) => {
        const finger = event.touches[0]
        if (held === null || event.touches.length !== 1 || finger === undefined)
          return
        if (xterm.modes.mouseTrackingMode === "none") return
        // The page must not move under the terminal even on the frames that come to no
        // notch at all, or the gesture stutters between the two.
        event.preventDefault()
        const travelled = held - finger.clientY
        carried += travelled
        held = finger.clientY

        // Smoothed, because one frame's delta is noisy and the release reads the last
        // value: an unsmoothed sample taken as the thumb slows would launch nothing.
        const elapsed = event.timeStamp - stamped
        stamped = event.timeStamp
        if (elapsed > 0) {
          speed = (travelled / elapsed) * 0.6 + speed * 0.4
        }
        roll(finger.clientX, finger.clientY)
      },
      { capture: true, passive: false, signal: gestures.signal }
    )
    container.addEventListener(
      "touchend",
      (event: TouchEvent) => {
        const finger = event.changedTouches[0]
        // A finger that was resting when it lifted meant to stop there.
        if (held !== null && Math.abs(speed) > 0.15 && finger !== undefined) {
          coast(finger.clientX, finger.clientY)
        } else {
          halt()
        }
        held = null
      },
      { capture: true, passive: true, signal: gestures.signal }
    )
    gestures.signal.addEventListener("abort", halt)
    fingers.current = gestures
  }, [csrf, machine, tell])

  /**
   * A key from the bar, through the same path a typed one takes.
   *
   * It used to bypass control() entirely, so an armed Ctrl was neither applied nor spent:
   * Ctrl then Tab sent a plain tab and left Ctrl lit for the next physical keystroke, and
   * Ctrl-A, Ctrl-D, Ctrl-L - the tmux prefix among them - were unreachable from a phone
   * while the button said otherwise.
   */
  /** Back to the card's Connect button, from any state that is not already there. */
  const stop = () => {
    teardown()
    setFull(false)
    setState("idle")
  }

  /**
   * The search, from the bar's three ways of asking for it: Enter, the arrows, and typing.
   *
   * Typing searches as it goes (`incremental`), which is the behaviour that makes a search
   * bar feel like a native one - the first match is highlighted at the third letter, not at
   * the Return. `findNext` from the same position is what incremental means to this addon,
   * so the direction only changes for the arrows and Shift-Enter.
   */
  const find = React.useCallback(
    (text: string, forward: boolean, incremental = false) => {
      const addon = finder.current
      if (addon === null) return
      if (text === "") {
        addon.clearDecorations()
        setHits({ index: -1, count: 0 })
        return
      }
      const options = { ...FOUND, incremental }
      if (forward) addon.findNext(text, options)
      else addon.findPrevious(text, options)
    },
    []
  )

  /** Leaves the bar and gives the keys back to the shell, which is what Escape means here. */
  const stopFinding = React.useCallback(() => {
    finder.current?.clearDecorations()
    setHits({ index: -1, count: 0 })
    setFinding(false)
    term.current?.focus()
  }, [])

  const send = (text: string) => {
    const armed = ctrl.current
    if (armed) {
      ctrl.current = false
      setArmed(false)
    }
    wire.current?.type(armed ? control(text) : text)
  }

  /**
   * Stops a key of the bar from taking the focus, which is what decides the keyboard.
   *
   * The bar writes to the socket directly, so it never needed the focus: `focus()` was
   * called only to give back what the button had just taken, and on a phone that reads as
   * "tapping an arrow summons the keyboard". Preventing the default of `mousedown` - which
   * iOS synthesises after `touchend`, so the tap itself still fires - leaves the focus
   * exactly where it was. Keyboard down stays down; keyboard up stays up, and typing after
   * a Ctrl-C carries on without a second tap.
   *
   * Not on `touchstart`, where preventDefault would cancel the synthesised click and the
   * button would stop working on the very device this is for.
   */
  const keepFocus = (event: React.MouseEvent) => event.preventDefault()

  /**
   * The eight keys a phone keyboard does not have, and without which a terminal on one is
   * a screen to read.
   *
   * A four-column grid, so all eight are RENDERED. They were one row that scrolled
   * sideways until 27/08, and that row was not merely tight: measured, the eight come to
   * 434 px against 322 usable in full page, so no scroll position ever showed them all -
   * bringing the right arrow into view pushed Ctrl, the modifier the others depend on,
   * entirely off the other end. A key nobody can see is a key that does not exist, and
   * nothing announced the scroll either.
   *
   * Two rows cost 52 px, which is four of the 58 lines. That is the price of the two keys
   * that were missing, and it is paid only where the arithmetic forces it: above PHONE the
   * grid is one row of eight again, so landscape, tablets and desktops lose nothing.
   *
   * `w-full` and no `min-w`: the cell decides the width, 73.5 px in portrait, which holds
   * `Ctrl-C` whole. h-11 stays, an arrow was 33 x 28 before 27/08 and that is under half
   * the area a thumb needs.
   */
  const keys =
    state === "open" ? (
      <>
        <Button
          // A filled button, not `secondary`. Armed is a mode that silently changes the
          // NEXT keystroke, and in the dark theme secondary and outline are two greys
          // within a hair of each other.
          variant={armed ? "default" : "outline"}
          className="h-11 w-full"
          onMouseDown={keepFocus}
          onClick={() => {
            ctrl.current = !ctrl.current
            setArmed(ctrl.current)
          }}
        >
          Ctrl
        </Button>
        <Button
          variant="outline"
          className="h-11 w-full"
          onMouseDown={keepFocus}
          onClick={() => send("\t")}
        >
          Tab
        </Button>
        <Button
          variant="outline"
          className="h-11 w-full"
          onMouseDown={keepFocus}
          onClick={() => send("\x1b")}
        >
          Esc
        </Button>
        {/* At the far end of the top row, diagonally opposite the arrow cluster the thumb
            works in: it interrupts what is running, and it used to be the widest button by
            accident of its label. */}
        <Button
          variant="outline"
          className="h-11 w-full"
          onMouseDown={keepFocus}
          onClick={() => send("\x03")}
        >
          Ctrl-C
        </Button>
        {/* The arrows on the lower row, in the order a keyboard has them, closest to the
            thumb. Labelled, since the glyph is the whole button. */}
        <Button
          variant="outline"
          className="h-11 w-full"
          onMouseDown={keepFocus}
          aria-label="Left"
          onClick={() => send("\x1b[D")}
        >
          ←
        </Button>
        <Button
          variant="outline"
          className="h-11 w-full"
          onMouseDown={keepFocus}
          aria-label="Down"
          onClick={() => send("\x1b[B")}
        >
          ↓
        </Button>
        <Button
          variant="outline"
          className="h-11 w-full"
          onMouseDown={keepFocus}
          aria-label="Up"
          onClick={() => send("\x1b[A")}
        >
          ↑
        </Button>
        <Button
          variant="outline"
          className="h-11 w-full"
          onMouseDown={keepFocus}
          aria-label="Right"
          onClick={() => send("\x1b[C")}
        >
          →
        </Button>
      </>
    ) : null

  /**
   * The way out, and in full page it is the only piece of interface that is not terminal.
   *
   * `outline` and not `ghost`: an icon with no border on a dark card does not read as a
   * button, and this is the button the whole layer depends on.
   */
  const toggle = (className: string) =>
    state !== "idle" ? (
      <Button
        variant="outline"
        size="icon-lg"
        className={className}
        aria-label={full ? "Leave full page" : "Full page"}
        onClick={() => {
          decided.current = true
          setFull((current) => !current)
          // Only on the way IN. Leaving is the gesture of someone who wants to read the
          // page again, and focusing the terminal there summons the keyboard over it.
          if (!full) term.current?.focus()
        }}
      >
        {full ? <MinimizeIcon /> : <MaximizeIcon />}
      </Button>
    ) : null

  return (
    <>
      {/* The blind, and it is no longer a guess about where the edges are.
          
          `inset-0` was the guess, and it was wrong twice over: `bottom: 0` is the foot of
          the LAYOUT viewport, which with a keyboard up is not the foot of what one can see.
          This box overhangs by a full viewport at each end instead, so no displacement
          short of a screen height can uncover it - and a fixed box hanging outside the
          viewport adds nothing to the document's scrollable overflow, so it costs no scroll
          range.
          
          Horizontal stays `inset-x-0`: offsetLeft is only ever non-zero under pinch-zoom,
          and widening this is the one direction that could argue with a desktop scrollbar.
          
          `visible` is what exempts it from the rule in index.css that puts out #root. It
          takes taps too, so a thumb landing in that band presses nothing.

          SURFACE and not bg-card, 29/08, and the layer below says why. */}
      {full ? (
        <div
          className="visible fixed inset-x-0 z-40 bg-[#22272e]"
          style={{ top: "-100vh", height: "300vh" }}
          aria-hidden="true"
        />
      ) : null}
      <Card
        ref={layer}
        className={cn(
          // Over the page rather than beside it: a card that only grew would still be a
          // column 42rem wide, which is the shape of a page and not of a terminal.
          //
          // inset-0 is the fallback and not the geometry: the effect above overwrites top,
          // left, width and height from the visual viewport wherever there is one. Where
          // there is not - an old browser, a test - this is what stays, and it is what the
          // layer has always been.
          //
          // All four safe areas and not only the bottom. A terminal on a phone is held in
          // landscape as often as upright, and there the notch and the rounded corner take
          // 44 px on each side: column 0 was drawing under the notch.
          //
          // The rest of this, 29/08, is one report: a grey frame around opencode in full
          // page. Three surfaces were stacked there, and the frame was all of them.
          //
          // The outermost was --card, a neutral oklch(0.205 0 0) against a terminal box of
          // #22272e - a seam between the layer and the thing it holds, and SURFACE is what
          // closes it. Only in full page: in the card that seam is the POINT, see the note
          // at the top on 27/08, where a terminal matching its page read as a hole.
          //
          // The middle one was padding - 8 px here, 8 more from px-2, 8 more around the
          // box - and colour cannot fix padding: a TUI paints ITS background over the cells
          // it draws and nothing beyond them, so every pixel of ours that is not a cell is
          // a frame around it, whatever it is painted. Those 24 px are gone; measured, the
          // grid now starts at x=0.
          //
          // What is left is the safe areas, and they stay. The notch is where it is, and
          // 27/08 put them here because column 0 was drawing under it. They are painted
          // SURFACE now rather than card grey, which is the most that can be done for them.
          //
          // Last seam, and it is not ours to close: xterm paints THEME.background, opencode
          // paints its own theme over that, and where the two differ the safe areas show
          // the difference. `"theme": "system"` in opencode.json makes it inherit instead.
          // At rest it is not a card at all, only the button that opens one: the page's single
          // filled button, with nothing around it to read (13/09). The host below still has
          // to be mounted for `open` to find it, so the card stays and loses its chrome.
          state === "idle" && !full && "gap-0 bg-transparent py-0 ring-0",
          full &&
            "visible fixed inset-0 z-50 flex flex-col gap-0 rounded-none bg-[#22272e] pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[calc(0.5rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] ring-0"
        )}
      >
        {/* No header in full page. The title says nothing the prompt does not, and Disconnect
          belongs to the card: closing the view costs nothing since tmux holds the session,
          so the way out is one button and it sits with the keys, under the thumb. Header
          plus a two-row key bar cost 192 px of a 844 px screen, measured 27/08 - 23% of a
          terminal spent on chrome, all of it at the far end from the hand. */}
        {full || state === "idle" ? null : (
          <CardHeader className="flex items-center justify-between gap-2">
            {/* What the machine calls the session, the way a native terminal titles its
                tab: tmux keeps it on the running command, so this reads `vim` while vim is
                up and the machine's name the rest of the time. `truncate` because a title
                is whatever the remote shell decided to send. */}
            <CardTitle className="truncate">{title ?? "Terminal"}</CardTitle>
            {/* gap-3, because 4 px between Disconnect and the full-page toggle is a missed
              tap that kills the session instead of resizing it. */}
            <div className="flex items-center gap-3">
              {/* The shortcut is the way this is reached once it is known; the button is how
                  it becomes known. Labelled with the chord it stands for, because a
                  magnifier on a terminal could mean a dozen things. */}
              {state === "open" ? (
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className="size-11 shrink-0"
                  aria-label={ON_MAC ? "Find (Cmd-F)" : "Find (Ctrl-Shift-F)"}
                  title={ON_MAC ? "⌘F" : "Ctrl-Shift-F"}
                  onClick={() => {
                    setFinding(true)
                    requestAnimationFrame(() => needle.current?.select())
                  }}
                >
                  <SearchIcon />
                </Button>
              ) : null}
              {/* From `connecting` and not from `open`. A handshake a proxy holds open
                  never times out on the browser's side, and there was no way back from it
                  short of reloading the page. */}
              <Button variant="ghost" size="lg" className="h-11" onClick={stop}>
                {state === "open" ? "Disconnect" : "Cancel"}
              </Button>
              {toggle("size-11 shrink-0")}
            </div>
          </CardHeader>
        )}

        <CardContent
          className={cn(
            state === "idle" && !full && "px-0",
            full && "flex min-h-0 flex-1 flex-col px-2 pb-0"
          )}
        >
          {/* The sentence about tmux left this spot on 13/09 for the machine's Details: at
              rest there is one thing to do here, and the button says it. */}
          {state === "idle" ? (
            <Button size="lg" className="h-12 w-full text-base" onClick={open}>
              <TerminalIcon data-icon="inline-start" />
              Open terminal
            </Button>
          ) : null}

          {/* In the card, the keys stay ABOVE the terminal, where 27/08 put them: that mode
            lives in a page that scrolls, and a row below the terminal was off screen on any
            phone shorter than 645 px. In full page they are below - see the bar at the foot
            of this component, and the comment there for why the reason they were moved up
            no longer holds. */}
          {full || state === "idle" ? null : (
            <div className="mb-3 grid grid-cols-4 gap-2 min-[480px]:grid-cols-8">
              {keys}
            </div>
          )}

          <div
            className={cn(
              state === "idle" && "hidden",
              // `relative`, and it is the search bar's whole layout: a bar in the flow
              // would push the grid down by its height the moment Cmd-F is pressed, which
              // is a resize of the pty - a SIGWINCH and a full redraw of whatever is
              // running - for a box that hides again on Escape.
              "relative",
              state !== "idle" && "overflow-hidden rounded-lg bg-[#22272e] p-2",
              // Full page gives the grid every pixel it can have. `px-2` on the content
              // above belongs to the key bar, which needs a margin; the terminal does not,
              // so it steps back out of it - and p-0 with square corners because both the
              // padding and the radius are surface showing around a TUI that paints its
              // own. See the note on the layer.
              full && "-mx-2 min-h-0 flex-1 rounded-none p-0"
            )}
          >
            <div
              ref={host}
              className={cn("w-full", full ? "h-full" : "h-[55svh] min-h-64")}
            />

            {/* The bar, over the grid rather than beside it - see `relative` above.

                Top right, which is where every application that has one puts it, and it is
                also the corner a prompt is furthest from: the line being read is at the
                bottom left. The scrollbar's 15 px are given back with `right-4`, so the
                bar does not sit half under it on Windows. */}
            {finding && state !== "idle" ? (
              <div className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-lg border border-[#444c56] bg-[#2d333b] p-1 shadow-lg">
                <SearchIcon className="ml-1 size-4 shrink-0 text-[#768390]" />
                <input
                  ref={needle}
                  value={query}
                  autoFocus
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label="Find in terminal"
                  placeholder="Find"
                  className="w-32 bg-transparent px-1 py-1 text-sm text-[#adbac7] outline-none placeholder:text-[#636e7b] sm:w-48"
                  onChange={(event) => {
                    setQuery(event.target.value)
                    find(event.target.value, true, true)
                  }}
                  onKeyDown={(event) => {
                    // The field is a text input inside a page: every key below would
                    // otherwise be the browser's or the form's, and none of them would be
                    // the search's.
                    if (event.key === "Enter") {
                      event.preventDefault()
                      find(query, !event.shiftKey)
                      return
                    }
                    if (event.key === "Escape") {
                      event.preventDefault()
                      stopFinding()
                    }
                  }}
                />
                {/* Tabular figures, so 1/9 and 8/9 are the same width and the buttons
                    beside them do not shift under the pointer as the count changes. */}
                <span className="w-14 shrink-0 text-center font-mono text-xs tabular-nums text-[#768390]">
                  {query === ""
                    ? ""
                    : hits.count === 0
                      ? "0/0"
                      : `${hits.index + 1}/${hits.count}`}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-[#adbac7] hover:bg-[#444c56] hover:text-[#cdd9e5]"
                  aria-label="Previous match"
                  onMouseDown={keepFocus}
                  onClick={() => find(query, false)}
                >
                  <ChevronUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-[#adbac7] hover:bg-[#444c56] hover:text-[#cdd9e5]"
                  aria-label="Next match"
                  onMouseDown={keepFocus}
                  onClick={() => find(query, true)}
                >
                  <ChevronDownIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-[#adbac7] hover:bg-[#444c56] hover:text-[#cdd9e5]"
                  aria-label="Close search"
                  onClick={stopFinding}
                >
                  <XIcon />
                </Button>
              </div>
            ) : null}
          </div>

          {/* The whole of full page's chrome: the keys, and the way out, at the bottom.
            
            Below the terminal is where a thumb is, and it was ruled out on 27/08 for a
            reason that was true then - a layer of `fixed inset-0` does not shrink under an
            iOS keyboard, so anything at its foot was covered exactly when it was wanted.
            The layer is now measured against the visual viewport, so its foot IS the top of
            the keyboard. The premise is gone; the placement follows it.
            
            The way out is a column of its own, full height beside the keys: it is the one
            button the whole layer depends on, so it is a corner target of 44 x 96 that no
            state moves and no gesture hides. 12 px from its neighbour, the same distance
            this file already keeps between Disconnect and it, because 4 px is a missed tap
            that does the other thing.

            It is rendered from `connecting` onwards and not from `open`: a phone enters
            full page before the session exists, and a full page with no way out is a trap.
            For the same reason the left-hand side never goes empty - where there are no
            keys yet, it carries the one action that state offers. */}
          {full ? (
            <div className="mt-2 flex shrink-0 items-stretch gap-3">
              <div className="min-w-0 flex-1">
                {state === "open" ? (
                  <div className="grid grid-cols-4 gap-2 min-[480px]:grid-cols-8">
                    {keys}
                  </div>
                ) : (
                  <Button
                    variant={state === "connecting" ? "outline" : "default"}
                    className="h-11 w-full text-base"
                    onClick={
                      state === "connecting"
                        ? stop
                        : () => {
                            teardown()
                            open()
                          }
                    }
                  >
                    {state === "connecting" ? "Cancel" : "Reconnect"}
                  </Button>
                )}
              </div>
              {toggle("h-auto w-11 shrink-0 self-stretch")}
            </div>
          ) : null}

          {/* In the card only: in full page this same action is in the bar above, where the
              thumb is and at 44 px. Here it was `size` default, 32 px high, the one button
              in this file under the tap minimum and the only one offered in the state that
              needs it. */}
          {state === "closed" && !full ? (
            <div className="mt-3">
              <Button
                size="lg"
                className="h-11"
                onClick={() => {
                  teardown()
                  open()
                }}
              >
                Reconnect
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </>
  )
}

/**
 * A printable key, as Ctrl would have made it.
 *
 * Ctrl-A is 0x01 and Ctrl-Z is 0x1a: the control characters are the letter's code with the
 * top bits cleared, which is the same arithmetic for `@ [ \ ] ^ _` as for the letters.
 * Anything else is passed through - a Ctrl armed by mistake before a `é` should type the
 * `é`, not swallow it.
 */
function control(text: string): string {
  if (text.length !== 1) return text
  const code = text.toUpperCase().charCodeAt(0)
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64)
  if (code === 32) return "\x00"
  return text
}
