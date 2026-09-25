import * as React from "react"
import {
  CheckIcon,
  InfoIcon,
  KeyRoundIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Link } from "react-router"

import { ConnectCloud } from "@/components/get-started"
import { Rich } from "@/components/guide"
import { Screen } from "@/components/layout"
import {
  FloorsLine,
  GithubMark,
  RepoLine,
  SecretChips,
} from "@/components/marks"
import { PanelHeader, Rows, Sheet } from "@/components/panel"
import { ProfileLine } from "@/components/profile-line"
import { SecretForm } from "@/components/secret-form"
import { useSession } from "@/components/session"
import { LoadingRows, Nothing, Trouble } from "@/components/states"
import { useAsync } from "@/hooks/use-async"
import { useCatalogue, useSecretGuides } from "@/hooks/use-catalogue"
import { api } from "@/lib/api"
import type { Catalogue, Profile } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Step 1 of 2: what the machine becomes.
 *
 * `up` needs two things nobody should have to remember: what the machine becomes, and what
 * it is made of. The old form took both from defaults - a profile, and cloud `hetzner`
 * - and that is precisely what made the command a gamble. The CLI settled the same question
 * in cli/src/ui/tui/Pickers.tsx: one path, two steps, nothing implied.
 *
 * A profile whose secrets are missing is named here, at the step where it is chosen, and not
 * discovered after pressing. The server already refuses that case with a 412 before ordering
 * anything - a machine created and then unable to seed itself is a machine on the meter with
 * nothing on it - but a refusal arriving after the gesture does not say what to do.
 *
 * AND IT IS FIXED HERE: the blocked row opens a sheet - where to get each key, the field,
 * Save - through the same PUT, and the list is read again in place, so the row turns
 * orderable under the reader's thumb.
 *
 * CALM, since 13/09, like the Keys page, and since 24/09 the same row as Profiles: a mark, a
 * name, one grey line of floors and what it installs, and a word only when something stands in
 * the way. The account's profiles above the built-in ones, headed as on Profiles. The note and
 * the full list of keys are behind the (i); a GitHub clone without a GitHub token turns that
 * (i) amber, and says why once the sheet is open.
 */
type Panel = { kind: "keys" | "inside"; name: string }

