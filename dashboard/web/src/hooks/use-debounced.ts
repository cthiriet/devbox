import * as React from "react"

/**
 * A value, held back until it stops moving.
 *
 * Written for one caller: the disk on step 2, which since 31/08 is part of the probe's key
 * rather than a client-side filter - GCP has no fixed disk per shape, so the size has to be
 * ASKED for. That made a `<select>` able to spawn work on the server, and a native select
 * walked with the arrow keys fires `change` on every option it passes through.
 *
 * What that cost, measured against the live dashboard: four concurrent probes answered 200
 * in 4,5 to 5,0 s; eight answered 502 in 4,15 s and took the whole site down with them
 * until systemd restarted the unit. Twelve disk rungs are one flick of a thumb.
 *
 * This is the FIRST of two defences and the weaker one on purpose. It makes the burst
 * unlikely; src/engine.ts makes it harmless, by running one probe at a time whatever
 * arrives. A debounce alone is a bet on human timing, and the thing it would be betting is
 * whether the site stays up.
 *
 * The displayed value is never this one - a control has to answer the finger that moved it
 * on the same frame, or it feels broken. Only what the probe is keyed on waits.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value)

  React.useEffect(() => {
    if (Object.is(settled, value)) return
    // In a timer and not in the effect body: a setState there is the cascading render
    // eslint refuses, and it would defeat the point besides - the whole purpose is that
    // nothing happens for `ms`.
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, settled, ms])

  return settled
}
