import * as React from "react"
import {
  CableIcon,
  ChevronLeftIcon,
  EllipsisIcon,
  PencilIcon,
  RotateCwIcon,
  Trash2Icon,
} from "lucide-react"
import { useNavigate, useParams } from "react-router"

import { CopyField } from "@/components/copy-field"
import { JobLine } from "@/components/job-line"
import { Screen } from "@/components/layout"
import { Price } from "@/components/marks"
import { Fold, PanelHeader, Row, Rows, Sheet } from "@/components/panel"
import { Loading, Trouble } from "@/components/states"
import { MachineTerminal } from "@/components/terminal"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useAsync } from "@/hooks/use-async"
import { api, reason } from "@/lib/api"
import { cloudName } from "@/lib/clouds"
import { age, eurSince, jobFailure } from "@/lib/format"
import type { Checkout, MachineDetail, Unpushed } from "@/lib/types"

/**
 * One machine: what it costs, a way in, and a way to end it.
 *
 * CALM, since 13/09, like the Keys page. At rest the page is the cost under the title, one
 * large button that opens the terminal, and Destroy in outline at the foot - the one gesture
 * that ends the bill stays in sight. Everything else is behind More: the connection card, the
 * label, the setup replayed, and the facts (cloud, profile, region, type, name, address).
 *
 * The connection card exists because an SSH client on a phone imports no ~/.ssh/config:
 * address, port, user and fingerprint are retyped by hand, so they are one field per line with
 * a copy button each. The terminal does not replace it, because of the forwards: an ssh opened
 * from here runs on the SERVER, so the LocalForward lines land there and not on the reader's
 * machine. What the terminal replaces is the session.
 *
 * A job that did not finish on this machine is said without a tap, in red, above the terminal:
 * a failed order or setup is a machine billing half made.
 */
type Panel = "more" | "connection" | "rename" | "setup"

export function Machine() {
  const params = useParams()
  const name = params.name ?? ""
  const state = useAsync(() => api.machine(name), [name])
  // The account's latest jobs, for the one this machine had last. Newest first, as the
  // server answers them; a failure to read them costs the red line and nothing else.
  const jobs = useAsync(() => api.jobs(), [name])

  const machine = state.status === "ready" ? state.data : null
  const label = machine?.label ?? null
  // Frozen at opening, like the fleet: an age is a landmark, not a stopwatch.
  const [opened] = React.useState(() => Date.now())
  const spent =
    machine === null
      ? null
      : eurSince(machine.hourly_eur, machine.ordered_at, opened)
  const last = (jobs.data ?? []).find((job) => job.machine === name) ?? null

  const [panel, setPanel] = React.useState<Panel | null>(null)
  // What the sheet draws, kept through its closing animation: see screens/secrets.tsx.
  const [drawn, setDrawn] = React.useState<Panel>("more")
  if (panel !== null && panel !== drawn) setDrawn(panel)

  return (
    <Screen
      title={
        label === null ? (
          <span className="font-mono break-all">{name}</span>
        ) : (
          <span className="break-words">{label}</span>
        )
      }
      back={{ to: "/", label: "Machines" }}
      action={
        machine === null ? null : (
          <div className="flex items-center">
            {/* The pencil where a label already took the title, since that is where one
                looks to change it. With no label, Rename is a row under More. */}
            {label === null ? null : (
              <Button
                variant="ghost"
                size="lg"
                className="h-11 w-11"
                aria-label="Rename"
                onClick={() => setPanel("rename")}
              >
                <PencilIcon />
              </Button>
            )}
            <Button
              variant="ghost"
              size="lg"
              className="h-11 w-11"
              aria-label="More"
              onClick={() => setPanel("more")}
            >
              <EllipsisIcon />
            </Button>
          </div>
        )
      }
      subtitle={
        machine === null ? null : (
          <Cost machine={machine} spent={spent} now={opened} />
        )
      }
    >
      {state.status === "loading" ? (
        <Loading label="Reading the machine" />
      ) : null}
      {state.status === "failed" ? (
        <Trouble
          title="Machine unreadable"
          detail={state.error}
          onRetry={state.reload}
        />
      ) : null}
      {machine === null ? null : (
        <>
          {last !== null &&
          (last.state === "failed" || last.state === "interrupted") ? (
            <JobLine
              tone="failed"
              to={`/job/${last.id}`}
              label={jobFailure(last.verb, last.state)}
              action="See why"
              className="mb-4"
            />
          ) : null}

          <MachineTerminal machine={machine.name} />

          <Destroy machine={machine} />

          <Sheet open={panel !== null} onClose={() => setPanel(null)}>
            {drawn === "more" ? (
              <MorePanel machine={machine} onOpen={setPanel} />
            ) : drawn === "connection" ? (
              <ConnectionPanel
                machine={machine}
                onBack={() => setPanel("more")}
              />
            ) : drawn === "rename" ? (
              <RenamePanel
                key={machine.label ?? ""}
                machine={machine}
                onBack={() => setPanel("more")}
                onDone={() => {
                  setPanel(null)
                  state.reload()
                }}
              />
            ) : (
              <SetupPanel machine={machine} onBack={() => setPanel("more")} />
            )}
          </Sheet>
        </>
      )}
    </Screen>
  )
}