export function NewProfile() {
  const { session } = useSession()
  const catalogue = useCatalogue()
  const state = useAsync(() => api.profiles(), [])
  // The list read again after a secret was added, in place: `reload()` goes back through
  // `loading`, which would unmount the sheet the secret was just typed into.
  const [fresh, setFresh] = React.useState<Profile[] | null>(null)
  // Profiles that became orderable on this screen, which say so as a status.
  const [ready, setReady] = React.useState<ReadonlySet<string>>(new Set())
  const [panel, setPanel] = React.useState<Panel | null>(null)
  // What the sheet draws. It outlives `panel` by the length of the closing animation - a
  // sheet emptying itself as it slides away reads as a glitch. See screens/secrets.tsx.
  const [drawn, setDrawn] = React.useState<Panel | null>(null)
  if (panel !== null && panel !== drawn) setDrawn(panel)

  const list = fresh ?? state.data

  const reread = async (unblocked: string) => {
    try {
      const answer = await api.profiles()
      setFresh(answer)
      const now = answer.find((one) => one.name === unblocked)
      if (now !== undefined && now.missing_secrets.length === 0) {
        setReady((previous) => new Set([...previous, unblocked]))
        // Nothing left to ask: the sheet goes, and the row behind it now says Ready.
        setPanel((current) =>
          current?.kind === "keys" && current.name === unblocked
            ? null
            : current
        )
      }
    } catch {
      state.reload()
    }
  }

  const target =
    drawn === null
      ? undefined
      : (list ?? []).find((one) => one.name === drawn.name)

  return (
    <Screen
      title="Choose a profile"
      subtitle="Step 1 of 2"
      back={{ to: "/", label: "Machines" }}
    >
      {/* Above the list, not instead of it: which profile needs which key is still worth
          settling with no cloud connected. */}
      {session?.configured === false ? <ConnectCloud className="mb-4" /> : null}
      {list === null && state.status === "loading" ? <LoadingRows /> : null}
      {list === null && state.status === "failed" ? (
        <Trouble
          title="Profiles unreadable"
          detail={state.error}
          onRetry={state.reload}
        />
      ) : null}
      {list === null ? null : list.length === 0 ? (
        <Nothing>
          No profile: this service has nothing to install on a machine.
        </Nothing>
      ) : (
        // The account's own first: they are what it made for its work, and the likeliest
        // order. Headed only when there are two lists - one list headed "Built-in" tells a
        // newcomer nothing the page does not already say.
        [
          { title: "Yours", group: list.filter((one) => one.own) },
          { title: "Built-in", group: list.filter((one) => !one.own) },
        ]
          .filter(({ group }) => group.length > 0)
          .map(({ title, group }, index, groups) => (
            <section key={title} className={index > 0 ? "mt-6" : undefined}>
              {groups.length > 1 ? (
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">
                  {title}
                </h2>
              ) : null}
              <Rows>
                {group.map((profile) => (
                  <ProfileRow
                    key={profile.name}
                    profile={profile}
                    catalogue={catalogue}
                    ready={ready.has(profile.name)}
                    onKeys={() => setPanel({ kind: "keys", name: profile.name })}
                    onInside={() =>
                      setPanel({ kind: "inside", name: profile.name })
                    }
                  />
                ))}
              </Rows>
            </section>
          ))
      )}

      <Sheet open={panel !== null} onClose={() => setPanel(null)}>
        {target === undefined || drawn === null ? null : drawn.kind ===
          "keys" ? (
          <KeysPanel
            key={target.name}
            profile={target}
            onAdded={() => void reread(target.name)}
          />
        ) : (
          <InsidePanel profile={target} />
        )}
      </Sheet>
    </Screen>
  )
}

const PRESS =
  "transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted"

/**
 * One profile at rest: the line Profiles draws, what stands between it and a machine, and the
 * (i) that opens what is inside.
 *
 * Silent when it can leave: `Ready` on every row said the same word five times, and the one
 * row that could not leave had to be found among them. A row speaks when it lacks a key, and
 * once when it has just stopped lacking one - the key was typed in the sheet over it, and the
 * word is the answer to that gesture.
 *
 * Two controls side by side and never one inside the other: a button inside a link is two
 * targets a screen reader cannot tell apart. The ready row is a link to step 2, as it always
 * was; the blocked one is a button that opens the keys it needs, where it used to be a card
 * with neither - nothing to press but the way out of the refusal.
 */
function ProfileRow({
  profile,
  catalogue,
  ready,
  onKeys,
  onInside,
}: {
  profile: Profile
  catalogue: Catalogue | null
  ready: boolean
  onKeys: () => void
  onInside: () => void
}) {
  const absent = profile.missing_secrets.length
  const blocked = absent > 0
  const warned = profile.clones_github_without_token

  const badge = blocked ? (
    // Amber, the brief's one exception to amber-is-money: it is what stands between this
    // profile and a bill, and red would say something failed when nothing has been tried.
    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
      Needs {absent} {absent === 1 ? "key" : "keys"}
    </span>
  ) : ready ? (
    <span
      role="status"
      className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
    >
      <CheckIcon aria-hidden className="size-3.5" />
      Ready
    </span>
  ) : null

  const main = (
    <ProfileLine profile={profile} catalogue={catalogue} badge={badge} />
  )

  const shape = cn(
    "flex min-h-14 min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left",
    PRESS
  )

  return (
    <li className="flex items-stretch">
      {blocked ? (
        <button type="button" onClick={onKeys} className={shape}>
          {main}
        </button>
      ) : (
        <Link
          to={`/new/shape?profile=${encodeURIComponent(profile.name)}`}
          className={shape}
        >
          {main}
        </Link>
      )}
      <button
        type="button"
        onClick={onInside}
        aria-label={
          warned
            ? `What's inside ${profile.name}, and a warning`
            : `What's inside ${profile.name}`
        }
        className={cn(
          "flex w-12 shrink-0 items-center justify-center border-l border-border",
          warned
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground hover:text-foreground",
          PRESS
        )}
      >
        {warned ? (
          <TriangleAlertIcon aria-hidden className="size-4" />
        ) : (
          <InfoIcon aria-hidden className="size-4" />
        )}
      </button>
    </li>
  )
}

