import * as React from "react"
import { ChevronRightIcon } from "lucide-react"
import { Link } from "react-router"

import { Screen } from "@/components/layout"
import { JobStateIcon } from "@/components/marks"
import { Rows } from "@/components/panel"
import { LoadingRows, Nothing, Trouble } from "@/components/states"
import { useAsync } from "@/hooks/use-async"
import { api } from "@/lib/api"
import { ago, jobAction } from "@/lib/format"
import type { Job, JobState } from "@/lib/types"

/**
 * The jobs, on their own page - called Activity, and still `/jobs` in the address.
 *
 * They sat under the fleet until 27/08, ten of them, on the screen opened most often and
 * for the shortest reason: reading an address. What is worth interrupting that reading is
 * a job RUNNING, and the fleet still says so at the top; the other nine are history, and
 * history belongs where it is looked for.
 *
 * Looked for it is, though, which is why this page exists rather than nothing: a seed that
 * died is read in its log, and a log with no way in is a log nobody reads.
 *
 * "Activity" and not "Jobs" on the page: a job is the server's unit of work, and what a
 * customer comes here to find is the order they placed an hour ago and what it printed.
 */
export function Jobs() {
  const jobs = useAsync(() => api.jobs(), [])

  return (
    <Screen title="Activity">
      {jobs.status === "loading" ? <LoadingRows rows={4} /> : null}
      {jobs.status === "failed" ? (
        <Trouble
          title="Activity unreadable"
          detail={jobs.error}
          onRetry={jobs.reload}
        />
      ) : null}
      {jobs.status === "ready" ? <JobList initial={jobs.data} /> : null}
    </Screen>
  )
}

/**
 * How often the list is read again while a job runs, and how often the ages move.
 *
 * The list was read once, with the clock frozen at opening: a job that finished while the
 * page was open kept its spinner until a reload, and "2 min ago" stayed two minutes for an
 * hour. Five seconds is the order of what a phase of a job takes; nothing is read at all once
 * nothing runs, nor while the tab is hidden.
 */
const REREAD_MS = 5_000
const CLOCK_MS = 30_000

/** Running first, then what failed or was cut, then the rest - each in the server's order. */
function rank(state: JobState): number {
  if (state === "running") return 0
  return state === "succeeded" ? 2 : 1
}

function JobList({ initial }: { initial: Job[] }) {
  const [jobs, setJobs] = React.useState(initial)
  const [now, setNow] = React.useState(() => Date.now())
  const [stale, setStale] = React.useState(false)
  const running = jobs.some((job) => job.state === "running")

  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [])

  React.useEffect(() => {
    if (!running) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    // A chain of timeouts and not an interval: over a train's network an answer can take
    // longer than the period, and two reads in flight would land in either order.
    const tick = async () => {
      if (!document.hidden) {
        try {
          const next = await api.jobs()
          if (!alive) return
          setJobs(next)
          setNow(Date.now())
          setStale(false)
        } catch {
          if (!alive) return
          setStale(true)
        }
      }
      if (alive) timer = setTimeout(tick, REREAD_MS)
    }
    timer = setTimeout(tick, REREAD_MS)

    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [running])

  if (jobs.length === 0) return <Nothing>No activity yet.</Nothing>

  // Array.prototype.sort is stable: inside a rank, the newest stays first.
  const ordered = [...jobs].sort((a, b) => rank(a.state) - rank(b.state))

  return (
    <>
      <Rows>
        {ordered.map((job) => (
          <li key={job.id}>
            <Link
              to={`/job/${job.id}`}
              state={{ from: "/jobs", label: "Activity" }}
              className="flex h-12 w-full items-center gap-3 px-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted"
            >
              <JobStateIcon state={job.state} />
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{jobAction(job.verb)}</span>
                {job.machine === null ? null : (
                  <>
                    {" "}
                    <span className="font-mono text-muted-foreground">
                      {job.machine}
                    </span>
                  </>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {ago(job.started_at, now)}
              </span>
              <ChevronRightIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
            </Link>
          </li>
        ))}
      </Rows>
      {stale ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Could not refresh. What shows is the last answer.
        </p>
      ) : null}
    </>
  )
}
