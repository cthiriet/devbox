import * as React from "react"
import { PackageIcon, PlusIcon, TriangleAlertIcon } from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router"

import { Rich } from "@/components/guide"
import { Screen } from "@/components/layout"
import { FloorsLine, RepoLine, SecretChips } from "@/components/marks"
import { ProfileLine } from "@/components/profile-line"
import { Fold, PanelHeader, Rows, Sheet } from "@/components/panel"
import { LoadingRows, Trouble } from "@/components/states"
import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { useAsync } from "@/hooks/use-async"
import { useCatalogue } from "@/hooks/use-catalogue"
import { api } from "@/lib/api"
import type { Profile } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The account's profiles, the ones every account has, and the way to compose another.
 *
 * Two lists, by where the file lives rather than by how it was written: "Yours" is this
 * account's directory - what it composed here, and what was deposited there by hand - and
 * "Built-in" is what the service publishes to every account. Only a composed row opens a form,
 * because only it has one: a hand-written file does not de-render into fields, and showing it
 * as editable would promise a screen that cannot exist. The others open read-only. Until
 * 24/09 the split was composed against everything else, and a profile deposited by hand was
 * listed as built-in, beside `claude`, as if the service shipped it.
 *
 * The built-in list is folded, and unfolded for as long as the account has nothing of its
 * own: what was meant to keep a long page short was hiding the whole page from whoever had
 * just arrived, who then read a title, a count, and no profiles at all.
 *
 * At rest a row is a name and one grey line - what it installs, what it clones - and the one
 * thing that stops it from ordering a machine: a token missing. Floors, notes and the full
 * list of tokens are a tap away, since 13/09: a page read to pick one profile out of four was
 * reading as a spreadsheet.
 *
 * Everything a row shows comes from `devbox profiles --json` - the floors, the secrets, the
 * repository - and not from the spec, the software line aside: what devbox reads is the
 * FILE, and a row drawn from the form would be a row describing something other than what
 * would run.
 */
export function Profiles() {
  const state = useAsync(() => api.profiles(), [])
  const catalogue = useCatalogue()
  const location = useLocation()
  const navigate = useNavigate()

  const yours = (state.data ?? []).filter((one) => one.own)
  const builtIn = (state.data ?? []).filter((one) => !one.own)

  const aimed = aimedAt(location.hash)
  const readOnlyAt = (fragment: string) =>
    (state.data ?? []).find(
      (one) => one.authored === null && `about-${one.name}` === fragment
    )

  // What the panel draws, kept through the closing animation: see screens/secrets.tsx.
  const [shown, setShown] = React.useState(aimed)
  if (readOnlyAt(aimed) !== undefined && aimed !== shown) setShown(aimed)
  const opened = readOnlyAt(shown)

  const go = (fragment: string) =>
    navigate(
      { pathname: location.pathname, search: location.search, hash: fragment },
      { replace: true }
    )

  const row = (profile: Profile) => (
    <li key={profile.name}>
      {profile.authored === null ? (
        <button
          type="button"
          onClick={() => go(`about-${profile.name}`)}
          className={LINE}
        >
          <ProfileLine
            profile={profile}
            catalogue={catalogue}
            badge={<Blocked profile={profile} />}
          />
        </button>
      ) : (
        <Link
          to={`/profiles/edit?name=${encodeURIComponent(profile.name)}`}
          className={LINE}
        >
          <ProfileLine
            profile={profile}
            catalogue={catalogue}
            badge={<Blocked profile={profile} />}
          />
        </Link>
      )}
    </li>
  )

  return (
    <Screen
      title="Profiles"
      action={
        state.status === "ready" ? (
          <Link
            to="/profiles/new"
            aria-label="Compose a profile"
            className={cn(
              buttonVariants({ variant: "outline", size: "icon-lg" }),
              "size-11"
            )}
          >
            <PlusIcon />
          </Link>
        ) : undefined
      }
    >
      {state.status === "loading" ? <LoadingRows /> : null}
      {state.status === "failed" ? (
        <Trouble
          title="Profiles unreadable"
          detail={state.error}
          onRetry={state.reload}
        />
      ) : null}

      {state.status === "ready" ? (
        <>
          {yours.length === 0 ? null : (
            <>
              <h2 className={HEADING}>Yours</h2>
              <Rows className="mt-2">{yours.map(row)}</Rows>
            </>
          )}

          {builtIn.length > 0 ? (
            <Fold
              title={`Built-in profiles (${builtIn.length})`}
              // Open when there is nothing else on the page, which is every account until it
              // composes its first profile: a fold holding the only list there is is not a
              // fold, it is a closed door in front of an empty room. With profiles of its own
              // above it, it goes back to being what it is - the ones every account has.
              defaultOpen={yours.length === 0}
              className="mt-6"
            >
              <Rows>{builtIn.map(row)}</Rows>
            </Fold>
          ) : null}

          {/* Under the lists, because the page is read before it is written on: what a
              reader arrives for is which profile to order with, and composing one is the
              answer only when none of them fits. Full width and quiet, unless there is
              nothing above it at all - then it is the page. */}
          <Link
            to="/profiles/new"
            className={cn(
              buttonVariants({
                variant: yours.length + builtIn.length === 0 ? "default" : "outline",
                size: "lg",
              }),
              "mt-6 h-12 w-full text-base"
            )}
          >
            <PlusIcon data-icon="inline-start" />
            Compose a profile
          </Link>

          <Sheet open={readOnlyAt(aimed) !== undefined} onClose={() => go("")}>
            {opened === undefined ? null : (
              <ReadOnlyPanel key={opened.name} profile={opened} />
            )}
          </Sheet>
        </>
      ) : null}
    </Screen>
  )
}