/**
 * The keys a profile lacks, each with where to get it and its field.
 *
 * The same SecretForm as /secrets, through the same PUT. A key saved leaves the list when the
 * profiles are read again; the last one closes the sheet (NewProfile#reread). A refusal stays
 * under its field, in the server's words, with the field empty for another paste.
 *
 * The line about dropping files into the service's secrets directory is gone since 13/09: it
 * was an instruction to whoever runs the server, drawn on a customer's order screen.
 */
function KeysPanel({
  profile,
  onAdded,
}: {
  profile: Profile
  onAdded: () => void
}) {
  const guides = useSecretGuides()
  const names = profile.missing_secrets
  return (
    <>
      <PanelHeader
        icon={
          <KeyRoundIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title={
          <>
            Add {names.length === 1 ? "a key" : "keys"} for{" "}
            <span className="font-mono">{profile.name}</span>
          </>
        }
      />
      <ul className="mt-2 divide-y divide-border">
        {names.map((name) => {
          const guide = guides.get(name)
          return (
            <li key={name} className="space-y-3 py-4 first:pt-2">
              <p className="flex items-center gap-2 text-sm font-medium">
                {name === "github" ? (
                  <GithubMark className="size-4 shrink-0" />
                ) : (
                  <KeyRoundIcon
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                )}
                <span>{guide?.label ?? name}</span>
              </p>
              <SecretForm
                id={`add-${name}`}
                name={name}
                guide={guide}
                replacing={false}
                onSave={async (value) => {
                  await api.setProfileSecret(name, value)
                  onAdded()
                }}
              />
            </li>
          )
        })}
      </ul>
    </>
  )
}

/**
 * What a profile is made of, for whoever asks: its note, what it needs, what it clones and
 * which keys it reads. The warning about a GitHub clone without a GitHub token is said here,
 * once, first.
 */
function InsidePanel({ profile }: { profile: Profile }) {
  return (
    <>
      <PanelHeader
        icon={
          <InfoIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
        }
        title={
          <>
            What's inside <span className="font-mono">{profile.name}</span>
          </>
        }
        description={
          profile.note === null ? undefined : <Rich text={profile.note} />
        }
      />
      {profile.clones_github_without_token ? (
        <p className="mt-2 mb-4 flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            Clones a GitHub repository but asks for no GitHub token: a private
            repository will not clone.
          </span>
        </p>
      ) : null}
      <dl
        className={cn(
          "divide-y divide-border rounded-xl ring-1 ring-foreground/10",
          profile.note === null && !profile.clones_github_without_token
            ? "mt-2"
            : undefined
        )}
      >
        <Fact label="Resources, at least">
          <FloorsLine floors={profile.floors} className="text-sm" />
        </Fact>
        {/* The repository comes from the profile's file, never from a field on a page: it is
            the only place where several repositories can be declared, each with its own
            secret and its own host. */}
        {profile.repo === null ? null : (
          <Fact label="Repository">
            <RepoLine repo={profile.repo} />
          </Fact>
        )}
        <Fact label="Keys">
          <SecretChips
            secrets={profile.secrets}
            missing={profile.missing_secrets}
            icon={false}
          />
        </Fact>
      </dl>
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
    <div className="flex flex-col gap-1.5 px-3 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}
