import * as React from "react"
import { Link, useLocation, useParams } from "react-router"

import { Screen } from "@/components/layout"
import { JobStateIcon } from "@/components/marks"
import { Fold } from "@/components/panel"
import { Loading, Trouble } from "@/components/states"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { buttonVariants } from "@/components/ui/button"
import { useAsync } from "@/hooks/use-async"
import { api, reason } from "@/lib/api"
import { jobAction, took } from "@/lib/format"
import type { Job, JobState } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * One job, followed live.
 *
 * The log is read by offset every two seconds: the server returns the slice that follows
 * what is already held and the size reached, which becomes the next offset. That is what
 * public/main.js did and it is the right mechanism - an `up` writes several hundred lines
 * of terraform, and reading them all again every two seconds over a train's network would
 * cost more than the command itself.
 *
 * The job outlives the tab that launched it: it runs on the server side, and closing this
 * page does not interrupt it. That is why this is an address and not a modal window.
 */
/**
 * Where the chevron goes back to.
 *
 * This screen is reached from three doors: the fleet's running-job alert, the job list, and
 * the redirect that follows an order, a seed or a destroy. It sent all three to Machines,
 * which made comparing two failed jobs a four-tap round trip through a page nobody asked
 * for - and the label was a lie about where the reader had been. The list says so when it
 * links; everything else still means Machines.
 */
function came(state: unknown): { to: string; label: string } {
  const from = state as { from?: unknown; label?: unknown } | null
  if (typeof from?.from === "string" && typeof from.label === "string") {
    return { to: from.from, label: from.label }
  }
  return { to: "/", label: "Machines" }
}

export function JobScreen() {
  const params = useParams()
  const id = Number(params.id)
  const back = came(useLocation().state)
  const row = useAsync(() => api.job(id), [id])

  if (!Number.isInteger(id)) {
    return (
      <Screen title="Job" back={back}>
        <Trouble
          title="Invalid address"
          detail={`${params.id ?? ""} is not a number.`}
        />
      </Screen>
    )
  }

  return (
    <Screen
      title={
        row.status === "ready" ? (
          <span className="break-words">
            {jobAction(row.data.verb)}{" "}
            <span className="font-mono break-all">
              {row.data.machine ?? ""}
            </span>
          </span>
        ) : (
          `Job ${id}`
        )
      }
      back={back}
    >
      {row.status === "loading" ? <Loading label="Reading the job" /> : null}
      {row.status === "failed" ? (
        <Trouble
          title="Job not found"
          detail={row.error}
          onRetry={row.reload}
        />
      ) : null}
      {row.status === "ready" ? <Follow job={row.data} back={back} /> : null}
    </Screen>
  )
}

function Follow({
  job,
  back,
}: {
  job: Job
  back: { to: string; label: string }
}) {
  // Returned separately, and not inside a single object: a ref stored next to the data in
  // an object makes the whole object unreadable during render as far as the React compiler
  // is concerned, whereas the log text is precisely what is read during render.
  const [log, box] = useLog(job.id)

  // The state comes from the log as soon as a slice has arrived: it is the same column of
  // the same database, fresher than the row read at opening. The row itself is never read
  // again - a reload would wipe the accumulated log and have it read back in full, which is
  // expensive for the only thing it would bring, `ended_at`, which can be measured here.
  const state: JobState = log.state ?? job.state
  const ended = job.ended_at ?? log.endedAt
  const now = useNow(state === "running")
  const lines = linesOf(log.text)
  const cut = state === "failed" || state === "interrupted"

  return (
    <>
      <p
        className={cn(
          "flex items-center gap-2 text-sm",
          cut ? "text-destructive" : "text-muted-foreground"
        )}
      >
        <JobStateIcon state={state} />
        <span>{statusLine(state, job.started_at, ended, now)}</span>
      </p>

      {/* What it is doing now, in one line: the rest is the log below, open while it runs. */}
      {state === "running" ? (
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {lines.length === 0 ? "Starting…" : lines[lines.length - 1]}
        </p>
      ) : null}

      <Outcome job={job} state={state} back={back} />

      {log.hiccup === null ? null : (
        <p className="mt-3 text-xs text-muted-foreground">Reconnecting…</p>
      )}

      {state === "running" ? (
        <pre ref={box} className={cn(LOG, "mt-4 max-h-[60svh]")}>
          {log.text === "" ? (
            <span className="text-muted-foreground">…</span>
          ) : (
            log.text
          )}
        </pre>
      ) : (
        <>
          {/* The end of a log that died is where it says why: five lines of it, without a
              tap. The rest is one fold away. */}
          {cut && lines.length > 0 ? (
            <pre className={cn(LOG, "mt-4")}>{lines.slice(-5).join("\n")}</pre>
          ) : null}
          <Fold title="Show full log" className="mt-3">
            <pre ref={box} className={cn(LOG, "max-h-[60svh]")}>
              {log.text === "" ? (
                <span className="text-muted-foreground">…</span>
              ) : (
                log.text
              )}
            </pre>
          </Fold>
        </>
      )}
    </>
  )
}