/**
 * What it costs, in one line under the title: the hour, what it has cost already, and for how
 * long. The hour alone could not tell a machine started before breakfast from one started on
 * Tuesday. Nothing is said that the dashboard cannot vouch for: no "so far" and no age for a
 * machine it did not order.
 */
function Cost({
  machine,
  spent,
  now,
}: {
  machine: MachineDetail
  spent: string | null
  now: number
}) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <Price value={machine.hourly_eur} />
      {spent === null ? null : (
        <>
          <span aria-hidden>·</span>
          <span>
            <span className="font-mono tabular-nums">{spent}</span> EUR so far
          </span>
        </>
      )}
      {machine.ordered_at ? (
        <>
          <span aria-hidden>·</span>
          <span>up {age(machine.ordered_at, now)}</span>
        </>
      ) : null}
    </span>
  )
}

/** The way back to More, in the header's first place, where a chevron is looked for. */
function Back({ onBack }: { onBack: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      className="-ml-2 size-11 shrink-0"
      onClick={onBack}
    >
      <ChevronLeftIcon />
      <span className="sr-only">Back</span>
    </Button>
  )
}

/**
 * What a tap on More opens: three rows, and the facts folded under them.
 *
 * The real name is in Details even when a label takes the title: it is what `ssh <name>`
 * wants, what the prompt inside says, and what the provider console lists.
 */
function MorePanel({
  machine,
  onOpen,
}: {
  machine: MachineDetail
  onOpen: (panel: Panel) => void
}) {
  const label = machine.label ?? null
  return (
    <>
      <PanelHeader
        icon={
          <EllipsisIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title={label ?? machine.name}
        mono={label === null}
      />
      <Rows className="mt-2">
        <Row
          icon={<CableIcon />}
          label="Connection details"
          onOpen={() => onOpen("connection")}
        />
        <Row
          icon={<PencilIcon />}
          label="Rename"
          value={label ?? undefined}
          onOpen={() => onOpen("rename")}
        />
        <Row
          icon={<RotateCwIcon />}
          label="Set up again"
          onOpen={() => onOpen("setup")}
        />
      </Rows>
      <Fold title="Details" className="mt-3 border-t border-border">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-xs">
          <Fact name="cloud">{cloudName(machine.cloud)}</Fact>
          <Fact name="profile">{machine.profile ?? "none"}</Fact>
          <Fact name="region">{machine.region}</Fact>
          <Fact name="type">{machine.instance_type}</Fact>
          <Fact name="ssh">{machine.name}</Fact>
          <Fact name="ip">{machine.ip}</Fact>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          The terminal attaches to tmux: closing its tab leaves the work
          running.
        </p>
      </Fold>
    </>
  )
}

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </>
  )
}

/**
 * The connection card, under the names every SSH client asks for them by - the CLI
 * (cli/src/ui/Info.tsx) prints the same five, and nothing here is owed to one particular app.
 */
