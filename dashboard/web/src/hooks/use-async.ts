import * as React from "react"

import { reason } from "@/lib/api"

/**
 * A load, its failure, and what it takes to replay it.
 *
 * Written by hand rather than borrowed from TanStack Query: this repository keeps its
 * dependency budget tight, and what these eight screens need fits inside this one effect. No
 * cache, no background revalidation, no client to provision - a screen that is opened asks
 * for what it displays, and `reload()` is the "retry" button.
 *
 * What is really needed here, and what a naive `useEffect` misses: a result that arrives
 * after we have moved to another screen must write nothing. `/api/probe` questions three
 * clouds and can take thirty seconds; step 2, abandoned in the meantime, must not come back
 * up over the top of the next screen.
 */

export type Async<T> =
  | { status: "loading"; data: null; error: null; reload: () => void }
  | { status: "ready"; data: T; error: null; reload: () => void }
  | { status: "failed"; data: null; error: string; reload: () => void }

type State<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "failed"; error: string }

export function useAsync<T>(
  run: () => Promise<T>,
  deps: React.DependencyList
): Async<T> {
  const [state, setState] = React.useState<State<T>>({ status: "loading" })
  const [attempt, setAttempt] = React.useState(0)

  // The function changes on every render (it is a closure written in the JSX) whereas the
  // dependencies are the ones that say when to make the call again. Going through a ref is
  // what prevents the infinite loop without forcing a useCallback on every screen.
  //
  // Stored in an effect and not during the render: writing to a ref in the middle of a
  // render is what the React compiler refuses, and the ordering suffices - this effect is
  // declared before the one that calls, so the stored version is always the latest.
  const latest = React.useRef(run)
  React.useEffect(() => {
    latest.current = run
  })

  React.useEffect(() => {
    let alive = true
    // Going back to loading costs one more render, and that is the point: when the key
    // changes - another machine, another job, another profile - keeping the previous
    // screen's data on display would show the wrong machine under the right name for the
    // duration of the call. One extra render per navigation, over eight screens, does not
    // measure.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ status: "loading" })
    latest.current().then(
      (data) => {
        if (alive) setState({ status: "ready", data })
      },
      (error: unknown) => {
        if (alive) setState({ status: "failed", error: reason(error) })
      }
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt])

  const reload = React.useCallback(() => setAttempt((n) => n + 1), [])

  if (state.status === "ready")
    return { status: "ready", data: state.data, error: null, reload }
  if (state.status === "failed")
    return { status: "failed", data: null, error: state.error, reload }
  return { status: "loading", data: null, error: null, reload }
}
