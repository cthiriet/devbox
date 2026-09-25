import * as React from "react"
import { ChevronRightIcon, PlusIcon } from "lucide-react"
import { Link } from "react-router"

import { ConnectCloud, GetStarted } from "@/components/get-started"
import { JobLine } from "@/components/job-line"
import { Screen } from "@/components/layout"
import { Price } from "@/components/marks"
import { Rows } from "@/components/panel"
import { useSession } from "@/components/session"
import { LoadingRows, Nothing, Trouble } from "@/components/states"
import { buttonVariants } from "@/components/ui/button"
import { useAsync } from "@/hooks/use-async"
import { api } from "@/lib/api"
import { age, eurPerDay, jobFailure, jobUnderway } from "@/lib/format"
import type { Job, Machine } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The fleet: what is running, and what it costs.
 *
 * The hourly total is the subject of this screen and not an ornament: the failure of a tool
 * able to start three machines is forgetting one of them. It is written under the list, and
 * doubled by the cost of a whole day - the number that decides to destroy tonight rather than
 * tomorrow. The month left this screen on 13/09: it is the hour times 730, and the question it
 * answers is asked on the order screen, not every time the fleet is opened.
 *
 * CALM, since 13/09, like the Keys page. A row is a name and a price, with the age under it;
 * the cloud, the profile, the region, the shape, the name ssh wants and the address are one
 * tap away, on the machine's page. What stays without a tap is what costs money while nobody
 * looks: a machine billing, a job that did not finish, machines no cloud can reach.
 *
 * It is also the first screen a new account ever opens, with no cloud and no machine, and
 * then it is not a list at all: it is the first step (get-started.tsx). The Order button is
 * not offered while no cloud can be ordered from - it led to a wizard whose last step could
 * only say "nothing creatable".
 */
export function Fleet() {
  const { session } = useSession()
  const fleet = useAsync(() => api.machines(), [])
  const jobs = useAsync(() => api.jobs(), [])
  // Frozen at opening, like the job list: an age is a landmark, not a stopwatch, and
  // reading the clock inside a render makes the render impure.
  const [now] = React.useState(() => Date.now())

  // What the account can order from, and not what it misses: `=== false`, because null is
  // "not asked" and must not read as a first run. See get-started.tsx for why `missing` is
  // not read at all.
  const noCloud = session?.configured === false
  const machines = fleet.status === "ready" ? fleet.data : null

  const list = jobs.data ?? []
  const running = list.find((job) => job.state === "running") ?? null
  const failures = unfinished(list, machines, now)
  const failure = failures[0]

  return (
    // "Machines", like the tab that leads here. The subtitle is the one fact that changes a
    // decision on this screen, and it stays.
    <Screen title="Machines" subtitle="Billed by the hour, until destroyed.">
      {/* Machines listed and no cloud left to reach them: they bill, and nothing here can
          destroy them until a credential is back. The first run is the other case, and it
          takes the list's place below. */}
      {noCloud && machines !== null && machines.length > 0 ? (
        <ConnectCloud stranded className="mb-3" />
      ) : null}

      {/* A job that did not finish, until 13/09, appeared nowhere on this screen - and it is
          the one case where a machine may bill with no state behind it. Said above the list,
          in red, and the tap leads to the log that says why. */}
      {failure === undefined ? null : (
        <JobLine
          tone="failed"
          to={failures.length === 1 ? `/job/${failure.id}` : "/jobs"}
          label={
            failures.length === 1
              ? jobFailure(failure.verb, settled(failure))
              : `${failures.length} recent jobs did not finish`
          }
          action="See why"
          className="mb-3"
        />
      )}

      {/* Several jobs run at once now, one per machine and under two caps: a job that is
          running is still the first thing worth following from here. */}
      {running ? (
        <JobLine
          tone="running"
          to={`/job/${running.id}`}
          label={
            <>
              {jobUnderway(running.verb)}{" "}
              <span className="font-mono font-normal">
                {running.machine ?? ""}
              </span>
            </>
          }
          action="Follow"
          className="mb-3"
        />
      ) : null}

      {fleet.status === "loading" ? <LoadingRows /> : null}
      {fleet.status === "failed" ? (
        <Trouble
          title="Fleet unreadable"
          detail={fleet.error}
          onRetry={fleet.reload}
        />
      ) : null}
      {machines === null ? null : noCloud && machines.length === 0 ? (
        <GetStarted />
      ) : (
        <MachineList machines={machines} now={now} />
      )}

      {/* The way into the wizard. It leads to step 1 and to nothing else: there is no quick
          form underneath, because a quick form is exactly what used to leave the profile or
          the cloud implicit. */}
      {/* A `Link` dressed in the button's classes, and not a `Button` rendering a `Link`:
          the Base UI button adds its own click behaviour to whatever it is given to render,
          and the anchor then stops navigating - measured here, the first attempt did not
          change page. The classes, for their part, change nothing but the appearance. */}
      {noCloud ? null : (
        <Link
          to="/new"
          className={cn(
            buttonVariants({ size: "lg" }),
            "mt-6 h-12 w-full text-base"
          )}
        >
          <PlusIcon data-icon="inline-start" />
          Order a machine
        </Link>
      )}

      {/* The way to the untracked machines, which stopped being a tab (nav.tsx). Quiet, and
          at the foot: it answers a doubt - a bill with a machine this list does not show -
          and the doubt comes from reading the list. `h-11` on the link: a line of text is
          not a thumb's target. */}
      {noCloud || machines === null ? null : (
        <div className="mt-2 text-center">
          <Link
            to="/orphans"
            className="inline-flex h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Look for untracked machines
          </Link>
        </div>
      )}
    </Screen>
  )
}