function ConnectionPanel({
  machine,
  onBack,
}: {
  machine: MachineDetail
  onBack: () => void
}) {
  return (
    <>
      <PanelHeader icon={<Back onBack={onBack} />} title="Connection details" />
      <h3 className="mt-2 text-xs font-medium text-muted-foreground">
        SSH host
      </h3>
      <CopyField label="Address" value={machine.ip} />
      <CopyField label="Port" value={String(machine.port ?? 22)} />
      <CopyField label="Username" value={machine.user} />
      <CopyField
        label="Key"
        value="devbox"
        copiable={false}
        note="the one already in your keychain"
      />
      <CopyField
        label="Fingerprint"
        value={machine.fingerprint ?? "unknown"}
        below="Compare on first connect."
      />

      <h3 className="mt-5 text-xs font-medium text-muted-foreground">
        Port forwarding
      </h3>
      <CopyField label="Local port" value={String(machine.local_port)} />
      <CopyField label="Remote host" value="localhost" copiable={false} />
      {/* Read from the profile, never assumed: this line printed a hardcoded 9010 until
          20/08, handing a wrong forward to every profile not serving on that port. */}
      <CopyField label="Remote port" value={String(machine.app_port)} />
      <p className="mt-3 text-sm text-muted-foreground">
        Then http://localhost:{machine.local_port} in Safari.
      </p>
      {machine.note ? (
        <p className="mt-1 text-sm text-muted-foreground">{machine.note}</p>
      ) : null}

      {/* The profile's other ports, one more rule each, remote host localhost as above. The
          local port is the one this server's ssh config gave it, which a phone may take as it
          is - or the remote port itself, for a machine described before the list. */}
      {extraForwards(machine).map(({ local, remote }) => (
        <div key={remote}>
          <h3 className="mt-5 text-xs font-medium text-muted-foreground">
            Port forwarding, port {remote}
          </h3>
          <CopyField label="Local port" value={String(local)} />
          <CopyField label="Remote port" value={String(remote)} />
        </div>
      ))}
    </>
  )
}

/** Every port the profile forwards after the app's, with the local port to give it. */
function extraForwards(machine: MachineDetail): { local: number; remote: number }[] {
  return (machine.app_ports ?? []).slice(1).map((remote) => ({
    remote,
    local: machine.forwards?.find((one) => one.remote === remote)?.local ?? remote,
  }))
}

/**
 * The label, given and taken back from the same field.
 *
 * In the sheet rather than a dialog of its own since 13/09: a dialog opened from a sheet is
 * cut by it (Confirm in screens/secrets.tsx says why). A form, so the keyboard's return key
 * saves - the button can sit behind the keyboard on a phone.
 *
 * Clearing is not a second control. An empty field is a removal, which is what somebody
 * reaching for a rename box to undo one will do without being told.
 */
function RenamePanel({
  machine,
  onBack,
  onDone,
}: {
  machine: MachineDetail
  onBack: () => void
  onDone: () => void
}) {
  const [typed, setTyped] = React.useState(machine.label ?? "")
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)

  const run = async () => {
    setSending(true)
    setError(null)
    try {
      await api.label(machine.name, typed)
      onDone()
    } catch (failure) {
      setError(reason(failure))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <PanelHeader
        icon={<Back onBack={onBack} />}
        title="Rename"
        description={
          <>
            ssh and the provider keep{" "}
            <span className="font-mono">{machine.name}</span>; an empty name
            removes the label.
          </>
        }
      />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!sending) void run()
        }}
      >
        <Input
          aria-label="Name in the dashboard"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={machine.name}
          maxLength={40}
          enterKeyHint="go"
          className="h-12 text-base"
        />
        {error ? (
          <p role="alert" className="mt-2 text-sm break-words text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          size="lg"
          className="mt-3 h-11 w-full"
          disabled={sending}
        >
          {sending ? <Spinner /> : "Save"}
        </Button>
      </form>
    </>
  )
}

/**
 * Phase 2, replayed: `devbox seed`, which the page calls "Set up again".
 *
 * What `cmd_seed` does, read in devbox-core on 13/09: it sends the profile's keys into the
 * machine's /run/secrets again, sends the profile and the prelude again, and runs the
 * profile's setup again - a setup written to be re-entered, every step checking for its own
 * result, a clone already there left untouched. So it is how a replaced key reaches a machine,
 * and that is the sentence. It destroys nothing, which is the whole difference with Destroy:
 * a confirmation in the panel, and no name to type.
 *
 * The profile is not asked for again: the server takes back the one the machine already
 * carries, the same choice `devbox seed` makes with no argument.
 */
