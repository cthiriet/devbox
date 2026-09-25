import * as React from "react"
import {
  CloudOffIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  TagIcon,
} from "lucide-react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router"

import { ConnectCloud } from "@/components/get-started"
import { Screen } from "@/components/layout"
import { CloudMark, Price, Specs } from "@/components/marks"
import { Fold, PanelHeader, Row, Rows, Sheet } from "@/components/panel"
import { CloudChip, Rung } from "@/components/rung"
import { useSession } from "@/components/session"
import { Loading, LoadingRows, Nothing, Trouble } from "@/components/states"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAsync } from "@/hooks/use-async"
import { useDebounced } from "@/hooks/use-debounced"
import { ApiError, api, reason } from "@/lib/api"
import { DISK_ASKED, cloudName } from "@/lib/clouds"
import {
  askedFloors,
  cloudsOf,
  floorsTextOf,
  ladders,
  narrow,
  shapesOf,
  valuesOf,
  type Shape,
  type Trio,
} from "@/lib/floors"
import { MONTH_HOURS, eur, eurPerMonth } from "@/lib/format"
import type { Profile } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Step 2 of 2: what it is made of, from every cloud, cheapest first.
 *
 * This is the list the old page did not have. It asked for a cloud, then three floors, and
 * the price was discovered once the machine had been created. Here the offers are real -
 * `/api/probe` questions the providers now - and they are filtered by THIS profile's
 * floors: the first row is the cheapest machine that can do the job, and that is the only
 * ordering that counts.
 *
 * The profile travels in the address (`?profile=`) and not in the navigation state, so that
 * reloading step 2 on a phone that put the tab to sleep is still step 2 rather than an
 * empty screen.
 *
 * What is sent to the server pins the SHAPE (`type`) and not the price: the price is what
 * it costs today, the shape is what was chosen. The server goes back through the probe with
 * the same profile's floors, so an offer that went out of stock between this screen and the
 * order is refused before anything at all is created, rather than at apply time.
 *
 * Nor the PLACE, and the list is drawn from that fact: one row per machine, not one per place
 * the probe found it in (lib/floors.ts#Shape). devbox-core orders the type in the first place
 * that sells it and moves to the next when stock runs out at apply - "the fallback at apply is
 * not optional", hz_up says - so the places are shown in the order they will be tried, on the
 * chosen card, and not offered as a choice the order would ignore, or honour by giving up
 * that fallback.
 *
 * CALM, since 13/09, like the Keys page. A machine at rest is its cores, memory and disk, its
 * price, and its cloud's mark; the one chosen unfolds the rest. The filters are a panel behind
 * the header's sliders, the name a panel behind a link under the Order button, and the clouds
 * that were not asked a row. What stays in sight is the price the button will spend, and
 * every way out of a dead end.
 */
export function NewShape() {
  const [params] = useSearchParams()
  const wanted = params.get("profile") ?? ""

  const profiles = useAsync(() => api.profiles(), [])
  const profile =
    (profiles.data ?? []).find((one) => one.name === wanted) ?? null

  if (wanted === "") return <Navigate to="/new" replace />

  if (profiles.status === "loading") {
    return (
      <Screen
        title="Choose a machine type"
        back={{ to: "/new", label: "Profile" }}
      >
        <Loading label="Reading the profiles" />
      </Screen>
    )
  }

  if (profiles.status === "failed") {
    return (
      <Screen
        title="Choose a machine type"
        back={{ to: "/new", label: "Profile" }}
      >
        <Trouble
          title="Profiles unreadable"
          detail={profiles.error}
          onRetry={profiles.reload}
        />
      </Screen>
    )
  }

  if (profile === null) {
    return (
      <Screen
        title="Choose a machine type"
        back={{ to: "/new", label: "Profile" }}
      >
        <Trouble
          title="Unknown profile"
          detail={`No profile is called ${wanted} on this service.`}
        />
      </Screen>
    )
  }

  return <Shapes profile={profile} />
}

type Panel = "filter" | "name" | "skipped"

function Shapes({ profile }: { profile: Profile }) {
  const navigate = useNavigate()
  const { session } = useSession()
  // No cloud to ask: the step is one sentence and one way out, and nothing else - filters,
  // a name and a list of clouds not asked would all describe a market there is no way into.
  const noCloud = session?.configured === false

  const [chosen, setChosen] = React.useState<{
    cloud: string
    type: string
  } | null>(null)
  /**
   * What the reader narrowed the list to, on top of the profile's floors.
   *
   * CPU AND RAM DO NOT GO BACK TO THE PROBE. Everything above the profile's floors is
   * already in hand - three cloud APIs answered for it, and it is the longest wait in the
   * product - and asking them again for a SUBSET of what is on screen would buy a spinner
   * and no new offer. So those two narrow, instantly, and never widen.
   *
   * THE DISK DOES, and it is the one axis that has to. On Hetzner the disk is an attribute
   * of the shape - a cx33 comes with 80 GB - and on Scaleway the shape caps it, so filtering
   * on it is the same subset argument as above. On GCP it is a PARAMETER: the root asks for
   * `boot_disk_gb`, any size up to 64 TB, so every GCP row carries back the floor it was
   * probed at and nothing else. Measured on 31/08 - the disk rungs the offers can feed are
   * 80/160/240/.../960 from Hetzner, 80/120/150/300/600 from Scaleway, and from GCP the
   * single value 80. Narrowing to 360 could then only ever answer `nothing on gcp`, for a
   * machine GCP creates perfectly well. And the price follows the disk there - 0,139 EUR/h
   * at 80 GB against 0,1727 at 360 - which no client-side filter can recompute.
   *
   * In state rather than in the address, unlike `?profile=`. The profile is the step, and a
   * phone that put the tab to sleep has to come back to it; a filter is a way of reading one
   * step, and every tap on a select would otherwise be a history entry for the back
   * chevron to walk through.
   */
  const [narrowing, setNarrowing] = React.useState<Trio | null>(null)
  /**
   * The clouds kept, and an empty list means all of them. See rung.tsx#CloudChip: a filter
   * that can be turned all the way off is a dead end two taps away, and this screen already
   * has one honest way to show nothing - a floor above what the market sells.
   */
  const [only, setOnly] = React.useState<string[]>([])
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<{
    text: string
    job?: number
  } | null>(null)
  const [sending, setSending] = React.useState(false)

  const [panel, setPanel] = React.useState<Panel | null>(null)
  // What the sheet draws, kept through its closing animation: see screens/secrets.tsx.
  const [drawn, setDrawn] = React.useState<Panel>("filter")
  if (panel !== null && panel !== drawn) setDrawn(panel)

  // The profile's effective floors - declared or inherited from the core's template. The
  // BASE, and the thing every "has the reader moved anything" question is asked against:
  // the probe's own floors now move with the reader, so they can no longer serve as that
  // reference without the Clear affordance vanishing the moment it becomes useful.
  const base = valuesOf(profile.floors)
  const wanted = narrowing ?? base

  // Only the floors the header declares: see lib/floors.ts. The ones that are not passed
  // along, the core fills in itself, exactly as `cmd_up` will - except the disk, which the
  // reader can raise and which therefore travels whenever they have.
  //
  // Held back a third of a second before it becomes a probe. A native `<select>` walked
  // with the arrow keys fires `change` on every option it crosses, and twelve disk rungs
  // are one flick: measured against the live dashboard, four concurrent probes are fine
  // and eight answer 502 and take the site down with them. The select itself still moves
  // on the frame the finger moved it - `wanted` is not debounced, only the probe's key.
  //
  // The weaker of the two defences, deliberately. src/engine.ts runs one probe at a time
  // whatever arrives here; a debounce alone would be a bet on human timing.
  const asked = useDebounced(
    Math.max(narrowing?.disk ?? 0, askedFloors(profile).disk ?? 0),
    350
  )
  const probe = useAsync(
    () =>
      asked > 0
        ? api.probe({ ...askedFloors(profile), disk: asked })
        : api.probe(askedFloors(profile)),
    [profile.name, asked]
  )

  const ready = probe.status === "ready" ? probe.data : null

  /**
   * The three menus and the provider chips, frozen at the FIRST answer.
   *
   * Two reasons, and neither is caching. A menu recomputed from the current offers would
   * lose every step below the one just chosen - GCP reports back the disk it was ASKED for,
   * so probing at 360 makes 80 disappear from the list that offers it, and the reader
   * cannot come back down except through Clear. And useAsync goes back to `loading`
   * whenever its key changes, deliberately, so a disk raised would take the three selects
   * out of the Filter panel for the length of a probe: a control vanishing under the finger
   * that just used it. The list shows its skeletons; the controls stay.
   */
  const [menu, setMenu] = React.useState<{
    rungs: ReturnType<typeof ladders>
    clouds: string[]
  } | null>(null)
  // Set DURING the render and not from an effect. React documents this shape for exactly
  // this case - state that has to catch up with what just arrived - and it re-renders at
  // once with the new value rather than painting a frame without it.
  if (ready !== null && menu === null) {
    setMenu({
      rungs: ladders(ready.offers, base),
      clouds: cloudsOf(ready.offers),
    })
  }

  const rungs = menu?.rungs ?? null
  // Offered only where there is a choice to make: one provider answering would be a chip
  // whose two states show the same list.
  const clouds = menu?.clouds ?? []
  const shown =
    ready === null
      ? []
      : shapesOf(
          narrow(ready.offers, wanted).filter(
            (offer) => only.length === 0 || only.includes(offer.cloud)
          )
        )
  // The disk the order will carry, and therefore the disk a Scaleway or GCP machine will be
  // created with (lib/clouds.ts#DISK_ASKED): the floor the list was probed at, or the one the
  // reader has just raised it to while the probe catches up. On Hetzner the type decides.
  const disk = Math.max(wanted.disk, asked)
  const narrowed =
    only.length > 0 ||
    wanted.cpu > base.cpu ||
    wanted.ram > base.ram ||
    wanted.disk > base.disk

  const clear = () => {
    setNarrowing(null)
    setOnly([])
  }

  /**
   * The choice, but only while it is still on screen.
   *
   * Derived rather than cleared by an effect: a shape chosen at 8 GB and then filtered out
   * at 16 must not leave `Order cx42 - 0,018 EUR/h` sitting on the button above a list that
   * no longer holds it. Two gestures to spend money, and the second one has to name
   * something the first one can still point at.
   *
   * A cloud and a type, and nothing else, because that is all an order names: one row holds
   * every place the type is sold in, so exactly one row is ever the chosen one.
   */
  const pick =
    chosen === null
      ? null
      : (shown.find(
          (shape) => shape.cloud === chosen.cloud && shape.type === chosen.type
        ) ?? null)

  const order = async () => {
    if (pick === null || sending) return
    setSending(true)
    setError(null)
    try {
      const answer = await api.create({
        profile: profile.name,
        cloud: pick.cloud,
        type: pick.type,
        // Only once raised: otherwise devbox-core reads the profile's own floor, as it did.
        ...(disk > base.disk ? { disk } : {}),
        ...(name.trim() === "" ? {} : { name: name.trim() }),
      })
      navigate(answer.redirect)
    } catch (failure) {
      // A 409 on a busy machine names the job holding it, and following it is the only useful
      // thing to do with a refusal like that. A cap reached names no job - the ones filling the
      // service may be another account's - and the sentence alone is the answer.
      const job =
        failure instanceof ApiError && typeof failure.payload.job === "number"
          ? failure.payload.job
          : undefined
      setError({ text: reason(failure), job })
      setSending(false)
    }
  }

  return (
    <Screen
      title="Choose a machine type"
      subtitle="Step 2 of 2"
      back={{ to: "/new", label: "Profile" }}
      action={
        noCloud ? null : (
          <div className="flex items-center">
            {rungs === null ? null : (
              <Button
                variant="ghost"
                size="lg"
                className="h-11 w-11"
                onClick={() => setPanel("filter")}
              >
                <SlidersHorizontalIcon />
                <span className="sr-only">Filter</span>
              </Button>
            )}
            <Button
              variant="ghost"
              size="lg"
              className="h-11 w-11"
              onClick={probe.reload}
              disabled={probe.status === "loading"}
            >
              <RefreshCwIcon />
              <span className="sr-only">Refresh</span>
            </Button>
          </div>
        )
      }
    >
      {/* Step 1 says it too, but a profile that declares no secret links straight here,
          whatever the clouds - and without this the first sentence of the step would be
          "Nothing creatable", which reads as a profile too demanding rather than as no
          cloud to ask. */}
      {noCloud ? (
        <ConnectCloud />
      ) : (
        <>
          {/* Said above the list while a filter holds, and the way out is in it: a filter
              hidden behind an icon must not silently shorten the list. */}
          {narrowed ? (
            <div className="mb-3">
              <Filtered onOpen={() => setPanel("filter")} onClear={clear} />
            </div>
          ) : null}

          {probe.status === "loading" ? (
            <>
              <Loading label="What the clouds can create right now" />
              {/* Skeletons under the sentence, like every other list in this app. This is
                  the longest wait in the product - three cloud APIs - and it was the one
                  dressed as an empty page, which is the shape that means "nothing here". */}
              <LoadingRows rows={5} />
            </>
          ) : null}

          {probe.status === "failed" ? (
            <Trouble
              title="Probe failed"
              detail={probe.error}
              onRetry={probe.reload}
            />
          ) : null}

          {probe.status === "ready" ? (
            <>
              {probe.data.offers.length === 0 ? (
                <Nothing>
                  Nothing creatable above what {profile.name} asks for.
                </Nothing>
              ) : shown.length === 0 ? (
                /* A dead end is the one thing a filter must never be, and this screen's
                   sticky button is disabled underneath it: the way back out is named here,
                   in the space where the offers were. It names the whole filter, cloud
                   included, because the reader who lands here has usually moved two of them
                   and is looking for which one went too far. */
                <div>
                  <Nothing>
                    Nothing at {floorsTextOf(wanted)}
                    {only.length > 0
                      ? ` on ${only.map(cloudName).join(" or ")}`
                      : " in this market"}
                    .
                  </Nothing>
                  <Button
                    variant="outline"
                    size="lg"
                    className="h-11"
                    onClick={clear}
                  >
                    Clear the filters
                  </Button>
                </div>
              ) : (
                <ul className="space-y-2">
                  {shown.map((shape) => (
                    <li key={`${shape.cloud}/${shape.type}`}>
                      <ShapeCard
                        shape={shape}
                        disk={diskOf(shape, disk)}
                        chosen={shape === pick}
                        onChoose={() =>
                          setChosen({ cloud: shape.cloud, type: shape.type })
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}

              {/* A missing GCP identifier must not read as a market in which GCP is simply
                  expensive: one row says how many were not asked, and the panel says why. */}
              {probe.data.skipped.length > 0 ? (
                <Rows className="mt-4">
                  <Row
                    icon={<CloudOffIcon />}
                    label={cloudsNotAsked(probe.data.skipped.length)}
                    onOpen={() => setPanel("skipped")}
                  />
                </Rows>
              ) : null}
            </>
          ) : null}

          {error ? (
            <Alert variant="destructive" className="mt-4">
              <AlertTitle>Nothing was ordered</AlertTitle>
              <AlertDescription>
                <p className="break-words">{error.text}</p>
                {error.job !== undefined ? (
                  <Link
                    to={`/job/${error.job}`}
                    className="mt-2 inline-block underline"
                  >
                    Follow the running job
                  </Link>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}

          {/* Two gestures to spend money: choose, then order. A thumb, on a train, touches
              things by accident: so the button repeats the shape and its hourly price, and it
              is the only place an order departs from. The name, which nobody has to give, is
              a quiet link under it rather than a field above - a field the thumb taps while
              the probe is still loading raises a keyboard over the list it waits for.

              Two lines, at one height whatever is chosen: on one line, `Order e2-standard-2
              on Google Cloud - 0,075 EUR/h` ran past both edges of a 375 px phone and cut the
              price, the one thing this button must never lose. The price is the first place's,
              where the order goes first, and says `from` when another place costs more. */}
          <div className="sticky bottom-0 -mx-4 mt-6 border-t border-border bg-background/95 px-4 pt-3 pb-[calc(0.25rem+env(safe-area-inset-bottom))] backdrop-blur">
            <Button
              size="lg"
              className="h-14 w-full text-base"
              disabled={pick === null || sending}
              onClick={order}
            >
              {sending ? (
                "…"
              ) : pick === null ? (
                "Choose a machine type"
              ) : (
                <span className="flex max-w-full min-w-0 flex-col items-center leading-tight">
                  <span className="max-w-full truncate">
                    Order {pick.type} on {cloudName(pick.cloud)}
                  </span>
                  <span className="font-mono text-sm tabular-nums opacity-80">
                    {pricesDiffer(pick) ? "from " : ""}
                    {eur(pick.places[0].hourly_eur)} EUR/h
                  </span>
                </span>
              )}
            </Button>
            <button
              type="button"
              onClick={() => setPanel("name")}
              className="flex h-11 w-full items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              {name.trim() === "" ? (
                "Name it (optional)"
              ) : (
                <>
                  Named{" "}
                  <span className="min-w-0 truncate font-mono text-foreground">
                    {name.trim()}
                  </span>
                </>
              )}
            </button>
          </div>
        </>
      )}

      <Sheet open={panel !== null} onClose={() => setPanel(null)}>
        {drawn === "filter" ? (
          rungs === null ? null : (
            <FilterPanel
              rungs={rungs}
              wanted={wanted}
              clouds={clouds}
              only={only}
              count={probe.status === "loading" ? null : shown.length}
              narrowed={narrowed}
              onNarrow={setNarrowing}
              onOnly={setOnly}
              onClear={clear}
              onDone={() => setPanel(null)}
            />
          )
        ) : drawn === "name" ? (
          <NamePanel
            name={name}
            onName={setName}
            onDone={() => setPanel(null)}
          />
        ) : ready === null ? null : (
          <SkippedPanel lines={ready.skipped} />
        )}
      </Sheet>
    </Screen>
  )
}

function cloudsNotAsked(count: number): string {
  return `${count} ${count === 1 ? "cloud" : "clouds"} not asked`
}

/** A filter is holding: which says so, and the way out of it. One pill, two targets. */
function Filtered({
  onOpen,
  onClear,
}: {
  onOpen: () => void
  onClear: () => void
}) {
  return (
    <span className="inline-flex h-11 items-center rounded-full bg-muted text-sm">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full items-center gap-1.5 rounded-l-full pr-2 pl-3.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SlidersHorizontalIcon aria-hidden className="size-3.5" />
        Filtered
      </button>
      <span aria-hidden className="text-muted-foreground">
        ·
      </span>
      <button
        type="button"
        onClick={onClear}
        className="flex h-full items-center rounded-r-full pr-3.5 pl-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        Clear
      </button>
    </span>
  )
}

/**
 * The three quantities and the providers, in the panel the header's sliders open.
 *
 * They move the list behind the sheet as they are moved, as they did in the page: nothing
 * to apply. The button at the foot says how many shapes are left, so a reader knows before
 * closing whether the filter went too far.
 */
function FilterPanel({
  rungs,
  wanted,
  clouds,
  only,
  count,
  narrowed,
  onNarrow,
  onOnly,
  onClear,
  onDone,
}: {
  rungs: ReturnType<typeof ladders>
  wanted: Trio
  clouds: string[]
  only: string[]
  /** Null while a raised disk is being asked of the providers. */
  count: number | null
  narrowed: boolean
  onNarrow: (next: Trio) => void
  onOnly: (next: string[]) => void
  onClear: () => void
  onDone: () => void
}) {
  return (
    <>
      <PanelHeader
        icon={
          <SlidersHorizontalIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title="Filter"
      />
      <div className="mt-2 divide-y divide-border rounded-xl ring-1 ring-foreground/10">
        <FilterLine label="Cores, at least">
          <Rung
            what="cpu"
            rungs={rungs.cpu}
            value={wanted.cpu}
            onPick={(cpu) => onNarrow({ ...wanted, cpu })}
          />
        </FilterLine>
        <FilterLine label="Memory, at least">
          <Rung
            what="ram"
            rungs={rungs.ram}
            value={wanted.ram}
            onPick={(ram) => onNarrow({ ...wanted, ram })}
          />
        </FilterLine>
        <FilterLine label="Disk, at least">
          <Rung
            what="disk"
            rungs={rungs.disk}
            value={wanted.disk}
            onPick={(disk) => onNarrow({ ...wanted, disk })}
          />
        </FilterLine>
      </div>

      {clouds.length > 1 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {clouds.map((cloud) => (
            <CloudChip
              key={cloud}
              cloud={cloud}
              active={only.includes(cloud)}
              dimmed={only.length > 0}
              onToggle={() =>
                onOnly(
                  only.includes(cloud)
                    ? only.filter((kept) => kept !== cloud)
                    : [...only, cloud]
                )
              }
            />
          ))}
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          size="lg"
          className="h-11"
          onClick={onClear}
          disabled={!narrowed}
        >
          Clear
        </Button>
        <Button size="lg" className="h-11" onClick={onDone}>
          {/* Machines, as the list draws them: a type sold in three places is one. */}
          {count === null
            ? "…"
            : `Show ${count} ${count === 1 ? "type" : "types"}`}
        </Button>
      </div>
    </>
  )
}

function FilterLine({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 px-3 py-1.5">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  )
}

/** The name, which nobody has to give: one is drawn at random otherwise. */
function NamePanel({
  name,
  onName,
  onDone,
}: {
  name: string
  onName: (name: string) => void
  onDone: () => void
}) {
  return (
    <>
      <PanelHeader
        icon={
          <TagIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title="Name it"
        description="Optional: one is drawn at random otherwise."
      />
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onDone()
        }}
      >
        <Input
          aria-label="Name"
          value={name}
          onChange={(event) => onName(event.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          className="h-12 font-mono text-base"
        />
        <Button type="submit" size="lg" className="mt-3 h-11 w-full">
          Done
        </Button>
      </form>
    </>
  )
}

/**
 * The clouds the probe could not ask, and why, in the core's own words under Details. The
 * CLI prints the same block under the same list.
 */
function SkippedPanel({ lines }: { lines: string[] }) {
  return (
    <>
      <PanelHeader
        icon={
          <CloudOffIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title={cloudsNotAsked(lines.length)}
        description="Their machine types are missing from this list."
      />
      <Link
        to="/account"
        className={cn(
          buttonVariants({ variant: "outline", size: "lg" }),
          "h-11 w-full"
        )}
      >
        Open Account
      </Link>
      <Fold title="Details" className="mt-3 border-t border-border">
        <ul className="space-y-1 font-mono text-xs break-words text-muted-foreground">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Fold>
    </>
  )
}

/**
 * One machine: at rest, what the list is compared by - the cores, the memory and the disk,
 * the hour, and whose it is; chosen, everything else, the places it is sold in included.
 *
 * The cloud is its mark alone at rest, monochrome: the coloured badge made Hetzner's rows red,
 * which on a list read as an error, and the word is back as soon as the card is chosen. The
 * three quantities are drawn with the icons of the Filter panel (marks.tsx#Specs), because
 * `4 GB · 40 GB` would leave the reader to guess which one is the disk.
 *
 * The price is the first place's, which is where the order goes first, and a small `from`
 * sits over it when another place sells the same machine for more: stacked, so the price
 * column is no wider on a phone, and the row does not pretend that three prices are one. The
 * specs wrap inside the row rather than run under the price, for the rare machine whose
 * numbers are too long for 375 px (416 cores and 11776 GB, on GCP). The shape's name, the
 * month, the CPU class, the availability and the places unfold on the one card chosen - that
 * is the card whose details decide, and the Order button repeats its name and price.
 */
function ShapeCard({
  shape,
  disk,
  chosen,
  onChoose,
}: {
  shape: Shape
  /** The disk it will be created with, which is not always `shape.disk_gb`: see diskOf. */
  disk: number
  chosen: boolean
  onChoose: () => void
}) {
  const first = shape.places[0]
  const from = pricesDiffer(shape) ? "from " : ""
  // Said once when every place says the same - three `available` in a row are one fact -
  // and place by place when they do not, which is when it matters.
  const availabilities = new Set(
    shape.places.map((place) => place.availability)
  )
  const availability =
    availabilities.size === 1 ? first.availability : undefined
  const where =
    shape.places.length === 1
      ? `in ${first.location}`
      : `in ${shape.places.length} places, ${first.location} first`
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      // Named in one stroke rather than left to the reading of the card, whose rest shows
      // less than a buyer needs out loud. The price is said before the rest, as it is read.
      aria-label={`${shape.type} on ${cloudName(shape.cloud)}, ${from}${eur(first.hourly_eur)} EUR/h, ${from}about ${eurPerMonth(first.hourly_eur)} EUR a month, ${shape.cpu} cores, ${shape.ram_gb} GB of memory, ${disk} GB of disk, ${where}${availability === undefined ? "" : `, ${availability ?? "availability unknown"}`}`}
      className={cn(
        "block w-full rounded-xl bg-card px-3 text-left ring-1 ring-foreground/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        chosen ? "ring-2 ring-primary" : "hover:bg-muted/60 active:bg-muted"
      )}
    >
      <span className="flex h-14 items-center gap-3">
        <CloudMark
          cloud={shape.cloud}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <Specs
          cpu={shape.cpu}
          ramGb={shape.ram_gb}
          diskGb={disk}
          className="min-w-0 flex-1 flex-wrap gap-y-0.5 text-sm"
        />
        <span className="flex shrink-0 flex-col items-end">
          {from === "" ? null : (
            <span className="text-[11px] leading-none text-muted-foreground">
              from
            </span>
          )}
          <Price value={first.hourly_eur} className="whitespace-nowrap" />
        </span>
      </span>
      {chosen ? (
        <span className="block border-t border-border pt-2.5 pb-3">
          <span className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <OfferFact name="Cloud">{cloudName(shape.cloud)}</OfferFact>
            <OfferFact name="Type" mono>
              {shape.type}
            </OfferFact>
            <OfferFact name="Per month">
              <span className="text-muted-foreground">{from}</span>
              <Price value={first.hourly_eur} per="month" />
            </OfferFact>
            <OfferFact name="Disk">
              {disk} GB
              {/* Scaleway's type holds more than it is created with: the reader who wants it
                  has to know where the rest is asked for. */}
              {shape.disk_gb > disk && DISK_ASKED.has(shape.cloud) ? (
                <span className="text-muted-foreground">
                  {" "}
                  (Filter raises it up to {shape.disk_gb} GB)
                </span>
              ) : null}
            </OfferFact>
            {shape.cpu_class ? (
              <OfferFact name="CPU">{shape.cpu_class}</OfferFact>
            ) : null}
            {/* GCP publishes no availability, hence "unknown": the regional quota before,
                the error during. Hetzner and Scaleway, for their part, publish it. */}
            {availability === undefined ? null : (
              <OfferFact name="Availability">
                {availability ?? "unknown"}
              </OfferFact>
            )}
            <OfferFact name="Where">
              {shape.places.map((place) => (
                <span key={place.location} className="block">
                  <span className="font-mono break-all">{place.location}</span>
                  {from === "" ? null : (
                    <span className="font-mono text-muted-foreground tabular-nums">
                      {" "}
                      {eur(place.hourly_eur)} EUR/h
                    </span>
                  )}
                  {availability === undefined ? (
                    <span className="text-muted-foreground">
                      {" "}
                      {place.availability ?? "unknown"}
                    </span>
                  ) : null}
                </span>
              ))}
            </OfferFact>
          </span>
          {/* The one thing the pixels cannot say: EUR/mo is a figure this interface
              computes, not one a provider will charge. A number labelled "per month" that
              nobody flags as derived is a number somebody budgets on. And where the machine
              lands is not chosen here, so the card says how it is decided. */}
          <span className="mt-2 block text-xs text-muted-foreground">
            {shape.places.length > 1
              ? "Ordered in the first place listed that can still create it. "
              : ""}
            EUR/mo is the hour times {MONTH_HOURS}, not a bill.
          </span>
        </span>
      ) : null}
    </button>
  )
}

/** Whether a reader would see two prices among a machine's places: compared as printed. */
function pricesDiffer(shape: Shape): boolean {
  const first = eur(shape.places[0].hourly_eur)
  return shape.places.some((place) => eur(place.hourly_eur) !== first)
}

/**
 * The disk a machine will be created with: its type's on Hetzner, and on Scaleway and GCP the
 * floor the order carries (lib/clouds.ts#DISK_ASKED). On Scaleway the probe's figure is what the
 * type could hold, and a row showing it would be a disk somebody compares prices by and never
 * gets.
 */
function diskOf(shape: Shape, ordered: number): number {
  return DISK_ASKED.has(shape.cloud) ? ordered : shape.disk_gb
}

function OfferFact({
  name,
  mono = false,
  children,
}: {
  name: string
  mono?: boolean
  children: React.ReactNode
}) {
  return (
    <>
      <span className="text-muted-foreground">{name}</span>
      <span
        className={cn("min-w-0 break-words", mono && "font-mono break-all")}
      >
        {children}
      </span>
    </>
  )
}
