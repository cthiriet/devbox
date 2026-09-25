import * as React from "react"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleSlashIcon,
  FileKeyIcon,
  ImportIcon,
  KeyRoundIcon,
  LockIcon,
  PlusIcon,
  ServerCogIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router"

import { GuideSteps } from "@/components/guide"
import { Screen } from "@/components/layout"
import { CloudMark, SecretMark } from "@/components/marks"
import { SecretForm } from "@/components/secret-form"
import { SecretInput, type Typed } from "@/components/secret-input"
import { Fold, PanelHeader, Sheet } from "@/components/panel"
import { useSession } from "@/components/session"
import { LoadingRows, Trouble } from "@/components/states"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { useAsync } from "@/hooks/use-async"
import { useSecretGuides } from "@/hooks/use-catalogue"
import { ApiError, api, reason } from "@/lib/api"
import { cloudName, providerOf, SOON, type Provider } from "@/lib/clouds"
import { ago, inSentence } from "@/lib/format"
import { EMPTY_TYPED, sendable } from "@/lib/typed"
import type {
  CloudField,
  CloudSaved,
  CloudSecrets,
  Forgotten,
  Imported,
  ProfileSecret,
  SecretGuide,
  SecretSource,
  Secrets,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Keys & tokens: what the clouds and the profiles are given, written here and never read back.
 *
 * WRITE-ONLY, and the whole screen is drawn from that. `GET /api/secrets` carries names,
 * places and fingerprints; no route answers a value, so there is none to show, and every
 * field below starts empty whatever the vault holds. Replacing a secret is the only way to
 * learn anything about it here, and what one learns is whether the value changed.
 *
 * What was typed lives in React state for as long as the request that sends it and not a
 * frame longer: a save takes the value out of state before the first byte leaves, so the
 * field is empty when the answer arrives, refused or not. A refusal costs a paste. The one
 * exception is a cloud the provider has just refused: its values stay in their fields, masked,
 * so one wrong value of three is one paste and "Save anyway" has something to save. Closing a
 * panel unmounts it, and whatever was typed in it goes with it.
 *
 * AT REST THE PAGE IS ALMOST EMPTY, ON PURPOSE. The first redraw of 13/09 put everything a
 * customer might need on the page at once - Hetzner's guide in four steps with its field and
 * its button, a card per token with its sentence, "Needed by", a button and Details, an
 * Advanced fold - and its owner read it as too much to take in: 1792 px on a phone before
 * anything was connected. So the page is three provider tiles and a short list of tokens,
 * each with its state and nothing else, and every guide, field and technical name opens on a
 * tap, in a panel: a sheet from the bottom on a phone, a dialog on a wider screen. What a
 * panel does is what the cards did, sentence for sentence where it could be; only where it is
 * drawn changed.
 *
 * Three things are shown without a tap, because they are faults and not information: a closed
 * vault (one line, the reason in its panel); a value served by the service's own environment
 * or files (a dot - the fallback trap: removing the page's value hands the job back to that
 * older one); and machines running on a cloud nothing here can reach any more (a line: they
 * bill, and the server refuses to destroy them).
 *
 * THE ADDRESS IS THE OPEN PANEL. `#cloud-hetzner` opens Hetzner's, `#secret-github` the GitHub
 * token's - the fragments the first-run card and a seed's way back already link to - and a
 * tap writes the fragment rather than a state beside it, replacing the history entry so Back
 * still leaves the page. A panel is therefore something a link can open, and a reload lands on
 * it. A fragment naming nothing this page knows opens nothing.
 *
 * The reviews of the first redraw still stand, each where it now lives:
 *
 *   - Names. `HCLOUD_TOKEN`, `gcp` in lowercase mono, "seeded with", "/run/secrets", a
 *     provenance and a fingerprint: all true, and all the first thing a customer read. Since
 *     15/09 the variable names and the fingerprints are not drawn at all, and a token no guide
 *     describes is its name in the page's type, not in mono beside the labelled ones. Where a
 *     value comes from, and when, is under each panel's Details, which opens on its own where
 *     the fallback trap is live.
 *   - One button. Connect tests the values with the provider and saves them only if it
 *     accepts; a refusal says so in plain words, keeps the provider's own words folded, and
 *     offers "Save anyway" for the day the check itself is what is broken.
 *   - Whole. `PUT /api/clouds/:cloud` writes a cloud in one transaction: Save once sent one
 *     PUT per field, and a refusal at the second left a Scaleway pair half written.
 *   - Where from. Each panel says where the value is made, and opens the provider's page in a
 *     new tab.
 *
 * The screen keeps its own copy of the answer and patches it from each write's reply rather
 * than reloading. `useAsync.reload()` goes back to `loading` on purpose, which would unmount
 * the open panel - and with it whatever the reader had typed - and a fresh list would drop a
 * profile secret just deleted that no profile declares, along with the sentence saying what
 * took over from it. The reply is the vault's own word on the entry it changed; `usable` is
 * the one derived field, recomputed by the contract's own rule.
 */
export function SecretsScreen() {
  const { session } = useSession()
  const first = useAsync(() => api.secrets(), [])
  const guides = useSecretGuides()
  const [held, setHeld] = React.useState<Secrets | null>(null)
  const [hiccup, setHiccup] = React.useState<string | null>(null)
  // Frozen at opening, like the fleet: a date is a landmark, and reading the clock in the
  // middle of a render makes the render impure. A secret written since reads "just now".
  const [now] = React.useState(() => Date.now())

  const data = held ?? first.data

  // The import, and a 503 met halfway through a save: the whole answer again, without going
  // back through `loading` - see above for what that would cost. There is no Refresh button
  // any more: every write patches the copy from its own answer, and opening the page reads it.
  const reread = async () => {
    try {
      setHeld(await api.secrets())
      setHiccup(null)
    } catch (failure) {
      setHiccup(reason(failure))
    }
  }

  const patch = (change: (data: Secrets) => Secrets) =>
    setHeld((previous) => {
      const base = previous ?? first.data
      return base === null ? previous : change(base)
    })

  return (
    <Screen title="Keys & tokens" subtitle="Encrypted, and never shown again.">
      {first.status === "loading" ? <LoadingRows rows={2} /> : null}
      {first.status === "failed" ? (
        <Trouble
          title="Keys and tokens unreadable"
          detail={first.error}
          onRetry={first.reload}
        />
      ) : null}
      {data === null ? null : (
        <Overview
          data={data}
          dir={session?.secrets_dir ?? ""}
          // The founder's to import: the service's variables and files become its vault.
          fallback={session?.account?.id === 1}
          guides={guides}
          now={now}
          hiccup={hiccup}
          onReread={() => void reread()}
          onEntry={(entry) => patch((current) => withEntry(current, entry))}
        />
      )}
    </Screen>
  )
}

/** The fragments that open a panel of their own, besides `secret-<name>`. */
const ADD_TOKEN = "add-token"
const IMPORT = "import"
const VAULT = "vault"

/** The two headings are signposts, not statements: quiet, and short. */
const HEADING = "text-sm font-medium text-muted-foreground"

/** A gesture that is not the page's point, drawn as text. 44 px tall all the same. */
const QUIET =
  "inline-flex h-11 items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"

/** Missing and needed first, then what is held and read, then what nothing reads. */
function urgency(entry: ProfileSecret): number {
  if (entry.used_by.length === 0) return 2
  return entry.set ? 1 : 0
}

function Overview({
  data,
  dir,
  fallback,
  guides,
  now,
  hiccup,
  onReread,
  onEntry,
}: {
  data: Secrets
  dir: string
  fallback: boolean
  guides: ReadonlyMap<string, SecretGuide>
  now: number
  hiccup: string | null
  onReread: () => void
  onEntry: (entry: ProfileSecret) => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const open = data.vault.available
  const aimed = aimedAt(location.hash)

  // Taken when the page opens, and never re-sorted: a row that jumped the moment its token
  // was added would move under the reader's thumb.
  const [order] = React.useState(() =>
    [...data.profile]
      .sort((a, b) => urgency(a) - urgency(b) || a.name.localeCompare(b.name))
      .map((entry) => entry.name)
  )
  const entries = [
    ...order.flatMap((name) => data.profile.filter((one) => one.name === name)),
    // A secret added on this page after it opened goes last, where it was added.
    ...data.profile.filter((one) => !order.includes(one.name)),
  ]
  // TWO GROUPS, and the line between them is the catalogue: a name SECRET_GUIDES describes is
  // one the page can explain - what it is for, where to make one, what it starts with - and
  // belongs to software devbox installs itself. Every other name was typed here or declared by
  // a profile written by hand, and the page holds nothing but the name. A reader scanning for
  // `team-scaleway` was reading past three rows that are never going to be theirs.
  //
  // Only when both groups exist: one heading over one list names a distinction that has no
  // other side, and the row that would carry it is quicker to read on its own.
  //
  // `guides` is empty until the catalogue answers, which is a request and not a constant here:
  // everything would fall in the second group and the lists would re-form under the reader.
  // So the split waits for it, and until then the tokens are the one list they have always
  // been.
  const described = (one: ProfileSecret) => guides.has(one.name)
  const split =
    guides.size > 0 && entries.some(described) && !entries.every(described)

  // The service's own credentials are the founder's to import, and only an account that may
  // use them: the server answers 403 to every other, and a link to what can only be refused is
  // a question with no answer. Offered while something is still read from outside the vault.
  const importable = fallback && outsideTheVault(data).length > 0

  const entryAt = (fragment: string) =>
    data.profile.find((entry) => `secret-${entry.name}` === fragment)
  const opens = (fragment: string) =>
    entryAt(fragment) !== undefined ||
    fragment === ADD_TOKEN ||
    (fragment === IMPORT && fallback) ||
    (fragment === VAULT && !open)

  // What the panel draws. It outlives the address by the length of the closing animation - the
  // fragment is already gone by then, and a sheet emptying itself as it slides away reads as a
  // glitch - so it changes only when the address names another panel.
  const [shown, setShown] = React.useState(aimed)
  if (opens(aimed) && aimed !== shown) setShown(aimed)

  const go = (fragment: string) =>
    navigate(
      { pathname: location.pathname, search: location.search, hash: fragment },
      { replace: true }
    )

  const panel = (): React.ReactNode => {
    const entry = entryAt(shown)
    if (entry !== undefined) {
      return (
        <SecretPanel
          key={shown}
          entry={entry}
          guide={guides.get(entry.name)}
          open={open}
          dir={dir}
          now={now}
          onEntry={onEntry}
          onReread={onReread}
        />
      )
    }
    if (shown === ADD_TOKEN) {
      return <AddTokenPanel open={open} onEntry={onEntry} onReread={onReread} />
    }
    if (shown === IMPORT && fallback) {
      return <ImportPanel data={data} open={open} dir={dir} onDone={onReread} />
    }
    if (shown === VAULT && !data.vault.available) {
      return <VaultPanel why={data.vault.reason} dir={dir} />
    }
    return null
  }

  return (
    <>
      {open ? null : (
        <button
          type="button"
          onClick={() => go(VAULT)}
          className="mb-5 flex min-h-11 w-full items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-left text-sm text-destructive outline-none hover:bg-destructive/15 focus-visible:ring-2 focus-visible:ring-destructive/40"
        >
          <LockIcon aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">Saving is unavailable right now</span>
          <ChevronRightIcon aria-hidden className="size-4 shrink-0" />
        </button>
      )}

      {hiccup === null ? null : (
        <p className="mb-4 text-sm break-words text-muted-foreground">
          Could not check again ({hiccup}). What shows is the last answer.
        </p>
      )}

      <section aria-labelledby="tokens">
        <h2 id="tokens" className={HEADING}>
          Tokens
        </h2>
        {split ? (
          <>
            <TokenList
              className="mt-3"
              title="For the software devbox installs"
              entries={entries.filter(described)}
              guides={guides}
              onOpen={(entry) => go(`secret-${entry.name}`)}
            />
            <TokenList
              className="mt-5"
              title="Named by your own profiles"
              entries={entries.filter((one) => !described(one))}
              guides={guides}
              onOpen={(entry) => go(`secret-${entry.name}`)}
            />
          </>
        ) : (
          <TokenList
            className="mt-2"
            entries={entries}
            guides={guides}
            onOpen={(entry) => go(`secret-${entry.name}`)}
          />
        )}
        {/* For a profile written by hand that reads a name of its own: last, and quiet, since
            a machine receives it only if its profile declares that name. */}
        <button type="button" className={QUIET} onClick={() => go(ADD_TOKEN)}>
          <PlusIcon aria-hidden className="size-4" />
          {entries.length === 0 ? "Add a token" : "Add another token"}
        </button>
      </section>

      {importable ? (
        <button
          type="button"
          className={cn(QUIET, "mt-6")}
          onClick={() => go(IMPORT)}
        >
          <ImportIcon aria-hidden className="size-4" />
          Import the service's own credentials
        </button>
      ) : null}

      <Sheet open={opens(aimed)} onClose={() => go("")}>
        {panel()}
      </Sheet>
    </>
  )
}

/* --- the cloud accounts, on the settings page ---------------------------------------- */

/**
 * The cloud accounts, on the settings page since 13/09: where this account's machines are created.
 *
 * Each account connects its own. Where a hosted service's extension puts an account on the
 * service's cloud accounts, the server says so cloud by cloud (`via: "service"`), and the same
 * three providers read one word each - "Service" where its machines go to the service's account,
 * "Yours" where it connected its own, which then answers for that provider whole
 * (src/secrets.ts#resolveSecret). Nothing here asks who founded the service: `via` is the
 * server's answer. The Keys page keeps what machines are handed: the tokens.
 *
 * Its own answer and its own sheet, opened by `#cloud-<id>` like the Keys page's panels, beside
 * the settings' own: the two sets of fragments do not meet.
 */
export function CloudAccounts() {
  const { session, reread: rereadSession } = useSession()
  const first = useAsync(() => api.secrets(), [])
  const [held, setHeld] = React.useState<Secrets | null>(null)
  const [now] = React.useState(() => Date.now())
  const location = useLocation()
  const navigate = useNavigate()
  const data = held ?? first.data
  const dir = session?.secrets_dir ?? ""

  // Whose account a cloud goes to is the server's to say, not a rule of this page: after a
  // disconnection the whole answer is read again rather than patched.
  const reread = async () => {
    try {
      setHeld(await api.secrets())
    } catch {
      // The last answer stays drawn; the next opening reads again.
    }
  }
  const patch = (change: (data: Secrets) => Secrets) =>
    setHeld((previous) => {
      const base = previous ?? first.data
      return base === null ? previous : change(base)
    })

  const aimed = aimedAt(location.hash)
  const cloudAt = (fragment: string) =>
    data?.clouds.find((cloud) => `cloud-${cloud.cloud}` === fragment)
  const [shown, setShown] = React.useState(aimed)
  if (cloudAt(aimed) !== undefined && aimed !== shown) setShown(aimed)
  const go = (fragment: string) =>
    navigate(
      { pathname: location.pathname, search: location.search, hash: fragment },
      { replace: true }
    )

  const connected = data?.clouds.some((cloud) => cloud.usable) ?? false
  const onService = data?.clouds.some((cloud) => cloud.via === "service") ?? false
  const stranded = (data?.clouds ?? []).filter(
    (cloud) => !cloud.usable && (cloud.machines ?? []).length > 0
  )
  const showing = cloudAt(shown)

  return (
    <section aria-labelledby="clouds">
      <h2 id="clouds" className={HEADING}>
        Cloud accounts
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {onService
          ? "The service's, unless you connect your own."
          : "Your machines are created on these."}
      </p>
      {first.status === "loading" ? <LoadingRows rows={1} /> : null}
      {first.status === "failed" ? (
        <Trouble
          title="Cloud accounts unreadable"
          detail={first.error}
          onRetry={first.reload}
        />
      ) : null}
      {data === null ? null : (
        <>
          <ul className="mt-2 grid grid-cols-3 gap-2">
            {data.clouds.map((cloud) => (
              <li key={cloud.cloud}>
                <CloudTile
                  cloud={cloud}
                  shared={onService}
                  hint={!connected ? providerOf(cloud.cloud).tag : null}
                  onOpen={() => go(`cloud-${cloud.cloud}`)}
                />
              </li>
            ))}
            {/* What is coming, in the same grid and the same tile, because the question a
                reader arrives with is "can I use mine?" and the answer is this row as much as
                the one above it. Not a button: there is nothing to open, and a tile that
                opened an empty sheet would be worse than one that says nothing back. */}
            {SOON.map((cloud) => (
              <li key={cloud}>
                <ComingTile cloud={cloud} />
              </li>
            ))}
          </ul>
          {stranded.map((cloud) => (
            <Stranded key={cloud.cloud} cloud={cloud} />
          ))}
          <Sheet open={cloudAt(aimed) !== undefined} onClose={() => go("")}>
            {showing === undefined ? null : (
              <CloudPanel
                key={shown}
                cloud={showing}
                shared={onService}
                open={data.vault.available}
                dir={dir}
                now={now}
                onSaved={(saved) => patch((current) => withCloud(current, saved))}
                onField={(field) => {
                  patch((current) => withField(current, showing.cloud, field))
                  if (onService) void reread()
                }}
                onReread={() => void reread()}
                // The session carries `configured` and `clouds`, which the fleet and the order
                // screens read: read again in place, so a cloud connected here is orderable
                // there without a reload.
                onConnected={() => void rereadSession().catch(() => undefined)}
              />
            )}
          </Sheet>
        </>
      )}
    </section>
  )
}

/* --- at rest -------------------------------------------------------------------------- */

const TILE =
  "rounded-xl bg-card ring-1 ring-foreground/10 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring active:bg-muted"

/**
 * One provider at rest: its mark, its name, and one word of state - or none.
 *
 * Connected is green. Machines on a cloud nothing here can reach any more are red, since they
 * bill. A cloud never connected says nothing at all: not having chosen one is not a fault, and
 * three "Not connected" in a row was the kind of noise this page was redrawn to lose. `hint`
 * is the provider's `tag`, while nothing is connected: one word under Hetzner.
 */
function CloudTile({
  cloud,
  shared,
  hint,
  onOpen,
}: {
  cloud: CloudSecrets
  /** Read by an account that orders on the service's: "Service" or "Yours", never "Connected". */
  shared: boolean
  hint: string | null
  onOpen: () => void
}) {
  const name = providerOf(cloud.cloud).name
  const stranded = !cloud.usable && (cloud.machines ?? []).length > 0
  const theService = shared && cloud.usable && cloud.via === "service"
  // One word of state, or none - and none takes no room: a line kept empty under the name
  // left a tile looking unfinished, its name high and a blank strip below it.
  const status = theService ? (
    <span className="text-muted-foreground">Service</span>
  ) : cloud.usable ? (
    <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
      <CheckIcon aria-hidden className="size-3.5" />
      {shared ? "Yours" : "Connected"}
    </span>
  ) : stranded ? (
    <span className="text-destructive">Disconnected</span>
  ) : hint !== null ? (
    <span className="text-muted-foreground">{hint}</span>
  ) : null
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        TILE,
        "relative flex h-full min-h-20 w-full flex-col items-center justify-center gap-1.5 px-1 py-3 text-center",
        stranded && "ring-destructive/50"
      )}
    >
      <CloudMark cloud={cloud.cloud} className="size-6 shrink-0" />
      <span className="text-sm leading-tight font-medium">{name}</span>
      {status === null ? (
        <span className="sr-only">Not connected</span>
      ) : (
        <span className="flex items-center gap-1 text-xs">{status}</span>
      )}
      {fromOutside(cloud.fields) ? (
        <OutsideDot className="absolute top-2 right-2" />
      ) : null}
    </button>
  )
}

