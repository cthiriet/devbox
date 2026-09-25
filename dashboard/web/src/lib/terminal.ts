/**
 * The socket, and nothing about how it is drawn.
 *
 * Kept out of the component for the same reason lib/api.ts is kept out of the screens:
 * three things must not be forgotten on any connection, and a component that also lays out
 * a card is where one of them goes missing. They are the anti-CSRF token, which cannot
 * travel in a header because `new WebSocket()` sets none; the split between binary frames
 * and text frames, which is what stops a paste from being read as a command; and the ping,
 * without which the server closes a live tab after two minutes of a quiet prompt.
 */

/** The server echoes this back; a browser fails the connection if it does not. */
const SUBPROTOCOL = "devbox-term"

/** Under the server's 120 s idle timeout by a factor of four, on purpose. */
const PING_MS = 30_000

export type Wire = {
  /** What the user typed, as bytes: a terminal carries no encoding of its own. */
  type: (text: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}

export type WireHooks = {
  onData: (chunk: Uint8Array) => void
  /** A sentence from the server, meant to be read in the terminal itself. */
  onNotice: (text: string) => void
  onOpen: () => void
  onClose: (reason: string | null) => void
}

export function connect(machine: string, csrf: string, hooks: WireHooks): Wire {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:"
  const url = `${scheme}//${location.host}/api/machines/${encodeURIComponent(machine)}/terminal`

  // The token as the second subprotocol. It is the only field the constructor lets us set,
  // and unlike a query string it is not written into Caddy's access log.
  const socket = new WebSocket(url, [SUBPROTOCOL, csrf])
  socket.binaryType = "arraybuffer"

  const encoder = new TextEncoder()
  let ping: ReturnType<typeof setInterval> | null = null

  /** Whether the handshake ever completed, which is what tells a refusal from a hang-up. */
  let opened = false

  socket.onopen = () => {
    opened = true
    hooks.onOpen()
    ping = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "ping" }))
      }
    }, PING_MS)
  }

  socket.onmessage = (event) => {
    if (typeof event.data !== "string") {
      hooks.onData(new Uint8Array(event.data as ArrayBuffer))
      return
    }
    // Text is the server talking about the connection rather than through it.
    const message = JSON.parse(event.data) as {
      notice?: string
      closed?: string | null
    }
    if (typeof message.notice === "string") hooks.onNotice(message.notice)
    // The server says why it is going before it goes. Kept, so `onclose` has something
    // better to hand back than a code: both sides declared this field and neither read it.
    if (typeof message.closed === "string") said = message.closed
  }

  /** The last thing the server said about the connection, if it said anything. */
  let said: string | null = null

  const done = (reason: string | null) => {
    if (ping !== null) clearInterval(ping)
    ping = null
    hooks.onClose(reason)
  }

  /**
   * Null means "I have nothing, go and ask the address", and that is a contract with
   * components/terminal.tsx, which only calls whyRefused on null.
   *
   * It has to turn on whether the socket ever OPENED, and that was the bug: a refused
   * handshake gives a browser code 1006 and an empty reason, so the guess below was
   * returned as if it were an answer and whyRefused was never once consulted - the 503 for
   * four terminals, the 404 for a destroyed machine and the 401 for a real expiry all read
   * "the session may have expired", and two of the three were wrong. The symmetric half was
   * worse: an ORDINARY close also has an empty reason, so it returned null and every
   * deliberate Disconnect fired a GET that keyscans a live machine with a 30 s ceiling.
   */
  socket.onclose = (event) => {
    if (event.reason !== "") return done(event.reason)
    if (said !== null) return done(said)
    if (!opened) return done(null)
    // It was open and then it was not, and nobody said why.
    done(event.code === 1006 ? "the connection dropped." : "Disconnected.")
  }

  socket.onerror = () => {
    // Deliberately silent: a WebSocket error event carries nothing, and `onclose` always
    // follows it with the little there is to say.
  }

  return {
    type: (text) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(encoder.encode(text))
    },
    resize: (cols, rows) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }))
      }
    },
    close: () => socket.close(),
  }
}

/**
 * Why the handshake was refused, asked of the same address in a form that can answer.
 *
 * A browser tells a page nothing about a WebSocket upgrade the server declined: no status,
 * no body, close code 1006 and an empty reason, whether the session expired an hour ago or
 * the four slots are taken. That is the difference between "try again" and "close a tab on
 * the other machine", so the question is asked again as an ordinary GET - the server takes
 * the token from `X-CSRF` there - and the answer is the server's own sentence.
 *
 * 426 means the guard was satisfied and the address simply refused to be spoken to in
 * HTTP: the handshake failed for a reason on the wire, not for one this server holds.
 */
export async function whyRefused(
  machine: string,
  csrf: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `/api/machines/${encodeURIComponent(machine)}/terminal`,
      { headers: { "X-CSRF": csrf }, credentials: "same-origin" }
    )
    if (response.status === 426) return null
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string
    }
    return typeof payload.error === "string" ? payload.error : null
  } catch {
    return null
  }
}
