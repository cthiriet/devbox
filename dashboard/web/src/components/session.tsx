/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { Navigate, useLocation } from "react-router"

import { Loading, Trouble } from "@/components/states"
import { api, onExpired, setCsrf } from "@/lib/api"
import type { Session } from "@/lib/types"
import { useAsync } from "@/hooks/use-async"

/**
 * Who we are, asked once, at startup.
 *
 * `GET /api/session` never answers 401: it is the "who am I" question, and its answer
 * carries everything the screens need before displaying anything at all - the anti-CSRF
 * token, the account signed in and its clouds, the secrets directory to quote when one of them
 * is missing, and the digest of the deployed executor.
 *
 * It also carries `disabled`: a service that can open no session at all - no sign-in provider
 * configured, or no account yet and no founder named. The login screen says so rather than
 * drawing buttons that lead nowhere - a sign-in refused with no explanation is the kind of fault
 * one hunts for twenty minutes on the wrong side.
 *
 * It is also where a browser learns its anti-CSRF token after a Google or GitHub sign-in: the
 * server opens the session at the end of a redirect, which carries no body to read it from.
 */

type Held = {
  session: Session | null
  status: "loading" | "ready" | "failed"
  error: string | null
  /** After a change of session: the session is read again rather than guessed. */
  refresh: () => void
  /**
   * The session read again IN PLACE, without passing through loading.
   *
   * `refresh()` goes back to loading, and RequireSession draws a spinner instead of the screen
   * for that time - which unmounts the screen and everything it had to say. That is right
   * after a login and wrong after a change made FROM a screen: /account changing its address
   * would lose the sentence saying so, along with the form it was said under. A failure
   * rejects and changes nothing; the caller already holds the server's answer to its write.
   */
  reread: () => Promise<void>
}

const SessionContext = React.createContext<Held | null>(null)

export function useSession(): Held {
  const held = React.useContext(SessionContext)
  if (held === null) throw new Error("useSession outside SessionProvider")
  return held
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const state = useAsync(() => api.session(), [])

  // A re-read answer, and the load it stands in for. Tied to that load by identity rather
  // than cleared by hand: once `refresh()` brings a new load, `over` no longer matches and the
  // re-read is simply not used - even one that lands after the new load does.
  const [newer, setNewer] = React.useState<{
    over: Session
    now: Session
  } | null>(null)
  const loaded = React.useRef(state.data)
  React.useEffect(() => {
    loaded.current = state.data
  })
  const session =
    newer !== null && newer.over === state.data ? newer.now : state.data

  const reread = React.useCallback(async () => {
    const over = loaded.current
    const now = await api.session()
    if (over !== null) setNewer({ over, now })
  }, [])

  // A 401 on any call whatsoever means the cookie is no longer valid. Read the session
  // again rather than force a `Navigate` from the HTTP client: it is the same answer that
  // then says whether to log in again or whether the configuration has changed under our
  // feet, and a single path leads to the login screen.
  const reload = state.reload
  React.useEffect(() => {
    onExpired(reload)
    return () => onExpired(null)
  }, [reload])

  // The anti-CSRF token lives in the HTTP client, not in the render: a write triggered by
  // an event handler must not depend on a render having happened.
  const csrf = session?.csrf ?? ""
  React.useEffect(() => {
    setCsrf(csrf)
  }, [csrf])

  const held = React.useMemo<Held>(
    () => ({
      session,
      status: state.status,
      error: state.error,
      refresh: state.reload,
      reread,
    }),
    [session, state.status, state.error, state.reload, reread]
  )

  return (
    <SessionContext.Provider value={held}>{children}</SessionContext.Provider>
  )
}

/**
 * A screen that only makes sense authenticated.
 *
 * The server renders the same index.html for every route, whatever the session: it is here
 * that the login screen is decided, and nowhere else. The route we came from is carried in
 * the navigation state, so as to come back to it once inside - opening a link to a machine
 * from a message must not end on the list.
 *
 * The fragment travels with it: `/secrets#secret-github` is the one address here whose hash
 * is the destination, and a session that expired on the way would otherwise land the reader
 * on the right screen and the wrong card.
 */
export function RequireSession({ children }: { children: React.ReactNode }) {
  const { session, status, error, refresh } = useSession()
  const location = useLocation()

  // These two states are displayed outside of any screen: they therefore have their own
  // column, otherwise the alert is stuck to the edges of the window where everything else
  // has a margin.
  if (status === "loading") {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 pt-6">
        <Loading label="Checking the session" />
      </div>
    )
  }
  if (status === "failed") {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 pt-6">
        <Trouble
          title="Service unreachable"
          detail={error ?? ""}
          onRetry={refresh}
        />
      </div>
    )
  }
  if (session === null || !session.authenticated) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search + location.hash }}
      />
    )
  }
  return <>{children}</>
}