/**
 * One group of tokens in a card of its own, under a heading when there is a second group.
 *
 * A card rather than a rule between two halves of one list: the separation has to survive a
 * thumb scrolling past it, and the gap between two cards says the same thing from any point
 * on the screen. The heading is the quietest thing on it - what a reader wants here is their
 * own name, and the groups are what stops them reading the other five rows to find it.
 */
function TokenList({
  title,
  entries,
  guides,
  onOpen,
  className,
}: {
  title?: string
  entries: ProfileSecret[]
  guides: ReadonlyMap<string, SecretGuide>
  onOpen: (entry: ProfileSecret) => void
  className?: string
}) {
  if (entries.length === 0) return null
  return (
    <div className={className}>
      {title === undefined ? null : (
        <h3 className="mb-1.5 text-xs text-muted-foreground">{title}</h3>
      )}
      <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {entries.map((entry) => (
          <li key={entry.name}>
            <TokenRow
              entry={entry}
              guide={guides.get(entry.name)}
              onOpen={() => onOpen(entry)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One token at rest: what it is, and whether it is added. Nothing about what it is for or who
 * needs it - that is the panel's first sentence, for whoever taps.
 */
function TokenRow({
  entry,
  guide,
  onOpen,
}: {
  entry: ProfileSecret
  guide: SecretGuide | undefined
  onOpen: () => void
}) {
  const label = guide?.label
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-12 w-full items-center gap-3 px-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted"
    >
      <SecretMark
        name={entry.name}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {label ?? entry.name}
      </span>
      {entry.set && entry.source === "file" ? <OutsideDot /> : null}
      {entry.set ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon aria-hidden className="size-3.5" />
          Added
        </span>
      ) : (
        <span className="sr-only">Not added</span>
      )}
      <ChevronRightIcon
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
      />
    </button>
  )
}

/**
 * A provider that is not connectable yet: its mark, its name, and the word `Soon`.
 *
 * Dimmed as a whole rather than drawn in grey with a coloured mark, so the row reads as one
 * state and not as three tiles somebody forgot to finish. `aria-disabled` and no handler: it
 * is a statement, and a reader who taps it is told by the word, not by a sheet that opens on
 * nothing.
 *
 * The list it comes from is SOON in lib/clouds.ts, which is a page-side list on purpose: a
 * name there reaches this tile and nothing that orders a machine.
 */
function ComingTile({ cloud }: { cloud: string }) {
  return (
    <div
      aria-disabled="true"
      className={cn(
        "flex h-full min-h-20 w-full flex-col items-center justify-center gap-1.5 rounded-xl px-1 py-3 text-center",
        "bg-card/50 opacity-60 ring-1 ring-foreground/5"
      )}
    >
      <CloudMark cloud={cloud} className="size-6 shrink-0" />
      <span className="text-sm leading-tight font-medium">{cloudName(cloud)}</span>
      <span className="text-xs text-muted-foreground">Soon</span>
    </div>
  )
}

/**
 * A value read from the service's own environment or files, marked where it is used. Amber and
 * small, because it works - and that is the trap: see the header.
 */
function OutsideDot({ className }: { className?: string }) {
  return (
    <span
      title="Read from the service's own files or environment"
      className={cn("size-2 shrink-0 rounded-full bg-amber-500", className)}
    >
      <span className="sr-only">
        Read from the service's own files or environment
      </span>
    </span>
  )
}

/**
 * Machines on a cloud nothing here can reach any more: the one case on this page that costs
 * money while nobody looks, so it is said without a tap.
 */
function Stranded({ cloud }: { cloud: CloudSecrets }) {
  const machines = cloud.machines ?? []
  const one = machines.length === 1
  return (
    <p className="mt-3 flex items-start gap-1.5 text-sm text-destructive">
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">
        <span className="font-mono">{inSentence(machines)}</span>{" "}
        {one ? "keeps" : "keep"} billing on {providerOf(cloud.cloud).name}, and
        cannot be destroyed until it is connected again.
      </span>
    </p>
  )
}

/* --- the panel ------------------------------------------------------------------------ */

/** Said inside a panel whose fields the closed vault disables, so a greyed button has a reason. */
function ClosedNote() {
  return (
    <p className="flex items-center gap-1.5 text-sm text-destructive">
      <LockIcon aria-hidden className="size-4 shrink-0" />
      Saving is unavailable right now.
    </p>
  )
}


/**
 * Why nothing can be written, in the reader's words first - they cannot fix a master key, and
 * they need to know whether their machines are in danger - then the reason, for whoever can
 * act on it. A closed vault stops nothing that is running; and for the account the service's
 * own files answer for, jobs carry on reading them, which is said to that account only.
 */
function VaultPanel({ why, dir }: { why: string; dir: string }) {
  return (
    <>
      <PanelHeader
        icon={<LockIcon aria-hidden className="size-5 shrink-0 text-destructive" />}
        title="Saving is unavailable"
        description="Nothing on this page can be saved or replaced until the service is repaired. Machines already running keep running."
      />
      <Fold title="Technical details" className="border-t border-border">
        <div className="space-y-2 text-sm text-muted-foreground">
          <p className="break-words">{why.replace(/\.$/, "")}.</p>
          {dir === "" ? null : (
            <p>
              Jobs carry on with the files in <Dir dir={dir} /> and the
              service's environment.
            </p>
          )}
        </div>
      </Fold>
    </>
  )
}

/* --- a cloud ------------------------------------------------------------------------ */

type Phase =
  | { kind: "idle" }
  | { kind: "testing" }
  /** The provider answered, and said no. */
  | { kind: "refused"; error: string }
  /** No answer from the provider: the network, this service, a malformed value. */
  | { kind: "unchecked"; error: string }
  | { kind: "saving" }
  /** The save itself was refused, after the values left the fields. */
  | { kind: "unsaved"; error: string }
  | { kind: "saved"; checked: boolean; usable: boolean }

type Gone = {
  fallbacks: { field: CloudField; fallback: Forgotten["fallback"] }[]
  error: string | null
}

/**
 * One provider: whether machines can be ordered there, how to connect it, and - folded - what
 * is stored and where it came from.
 *
 * A panel for a cloud that is not connected opens on its guide and its fields: there is
 * nothing else to do with it. A connected one opens on a line, Replace and Disconnect.
 *
 * Connect is the panel's, not a field's, because the test is: a Scaleway key is a pair and a
 * project, and trying a new secret key against the old access key answers a question nobody
 * asked. A field left empty keeps what it has - it is sent to neither the test nor the save -
 * so replacing one token is still one field. No return-to-send with several fields: the
 * keyboard's return key in the first one would send it alone.
 *
 * The machines running on the cloud are named wherever a missing credential is: a cloud with
 * no credential is also one the server will not destroy anything on, and a machine nobody can
 * destroy from here goes on billing.
 *
 * The Disconnect confirmation is drawn in one place whichever button asked for it, and on its
 * own state rather than the cloud's: the line and the buttons go the moment the first field is
 * removed, and a confirmation unmounted mid-request would lose the answer it is waiting for.
 */
function CloudPanel({
  cloud,
  shared,
  open,
  dir,
  now,
  onSaved,
  onField,
  onReread,
  onConnected,
}: {
  cloud: CloudSecrets
  /** An account that orders on the service's: what this panel connects is its OWN account. */
  shared: boolean
  open: boolean
  dir: string
  now: number
  onSaved: (saved: CloudSaved) => void
  onField: (field: CloudField) => void
  onReread: () => void
  onConnected: () => void
}) {
  const provider = providerOf(cloud.cloud)
  const name = provider.name
  // An older server does not send the list: nothing is named then, and nothing breaks.
  const machines = cloud.machines ?? []
  const anything = cloud.fields.some((field) => field.set)
  const held = cloud.fields.filter((field) => field.source === "db")

  // Connected means THIS account's credentials: for an account on the service's, a cloud the
  // service answers for is one it has not connected, and the panel opens on the way to.
  const connected = shared ? cloud.usable && cloud.via === "own" : cloud.usable
  const onService = shared && cloud.usable && cloud.via === "service"
  const [editing, setEditing] = React.useState(() => !connected)
  const [typed, setTyped] = React.useState<Record<string, Typed>>({})
  /** The value the page wrote into a field on its own, as long as the reader has left it. */
  const [suggested, setSuggested] = React.useState<string | null>(null)
  /** The reader asked to type the derived field themselves: see Provider.derived. */
  const [overriding, setOverriding] = React.useState(false)
  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" })
  const [gone, setGone] = React.useState<Gone | null>(null)
  const [disconnecting, setDisconnecting] = React.useState(false)

  const values: Record<string, string> = {}
  for (const field of cloud.fields) {
    const value = sendable(typed[field.name])
    if (value !== "") values[field.name] = value
  }
  const count = Object.keys(values).length
  const complete = cloud.fields.every(
    (field) => !field.required || field.set || values[field.name] !== undefined
  )
  const busy = phase.kind === "testing" || phase.kind === "saving"
  const warnings = provider.check(values)

  const change = (fieldName: string, next: Typed) => {
    const update: Record<string, Typed> = { [fieldName]: next }
    // The GCP key names its project: written into the Project field, in clear, while that
    // field is empty or still holds what was written there last - never over what the
    // reader typed. Never assumed on the server either: see lib/clouds.ts.
    const suggestion = provider.suggest?.(fieldName, next.value) ?? null
    if (suggestion !== null) {
      const current = typed[suggestion.field]?.value ?? ""
      if (current === "" || current === suggested) {
        update[suggestion.field] = { value: suggestion.value, file: null }
        setSuggested(suggestion.value)
      }
    }
    setTyped((previous) => ({ ...previous, ...update }))
    setPhase({ kind: "idle" })
    setGone(null)
  }

  const cancel = () => {
    setTyped({})
    setSuggested(null)
    setOverriding(false)
    setPhase({ kind: "idle" })
    setEditing(false)
  }

  const edit = () => {
    setPhase({ kind: "idle" })
    setEditing(true)
  }

  /**
   * Test with the provider, then save - or save without the test, when the reader has read
   * the refusal and decided the check is what is wrong. The values travel in this closure from
   * here on: the fields are disabled while it runs, so nothing typed meanwhile is lost to it.
   */
  const connect = async (check: boolean) => {
    if (busy || count === 0 || !complete || !open) return
    const sending = values
    setGone(null)
    if (check) {
      setPhase({ kind: "testing" })
      try {
        const answer = await api.testCloud(cloud.cloud, sending)
        if (!answer.ok) {
          setPhase({ kind: "refused", error: answer.error })
          return
        }
      } catch (failure) {
        setPhase({ kind: "unchecked", error: reason(failure) })
        return
      }
    }
    // Out of state before anything leaves: see the header.
    setTyped({})
    setSuggested(null)
    setPhase({ kind: "saving" })
    try {
      const saved = await api.saveCloud(cloud.cloud, sending)
      onSaved(saved)
      setPhase({ kind: "saved", checked: check, usable: saved.usable })
      if (saved.usable) {
        setEditing(false)
        onConnected()
      }
    } catch (failure) {
      setPhase({ kind: "unsaved", error: reason(failure) })
      // The vault closed under us: the line has to appear, and only a fresh answer carries it.
      if (failure instanceof ApiError && failure.status === 503) onReread()
    }
  }

  const one = machines.length === 1
  // Connected, and nothing under way: the panel opens here. Right after Connect the verdict
  // says it instead, with the one next step there is.
  const resting = connected && !editing && phase.kind !== "saved"

  return (
    <>
      <PanelHeader
        icon={<CloudMark cloud={cloud.cloud} className="size-5 shrink-0" />}
        title={name}
        description={editing && provider.intro !== "" ? provider.intro : undefined}
      />
      <div className="space-y-4">
        {open ? null : <ClosedNote />}

        {onService ? (
          <p className="text-sm text-muted-foreground">
            Your machines on {name} use the service's account. Connect your own
            to use it instead.
          </p>
        ) : null}

        {!cloud.usable && machines.length > 0 ? (
          <p className="text-sm break-words text-destructive">
            <span className="font-mono">{inSentence(machines)}</span>{" "}
            {one ? "runs" : "run"} on {name}, and cannot be destroyed from here
            until {name} is connected again. {one ? "It keeps" : "They keep"}{" "}
            running, and billing.
          </p>
        ) : null}

        {resting ? (
          <>
            <p className="flex items-start gap-1.5 text-sm">
              <CheckIcon
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-emerald-500"
              />
              {machines.length === 0
                ? "Connected. Machines can be ordered here."
                : `Connected, with ${machines.length} machine${one ? "" : "s"} running here.`}
            </p>
            {disconnecting ? null : (
              <div
                className={cn(
                  "grid gap-2",
                  held.length > 0 ? "grid-cols-2" : "grid-cols-1"
                )}
              >
                <Button
                  variant="outline"
                  size="lg"
                  className="h-11"
                  onClick={() => {
                    setGone(null)
                    edit()
                  }}
                  disabled={!open}
                >
                  Replace
                </Button>
                {held.length > 0 ? (
                  <Button
                    variant="destructive"
                    size="lg"
                    className="h-11"
                    onClick={() => setDisconnecting(true)}
                    disabled={!open}
                  >
                    Disconnect
                  </Button>
                ) : null}
              </div>
            )}
          </>
        ) : null}

        {/* Just disconnected: the way back, one tap away rather than a reopened panel. */}
        {!connected && !editing ? (
          <Button
            variant="outline"
            size="lg"
            className="h-11 w-full"
            onClick={edit}
            disabled={!open}
          >
            Connect {name}
          </Button>
        ) : null}

        {editing ? (
          <>
            <GuideSteps steps={provider.steps} />
            {cloud.fields.map((field) => {
              const copy = provider.fields[field.name]
              const label = copy?.label ?? field.label
              const id = `value-${cloud.cloud}-${field.name}`
              const warning = warnings[field.name]
              const filledIn =
                suggested !== null && typed[field.name]?.value === suggested
              // The project is in the key: not asked, said. Hidden before a key is typed,
              // one line once the key named it, and the field itself only when the reader
              // asks for another project or the key names none.
              const derived = provider.derived
              if (derived?.field === field.name && !overriding) {
                if (filledIn) {
                  return (
                    <div
                      key={field.name}
                      className="flex min-h-11 items-center justify-between gap-3"
                    >
                      <p className="min-w-0 text-sm">
                        <span className="text-muted-foreground">
                          {derived.says}{" "}
                        </span>
                        <span className="font-mono break-all">{suggested}</span>
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 shrink-0 text-muted-foreground"
                        onClick={() => setOverriding(true)}
                        disabled={!open || busy}
                      >
                        Change
                      </Button>
                    </div>
                  )
                }
                if (sendable(typed[derived.from]) === "") return null
              }
              return (
                <div key={field.name} className="space-y-1.5">
                  <Label htmlFor={id} className="leading-snug">
                    {label}
                  </Label>
                  {copy?.hint === undefined ? null : (
                    <p className="text-xs text-muted-foreground">{copy.hint}</p>
                  )}
                  <SecretInput
                    id={id}
                    multiline={field.multiline}
                    json={field.multiline}
                    loadable={field.multiline}
                    reveal={copy?.reveal === true}
                    typed={typed[field.name] ?? EMPTY_TYPED}
                    onChange={(next) => change(field.name, next)}
                    onEnter={
                      cloud.fields.length === 1
                        ? () => void connect(true)
                        : undefined
                    }
                    placeholder={
                      field.set
                        ? "Leave empty to keep the one saved"
                        : field.multiline
                          ? "Load the key file, or paste what it holds"
                          : `Paste the ${label.replace(/ \(.*\)$/, "")}`
                    }
                    disabled={!open || busy}
                  />
                  {filledIn ? (
                    <p className="text-xs text-muted-foreground">
                      Filled in from the key. Change it if your machines belong
                      in another project.
                    </p>
                  ) : null}
                  {warning === undefined ? null : (
                    <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0 break-words">{warning}</span>
                    </p>
                  )}
                </div>
              )
            })}
            <div
              className={cn(
                "grid gap-2",
                connected ? "grid-cols-2" : "grid-cols-1"
              )}
            >
              {connected ? (
                <Button
                  variant="ghost"
                  size="lg"
                  className="h-11"
                  onClick={cancel}
                  disabled={busy}
                >
                  Cancel
                </Button>
              ) : null}
              <Button
                size="lg"
                className="h-11"
                onClick={() => void connect(true)}
                disabled={!open || busy || count === 0 || !complete}
              >
                {busy ? <Spinner /> : null}
                {phase.kind === "testing"
                  ? "Checking…"
                  : phase.kind === "saving"
                    ? "Saving…"
                    : connected
                      ? "Connect"
                      : `Connect ${name}`}
              </Button>
            </div>
          </>
        ) : null}

        {disconnecting ? (
          <DisconnectConfirm
            name={name}
            shared={shared}
            held={held}
            machines={machines}
            dir={dir}
            onField={onField}
            onCancel={() => setDisconnecting(false)}
            onGone={(result) => {
              setDisconnecting(false)
              setPhase({ kind: "idle" })
              setEditing(false)
              setGone(result)
            }}
          />
        ) : null}

        <Verdict
          phase={phase}
          provider={provider}
          canSave={open && count > 0 && complete}
          onSaveAnyway={() => void connect(false)}
        />

        {gone === null ? null : (
          <Disconnected gone={gone} name={name} dir={dir} machines={machines} />
        )}

        {anything || machines.length > 0 ? (
          <CloudDetails
            cloud={cloud}
            provider={provider}
            dir={dir}
            now={now}
            // Where the resting line has no Disconnect beside Replace - a cloud with a field
            // or two saved and not the rest - it is here, with what it would remove.
            onDisconnect={
              !resting && held.length > 0 && open && !disconnecting
                ? () => setDisconnecting(true)
                : undefined
            }
          />
        ) : null}
      </div>
    </>
  )
}

/**
 * What came of Connect, in the reader's words, and the provider's own words folded under them.
 *
 * "Save anyway" is a quiet link and not a button beside Connect: a refusal is almost always
 * right, and the thing to do after one is to look at the values again. It is there for the
 * day the check is what fails - a provider's API down for a minute - and it says what saving
 * unchecked means.
 */
function Verdict({
  phase,
  provider,
  canSave,
  onSaveAnyway,
}: {
  phase: Phase
  provider: Provider
  canSave: boolean
  onSaveAnyway: () => void
}) {
  const name = provider.name
  const anyway = canSave ? (
    <button
      type="button"
      className="inline-flex h-11 items-center text-muted-foreground underline underline-offset-4 hover:text-foreground"
      onClick={onSaveAnyway}
    >
      Save anyway
    </button>
  ) : null

  switch (phase.kind) {
    case "idle":
    case "saving":
      return null
    case "testing":
      return (
        <p
          role="status"
          className="flex items-start gap-2 text-sm text-muted-foreground"
        >
          <Spinner className="mt-0.5 shrink-0" />
          <span>
            Checking with {name}. This can take up to three minutes: keep this
            page open.
          </span>
        </p>
      )
    case "refused":
      return (
        <div
          role="status"
          className="rounded-lg border border-destructive/40 p-3 text-sm"
        >
          <p className="font-medium text-destructive">
            {name} did not accept {provider.given}.
          </p>
          {provider.retry === "" ? null : (
            <p className="mt-1 text-muted-foreground">{provider.retry}</p>
          )}
          <details>
            <summary className="flex h-11 cursor-pointer list-none items-center underline underline-offset-4 [&::-webkit-details-marker]:hidden">
              What {name} said
            </summary>
            <p className="font-mono text-xs break-words text-muted-foreground">
              {phase.error}
            </p>
          </details>
          {anyway}
        </div>
      )
    case "unchecked":
      return (
        <div role="status" className="text-sm">
          <p className="break-words text-destructive">
            Could not check with {name}: {phase.error.replace(/\.$/, "")}.
          </p>
          {anyway}
        </div>
      )
    case "unsaved":
      return (
        <p role="alert" className="text-sm break-words text-destructive">
          Not saved: {phase.error.replace(/\.$/, "")}. Nothing was kept: paste
          the values again.
        </p>
      )
    case "saved":
      if (!phase.usable) {
        return (
          <p role="status" className="text-sm text-muted-foreground">
            Saved. {name} needs every field before a machine can be ordered.
          </p>
        )
      }
      return (
        <div role="status" className="text-sm">
          <p className="flex items-start gap-1.5">
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <span>
              {phase.checked
                ? `${name} connected. You can order a machine.`
                : `Saved without ${name}'s approval: an order there fails until it accepts ${provider.given}.`}
            </span>
          </p>
          {phase.checked ? (
            <Link
              to="/new"
              className={cn(buttonVariants({ size: "lg" }), "mt-3 h-11 w-full")}
            >
              Order a machine
            </Link>
          ) : null}
        </div>
      )
  }
}

/**
 * The detail of a cloud: each field, where its value comes from, and when it was saved.
 *
 * Open on its own when a value comes from the service's environment or its files. That is
 * where the fallback trap is (src/secrets.ts decides): what is removed from this page hands
 * the job back to that older value, and a reader who never opened Details would never know it
 * was there.
 */
function CloudDetails({
  cloud,
  provider,
  dir,
  now,
  onDisconnect,
}: {
  cloud: CloudSecrets
  provider: Provider
  dir: string
  now: number
  onDisconnect?: () => void
}) {
  const machines = cloud.machines ?? []
  const outside = fromOutside(cloud.fields)
  return (
    <Fold
      title="Details"
      defaultOpen={outside}
      className="border-t border-border"
    >
      <ul className="space-y-3">
        {cloud.fields.map((field) => (
          <li key={field.name} className="text-sm">
            <p className="font-medium">
              {provider.fields[field.name]?.label ?? field.label}
            </p>
            <Where
              className="mt-1"
              set={field.set}
              source={field.source}
              updatedAt={field.updated_at}
              needed={field.required && machines.length > 0}
              now={now}
              dir={dir}
            />
          </li>
        ))}
      </ul>
      {outside ? (
        <p className="mt-3 text-sm text-muted-foreground">
          A value from the service's environment or its files is used only while
          nothing is saved on this page under that name.
        </p>
      ) : null}
      {onDisconnect === undefined ? null : (
        <Button
          type="button"
          variant="destructive"
          size="lg"
          className="mt-3 h-11 w-full"
          onClick={onDisconnect}
        >
          <Trash2Icon data-icon="inline-start" />
          Disconnect {provider.name}
        </Button>
      )}
    </Fold>
  )
}

/**
 * Everything this page saved for one cloud, removed - after a confirmation that says what it
 * costs.
 *
 * One DELETE per field, in order. Unlike the save there is no half state worth a transaction:
 * a cloud missing one credential is as unusable as one missing all, and the page redraws each
 * field from its own answer. What the confirmation has to carry is the consequence, because it
 * is not visible from the panel: the machines that can no longer be destroyed from here, and,
 * for an account the service's files answer for, the older value that may stand behind this
 * one.
 */
function DisconnectConfirm({
  name,
  shared,
  held,
  machines,
  dir,
  onField,
  onGone,
  onCancel,
}: {
  name: string
  shared: boolean
  held: CloudField[]
  machines: string[]
  dir: string
  onField: (field: CloudField) => void
  onGone: (gone: Gone) => void
  onCancel: () => void
}) {
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const one = machines.length === 1

  const run = async () => {
    setSending(true)
    setError(null)
    const fallbacks: Gone["fallbacks"] = []
    try {
      for (const field of held) {
        const answer = await api.forgetSecret("cloud", field.name)
        onField(withoutValue(field, answer.fallback))
        fallbacks.push({ field, fallback: answer.fallback })
      }
      onGone({ fallbacks, error: null })
    } catch (failure) {
      // Half done is reported where the panel reports a disconnection, which closes this;
      // nothing done yet stays here, with the reason and the same two buttons.
      if (fallbacks.length > 0) onGone({ fallbacks, error: reason(failure) })
      else setError(reason(failure))
    } finally {
      setSending(false)
    }
  }

  return (
    <Confirm
      title={`Disconnect ${name}?`}
      action="Disconnect"
      sending={sending}
      error={error}
      onConfirm={() => void run()}
      onCancel={onCancel}
    >
      <p>
        devbox forgets what was saved for {name} on this page.{" "}
        {shared
          ? `Machines on ${name} go to the service's account again, if it has one.`
          : machines.length === 0
            ? `Nothing can be ordered on ${name} until it is connected again.`
            : `Machines on ${name} can no longer be destroyed from here until it is connected again.`}
        {dir === "" || shared
          ? null
          : " If the service holds an older value of its own, that one is used again."}
      </p>
      {machines.length === 0 ? null : (
        <div className="text-destructive">
          <p>
            {one
              ? "This machine keeps"
              : `These ${machines.length} machines keep`}{" "}
            running, and billing:
          </p>
          <ul className="mt-1 space-y-0.5 font-mono">
            {machines.map((machine) => (
              <li key={machine} className="break-all">
                {machine}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Confirm>
  )
}

/**
 * What the next job reads, now that this page's values are gone.
 *
 * Amber when something takes over, and that is not a detail: the value standing behind the
 * page's is the OLD one - quite possibly the very token being rotated away from - and it is
 * live again the moment this answer arrives. A reader who disconnected to fall back on
 * purpose loses nothing by being told; one who did not has to be.
 */
function Disconnected({
  gone,
  name,
  dir,
  machines,
}: {
  gone: Gone
  name: string
  dir: string
  machines: string[]
}) {
  const back = gone.fallbacks.filter(
    (one) => one.fallback === "env" || one.fallback === "file"
  )
  const toService = gone.fallbacks.some((one) => one.fallback === "service")
  return (
    <div role="status" className="space-y-1 text-sm">
      {gone.error === null ? null : (
        <p className="break-words text-destructive">
          Not everything was removed: {gone.error}
        </p>
      )}
      {back.length > 0 ? (
        <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            Removed from this page, but{" "}
            <span className="font-mono break-all">
              {inSentence(back.map((one) => one.field.name))}
            </span>{" "}
            {back.length === 1 ? "is" : "are"} still read from{" "}
            {back.some((one) => one.fallback === "file") ? (
              <>
                the files in <Dir dir={dir} />
              </>
            ) : (
              "the service's environment"
            )}
            : that older value is what the next job uses.
          </span>
        </p>
      ) : toService ? (
        <p className="text-muted-foreground">
          Disconnected. Machines on {name} use the service's account again.
        </p>
      ) : machines.length > 0 ? (
        <p className="text-destructive">
          {name} is disconnected.{" "}
          <span className="font-mono break-all">{inSentence(machines)}</span>{" "}
          can no longer be destroyed from here until it is connected again.
        </p>
      ) : (
        <p className="text-muted-foreground">{name} is disconnected.</p>
      )}
    </div>
  )
}

/* --- a secret for the machines ----------------------------------------------------- */

type After =
  | { kind: "saved"; same: boolean; first: boolean; machines: string[] }
  | { kind: "gone"; fallback: Forgotten["fallback"] }

/**
 * One token a profile gives its machines: what it is for, who needs it, how to get it, the
 * field - or, once added, Replace and Delete.
 *
 * A token with nothing saved opens on its field, since the reader tapped it with one thing to
 * do. The field is not focused: on a phone that would throw a keyboard over the guide before
 * it has been read.
 *
 * A replacement changes what is saved and nothing else. The machines already set up keep the
 * copy they were given until they are set up again, and they are named right after the save,
 * each with the gesture that updates it: phase 2 again, the same one machine.tsx offers.
 *
 * The Delete confirmation is drawn on its own state, for the reason CloudPanel's is: the
 * buttons go with the value, while the confirmation still has an answer to hand back.
 */
function SecretPanel({
  entry,
  guide,
  open,
  dir,
  now,
  onEntry,
  onReread,
}: {
  entry: ProfileSecret
  guide: SecretGuide | undefined
  open: boolean
  dir: string
  now: number
  onEntry: (entry: ProfileSecret) => void
  onReread: () => void
}) {
  const needed = entry.used_by.length > 0
  const [editing, setEditing] = React.useState(() => !entry.set && open)
  const [after, setAfter] = React.useState<After | null>(null)
  const [forgetting, setForgetting] = React.useState(false)
  const label = guide?.label
  const one = entry.machines.length === 1

  const save = async (value: string) => {
    const before = entry
    setAfter(null)
    try {
      const updated = await api.setProfileSecret(entry.name, value)
      onEntry(updated)
      // The same bytes again - a paste from the same password manager entry - change
      // nothing on any machine, and a list of machines to update would send the reader to
      // interrupt them for nothing. Only the vault's own fingerprints can say so: a file
      // has none, and then the list stands.
      const same =
        before.source === "db" &&
        before.fingerprint !== null &&
        before.fingerprint === updated.fingerprint
      setAfter({
        kind: "saved",
        same,
        first: !before.set,
        machines: same ? [] : updated.machines,
      })
      setEditing(false)
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 503) onReread()
      throw failure
    }
  }

  const edit = () => {
    setAfter(null)
    setEditing(true)
  }

  return (
    <>
      <PanelHeader
        icon={
          <SecretMark
            name={entry.name}
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title={label ?? entry.name}
        description={guide?.purpose}
      />
      <div className="space-y-4">
        {open ? null : <ClosedNote />}
        {needed && !entry.set ? (
          <p className="text-sm">
            Needed by{" "}
            <span className="font-medium">{inSentence(entry.used_by)}</span>.
          </p>
        ) : null}
        {!needed && entry.set ? (
          <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            No profile uses it any more.
          </p>
        ) : null}

        {editing ? (
          <SecretForm
            id={`value-${entry.name}`}
            name={entry.name}
            guide={guide}
            replacing={entry.set}
            disabled={!open}
            onSave={save}
            onCancel={entry.set ? () => setEditing(false) : undefined}
          />
        ) : (
          <>
            {after?.kind === "saved" ? (
              <Replaced
                name={entry.name}
                label={label}
                same={after.same}
                first={after.first}
                machines={after.machines}
              />
            ) : null}
            {after?.kind === "gone" ? (
              <Removed
                fallback={after.fallback}
                dir={dir}
                profiles={entry.used_by}
              />
            ) : null}
            {after === null && entry.set ? (
              entry.source === "file" ? (
                <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                  <FileKeyIcon className="mt-0.5 size-4 shrink-0" />
                  Read from a file on the server.
                </p>
              ) : (
                <p className="flex items-start gap-1.5 text-sm">
                  <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                  {entry.updated_at === null
                    ? "Added."
                    : `Added ${ago(entry.updated_at, now)}.`}
                </p>
              )
            ) : null}
            {forgetting ? null : entry.set ? (
              <div
                className={cn(
                  "grid gap-2",
                  entry.source === "db" ? "grid-cols-2" : "grid-cols-1"
                )}
              >
                <Button
                  variant="outline"
                  size="lg"
                  className="h-11"
                  onClick={edit}
                  disabled={!open}
                >
                  Replace
                </Button>
                {/* The saved copy alone can be deleted from here. A file is the directory's,
                    and removing it is a shell's job, not a button's. */}
                {entry.source === "db" ? (
                  <Button
                    variant="destructive"
                    size="lg"
                    className="h-11"
                    onClick={() => setForgetting(true)}
                    disabled={!open}
                  >
                    Delete
                  </Button>
                ) : null}
              </div>
            ) : (
              <Button
                variant="outline"
                size="lg"
                className="h-11 w-full"
                onClick={edit}
                disabled={!open}
              >
                Add {label ?? entry.name}
              </Button>
            )}
          </>
        )}

        {forgetting ? (
          <ForgetConfirm
            name={entry.name}
            label={label}
            consequence={[
              needed
                ? `${inSentence(entry.used_by)} cannot start a machine without it.`
                : "",
              dir === ""
                ? ""
                : "If the server holds an older copy in a file, that one is used again.",
              entry.machines.length > 0
                ? `${inSentence(entry.machines)} ${one ? "keeps the copy it was" : "keep the copies they were"} set up with.`
                : "",
            ]
              .filter((sentence) => sentence !== "")
              .join(" ")}
            onCancel={() => setForgetting(false)}
            onGone={(fallback) => {
              setForgetting(false)
              onEntry(withoutEntryValue(entry, fallback))
              setAfter({ kind: "gone", fallback })
            }}
          />
        ) : null}

        {/* Nothing saved: "Not saved" and the profiles are the sentence above, said twice. */}
        {entry.set ? <SecretDetails entry={entry} dir={dir} now={now} /> : null}
      </div>
    </>
  )
}

function SecretDetails({
  entry,
  dir,
  now,
}: {
  entry: ProfileSecret
  dir: string
  now: number
}) {
  const needed = entry.used_by.length > 0
  return (
    <Fold
      title="Details"
      defaultOpen={entry.source === "file"}
      className="border-t border-border"
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Stored</dt>
        <dd>
          <Where
            set={entry.set}
            source={entry.source}
            updatedAt={entry.updated_at}
            needed={needed}
            now={now}
            dir={dir}
          />
        </dd>
        {needed ? (
          <>
            <dt className="text-muted-foreground">Profiles</dt>
            <dd className="break-all">{entry.used_by.join(", ")}</dd>
          </>
        ) : null}
        {entry.machines.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Machines</dt>
            <dd className="break-all">{entry.machines.join(", ")}</dd>
          </>
        ) : null}
      </dl>
      {entry.source === "file" ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Read from a file on the server, because nothing is saved on this page
          under this name. A value saved on this page takes over from the file.
        </p>
      ) : null}
    </Fold>
  )
}

function Replaced({
  name,
  label,
  same,
  first,
  machines,
}: {
  name: string
  label: string | undefined
  same: boolean
  first: boolean
  machines: string[]
}) {
  const one = machines.length === 1
  return (
    <div role="status" className="space-y-2 text-sm">
      <p className="flex items-start gap-1.5">
        <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
        {same ? "Saved: the same value as before." : "Saved."}
      </p>
      {machines.length > 0 ? (
        <div className="rounded-lg border border-amber-500/40 p-3">
          <p className="text-amber-700 dark:text-amber-400">
            {first
              ? `${machines.length} machine${one ? " was" : "s were"} set up without it.`
              : `${machines.length} machine${one ? " still uses" : "s still use"} the old ${label ?? "value"}.`}{" "}
            Updating runs a machine's setup again with the new one, which takes
            a few minutes.
          </p>
          <ul className="mt-1 divide-y divide-border">
            {machines.map((machine) => (
              <li key={machine}>
                <Reseed machine={machine} back={`/secrets#secret-${name}`} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Phase 2 again, for one machine, from where the reason for it is on screen.
 *
 * It stays here rather than following the job the way machine.tsx does: with two machines
 * to update, leaving for the first one's log would lose the list the second one is on. The
 * job is linked instead, and its chevron comes back to this very panel.
 *
 * One job per machine on the server side, so a second tap on the same machine meets the first
 * seed still running: the 409 names that job, and following it is the useful thing to offer.
 */
function Reseed({ machine, back }: { machine: string; back: string }) {
  const [sending, setSending] = React.useState(false)
  const [job, setJob] = React.useState<number | null>(null)
  const [error, setError] = React.useState<{
    text: string
    job?: number
  } | null>(null)

  const run = async () => {
    setSending(true)
    setError(null)
    try {
      const answer = await api.seed(machine)
      setJob(answer.job)
    } catch (failure) {
      const running =
        failure instanceof ApiError && typeof failure.payload.job === "number"
          ? failure.payload.job
          : undefined
      setError({ text: reason(failure), job: running })
    } finally {
      setSending(false)
    }
  }

  const from = { from: back, label: "Keys & tokens" }

  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 font-mono break-all">{machine}</span>
        {job === null ? (
          <Button
            variant="warning"
            size="lg"
            className="h-11 shrink-0"
            onClick={() => void run()}
            disabled={sending}
          >
            {sending ? <Spinner /> : "Update"}
          </Button>
        ) : (
          <Link
            to={`/job/${job}`}
            state={from}
            className="inline-flex h-11 shrink-0 items-center underline underline-offset-4"
          >
            Updating - follow it
          </Link>
        )}
      </div>
      {error === null ? null : (
        <div className="text-sm text-destructive">
          <p className="break-words">{error.text}</p>
          {error.job === undefined ? null : (
            <Link
              to={`/job/${error.job}`}
              state={from}
              className="inline-flex h-11 items-center underline underline-offset-4"
            >
              Follow the running job
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Delete a saved profile secret, after a confirmation that names what goes.
 *
 * Nothing to retype, unlike destroying a machine: this loses no work, and the value can be
 * written again in one paste. What the confirmation has to carry is the consequence, because
 * it is not visible from the panel - who needs it at their next setup, and that an older file
 * may be standing behind it.
 */
function ForgetConfirm({
  name,
  label,
  consequence,
  onGone,
  onCancel,
}: {
  name: string
  label: string | undefined
  consequence: string
  onGone: (fallback: Forgotten["fallback"]) => void
  onCancel: () => void
}) {
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const run = async () => {
    setSending(true)
    setError(null)
    try {
      const answer = await api.forgetSecret("profile", name)
      onGone(answer.fallback)
    } catch (failure) {
      setError(reason(failure))
    } finally {
      setSending(false)
    }
  }

  return (
    <Confirm
      title={
        label === undefined ? (
          <>
            Delete <span className="font-mono break-all">{name}</span>?
          </>
        ) : (
          `Delete the ${label}?`
        )
      }
      action="Delete"
      sending={sending}
      error={error}
      onConfirm={() => void run()}
      onCancel={onCancel}
    >
      {consequence === "" ? null : <p>{consequence}</p>}
    </Confirm>
  )
}

/**
 * A confirmation drawn inside the panel, where the gesture was made, in place of its buttons.
 *
 * Not a dialog over the panel. A dialog opened inside another is portalled into its popup, and
 * the sheet's transform makes that popup the containing block of anything `fixed` in it:
 * measured on 13/09, the Delete dialog opened behind the sheet, cut by it and under its blur.
 * And a second layer over a sheet on a phone was one more surface to read before Cancel.
 *
 * Focused when it appears, so the keyboard is not left on a button that has just gone, and
 * scrolled to: it may take the place of a button at the foot of Details. Escape still closes
 * the whole panel, which cancels it too.
 */
function Confirm({
  title,
  action,
  tone = "destructive",
  sending,
  error,
  onConfirm,
  onCancel,
  children,
}: {
  title: React.ReactNode
  action: string
  tone?: "destructive" | "default"
  sending: boolean
  error: string | null
  onConfirm: () => void
  onCancel: () => void
  children?: React.ReactNode
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const titleId = React.useId()

  React.useEffect(() => {
    const element = ref.current
    if (element === null) return
    element.focus({ preventScroll: true })
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    element.scrollIntoView({
      behavior: still ? "auto" : "smooth",
      block: "nearest",
    })
  }, [])

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-labelledby={titleId}
      className={cn(
        "scroll-mb-6 rounded-lg border p-3 text-sm outline-none",
        tone === "destructive" ? "border-destructive/40" : "border-border"
      )}
    >
      <p id={titleId} className="font-medium break-words">
        {title}
      </p>
      {children === undefined ? null : (
        <div className="mt-1 space-y-2 text-muted-foreground">{children}</div>
      )}
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
          variant={tone === "destructive" ? "destructive" : "default"}
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

/** What the next machine gets, now that the saved copy is gone. Amber when a file takes over. */
function Removed({
  fallback,
  dir,
  profiles,
}: {
  fallback: Forgotten["fallback"]
  dir: string
  profiles: string[]
}) {
  if (fallback !== null) {
    return (
      <p
        role="status"
        className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400"
      >
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0">
          Deleted, and the file in <Dir dir={dir} /> takes over again: that
          older value is what the next machine gets.
        </span>
      </p>
    )
  }
  return (
    <p
      role="status"
      className={cn(
        "text-sm",
        profiles.length === 0 ? "text-muted-foreground" : "text-destructive"
      )}
    >
      Deleted.
      {profiles.length === 0
        ? null
        : ` ${inSentence(profiles)} cannot start a machine until it is added again.`}
    </p>
  )
}

/* --- the quiet links ------------------------------------------------------------------ */

/**
 * A secret under a name of the reader's choosing, for a profile written by hand. It reaches a
 * machine only if that profile declares the name - which is why it is a quiet link under the
 * tokens the profiles actually ask for, and not one of them.
 */
function AddTokenPanel({
  open,
  onEntry,
  onReread,
}: {
  open: boolean
  onEntry: (entry: ProfileSecret) => void
  onReread: () => void
}) {
  const [name, setName] = React.useState("")
  const [done, setDone] = React.useState<string | null>(null)
  const trimmed = name.trim()
  // devbox-core's own rule for a declared name, and the vault's: see checkedSecretName.
  const valid = /^[A-Za-z0-9_-]{1,64}$/.test(trimmed)

  return (
    <>
      <PanelHeader
        icon={
          <KeyRoundIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title="Add a token"
        description="For a profile written by hand that reads a secret under a name of its own. A machine receives it only if its profile declares that name."
      />
      <div className="space-y-4">
        {open ? null : <ClosedNote />}
        <div className="space-y-1.5">
          <Label htmlFor="custom-name">Name</Label>
          <Input
            id="custom-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setDone(null)
            }}
            placeholder="deploy-key"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={!open}
            className="h-12 font-mono text-base"
          />
          {trimmed !== "" && !valid ? (
            <p className="text-sm text-destructive">
              Letters, digits, dash and underscore only, up to 64.
            </p>
          ) : null}
        </div>
        <SecretForm
          id="custom-value"
          name={valid ? trimmed : "the value"}
          guide={undefined}
          replacing={false}
          showGuide={false}
          disabled={!open || !valid}
          onSave={async (value) => {
            try {
              onEntry(await api.setProfileSecret(trimmed, value))
              setDone(trimmed)
              setName("")
            } catch (failure) {
              if (failure instanceof ApiError && failure.status === 503)
                onReread()
              throw failure
            }
          }}
        />
        {done === null ? null : (
          <p role="status" className="flex items-center gap-1.5 text-sm">
            <CheckIcon className="size-4 shrink-0 text-emerald-500" />
            Saved as <span className="font-mono break-all">{done}</span>.
          </p>
        )}
      </div>
    </>
  )
}

/**
 * The one-time copy of the service's own credentials into this account's store.
 *
 * Linked from the page for as long as something is still read from outside the vault, and only
 * then: the list is the reason for the link. The report outlives the list - once everything is
 * in, the list is empty and the reader still needs to see what went in and what was left
 * alone - which is why the confirmation is rendered outside the part that empties.
 */
function ImportPanel({
  data,
  open,
  dir,
  onDone,
}: {
  data: Secrets
  open: boolean
  dir: string
  onDone: () => void
}) {
  const [asking, setAsking] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<Imported | null>(null)

  const outside = outsideTheVault(data)
  const fromEnv = outside.filter((one) => one.source === "env")
  const fromFiles = outside.filter((one) => one.source === "file")
  const count = `${outside.length} value${outside.length === 1 ? "" : "s"}`

  const run = async () => {
    setSending(true)
    setError(null)
    try {
      setResult(await api.importSecrets())
      setAsking(false)
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
        icon={
          <ServerCogIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title="The service's own credentials"
        description={
          outside.length > 0
            ? `${count} still read from outside this page.`
            : undefined
        }
      />
      <div className="space-y-4">
        {open ? null : <ClosedNote />}
        {outside.length > 0 ? (
          <>
            <div className="space-y-0.5 text-sm text-muted-foreground">
              {fromEnv.length > 0 ? (
                <p>
                  The service's environment:{" "}
                  <span className="font-mono break-all">
                    {fromEnv.map((one) => one.name).join(", ")}
                  </span>
                </p>
              ) : null}
              {fromFiles.length > 0 ? (
                <p>
                  Files:{" "}
                  <span className="font-mono break-all">
                    {fromFiles.map((one) => one.name).join(", ")}
                  </span>
                </p>
              ) : null}
            </div>
            {asking ? null : (
              <Button
                variant="outline"
                size="lg"
                className="h-11 w-full"
                onClick={() => setAsking(true)}
                disabled={!open}
              >
                <ImportIcon data-icon="inline-start" />
                Import them here
              </Button>
            )}
          </>
        ) : null}
        {asking ? (
          <Confirm
            title={`Copy ${count} here?`}
            action="Import"
            tone="default"
            sending={sending}
            error={error}
            onConfirm={() => void run()}
            onCancel={() => {
              setAsking(false)
              setError(null)
            }}
          >
            <p>
              Once, and over nothing: a name already saved here, or saved and
              then removed, is left as it is. The files and the environment are
              not touched, and still answer for what is not saved here.
            </p>
          </Confirm>
        ) : null}
        {result === null ? null : (
          <div role="status" className="space-y-1 text-sm">
            {result.imported.length > 0 ? (
              <p className="flex items-start gap-1.5">
                <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                <span>
                  Imported:{" "}
                  <span className="font-mono break-all">
                    {result.imported.join(", ")}
                  </span>
                  .
                </span>
              </p>
            ) : null}
            {/* Each line in the server's words, and not one sentence for all of them: "same
                value" is safe to clean up after, "another value" is a file holding the
                token from before a rotation, and "unreadable" is nothing imported at all. */}
            {result.skipped.length > 0 ? (
              <div className="text-muted-foreground">
                <p>Left out:</p>
                <ul className="mt-0.5 space-y-1">
                  {result.skipped.map((line) => (
                    <li key={line} className="pl-4 -indent-4 break-words">
                      <Skipped line={line} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {result.imported.length === 0 && result.skipped.length === 0 ? (
              <p className="text-muted-foreground">
                Nothing was imported: there was nothing to copy.
              </p>
            ) : null}
          </div>
        )}
        {dir === "" ? null : (
          <p className="text-sm text-muted-foreground">
            Anything not saved on this page is read from the files in{" "}
            <Dir dir={dir} />, and cloud tokens from the service's environment.
            Saving a value here takes over from them.
          </p>
        )}
      </div>
    </>
  )
}

/**
 * One line of the import's report, as the server wrote it: `kind/NAME: why`. The name is set
 * in the names' type and the reason in the page's, and not a word is changed - a line that
 * does not have that shape is shown whole.
 */
function Skipped({ line }: { line: string }) {
  const at = line.indexOf(": ")
  if (at <= 0) return <>{line}</>
  return (
    <>
      <span className="font-mono break-all">{line.slice(0, at)}</span>
      {line.slice(at)}
    </>
  )
}

/* --- shared ------------------------------------------------------------------------- */

/**
 * Where a value lives, in one line: encrypted in this dashboard's vault and how long ago, the
 * service's environment, a file, or nowhere. In Details only.
 *
 * "Encrypted", and no longer "Saved here" (until 24/09), which named the page a reader was
 * already on and said nothing about the value. What sets the vault apart from the other two
 * sources is that it is sealed, and the date beside it reads as when it was.
 *
 * Missing is red only when something needs it - a required field on a cloud with machines, a
 * secret a profile declares. An empty optional field is a choice, and drawing it like a fault
 * would teach the reader to ignore the red that means something.
 */
function Where({
  set,
  source,
  updatedAt,
  needed,
  now,
  dir,
  className,
}: {
  set: boolean
  source: SecretSource | null
  updatedAt: number | null
  needed: boolean
  now: number
  dir: string
  className?: string
}) {
  const line = cn(
    "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground",
    className
  )
  // One sentence, not three facts: the icon stays on its first line and the words wrap
  // beside it. Under `flex-wrap` a long directory pushed the whole sentence below the icon,
  // leaving the mark alone on a line of its own.
  const sentence = cn(
    "flex items-start gap-2 text-sm text-muted-foreground",
    className
  )

  if (!set) {
    return needed ? (
      <p className={cn(line, "text-destructive")}>
        <CircleSlashIcon className="size-3.5 shrink-0" />
        Not saved
      </p>
    ) : (
      <p className={line}>
        <CircleDashedIcon className="size-3.5 shrink-0" />
        Not saved
      </p>
    )
  }

  if (source === "db") {
    return (
      <p className={line}>
        <span className="flex items-center gap-1.5 text-foreground">
          <LockIcon className="size-3.5 shrink-0 text-emerald-500" />
          Encrypted
        </span>
        {updatedAt === null ? null : (
          <span title={new Date(updatedAt).toLocaleString()}>
            {ago(updatedAt, now)}
          </span>
        )}
      </p>
    )
  }

  if (source === "env") {
    return (
      <p className={sentence}>
        <ServerCogIcon className="mt-[3px] size-3.5 shrink-0" />
        <span className="min-w-0">From the service's environment</span>
      </p>
    )
  }

  if (source === "file") {
    return (
      <p className={sentence}>
        <FileKeyIcon className="mt-[3px] size-3.5 shrink-0" />
        <span className="min-w-0">
          From a file in <Dir dir={dir} />
        </span>
      </p>
    )
  }

  return <p className={line}>Saved</p>
}

/** The secrets directory, named when the session gave its path. */
function Dir({ dir }: { dir: string }) {
  if (dir === "") return <>the server's secrets directory</>
  return <span className="font-mono break-all">{dir}</span>
}

/** The anchor the address points at, decoded: `#secret-github` is `secret-github`. */
function aimedAt(hash: string): string {
  const raw = hash.replace(/^#/, "")
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Whether any of a cloud's values is read from the service's environment or its files. */
function fromOutside(fields: CloudField[]): boolean {
  return fields.some(
    (field) => field.set && (field.source === "env" || field.source === "file")
  )
}

/** Every name still read from the environment or a file, once each. */
function outsideTheVault(
  data: Secrets
): { name: string; source: "env" | "file" }[] {
  const seen = new Set<string>()
  const found: { name: string; source: "env" | "file" }[] = []
  const all = [...data.clouds.flatMap((cloud) => cloud.fields), ...data.profile]
  for (const one of all) {
    if (!one.set || seen.has(one.name)) continue
    if (one.source === "env" || one.source === "file") {
      seen.add(one.name)
      found.push({ name: one.name, source: one.source })
    }
  }
  return found
}

/** A cloud's save, folded into the screen's copy: its fields and `usable`, its machines kept. */
function withCloud(data: Secrets, saved: CloudSaved): Secrets {
  return {
    ...data,
    clouds: data.clouds.map((one) =>
      one.cloud === saved.cloud
        ? { ...one, usable: saved.usable, fields: saved.fields }
        : one
    ),
  }
}

/**
 * One field's answer, folded into the screen's copy.
 *
 * `usable` is recomputed rather than asked for again, by the contract's own definition -
 * every required field present.
 */
function withField(data: Secrets, cloud: string, field: CloudField): Secrets {
  return {
    ...data,
    clouds: data.clouds.map((one) => {
      if (one.cloud !== cloud) return one
      const fields = one.fields.map((known) =>
        known.name === field.name ? field : known
      )
      return {
        ...one,
        fields,
        usable: fields.every((known) => !known.required || known.set),
      }
    }),
  }
}

function withEntry(data: Secrets, entry: ProfileSecret): Secrets {
  const known = data.profile.some((one) => one.name === entry.name)
  return {
    ...data,
    profile: known
      ? data.profile.map((one) => (one.name === entry.name ? entry : one))
      : [...data.profile, entry],
  }
}

/** A field once the vault let go of it: whatever stood behind it, and no fingerprint. */
function withoutValue(
  field: CloudField,
  fallback: Forgotten["fallback"]
): CloudField {
  // The service answering again is not a value of this account's: its own field is unset.
  const behind = fallback === "service" ? null : fallback
  return {
    ...field,
    set: behind !== null,
    source: behind,
    fingerprint: null,
    updated_at: null,
  }
}

function withoutEntryValue(
  entry: ProfileSecret,
  fallback: Forgotten["fallback"]
): ProfileSecret {
  return {
    ...entry,
    set: fallback !== null,
    source: fallback === "file" ? "file" : null,
    fingerprint: null,
    updated_at: null,
  }
}