function MachineList({ machines, now }: { machines: Machine[]; now: number }) {
  if (machines.length === 0) {
    return <Nothing>No machine is running.</Nothing>
  }

  const total = machines.reduce(
    (sum, machine) => sum + (machine.hourly_eur ?? 0),
    0
  )

  return (
    <section>
      <Rows>
        {machines.map((machine) => (
          <li key={machine.name}>
            <Link
              to={`/machine/${encodeURIComponent(machine.name)}`}
              className="flex min-h-14 items-center gap-3 px-3 py-2 transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted"
            >
              {/* The label when there is one, and the real name otherwise: the page one tap
                  away gives the name back, beside the address, where it is typed from. */}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-base",
                  machine.label ? undefined : "font-mono"
                )}
              >
                {machine.label || machine.name}
              </span>
              {/* One right-hand column: the hour, and how long it has been running under it.
                  The eye goes down the right edge to add up the hours, and stops on the row
                  started on Tuesday. Nothing under the price for a machine this dashboard did
                  not order, which has no age it can vouch for. */}
              <span className="flex shrink-0 flex-col items-end">
                <Price value={machine.hourly_eur} className="text-sm" />
                {machine.ordered_at ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {age(machine.ordered_at, now)}
                  </span>
                ) : null}
              </span>
              <ChevronRightIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
            </Link>
          </li>
        ))}
      </Rows>
      {/* Mono and tabular like every other price in this app, grey and not amber past the
          hour: the hour is the only amber figure, and a second one would split the eye. */}
      <p className="px-1 pt-3 text-sm text-muted-foreground">
        Total <Price value={total} /> ·{" "}
        <span className="font-mono tabular-nums">{eurPerDay(total)}</span>{" "}
        EUR/day
      </p>
    </section>
  )
}

const DAY = 86_400_000

/**
 * The jobs that did not finish and that nothing has settled since.
 *
 * The LATEST job of each machine, when it failed or was interrupted: a failed order followed
 * by a setup that worked says nothing any more, and neither does a failed destroy followed by
 * one that worked. `/api/jobs` answers newest first, so the first job met for a name is its
 * latest.
 *
 * Kept for as long as its machine is still listed - a machine whose last job failed is on the
 * meter half made, whatever the date - and for a day otherwise: an order refused before
 * anything was created has nothing left to say by tomorrow, while an interrupted one is still
 * worth a look at the untracked machines. Fifty jobs, which is what the list holds, is more
 * than a day of anyone's.
 */
function unfinished(
  jobs: Job[],
  machines: Machine[] | null,
  now: number
): Job[] {
  const seen = new Set<string>()
  const found: Job[] = []
  for (const job of jobs) {
    const key = job.machine ?? `#${job.id}`
    if (seen.has(key)) continue
    seen.add(key)
    if (job.state !== "failed" && job.state !== "interrupted") continue
    const listed =
      machines?.some((machine) => machine.name === job.machine) ?? false
    if (listed || now - (job.ended_at ?? job.started_at) < DAY) found.push(job)
  }
  return found
}

/** A job `unfinished` kept, by the one of its two states it is in. */
function settled(job: Job): "failed" | "interrupted" {
  return job.state === "interrupted" ? "interrupted" : "failed"
}