function missingWord(profile: Profile): string {
  return profile.missing_secrets.length > 1 ? "Tokens missing" : "Token missing"
}

/** The one thing at rest that stops a profile from ordering, and the one that lets it clone badly. */
function Blocked({ profile }: { profile: Profile }) {
  return (
    <>
      {profile.clones_github_without_token ? <GithubWarning /> : null}
      {profile.missing_secrets.length > 0 ? (
        <Badge variant="destructive" className="shrink-0">
          {missingWord(profile)}
        </Badge>
      ) : null}
    </>
  )
}

/** The two headings, as quiet as the Keys page's. */
const HEADING = "text-sm font-medium text-muted-foreground"

/** One row, tapped whole: the same target whether it opens a form or a panel. */
const LINE =
  "flex min-h-14 w-full items-center gap-3 px-3 py-2.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted"

function GithubWarning() {
  return (
    <span className="inline-flex shrink-0">
      <TriangleAlertIcon
        aria-hidden
        className="size-4 text-amber-600 dark:text-amber-400"
      />
      <span className="sr-only">
        Clones from GitHub without a GitHub token
      </span>
    </span>
  )
}

/**
 * A profile with no form behind it, read-only: what it asks for, what it clones, which keys it
 * needs. Built in, or written by hand in the account's directory, and the panel says which:
 * the reader who wonders why there is no Edit gets the reason, not a missing button.
 */
function ReadOnlyPanel({ profile }: { profile: Profile }) {
  return (
    <>
      <PanelHeader
        icon={
          <PackageIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title={profile.name}
        mono
        description={
          <>
            {profile.note === null ? null : <Rich text={profile.note} />}
            <span className={cn("block text-xs", profile.note !== null && "mt-1")}>
              {profile.own
                ? "Written by hand, so it is not edited here."
                : "Built in: every account has it."}
            </span>
          </>
        }
      />
      <div className="space-y-4">
        <Fact label="Resources">
          <FloorsLine floors={profile.floors} className="text-sm" />
        </Fact>
        {profile.repo === null ? null : (
          <Fact label="Repository">
            <RepoLine repo={profile.repo} />
          </Fact>
        )}
        <Fact label="Keys">
          {profile.secrets.length === 0 ? (
            <span className="text-sm text-muted-foreground">None</span>
          ) : (
            <SecretChips
              secrets={profile.secrets}
              missing={profile.missing_secrets}
              icon={false}
            />
          )}
        </Fact>
        {profile.missing_secrets.length > 0 ? (
          <p className="text-sm text-destructive">
            Add what is missing on{" "}
            <Link to="/secrets" className="underline underline-offset-4">
              Keys
            </Link>{" "}
            before ordering with it.
          </p>
        ) : null}
        {profile.clones_github_without_token ? (
          <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
            <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">
              A private repository will not clone: it asks for no GitHub token.
            </span>
          </p>
        ) : null}
      </div>
    </>
  )
}

function Fact({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

/** The anchor the address points at, decoded: `#about-claude` is `about-claude`. */
function aimedAt(hash: string): string {
  const raw = hash.replace(/^#/, "")
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