function SetupPanel({
  machine,
  onBack,
}: {
  machine: MachineDetail
  onBack: () => void
}) {
  const navigate = useNavigate()
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)

  const run = async () => {
    setSending(true)
    setError(null)
    try {
      const answer = await api.seed(machine.name)
      navigate(answer.redirect)
    } catch (failure) {
      setError(reason(failure))
      setSending(false)
    }
  }

  return (
    <>
      <PanelHeader icon={<Back onBack={onBack} />} title="Set up again" />
      <Confirmation
        title={
          <>
            Set up <span className="font-mono">{machine.name}</span> again?
          </>
        }
        action="Set up again"
        sending={sending}
        error={error}
        onConfirm={() => void run()}
        onCancel={onBack}
      >
        Sends your current keys to the machine and runs{" "}
        {machine.profile === null ? (
          "its setup"
        ) : (
          <>
            the <span className="font-mono">{machine.profile}</span> setup
          </>
        )}{" "}
        again, which is how a replaced key reaches it.
      </Confirmation>
    </>
  )
}

/**
 * A confirmation drawn inside the sheet, the shape of Confirm in screens/secrets.tsx: a
 * dialog over a sheet is cut by it. Focused when it appears, so the keyboard is not left on
 * a row that has just gone.
 */
function Confirmation({
  title,
  action,
  sending,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: React.ReactNode
  action: string
  sending: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  children: React.ReactNode
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const titleId = React.useId()

  React.useEffect(() => {
    ref.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-labelledby={titleId}
      className="mt-2 rounded-lg border border-border p-3 text-sm outline-none"
    >
      <p id={titleId} className="font-medium break-words">
        {title}
      </p>
      <p className="mt-1 text-muted-foreground">{children}</p>
      {error === null ? null : (
        <p role="alert" className="mt-2 text-sm break-words text-destructive">
          {error}
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          size="lg"
          className="h-11"
          onClick={onCancel}
          disabled={sending}
        >
          Cancel
        </Button>
        <Button
          size="lg"
          className="h-11"
          onClick={onConfirm}
          disabled={sending}
        >
          {sending ? <Spinner /> : action}
        </Button>
      </div>
    </div>
  )
}

/**
 * Destroy, with the name to type back in.
 *
 * Destroyed, never powered off: a stopped machine is still billed, and so there is no
 * "stop" button beside this one. The name is typed back in because this is the only
 * mistake in this tool that destroys unpushed work - and the server checks it again on its
 * own side, a confirmation living only in the page being no confirmation at all for
 * whatever holds the API token.
 *
 * Visible at rest, in outline and red, at the foot: the gesture that ends the bill is never
 * behind a menu. The sentence the card used to carry above it now opens the dialog, where the
 * gesture is.
 *
 * As a Dialog rather than a form folded away at the bottom of the page: on a phone,
 * destruction is the one gesture that should cut off the rest of the screen.
 */
function Destroy({ machine }: { machine: MachineDetail }) {
  const navigate = useNavigate()
  const [typed, setTyped] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const [held, setHeld] = React.useState<Held>(null)
  // Which question is the current one: a dialog closed and reopened while the first is still
  // in flight must not be answered by it. The answer names a moment, and the moment is gone.
  const asked = React.useRef(0)

  // Asked on every opening rather than once: the reader is looking at this dialog because
  // they are about to destroy the machine, and an agent has been committing on it since the
  // last time they opened it. Three seconds of SSH against an answer that is true now.
  const look = (opening: boolean) => {
    if (!opening) return
    const mine = ++asked.current
    setHeld("looking")
    api.unpushed(machine.name).then(
      (answer) => {
        if (asked.current === mine) setHeld(answer)
      },
      (failure: unknown) => {
        if (asked.current === mine) setHeld({ known: false, why: reason(failure) })
      }
    )
  }

  const run = async () => {
    if (typed.trim() !== machine.name) {
      setError(`Type exactly ${machine.name} to confirm.`)
      return
    }
    setSending(true)
    setError(null)
    try {
      const answer = await api.destroy(machine.name, typed.trim())
      navigate(answer.redirect)
    } catch (failure) {
      setError(reason(failure))
      setSending(false)
    }
  }

  return (
    <Dialog onOpenChange={look}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="lg"
            className="mt-10 h-12 w-full border-destructive/50 text-base text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50 dark:hover:bg-destructive/15"
          />
        }
      >
        <Trash2Icon data-icon="inline-start" />
        Destroy machine
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Destroy {machine.name}?</DialogTitle>
          <DialogDescription>
            Destroyed, never powered off: a stopped machine is still billed.
            Whatever was not pushed goes with it. Type the name to confirm.
          </DialogDescription>
        </DialogHeader>
        <Held state={held} />
        {/* A form, so the keyboard's own return key confirms.
            The dialog is centred: on an iPhone the footer sits behind the portrait keyboard
            once the name is being typed, and tapping outside to dismiss the keyboard hits the
            backdrop and closes the dialog. The login screen already submits on return
            (screens/login.tsx); this is the same gesture, on the one dialog that destroys
            unpushed work. */}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!sending) void run()
          }}
        >
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={machine.name}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            className="h-12 font-mono text-base"
          />
          {error ? (
            <p className="mt-2 text-sm break-words text-destructive">{error}</p>
          ) : null}
        </form>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" size="lg" className="h-12 text-base" />
            }
          >
            Cancel
          </DialogClose>
          {/* Deliberately live even when the name does not match: it is the check that
              answers "type exactly <name>". A greyed-out button with no sentence leaves the
              reader hunting for what is wrong. */}
          <Button
            variant="destructive"
            size="lg"
            className="h-12 text-base"
            onClick={run}
            disabled={sending}
          >
            {sending ? "…" : "Destroy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** What the machine answered about its checkouts, while the dialog is open. */
type Held = "looking" | Unpushed | null

/** Anything a destroy would take with it: see src/unpushed.ts#holdsWork, which is this rule. */
function holding(one: Checkout): boolean {
  return one.changed > 0 || one.ahead === null || one.ahead > 0
}

/** `3 files not committed, 2 commits not pushed`, and never a zero spelled out. */
function what(one: Checkout): string {
  const said: string[] = []
  if (one.changed > 0) {
    said.push(`${one.changed} file${one.changed === 1 ? "" : "s"} not committed`)
  }
  // Null is not zero: a branch with no upstream has every commit on it living on this disk
  // alone, and a count would be the wrong shape of answer as well as the wrong number.
  if (one.ahead === null) said.push("never pushed")
  else if (one.ahead > 0) {
    said.push(`${one.ahead} commit${one.ahead === 1 ? "" : "s"} not pushed`)
  }
  return said.join(", ")
}

/**
 * What this machine is holding, drawn above the button that ends it.
 *
 * Four states and they are four different sentences, because collapsing any two of them
 * would be the one mistake this whole feature exists to prevent. A machine with nothing on
 * it and a machine that would not answer look identical from here unless it is said: the
 * first is "nothing to lose", the second is "unknown", and only one of them is a reason to
 * press without looking further. A doubt must never render as an agreement - the version
 * handshake's rule (`version_gate` in devbox-core), on the screen where it costs work rather
 * than a redeploy.
 *
 * It never blocks, and the button below it is live throughout: a machine whose disk is
 * already gone is exactly the one that most needs destroying, and a reader who knows what
 * they are throwing away does not need to be stopped, only told.
 */
function Held({ state }: { state: Held }) {
  if (state === null) return null
  if (state === "looking") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Looking at what is on it…
      </p>
    )
  }
  if (!state.known) {
    return (
      <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm break-words text-amber-700 dark:text-amber-400">
        Could not look at what is on it ({state.why}). What it holds is unknown,
        which is not the same as nothing.
      </p>
    )
  }
  const work = state.checkouts.filter(holding)
  if (work.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {state.checkouts.length === 0
          ? "Nothing is cloned under /workspace."
          : `Every checkout is committed and pushed (${state.checkouts.length}).`}
      </p>
    )
  }
  return (
    <ul className="space-y-1 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {work.map((one) => (
        <li key={one.dir} className="break-words">
          {/* The directory in mono, as everywhere a machine produced the string, and its
              branch beside it: two checkouts of the same repository differ by that alone.
              `-` is a repository with no commit yet, which has no branch to name. */}
          <span className="font-mono">{one.dir.split("/").pop()}</span>
          {one.branch === "-" ? null : (
            <span className="opacity-80"> ({one.branch})</span>
          )}
          : {what(one)}
        </li>
      ))}
    </ul>
  )
}
