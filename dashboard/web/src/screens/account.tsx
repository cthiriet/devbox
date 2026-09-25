import * as React from "react"
import {
  InfoIcon,
  LogOutIcon,
  MailIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react"
import { useLocation, useNavigate } from "react-router"

import { CopyField } from "@/components/copy-field"
import { EngineVersion, Screen } from "@/components/layout"
import { Fold, PanelHeader, Row, Rows, Sheet } from "@/components/panel"
import { useSession } from "@/components/session"
import { CloudAccounts } from "@/screens/secrets"
import { AccountSection } from "@extension"
import { Loading, Nothing, Trouble } from "@/components/states"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { useAsync, type Async } from "@/hooks/use-async"
import { ApiError, api, reason, refusal, type Refusal } from "@/lib/api"
import { ago } from "@/lib/format"
import type { Account, ApiToken, CreatedToken } from "@/lib/types"

/**
 * The account: what signs in, what the CLI presents, and the cloud accounts machines go to.
 *
 * Everything here goes through a SESSION - `guard(req, { bearer: false })` on the server -
 * and never through the CLI token. A token that could mint another token would be a token that
 * renews itself forever; the same reasoning keeps secret writes off it, since a token that could
 * replace a cloud credential could collect every secret a seed pushes.
 *
 * AT REST IT IS ONE LIST, as the Keys page is. The first account page stacked six headed
 * sections - the address twice, a paragraph under each heading, five buttons and a full-width
 * red "Sign out everywhere", the loudest thing on the page for the rarest gesture: 1465 px on a
 * phone. Now each thing is a row with one grey value, and a tap opens its panel (panel.tsx):
 * the form, the sentence, the confirmation. The address is the open panel, `#command-line` or
 * `#sign-out-everywhere`, replacing the history entry so Back still leaves the page.
 *
 * What each panel does is what its section did, call for call:
 *
 * There is no password panel since 15/09: an account opens through Google or GitHub, and what
 * someone does after losing a phone is sign out everywhere - which leaves the CLI tokens alone,
 * a token on a build machine having nothing to do with a browser.
 *
 * A token is shown ONCE, in the answer that created it. Nothing asks for it again, so the
 * line to paste is offered next to it, and it stays drawn until Done - held by the screen and
 * not by the panel, so closing the sheet by mistake does not lose the only copy.
 *
 * The cloud accounts live here since 13/09, above the rows: the service's, which the founding
 * account connects and every account orders on, and an account's own, which it may connect
 * instead. See CloudAccounts in screens/secrets.tsx.
 *
 * The lists the rows count - the tokens, and the founder's accounts - are loaded by the screen
 * and patched from each write's answer, so a panel closed and opened again shows the switch
 * it left and not the load from before.
 */
export function AccountScreen() {
  const { session } = useSession()
  const account = session?.account ?? null
  // Frozen at opening, like the fleet and the vault: a date here is a landmark, and reading
  // the clock inside a render makes the render impure.
  const [now] = React.useState(() => Date.now())

  return (
    <Screen title="Account" action={<SignOut />}>
      {account === null ? (
        <Trouble
          title="Sign in again."
          detail="The service answered a session that names no account. Signing in again is the only useful gesture from here."
        />
      ) : (
        <Settings account={account} now={now} />
      )}
    </Screen>
  )
}

/** Id 1 founded the service. */
const FOUNDER = 1

/** The fragments that open a panel. */
const CLI = "command-line"
const EVERYWHERE = "sign-out-everywhere"

const PANELS = [CLI, EVERYWHERE]

/** An icon in a panel's header. */
const HEAD_ICON = "size-5 shrink-0 text-muted-foreground"

function Settings({ account, now }: { account: Account; now: number }) {
  const location = useLocation()
  const navigate = useNavigate()
  const founder = account.id === FOUNDER

  const tokens = useAsync(() => api.tokens(), [])
  const [heldTokens, setHeldTokens] = React.useState<ApiToken[] | null>(null)
  const tokenList = heldTokens ?? tokens.data
  const [fresh, setFresh] = React.useState<CreatedToken | null>(null)

  const aimed = aimedAt(location.hash)
  const opens = (fragment: string) => PANELS.includes(fragment)

  // What the panel draws outlives the address by the closing animation: see secrets.tsx.
  const [shown, setShown] = React.useState(aimed)
  if (opens(aimed) && aimed !== shown) setShown(aimed)

  const go = (fragment: string) =>
    navigate(
      { pathname: location.pathname, search: location.search, hash: fragment },
      { replace: true }
    )
  const close = () => go("")

  const tokenValue =
    fresh !== null
      ? "Copy your new token"
      : tokenList !== null
        ? tokenList.length === 0
          ? "Off"
          : `${tokenList.length} token${tokenList.length === 1 ? "" : "s"}`
        : tokens.status === "failed"
          ? "Couldn't load"
          : undefined

  const panel = (): React.ReactNode => {
    switch (shown) {
      case CLI:
        return (
          <CliPanel
            now={now}
            load={tokens}
            list={tokenList}
            fresh={fresh}
            onCreated={(made) => {
              setFresh(made)
              setHeldTokens((previous) => [
                ...(previous ?? tokens.data ?? []),
                {
                  id: made.id,
                  label: made.label,
                  created_at: made.created_at,
                  used_at: null,
                },
              ])
            }}
            onGone={(id) => {
              setHeldTokens((previous) =>
                (previous ?? tokens.data ?? []).filter((one) => one.id !== id)
              )
              setFresh((held) => (held?.id === id ? null : held))
            }}
            onDone={() => setFresh(null)}
          />
        )
      case EVERYWHERE:
        return <EverywherePanel onCancel={close} />
      default:
        return null
    }
  }

  return (
    <>
      <CloudAccounts />

      <Rows className="mt-8">
        {/* A fact and not a row that opens: an address is for good, account 1's included. */}
        <Fact icon={<MailIcon />} label="Email" value={account.email} />
        <Row
          icon={<TerminalIcon />}
          label="Command-line access"
          value={tokenValue}
          tone={
            fresh === null && tokenList === null && tokens.status === "failed"
              ? "danger"
              : "muted"
          }
          onOpen={() => go(CLI)}
        />
        <Row
          icon={<LogOutIcon />}
          label="Sign out everywhere"
          onOpen={() => go(EVERYWHERE)}
        />
        {/* The deployed executor's digest: the founder's question after a deployment, and
            nobody else's. See layout.tsx#EngineVersion. */}
        {founder ? (
          <Fact icon={<InfoIcon />} label="Version" value={<EngineVersion />} />
        ) : null}
      </Rows>

      {/* What a private extension adds under the rows - a subscription - or nothing. */}
      <AccountSection />

      <Sheet open={opens(aimed)} onClose={close}>
        {panel()}
      </Sheet>
    </>
  )
}

/** A row that opens nothing: a value to read, aligned with the rows around it. */
function Fact({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
}) {
  return (
    <li className="flex h-12 items-center gap-3 px-3">
      <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{value}</span>
      <span aria-hidden className="size-4 shrink-0" />
    </li>
  )
}

/**
 * The tokens the CLI presents, listed by what they are for.
 *
 * The list never carries a token, only its label and when it was last used - the one date that
 * answers "can this one go?"; the creation date is in the row's title. The value exists in the
 * answer that created it and nowhere else afterwards, which is why the creation is the only
 * place it can be copied from. While it is drawn, the form that makes another is not: one
 * token on the screen at a time, and Done the only button that matters.
 */
function CliPanel({
  now,
  load,
  list,
  fresh,
  onCreated,
  onGone,
  onDone,
}: {
  now: number
  load: Async<ApiToken[]>
  list: ApiToken[] | null
  fresh: CreatedToken | null
  onCreated: (made: CreatedToken) => void
  onGone: (id: number) => void
  onDone: () => void
}) {
  const [label, setLabel] = React.useState("")
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<Refusal | null>(null)
  /** The token whose revocation is being confirmed: one at a time. */
  const [asking, setAsking] = React.useState<number | null>(null)

  const create = async (event: React.FormEvent) => {
    event.preventDefault()
    if (sending || list === null) return
    setSending(true)
    setError(null)
    try {
      const made = await api.createToken(label.trim())
      onCreated(made)
      setLabel("")
    } catch (failure) {
      setError(refusal(failure))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <PanelHeader
        icon={<TerminalIcon aria-hidden className={HEAD_ICON} />}
        title="Command-line access"
        description="Tokens let the devbox command reach this account."
      />

      {fresh === null ? null : <Fresh token={fresh} onDone={onDone} />}

      {list === null && load.status === "loading" ? <Loading /> : null}
      {list === null && load.status === "failed" ? (
        <Trouble detail={load.error} onRetry={load.reload} />
      ) : null}

      {list === null ? null : (
        <>
          {list.length === 0 ? (
            <Nothing>No tokens yet.</Nothing>
          ) : (
            <ul className="divide-y divide-border">
              {list.map((token) => (
                <TokenLine
                  key={token.id}
                  token={token}
                  now={now}
                  asking={asking === token.id}
                  onAsk={() => setAsking(token.id)}
                  onCancel={() => setAsking(null)}
                  onGone={(id) => {
                    setAsking(null)
                    onGone(id)
                  }}
                />
              ))}
            </ul>
          )}

          {fresh !== null ? null : (
            <form
              onSubmit={create}
              className="mt-2 space-y-3 border-t border-border pt-4"
            >
              <div className="space-y-2">
                <Label htmlFor="token-label">Name</Label>
                {/* A label, required here rather than by the server: the list is read on the
                    day one of these has to go, and two rows called "" name nothing. */}
                <Input
                  id="token-label"
                  type="text"
                  name="label"
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="laptop"
                  className="h-12 text-base"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  aria-invalid={error?.field === "label" || undefined}
                  disabled={sending}
                />
              </div>
              {error === null ? null : (
                <p
                  role="alert"
                  className="text-sm break-words text-destructive"
                >
                  {error.text}
                </p>
              )}
              <Button
                type="submit"
                size="lg"
                className="h-12 w-full text-base"
                disabled={sending || label.trim() === ""}
              >
                {sending ? <Spinner /> : "Create token"}
              </Button>
            </form>
          )}
        </>
      )}
    </>
  )
}

/**
 * The token itself, the only time it exists outside the server.
 *
 * The line for the environment first - it is what the CLI reads first - and the bare token and
 * the file it falls back to under "Other ways". Done is not decoration: what is on the screen
 * is the whole credential, and the reader is the only one who knows they are done with it.
 */
function Fresh({ token, onDone }: { token: CreatedToken; onDone: () => void }) {
  return (
    <div role="status" className="mb-4 rounded-lg border border-border p-3">
      <p className="font-medium">Copy it now. It won't be shown again.</p>
      <CopyField label="Line" value={`DEVBOX_REMOTE_TOKEN=${token.token}`} />
      <Fold title="Other ways">
        <CopyField label="Token" value={token.token} />
        <p className="mt-1 text-xs text-muted-foreground">
          Or the token alone, on one line, in{" "}
          <span className="font-mono break-all">
            ~/.config/devbox/secrets/remote
          </span>
          .
        </p>
      </Fold>
      <Button
        variant="outline"
        size="lg"
        className="mt-2 h-11 w-full"
        onClick={onDone}
      >
        Done
      </Button>
    </div>
  )
}

function TokenLine({
  token,
  now,
  asking,
  onAsk,
  onCancel,
  onGone,
}: {
  token: ApiToken
  now: number
  asking: boolean
  onAsk: () => void
  onCancel: () => void
  onGone: (id: number) => void
}) {
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const run = async () => {
    setSending(true)
    setError(null)
    try {
      await api.revokeToken(token.id)
    } catch (failure) {
      // A 404 is a token that is already gone - revoked from another tab, or another phone.
      // The row leaves all the same: it names nothing that still opens a door.
      if (!(failure instanceof ApiError && failure.status === 404)) {
        setError(reason(failure))
        setSending(false)
        return
      }
    }
    setSending(false)
    onGone(token.id)
  }

  return (
    <li className="py-1">
      <div className="flex min-h-12 items-center gap-3">
        <div
          className="min-w-0 flex-1"
          title={`created ${new Date(token.created_at).toLocaleString()}`}
        >
          <p className="font-medium break-words">{token.label}</p>
          <p className="text-xs text-muted-foreground">
            {token.used_at === null
              ? "Never used"
              : `Used ${ago(token.used_at, now)}`}
          </p>
        </div>
        {asking ? null : (
          <Button
            variant="ghost"
            size="icon-lg"
            className="-mr-2 size-11 text-muted-foreground hover:text-destructive"
            onClick={() => {
              setError(null)
              onAsk()
            }}
            aria-label={`Revoke ${token.label}`}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      {asking ? (
        <Confirm
          title={`Revoke ${token.label}?`}
          action="Revoke"
          sending={sending}
          error={error}
          onConfirm={() => void run()}
          onCancel={onCancel}
        >
          The devbox command using it is refused from its next command. It can't
          be brought back.
        </Confirm>
      ) : null}
    </li>
  )
}

/**
 * A confirmation drawn inside the panel, not over it: the reason is Confirm's in
 * screens/secrets.tsx - a dialog opened inside the sheet opened behind it. Focused when it
 * appears, so the keyboard is not left on the button that has just gone.
 */
function Confirm({
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
      className="mb-2 scroll-mb-6 rounded-lg border border-destructive/40 p-3 text-sm outline-none"
    >
      <p id={titleId} className="font-medium break-words">
        {title}
      </p>
      {children === undefined ? null : (
        <p className="mt-1 text-muted-foreground">{children}</p>
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
          variant="destructive"
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
 * Leaving this browser: the screen's own action, at the top. No confirmation - one tap loses
 * nothing but a cookie.
 */
function SignOut() {
  const { refresh } = useSession()
  const navigate = useNavigate()
  const [sending, setSending] = React.useState(false)

  const leave = async () => {
    setSending(true)
    await api.logout().catch(() => undefined)
    refresh()
    navigate("/login", { replace: true })
  }

  return (
    <Button
      variant="ghost"
      size="lg"
      className="h-11"
      onClick={() => void leave()}
      disabled={sending}
    >
      <LogOutIcon data-icon="inline-start" />
      {sending ? "…" : "Sign out"}
    </Button>
  )
}

/**
 * Leaving every browser at once, confirmed in its own panel.
 *
 * Not destructive - nothing is lost but a cookie - but it signs out the phone in a pocket and
 * the tab on the desk at once, and a reader who meant "this one" would have to sign in again with
 * Google or GitHub on every device. The sentence that machines keep running is said here, at
 * the gesture, and nowhere else on the page.
 */
function EverywherePanel({ onCancel }: { onCancel: () => void }) {
  const { refresh } = useSession()
  const navigate = useNavigate()
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const all = async () => {
    setSending(true)
    setError(null)
    try {
      await api.closeSessions()
      refresh()
      navigate("/login", { replace: true })
    } catch (failure) {
      setError(reason(failure))
      setSending(false)
    }
  }

  return (
    <>
      <PanelHeader
        icon={<LogOutIcon aria-hidden className={HEAD_ICON} />}
        title="Sign out everywhere"
        description="Every device, this one included, signs in again. Machines keep running."
      />
      {error === null ? null : (
        <p role="alert" className="mb-3 text-sm break-words text-destructive">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
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
          variant="destructive"
          size="lg"
          className="h-11"
          onClick={() => void all()}
          disabled={sending}
        >
          {sending ? <Spinner /> : "Sign out all"}
        </Button>
      </div>
    </>
  )
}

/** The anchor the address points at, decoded: `#command-line` is `command-line`. */
function aimedAt(hash: string): string {
  const raw = hash.replace(/^#/, "")
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