const LOG =
  "overflow-auto rounded-xl bg-card p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-card-foreground ring-1 ring-foreground/10"

/** "Running for 40 s", "Failed after 3 min", "Done in 4 min": the state and its length, in one line. */
function statusLine(
  state: JobState,
  started: number,
  ended: number | null,
  now: number
): string {
  if (state === "running") return `Running for ${took((now - started) / 1000)}`
  // An interrupted job's end is the restart that swept it, not a length it ran for.
  if (state === "interrupted") return "Interrupted"
  const lasted = ended === null ? null : took((ended - started) / 1000)
  if (state === "succeeded") return lasted === null ? "Done" : `Done in ${lasted}`
  return lasted === null ? "Failed" : `Failed after ${lasted}`
}

/**
 * The clock, moving only while the job runs.
 *
 * Frozen at opening until 13/09, which is what the list did too: a "Running for 3 min" that
 * stays three minutes for ten says the job is stuck when it is not.
 */
function useNow(ticking: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/** The log's lines, without the empty one a trailing newline leaves. */
function linesOf(text: string): string[] {
  const trimmed = text.replace(/\n+$/, "")
  return trimmed === "" ? [] : trimmed.split("\n")
}

function machinePath(machine: string): string {
  return `/machine/${encodeURIComponent(machine)}`
}

/** The screen's one main button, as a link: it goes somewhere, it does nothing here. */
function Primary({
  to,
  className,
  children,
}: {
  to: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      className={cn(
        buttonVariants({ size: "lg" }),
        "mt-4 h-12 w-full text-base",
        className
      )}
    >
      <span className="truncate">{children}</span>
    </Link>
  )
}

/**
 * What to do now, and nothing when there is nothing to do.
 *
 * A failed `up` is the state this screen exists for, and it was the one it said nothing
 * about. devbox creates the machine FIRST and provisions it afterwards (devbox-core: hz_up,
 * then the wait on sshd, then the profile), so a job that dies in phase 2 leaves a machine at
 * the provider, running, billing, and named nowhere on this page. Measured on 27/08: a seed
 * died on a 404, "failed - code 22" was all the screen said, and the machine spent the night
 * up. "may be billing" and not "is billing", because a failure before the apply - a refused
 * credential, a missing secret - leaves nothing behind.
 *
 * Said per verb since 13/09, from what each one does. A setup acts on a machine that exists,
 * so a failed one leaves it running. A destroy that did not finish may have left it running.
 * A service restarted during an order may leave a machine no state knows about, which only the
 * untracked machines find. Each says it with one button: the machine's page carries Set up and
 * Destroy, and says so itself when there is no machine to show.
 */
function Outcome({
  job,
  state,
  back,
}: {
  job: Job
  state: JobState
  back: { to: string; label: string }
}) {
  if (state === "running") return null

  if (state === "succeeded") {
    if (job.verb === "up" && job.machine !== null) {
      return <Primary to={machinePath(job.machine)}>Open {job.machine}</Primary>
    }
    // A destroyed machine's page has nothing left to show.
    const to =
      job.verb === "down" && back.to.startsWith("/machine/") ? "/" : back.to
    return <Primary to={to}>Done</Primary>
  }

  const told = tell(job.verb, state, job.machine)
  if (told === null) return null
  return (
    <Alert variant="destructive" className="mt-4">
      <AlertTitle className="break-words">{told.title}</AlertTitle>
      <AlertDescription>
        <p>{told.sentence}</p>
      </AlertDescription>
      <Primary to={told.to} className="mt-3">
        {told.button}
      </Primary>
    </Alert>
  )
}

function tell(
  verb: string,
  state: "failed" | "interrupted",
  machine: string | null
): { title: string; sentence: string; button: string; to: string } | null {
  const open =
    machine === null
      ? null
      : { button: `Open ${machine}`, to: machinePath(machine) }

  if (state === "interrupted") {
    if (verb === "seed" && open !== null) {
      return {
        title: `Setup was cut short on ${machine}`,
        sentence: "A service restart stopped it. The machine is still running.",
        ...open,
      }
    }
    if (verb === "down" && open !== null) {
      return {
        title: `${machine} may still be running`,
        sentence: "A service restart stopped the destroy.",
        ...open,
      }
    }
    return {
      title: `${machine ?? "A machine"} may be billing`,
      sentence:
        "A service restart cut the job short: a machine may exist that this service no longer tracks.",
      button: "Check untracked machines",
      to: "/orphans",
    }
  }

  if (open === null) return null
  if (verb === "up") {
    return {
      title: `${machine} may be billing`,
      sentence: "It was either not created, or created and left unfinished.",
      ...open,
    }
  }
  if (verb === "seed") {
    return {
      title: `Setup failed on ${machine}`,
      sentence: "It is still running, and billing.",
      ...open,
    }
  }
  if (verb === "down") {
    return {
      title: `${machine} may still be running`,
      sentence: "The destroy did not finish, so it may still be billing.",
      ...open,
    }
  }
  return {
    title: `${machine} may exist, and be billing`,
    sentence: "The job stopped before it finished.",
    ...open,
  }
}

/**
 * The log in slices, and the one display detail that really matters here.
 *
 * Pinned to the bottom only if the reader was already there: scrolling back up to reread an
 * error must not be undone by the next slice. This is taken as is from public/main.js,
 * except that the scrolling is the box's and not the page's - on a phone, six hundred lines
 * of terraform pushing the title and the state off the screen make the page unusable at the
 * precise moment one wants to know where things stand.
 */
function useLog(id: number) {
  const [text, setText] = React.useState("")
  const [state, setState] = React.useState<JobState | null>(null)
  const [exitCode, setExitCode] = React.useState<number | null>(null)
  const [endedAt, setEndedAt] = React.useState<number | null>(null)
  const [hiccup, setHiccup] = React.useState<string | null>(null)

  const box = React.useRef<HTMLPreElement>(null)
  const offset = React.useRef(0)
  const pinned = React.useRef(true)

  React.useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      try {
        const chunk = await api.log(id, offset.current)
        // An answer arriving after unmount writes nothing, and above all does not advance
        // the offset: otherwise the slice it carried would be lost for good.
        if (!alive) return
        setHiccup(null)

        if (chunk.text !== "") {
          const element = box.current
          // Measured BEFORE writing: afterwards the height has changed and the question
          // "was it at the bottom?" no longer has an answer.
          pinned.current =
            element === null ||
            element.scrollHeight - element.scrollTop - element.clientHeight < 40
          offset.current = chunk.size
          setText((previous) => previous + chunk.text)
        }

        setState(chunk.state)
        setExitCode(chunk.exit_code)

        if (chunk.state === "running") {
          timer = setTimeout(tick, 2000)
          return
        }
        // The server returns everything that is left as soon as the job is over, including
        // a last line with no carriage return: there is nothing more to wait for.
        setEndedAt((known) => known ?? Date.now())
      } catch (failure) {
        if (!alive) return
        // A tunnel, not a breakdown: the job carries on over there, and we ask again.
        setHiccup(reason(failure))
        timer = setTimeout(tick, 2000)
      }
    }

    tick()

    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [id])

  React.useLayoutEffect(() => {
    if (pinned.current && box.current !== null) {
      box.current.scrollTop = box.current.scrollHeight
    }
  }, [text])

  return [{ text, state, exitCode, endedAt, hiccup }, box] as const
}
