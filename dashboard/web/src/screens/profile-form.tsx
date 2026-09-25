import * as React from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileCode2Icon,
  InfoIcon,
  KeyRoundIcon,
  Link2Icon,
  PlusIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
} from "lucide-react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router"

import { Rich } from "@/components/guide"
import { Screen } from "@/components/layout"
import { SecretMark, SoftwareMark } from "@/components/marks"
import { Fold, PanelHeader, Rows, Sheet } from "@/components/panel"
import { SecretForm } from "@/components/secret-form"
import { Loading, Trouble } from "@/components/states"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useAsync } from "@/hooks/use-async"
import { aSecret } from "@/hooks/use-catalogue"
import { api, reason } from "@/lib/api"
import { clearShared, peekShared, shareLink } from "@/lib/share"
import { inSentence } from "@/lib/format"
import type {
  ProfileRepo,
  ProfileSecret,
  ProfileSpec,
  SecretGuide,
  Software,
  SoftwareSecret,
} from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Composing a profile: what gets installed, what gets cloned, what it is seeded with.
 *
 * The one screen on this dashboard that WRITES a file the machine will run, and the shape it
 * takes follows from that. Nothing typed here becomes shell: the fields are a name, urls,
 * secret names and numbers, each checked by the server against an allow-list, and the body
 * of the profile is a list of calls into prelude.sh that the catalogue spells out. The
 * script under More options is rendered BY THE SERVER, from the same function that writes the
 * file - a preview drawn in the browser would be a second renderer, and the day the two
 * disagreed the reassuring one would be the wrong one.
 *
 * A secret is set from here rather than only pointed at, which is the difference between
 * composing a profile and composing one that can actually seed a machine: the field is the
 * same SecretForm as /secrets and it goes out through the same PUT, so a value is written
 * once, never read back, and never drawn.
 *
 * The profile saves whether or not its secrets are held. What is missing is said, in amber,
 * and the refusal that matters already exists: prepareLaunch refuses the job with a 412
 * before a machine is ordered, and /new greys the card.
 *
 * AN OPTIONAL SECRET IS A SWITCH, OFF, since 13/09. The GitHub CLI's token was drawn
 * "optional" and declared all the same - and a declared name is one the 412 counts - so a
 * profile the page called complete could not order a single machine. Now it is declared only
 * when the switch is on, and then it is needed like every other name on the list: see
 * ProfileSpec.optional in src/profiles.ts.
 *
 * ONE CALM PAGE, since 13/09. At rest it is the repositories - one list, however many - the
 * agent, and the tokens the profile needs, one row each; everything else - a note, other
 * token names, the machine's size, the script - is under More options, opened on its own when
 * the profile being edited already uses one of them.
 *
 * IN THAT ORDER SINCE 21/09, and the order is the argument. The form used to open on an empty
 * name and a list of software to tick - node, python, bun, a browser - which is a list of
 * things an agent installs for itself in one sentence, on a machine where `dev` has
 * passwordless sudo. Asking for them in advance asked the reader to predict their own week
 * before they had said what they were working on. What a profile is actually FOR is what
 * cannot be added later: an agent signed in with a token only the seed can carry, a
 * repository cloned with a credential only the seed can place, and the secrets that machine
 * is to read. So the repository leads, the agent follows it, the generic tools are folded
 * away under a sentence saying where they belong, and the name - proposed from the repository
 * - is the last thing asked rather than the first. A token is saved from its own panel the
 * moment it is pasted, through the same PUT as before, rather than held in the page until
 * the profile is saved: a composed profile and the tokens it reads are two writes either way.
 *
 * A SETUP SCRIPT IS A PATH, since 17/09, and still not shell. Whatever the catalogue cannot say
 * - a cluster, images, a seeded database - goes in a script of the profile's own repository,
 * and the field under the repositories only names it: the server checks the path and renders
 * one `run_setup` call, which runs it last, as dev. It is drawn only while there is a
 * repository to read it from.
 */
export function ProfileForm() {
  const [params] = useSearchParams()
  const editing = params.get("name")
  // A spec from a shared link, read once and forgotten: see lib/share.ts. Only on a NEW profile
  // - a link never edits one that exists - and read in the initializer, which must stay pure,
  // so the forgetting happens in an effect.
  const [prefill] = React.useState(() => (editing === null ? peekShared() : null))
  React.useEffect(() => {
    if (prefill !== null) clearShared()
  }, [prefill])

  const state = useAsync(
    async () => {
      const [profiles, catalogue, secrets] = await Promise.all([
        api.profiles(),
        api.software(),
        api.secrets(),
      ])
      return { profiles, catalogue, held: secrets.profile }
    },
    [editing]
  )

  if (state.status === "loading") return <Frame><Loading label="Reading the catalogue" /></Frame>
  if (state.status === "failed") {
    return (
      <Frame>
        <Trouble title="Nothing to compose with" detail={state.error} onRetry={state.reload} />
      </Frame>
    )
  }

  const found =
    editing === null ? undefined : state.data.profiles.find((one) => one.name === editing)

  if (editing !== null && (found === undefined || found.authored === null)) {
    // Either no profile of that name, or one written by hand: a form cannot be drawn from a
    // file, and offering to save one would overwrite what somebody wrote.
    return (
      <Frame>
        <Trouble
          title={found === undefined ? "Unknown profile" : "Not composed here"}
          detail={
            found === undefined
              ? `No profile named ${editing}.`
              : `${editing} was written by hand: it is changed where it was written, not from this form.`
          }
        />
        <Link to="/profiles" className="text-sm underline underline-offset-4">
          Back to the profiles
        </Link>
      </Frame>
    )
  }

  return (
    <Editor
      // Remounted when the profile changes, so every field below can be initialised once
      // from the spec rather than synchronised with an effect.
      key={editing ?? "new"}
      initial={found?.authored ?? null}
      prefill={prefill}
      catalogue={state.data.catalogue.software}
      guides={state.data.catalogue.secrets}
      held={state.data.held}
      taken={state.data.profiles.map((one) => one.name)}
    />
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <Screen title="Compose a profile" back={{ to: "/profiles", label: "Profiles" }}>
      {children}
    </Screen>
  )
}

/** The words of the ports field: spaces or commas between them, as a person types a list. */
function portWords(value: string): string[] {
  return value.split(/[\s,]+/).filter((word) => word !== "")
}

const BLANK: ProfileSpec = {
  name: "",
  note: null,
  software: [],
  optional: [],
  secrets: [],
  repos: [],
  setup: null,
  cpu: null,
  ram: null,
  disk: null,
  ports: [],
}

const NO_REPO: ProfileRepo = { url: "", secret: null, dir: null }

/**
 * The agents, and what sits with the repositories rather than with them.
 *
 * The GitHub CLI is not an agent and was drawn under that heading for a day: it is what lets
 * an agent HAND THE WORK BACK - push a branch, open a pull request - so it belongs beside the
 * repository it does that to, and it carries that repository's token. Everything the two
 * lists leave out is folded away: see the sentence under the agents.
 */
const AGENTS = ["claude", "opencode"]
const WITH_REPOS = ["gh"]

/** The ids SoftwareMark draws, so a panel knows when to fall back to a wrench. */
const SOFTWARE_MARKED = [...AGENTS, ...WITH_REPOS]

/**
 * devbox-core's rule for a profile name, as src/profiles.ts checks it (NAME, NAME_MAX).
 *
 * Said under the field as it is typed, and never instead of the server: the server refuses
 * all the same, and its refusal is what the page shows when the two disagree.
 */
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const NAME_MAX = 32

/** The two headings are signposts, as on Keys: quiet, and short. */
const HEADING = "text-sm font-medium text-muted-foreground"

/**
 * One part of the form: a heading that reads as one, a sentence saying what the part is for,
 * and room around it.
 *
 * Since 25/09. The parts used to follow one another under grey labels a notch above the body
 * text, eight pixels apart, and the page read as one long list where the repository, the tool
 * that pushes to it, its setup script and the agent ran together. A rule and forty pixels
 * between two parts is what says where one question ends and the next begins.
 */
function Part({
  id,
  title,
  hint,
  first = false,
  children,
}: {
  id: string
  title: string
  hint: string
  first?: boolean
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={id}
      className={first ? undefined : "mt-10 border-t border-border pt-8"}
    >
      <h2 id={id} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{hint}</p>
      <div className="mt-5">{children}</div>
    </section>
  )
}

/**
 * What the catalogue pulls in on its own: the entries `needs` names, minus the ones ticked.
 *
 * Computed here for DISPLAY ONLY - a tile that is on because something else wants it has to
 * say so rather than look ticked. What is actually installed is the server's answer: it
 * resolves the same list when it renders, and the script under More options shows the result.
 */
function impliedBy(chosen: string[], catalogue: Software[]): Set<string> {
  const byId = new Map(catalogue.map((one) => [one.id, one]))
  const wanted = new Set<string>()
  const add = (id: string) => {
    if (wanted.has(id)) return
    wanted.add(id)
    for (const need of byId.get(id)?.needs ?? []) add(need)
  }
  for (const id of chosen) add(id)
  for (const id of chosen) wanted.delete(id)
  return wanted
}

/**
 * A name proposed from the first repository, and only while nobody has typed one.
 *
 * `https://github.com/me/my-app.git` becomes `my-app`, which is what the reader would have
 * typed and the name they will recognise on /new. Anything the profile name rule does not
 * allow becomes `-`, a leading run of them is dropped - `NAME` wants an alphanumeric first -
 * and a name already taken gets a number, because a suggestion that cannot be saved is worse
 * than an empty field.
 *
 * It only ever fills a field the reader has not touched, and never while editing: a name is
 * what `devbox up --profile` is typed with, and changing one under somebody is changing what
 * their machines are ordered with.
 */
function suggestName(url: string, taken: string[]): string {
  const path = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const last = path.split(/[/:]/).pop() ?? ""
  const cleaned = last
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, NAME_MAX)
  if (cleaned === "") return ""
  if (!taken.includes(cleaned)) return cleaned
  for (let n = 2; n < 100; n += 1) {
    const tried = `${cleaned.slice(0, NAME_MAX - 3)}-${n}`
    if (!taken.includes(tried)) return tried
  }
  return ""
}

function nameProblem(name: string, taken: string[]): string | null {
  if (name === "") return null
  if (name.length > NAME_MAX) return `Use ${NAME_MAX} characters at most`
  if (/^[-_]/.test(name)) return "Start with a letter or a digit"
  if (!NAME.test(name)) return "Use letters, digits, - and _"
  if (taken.includes(name)) return "That name is taken"
  return null
}

/**
 * An address the server will refuse for being the wrong kind, said before it is sent.
 *
 * https only - see REPO_URL in src/profiles.ts: a private repository is cloned with a token,
 * and a token can only be handed to an https host.
 */
function urlProblem(url: string): string | null {
  const trimmed = url.trim()
  if (/^(git@|ssh:\/\/|http:\/\/|git:\/\/)/.test(trimmed)) return "Use the https address"
  return null
}

function Editor({
  initial,
  prefill,
  catalogue,
  guides,
  held,
  taken,
}: {
  initial: ProfileSpec | null
  /** A spec from a shared link: fills a NEW profile, and is not the profile being edited. */
  prefill: ProfileSpec | null
  catalogue: Software[]
  guides: SecretGuide[]
  held: ProfileSecret[]
  taken: string[]
}) {
  const guideOf = (secretName: string) =>
    guides.find((guide) => guide.name === secretName)
  const navigate = useNavigate()
  const location = useLocation()
  const start = initial ?? prefill ?? BLANK

  const [name, setName] = React.useState(start.name)
  // A name the reader typed is theirs: the suggestion below stops the moment this is true,
  // including when they clear the field - an empty box they emptied is a decision too.
  // A name that came with a shared link counts as chosen: the repository proposing its own
  // over it would rename the profile the colleague was sent.
  const [namedByHand, setNamedByHand] = React.useState(
    initial !== null || (prefill !== null && prefill.name !== "")
  )
  const [note, setNote] = React.useState(start.note ?? "")
  const [chosen, setChosen] = React.useState<string[]>(start.software)
  // Every repository in one list, the profile's own first, as the spec carries them. They were
  // split until 13/09 - the first a field at rest, the others under More options with another
  // shape - and two drawings of the same thing read as two different things. A new profile
  // starts with one empty row, so the field is there without a button to press first.
  const [repoList, setRepoList] = React.useState<ProfileRepo[]>(
    start.repos.length > 0 ? start.repos : [NO_REPO]
  )
  const [setup, setSetup] = React.useState(start.setup ?? "")
  const [extra, setExtra] = React.useState<string[]>(start.secrets)
  const [optional, setOptional] = React.useState<string[]>(start.optional)
  const [floors, setFloors] = React.useState({
    cpu: start.cpu === null ? "" : String(start.cpu),
    ram: start.ram === null ? "" : String(start.ram),
    disk: start.disk === null ? "" : String(start.disk),
    ports: start.ports.join(" "),
  })

  const [known, setKnown] = React.useState(held)
  const [saving, setSaving] = React.useState(false)
  /**
   * The name that was just saved, carried across the remount a creation causes.
   *
   * A creation navigates from /profiles/new to /profiles/edit?name=…, and this component is
   * keyed on that name so every field can be initialised from the spec rather than
   * synchronised with an effect - which means the component that did the saving is gone by
   * the time the answer would be drawn. Measured here, first try: the profile was written,
   * the secrets were written, and the page said nothing at all. The router's own state is
   * what survives that remount.
   */
  const arrived = (location.state as { composed?: string } | null)?.composed ?? null
  const [saved, setSaved] = React.useState<string | null>(arrived)
  const [failure, setFailure] = React.useState<string | null>(null)

  /**
   * Whether the profile being edited uses anything under More options: then it opens on its
   * own, or a note, a floor or a port would be on the profile and nowhere on the page. The
   * tokens added by hand have their own part since 25/09, open whatever it holds.
   */
  const [usesMore] = React.useState(
    () =>
      start.note !== null ||
      start.cpu !== null ||
      start.ram !== null ||
      start.disk !== null ||
      start.ports.length > 0
  )

  const number = (value: string): number | null => {
    const trimmed = value.trim()
    if (trimmed === "") return null
    const parsed = Number(trimmed)
    return Number.isInteger(parsed) ? parsed : null
  }

  // A row left empty is not a repository: sent, the server would refuse the whole profile.
  const repos = repoList.filter((repo) => repo.url.trim() !== "")

  const spec: ProfileSpec = {
    name: name.trim(),
    note: note.trim() === "" ? null : note.trim(),
    software: chosen,
    optional,
    secrets: extra,
    repos,
    // Only while there is a repository to read it from, which is also the only time the field
    // is drawn: a path left behind by a removed repository would be refused, invisibly.
    setup: repos.length === 0 || setup.trim() === "" ? null : setup.trim(),
    cpu: number(floors.cpu),
    ram: number(floors.ram),
    disk: number(floors.disk),
    // Typed as `9010 5173` or `9010, 5173`. A word that is not a whole number goes as NaN,
    // which JSON writes null and the server refuses by name; the field says so first.
    ports: portWords(floors.ports).map((word) => (/^[0-9]+$/.test(word) ? Number(word) : NaN)),
  }
  const portsUnread = portWords(floors.ports).some(
    (word) => !/^[0-9]+$/.test(word) || Number(word) < 1 || Number(word) > 65535
  )

  const problem = initial === null ? nameProblem(spec.name, taken) : null

  const implied = impliedBy(chosen, catalogue)
  const installed = catalogue.filter((one) => chosen.includes(one.id) || implied.has(one.id))

  // Every name the header will carry, worked out the way the server does (declaredSecrets):
  // what the software requires, the optional ones switched on, what a private repository
  // clones with, and what was added by hand. Every one of them is needed to order a machine.
  const asked = installed.flatMap((one) => one.secrets)
  const requiredBySoftware = new Set(
    asked.filter((secret) => secret.required).map((secret) => secret.name)
  )
  const viaRepos = new Set(
    repos.flatMap((repo) => (repo.secret === null || repo.secret === "" ? [] : [repo.secret]))
  )
  const offered = new Set(
    asked
      .filter((secret) => !secret.required && !requiredBySoftware.has(secret.name))
      .map((secret) => secret.name)
  )
  const switchedOn = [...offered].filter((secretName) => optional.includes(secretName))
  const declared = [
    ...new Set([...requiredBySoftware, ...switchedOn, ...viaRepos, ...extra]),
  ].sort()

  const holds = (secretName: string) =>
    known.find((one) => one.name === secretName)?.set === true
  const missing = declared.filter((secretName) => !holds(secretName))

  const toggle = (id: string) =>
    setChosen((current) =>
      current.includes(id) ? current.filter((one) => one !== id) : [...current, id]
    )

  /* --- the panels a tap opens ------------------------------------------------------ */

  const aimed = aimedAt(location.hash)
  const toolAt = (fragment: string) =>
    catalogue.find((one) => `tool-${one.id}` === fragment)
  const tokenAt = (fragment: string) =>
    declared.find((secretName) => `token-${secretName}` === fragment)
  const opens = (fragment: string) =>
    toolAt(fragment) !== undefined || tokenAt(fragment) !== undefined

  // What the panel draws, kept through the closing animation: see screens/secrets.tsx.
  const [shown, setShown] = React.useState(aimed)
  if (opens(aimed) && aimed !== shown) setShown(aimed)

  const go = (fragment: string) =>
    navigate(
      { pathname: location.pathname, search: location.search, hash: fragment },
      { replace: true }
    )

  const panel = (): React.ReactNode => {
    const tool = toolAt(shown)
    if (tool !== undefined) {
      return <ToolPanel key={shown} software={tool} catalogue={catalogue} />
    }
    const secretName = tokenAt(shown)
    if (secretName !== undefined) {
      return (
        <TokenPanel
          key={shown}
          name={secretName}
          guide={guideOf(secretName)}
          entry={known.find((one) => one.name === secretName) ?? null}
          // The software's own word for a secret it requires, when the catalogue has no
          // guide to say what the token is for.
          help={
            installed
              .flatMap((one) => one.secrets)
              .find((one) => one.name === secretName && one.required)?.help ?? null
          }
          onSaved={(entry) => {
            setKnown((current) =>
              current.some((one) => one.name === entry.name)
                ? current.map((one) => (one.name === entry.name ? entry : one))
                : [...current, entry]
            )
            go("")
          }}
        />
      )
    }
    return null
  }

  const save = async () => {
    if (saving || spec.name === "" || problem !== null) return
    setSaving(true)
    setFailure(null)
    setSaved(null)
    try {
      const answer = await api.saveProfile(spec)
      setSaved(answer.name)
      if (initial === null) {
        // A creation becomes an edit, so a second save replaces rather than composing twice.
        navigate(`/profiles/edit?name=${encodeURIComponent(answer.name)}`, {
          replace: true,
          state: { composed: answer.name },
        })
      }
    } catch (error) {
      setFailure(reason(error))
    } finally {
      setSaving(false)
    }
  }

  const tile = (one: Software, featured: boolean) => (
    <ToolTile
      software={one}
      icon={featured ? <SoftwareMark id={one.id} /> : null}
      on={chosen.includes(one.id)}
      implied={implied.has(one.id)}
      needed={catalogue
        .filter((other) => chosen.includes(other.id) && other.needs.includes(one.id))
        .map((other) => other.label)}
      onToggle={() => toggle(one.id)}
      onInfo={() => go(`tool-${one.id}`)}
    >
      {/* The token, in the tile of the software that signs in with it, rather than in a list
          further down repeating the same three names. What is NOT here is what belongs to no
          tile: a private repository's credential when the GitHub CLI is off, and the names
          added by hand under More options. */}
      {one.secrets
        .filter((secret) => declared.includes(secret.name))
        .map((secret) => (
          <TokenLine
            key={`held-${secret.name}`}
            name={secret.name}
            label={guideOf(secret.name)?.label}
            set={holds(secret.name)}
            onOpen={() => go(`token-${secret.name}`)}
          />
        ))}
      {one.secrets
        .filter((secret) => offered.has(secret.name))
        .map((secret) => (
          <OptionalSecret
            key={secret.name}
            secret={secret}
            guide={guideOf(secret.name)}
            // Already declared another way - a private repository, a name added by hand -
            // and so needed whatever the switch says: drawn on, and not offered off.
            already={viaRepos.has(secret.name) || extra.includes(secret.name)}
            on={optional.includes(secret.name)}
            disabled={saving}
            onChange={(checked) =>
              setOptional((current) =>
                checked
                  ? [...new Set([...current, secret.name])]
                  : current.filter((one) => one !== secret.name)
              )
            }
          />
        ))}
    </ToolTile>
  )

  const featured = AGENTS.flatMap((id) => catalogue.filter((one) => one.id === id))
  const alongside = WITH_REPOS.flatMap((id) => catalogue.filter((one) => one.id === id))
  const more = catalogue.filter(
    (one) => !AGENTS.includes(one.id) && !WITH_REPOS.includes(one.id)
  )
  const names = [...new Set([...known.map((one) => one.name), "github"])].sort()

  /**
   * The declared names no tile is showing: a private repository's credential while the GitHub
   * CLI is off, and the names added by hand under More options.
   *
   * Computed from the tiles that are actually drawn and installed, not from a second list of
   * ids: a name would otherwise be in two places the day one of the two lists learned about
   * an entry and the other did not.
   */
  const inTiles = new Set(
    [...featured, ...alongside]
      .filter((one) => chosen.includes(one.id) || implied.has(one.id))
      .flatMap((one) => one.secrets.map((secret) => secret.name))
  )
  const loose = declared.filter((secretName) => !inTiles.has(secretName))

  return (
    <Screen
      title={initial === null ? "Compose a profile" : `Edit ${initial.name}`}
      back={{ to: "/profiles", label: "Profiles" }}
    >
      {/* First, and before any field: the reader did not type what follows, and the two
          things that decide what runs on their machine - the repository and its setup
          script - are named, rather than "check everything", which reads as nothing. */}
      {prefill === null ? null : (
        <Alert className="mb-6">
          <Link2Icon aria-hidden />
          <AlertTitle>Filled in from a shared link</AlertTitle>
          <AlertDescription>
            Nothing exists until you save it. Check the repository and the setup script
            first: they run on your machine, with your tokens.
          </AlertDescription>
        </Alert>
      )}
      <Part
        id="repository"
        title={repoList.length > 1 ? "Repositories" : "Repository"}
        hint="What the machine clones into /workspace before anything else runs."
        first
      >
        <ul className="space-y-3">
          {repoList.map((repo, index) => (
            <li key={index}>
              <RepoEditor
                index={index}
                repo={repo}
                names={names}
                grouped={repoList.length > 1}
                disabled={saving}
                onChange={(next) => {
                  setRepoList((current) =>
                    current.map((one, at) => (at === index ? next : one))
                  )
                  // The profile's own repository, and only it: a second one is a library
                  // beside the work, not what the machine is called after.
                  if (index === 0 && !namedByHand) setName(suggestName(next.url, taken))
                }}
                onRemove={() =>
                  setRepoList((current) => current.filter((_, at) => at !== index))
                }
              />
            </li>
          ))}
        </ul>
        {/* Not while a row is still empty: a second blank row is a row to delete. */}
        {repoList.some((repo) => repo.url.trim() === "") ? null : (
          <Button
            variant="ghost"
            className="mt-2 h-11 px-2 text-muted-foreground"
            onClick={() => setRepoList((current) => [...current, NO_REPO])}
          >
            <PlusIcon data-icon="inline-start" />
            Add another repository
          </Button>
        )}
        {repos.length === 0 ? null : (
          <div className="mt-8 space-y-2">
            <Label htmlFor="setup" className="text-sm font-medium">
              Setup script <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="setup"
              value={setup}
              onChange={(event) => setSetup(event.target.value)}
              placeholder="scripts/devbox-setup.sh"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              disabled={saving}
              aria-describedby="setup-help"
              className="h-12 font-mono text-base"
            />
            <p id="setup-help" className="text-sm leading-relaxed text-muted-foreground">
              A file of {repos.length > 1 ? "the first repository" : "this repository"}, run last
              from its root. It can use <span className="font-mono">sudo</span> and read your
              tokens in <span className="font-mono">/run/secrets</span>. It runs again whenever
              the machine is set up again, so it must be safe to repeat.
            </p>
          </div>
        )}
        {/* What hands the work back, beside what the work is done on: `gh` pushes a branch
            and opens a pull request, and the token it reads is that repository's. */}
        {alongside.length === 0 ? null : (
          <div className="mt-8">
            <p className="text-sm font-medium">Pull requests</p>
            <ul className="mt-2 space-y-3">
              {alongside.map((one) => (
                <li key={one.id}>{tile(one, true)}</li>
              ))}
            </ul>
          </div>
        )}
      </Part>

      <Part
        id="tools"
        title="Agent"
        hint="Installed and signed in before you connect, so a session starts working at once."
      >
        <ul className="space-y-3">
          {featured.map((one) => (
            <li key={one.id}>{tile(one, true)}</li>
          ))}
        </ul>
        {/* What this page is FOR, said once where the old list of tick-boxes was.
            A language, a database, a CLI: an agent on a machine with passwordless sudo
            installs those in a sentence, and a form that asked for them in advance was
            asking the reader to predict their own week. What cannot be asked for later is
            what stays above: an agent signs itself in with a token only the seed can carry,
            and a private repository clones with a credential only the seed can place. */}
        {more.length === 0 ? null : (
          <Fold
            title="Other software"
            defaultOpen={more.some((one) => start.software.includes(one.id))}
            className="mt-6"
          >
            <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
              A language or a CLI is one sentence to the agent once the machine is up. Tick one
              here only if it must be there before the agent starts.
            </p>
            <ul className="space-y-3">
              {more.map((one) => (
                <li key={one.id}>{tile(one, false)}</li>
              ))}
            </ul>
          </Fold>
        )}
      </Part>

      {/* Every name no tile shows, and the way to add one: a single place, where the list and
          the "Other tokens" field under More options used to name the same three secrets. */}
      <Part
        id="tokens"
        title="Tokens"
        hint="Anything else your setup script or your app reads from /run/secrets. Saved once in Keys, never shown again."
      >
        {loose.length === 0 ? null : (
          <Rows className="mb-4">
            {loose.map((secretName) => (
              <TokenRow
                key={secretName}
                name={secretName}
                label={guideOf(secretName)?.label}
                set={holds(secretName)}
                onOpen={() => go(`token-${secretName}`)}
                // Only a name added here comes off here: a private repository's credential
                // goes with the repository, or with its switch.
                onRemove={
                  extra.includes(secretName)
                    ? () => setExtra((current) => current.filter((one) => one !== secretName))
                    : undefined
                }
              />
            ))}
          </Rows>
        )}
        <AddSecret
          onAdd={(secretName) =>
            setExtra((current) =>
              current.includes(secretName) ? current : [...current, secretName]
            )
          }
        />
      </Part>

      {/* Last, and proposed rather than demanded: the first field of this form used to be
          an empty box wanting a name for something the reader had not described yet. It is
          still the profile's identity - `devbox up --profile <name>`, and the card on /new -
          so it is a field and not a derivation, and editing a profile leaves it alone. */}
      <Part
        id="name-heading"
        title="Name"
        hint={
          initial === null
            ? "Proposed from the repository. It is what you pick when ordering a machine."
            : "A saved profile keeps its name."
        }
      >
        <Label htmlFor="name" className="sr-only">
          Profile name
        </Label>
        <Input
          id="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setNamedByHand(true)
          }}
          disabled={initial !== null}
          placeholder="my-agent"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem !== null || undefined}
          aria-describedby={problem === null ? undefined : "name-problem"}
          className="h-12 font-mono text-base"
        />
        {problem === null ? null : (
          <p id="name-problem" className="mt-2 text-sm text-destructive">
            {problem}
          </p>
        )}
        {problem !== null || initial !== null || name === "" ? null : (
          <p className="mt-2 text-sm text-muted-foreground">
            From a terminal: <span className="font-mono">devbox up --profile {name}</span>
          </p>
        )}
      </Part>

      <Fold
        title="More options"
        defaultOpen={usesMore}
        className="mt-10 border-t border-border pt-2"
      >
        <div className="space-y-8 pt-2 pb-2">
          <div className="space-y-2">
            <Label htmlFor="note">Note</Label>
            <Input
              id="note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Open a session and type claude"
              className="h-12"
            />
          </div>

          <div>
            <p className="text-sm font-medium">Machine size</p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(
                [
                  ["cpu", "Cores"],
                  ["ram", "Memory, GB"],
                  ["disk", "Disk, GB"],
                ] as const
              ).map(([field, label]) => (
                <div key={field} className="space-y-1.5">
                  <Label htmlFor={field} className="text-xs text-muted-foreground">
                    {label}
                  </Label>
                  <Input
                    id={field}
                    inputMode="numeric"
                    value={floors[field]}
                    onChange={(event) =>
                      setFloors((current) => ({ ...current, [field]: event.target.value }))
                    }
                    className="h-12 font-mono text-base tabular-nums"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ports">App ports</Label>
            <Input
              id="ports"
              value={floors.ports}
              onChange={(event) =>
                setFloors((current) => ({ ...current, ports: event.target.value }))
              }
              placeholder="9010"
              aria-invalid={portsUnread || undefined}
              aria-describedby="ports-help"
              className="h-12 font-mono text-base tabular-nums"
            />
            {/* What the field is for, since nothing else on the page says it: a port inside the
                machine, reached from a Mac or a phone through ssh and from nowhere else. */}
            <p
              id="ports-help"
              className={cn(
                "text-xs",
                portsUnread ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {portsUnread
                ? "Whole numbers between 1 and 65535, separated by spaces."
                : "Where your app listens on the machine, the main one first. Each opens on your Mac through SSH."}
            </p>
          </div>

          <Preview spec={spec} ready={spec.name !== ""} />
        </div>
      </Fold>

      {missing.length > 0 ? (
        <p className="mt-6 flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
          <KeyRoundIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            A machine cannot start with it until{" "}
            {inSentence(missing.map((secretName) => aSecret(secretName, guideOf(secretName))))}{" "}
            {missing.length === 1 ? "is" : "are"} added.
          </span>
        </p>
      ) : null}

      {failure !== null ? (
        <Alert variant="destructive" className="mt-4">
          <AlertTitle>Not saved</AlertTitle>
          <AlertDescription>
            <p className="break-words">{failure}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      {saved !== null ? (
        <p role="status" className="mt-4 text-sm">
          <span className="text-emerald-600 dark:text-emerald-400">Saved.</span>{" "}
          <Link
            to={
              missing.length === 0
                ? `/new/shape?profile=${encodeURIComponent(saved)}`
                : "/new"
            }
            className="font-medium underline underline-offset-4"
          >
            Order a machine →
          </Link>
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-4 mt-6 border-t border-border bg-background/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
        <Button
          size="lg"
          className="h-12 w-full text-base"
          disabled={saving || spec.name === "" || problem !== null}
          onClick={() => void save()}
        >
          {saving ? "…" : "Save profile"}
        </Button>
      </div>

      {initial === null ? null : <Share spec={spec} />}
      {initial === null ? null : <Delete name={initial.name} />}

      <Sheet open={opens(aimed)} onClose={() => go("")}>
        {panel()}
      </Sheet>
    </Screen>
  )
}

/**
 * One row for the software and its token, since 21/09.
 *
 * The tile and the token row used to carry two different glyphs - a robot for Claude Code, a
 * key for its token - and they are not two things: the token is how that software signs in.
 * Both come from marks.tsx now, which draws each issuer's own mark and a plain key for a name
 * no guide describes.
 */
function TokenLine({
  name,
  label,
  set,
  onOpen,
}: {
  name: string
  label: string | undefined
  set: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex min-h-12 w-full items-center gap-3 border-t border-border px-3 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <SecretMark name={name} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm">
        {label ?? <span className="font-mono">{name}</span>}
      </span>
      {set ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon aria-hidden className="size-3.5" />
          Added
        </span>
      ) : (
        <span className="shrink-0 text-xs text-muted-foreground">Add</span>
      )}
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

/**
 * One tool: a tap turns it on or off, the (i) says what it is.
 *
 * Two buttons side by side and not one inside the other, which HTML does not allow. What a
 * tool may use besides - the GitHub token for the GitHub CLI - is drawn inside its tile once
 * it is on, as `children`, where the decision belongs.
 */
function ToolTile({
  software,
  icon,
  on,
  implied,
  needed,
  onToggle,
  onInfo,
  children,
}: {
  software: Software
  icon: React.ReactNode
  on: boolean
  implied: boolean
  needed: string[]
  onToggle: () => void
  onInfo: () => void
  children?: React.ReactNode
}) {
  const installed = on || implied
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10",
        on && "ring-2 ring-primary",
        // The focus ring of the toggle is the tile's own: drawn inside the left button alone, it
        // stopped at the (i), a lit rectangle beside a dark one in a rounded tile.
        "has-[[aria-pressed]:focus-visible]:ring-2 has-[[aria-pressed]:focus-visible]:ring-ring"
      )}
    >
      {/* Hover and press on the whole row, (i) included, for the same reason. */}
      <div className="flex items-stretch transition-colors hover:bg-muted/60 has-[button:active]:bg-muted">
        <button
          type="button"
          aria-pressed={on}
          onClick={onToggle}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 pl-3 text-left outline-none",
            icon === null ? "min-h-12" : "min-h-14"
          )}
        >
          {icon === null ? null : (
            <span className="flex shrink-0 text-muted-foreground [&_svg]:size-5">{icon}</span>
          )}
          <span className="min-w-0 flex-1 py-2">
            <span className="block truncate text-sm font-medium">{software.label}</span>
            {implied && !on ? (
              <span className="block truncate text-xs text-muted-foreground">
                With {inSentence(needed)}
              </span>
            ) : null}
          </span>
          <span
            aria-hidden
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border",
              on
                ? "border-primary bg-primary text-primary-foreground"
                : implied
                  ? "border-transparent bg-muted text-muted-foreground"
                  : "border-input"
            )}
          >
            {installed ? <CheckIcon className="size-3.5" /> : null}
          </span>
        </button>
        <button
          type="button"
          onClick={onInfo}
          aria-label={`About ${software.label}`}
          className="group/info flex w-11 shrink-0 items-center justify-center text-muted-foreground outline-none hover:text-foreground"
        >
          {/* Its own ring, round and around the icon, so a keyboard can tell which of the two
              buttons of the tile it is on. */}
          <span className="flex size-8 items-center justify-center rounded-full group-focus-visible/info:ring-2 group-focus-visible/info:ring-ring">
            <InfoIcon aria-hidden className="size-4" />
          </span>
        </button>
      </div>
      {installed ? children : null}
    </div>
  )
}

/** The first sentence of a catalogue help: a tile has room for one. */
function firstSentence(text: string): string {
  const match = /^.*?[.!?](\s|$)/.exec(text)
  return match === null ? text : match[0].trim()
}

/**
 * An optional secret, as a switch inside its tool's tile.
 *
 * AN OPTIONAL SECRET IS A SWITCH, OFF: see the header of this file, and ProfileSpec.optional
 * in src/profiles.ts.
 */
function OptionalSecret({
  secret,
  guide,
  already,
  on,
  disabled,
  onChange,
}: {
  secret: SoftwareSecret
  guide: SecretGuide | undefined
  already: boolean
  on: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center justify-between gap-3 border-t border-border px-3 py-2">
      <span className="min-w-0">
        <span className="block text-sm">Use {aSecret(secret.name, guide)}</span>
        <span className="block text-xs text-muted-foreground">
          {already ? "Already needed by this profile." : <Rich text={firstSentence(secret.help)} />}
        </span>
      </span>
      <Switch
        checked={already || on}
        disabled={already || disabled}
        onCheckedChange={onChange}
      />
    </label>
  )
}

/** What a tool is, in its catalogue's sentence; what it brings along and reads, under Details. */
function ToolPanel({ software, catalogue }: { software: Software; catalogue: Software[] }) {
  const needs = catalogue
    .filter((one) => software.needs.includes(one.id))
    .map((one) => one.label)
  const bare = needs.length === 0 && software.secrets.length === 0
  return (
    <>
      <PanelHeader
        icon={
          <span className="flex shrink-0 text-muted-foreground [&_svg]:size-5">
            {/* The same mark as the tile it was opened from, and a wrench for the tools
                that read no token: see SOFTWARE_MARKS. */}
            <SoftwareMark id={software.id} />
            {SOFTWARE_MARKED.includes(software.id) ? null : <WrenchIcon aria-hidden />}
          </span>
        }
        title={software.label}
        description={software.note}
      />
      {bare ? null : (
        <Fold title="Details" className="border-t border-border">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {needs.length === 0 ? null : (
              <>
                <dt>Also installs</dt>
                <dd className="text-foreground">{needs.join(", ")}</dd>
              </>
            )}
            {software.secrets.map((secret) => (
              <React.Fragment key={secret.name}>
                <dt>{secret.required ? "Needs" : "Can use"}</dt>
                <dd className="text-foreground">{secret.label}</dd>
              </React.Fragment>
            ))}
          </dl>
        </Fold>
      )}
    </>
  )
}

/**
 * One token this profile needs: where to get it, and the field.
 *
 * The same SecretForm as Keys and /new, through the same PUT, so a value is written once,
 * never read back, and never drawn. Saved on its own, here, and not with the profile: the
 * value leaves the page's state the moment it is sent, like everywhere else a secret is typed.
 */
function TokenPanel({
  name,
  guide,
  entry,
  help,
  onSaved,
}: {
  name: string
  guide: SecretGuide | undefined
  entry: ProfileSecret | null
  help: string | null
  onSaved: (entry: ProfileSecret) => void
}) {
  const set = entry?.set === true
  return (
    <>
      <PanelHeader
        icon={<SecretMark name={name} className="size-5 shrink-0 text-muted-foreground" />}
        title={guide?.label ?? name}
        description={
          <Rich
            text={guide?.purpose ?? help ?? "A secret this profile reads on its machines."}
          />
        }
      />
      <SecretForm
        id={`token-${name}`}
        name={name}
        guide={guide}
        replacing={set}
        showGuide={!set}
        onSave={async (value) => onSaved(await api.setProfileSecret(name, value))}
      />
      {set && entry !== null && entry.machines.length > 0 ? (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
          {inSentence(entry.machines)} keep the previous one until set up again.
        </p>
      ) : null}
    </>
  )
}

const OTHER = " other"

/**
 * Which token a repository is cloned with: one the service knows, or another name.
 *
 * `""` while another name is being typed, as before: the server reads it as none, and a
 * repository saved that way is public.
 */
function CredentialPicker({
  id,
  value,
  names,
  allowPublic,
  onChange,
}: {
  id: string
  value: string | null
  names: string[]
  allowPublic: boolean
  onChange: (secret: string | null) => void
}) {
  const listed = value === null || names.includes(value)
  const [other, setOther] = React.useState(!listed)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="relative inline-flex h-11 items-center rounded-lg border border-input pr-2 pl-2.5">
        <select
          id={id}
          value={other ? OTHER : (value ?? "")}
          onChange={(event) => {
            if (event.target.value === OTHER) {
              setOther(true)
              onChange("")
              return
            }
            setOther(false)
            onChange(event.target.value === "" ? null : event.target.value)
          }}
          className="h-full appearance-none bg-transparent pr-5 font-mono text-sm outline-none focus-visible:ring-0"
        >
          {allowPublic ? <option value="">nothing (public)</option> : null}
          {names.map((one) => (
            <option key={one} value={one}>
              {one}
            </option>
          ))}
          <option value={OTHER}>another name…</option>
        </select>
        <ChevronDownIcon
          aria-hidden
          className="pointer-events-none absolute right-2 size-3.5 opacity-50"
        />
      </span>
      {other ? (
        <Input
          aria-label="Token name"
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder="gitlab"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 w-40 font-mono"
        />
      ) : null}
    </div>
  )
}

/**
 * One repository: its address, whether it is private, and - folded, for whoever needs them -
 * the token it is cloned with when not the GitHub one, and where it lands.
 *
 * "Private" is the GitHub token, which is what a private repository almost always wants; the
 * picker under Options keeps every other name reachable. Where is offered from the second
 * repository on: the first one is the profile's own, cloned where the profile works, and the
 * server refuses a place for it (checkedSpec in src/profiles.ts).
 */
function RepoEditor({
  index,
  repo,
  names,
  grouped,
  disabled,
  onChange,
  onRemove,
}: {
  index: number
  repo: ProfileRepo
  names: string[]
  /** Several repositories: each in its own ring, and each removable. */
  grouped: boolean
  disabled: boolean
  onChange: (next: ProfileRepo) => void
  onRemove: () => void
}) {
  const problem = urlProblem(repo.url)
  const filled = repo.url.trim() !== ""
  const placed = index > 0
  const custom = repo.secret !== null && repo.secret !== "github"
  // github.com, or not yet an address: the GitHub token is the obvious one, and the switch
  // says it. Anywhere else the token has to be named, since `github` would open nothing there.
  const onGithub = !filled || hostOf(repo.url) === "github.com"
  const [otherToken, setOtherToken] = React.useState(custom)
  const [elsewhere, setElsewhere] = React.useState(repo.dir !== null)
  const picking = repo.secret !== null && (!onGithub || custom || otherToken)
  const offerToken = repo.secret !== null && !picking
  const offerPlace = placed && !elsewhere
  return (
    <div className={cn(grouped && "rounded-xl p-3 ring-1 ring-foreground/10")}>
      <div className="flex items-center gap-2">
        <Label htmlFor={`repo-${index}`} className="sr-only">
          Repository address
        </Label>
        <Input
          id={`repo-${index}`}
          value={repo.url}
          onChange={(event) => onChange({ ...repo, url: event.target.value })}
          placeholder={index === 0 ? "https://github.com/me/app" : "https://github.com/me/lib"}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={problem !== null || undefined}
          className="h-12 min-w-0 flex-1 font-mono text-base"
        />
        {grouped ? (
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-11 shrink-0"
            aria-label="Remove this repository"
            onClick={onRemove}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      {problem === null ? null : <p className="mt-1.5 text-sm text-destructive">{problem}</p>}
      {filled ? (
        <label className="mt-1 flex min-h-11 cursor-pointer items-center justify-between gap-3">
          <span className="text-sm">
            Private repository
            {repo.secret !== null && !picking ? (
              <span className="block text-xs text-muted-foreground">
                Cloned with your GitHub token.
              </span>
            ) : null}
          </span>
          <Switch
            checked={repo.secret !== null}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({
                ...repo,
                // Named after the host off GitHub - `gitlab` for gitlab.com - so the picker opens
                // on a name that means something there rather than on `github`, which opens nothing.
                secret: checked ? (onGithub ? "github" : hostToken(repo.url)) : null,
              })
            }
          />
        </label>
      ) : null}
      {filled && picking ? (
        <div className="mt-2 space-y-1.5">
          <Label htmlFor={`repo-secret-${index}`} className="text-xs text-muted-foreground">
            {onGithub ? "Token" : "Token for this host"}
          </Label>
          <CredentialPicker
            id={`repo-secret-${index}`}
            value={repo.secret ?? "github"}
            names={names}
            allowPublic={false}
            onChange={(secret) => onChange({ ...repo, secret })}
          />
        </div>
      ) : null}
      {/* Two rare cases, one link each, rather than a fold of options on every repository: a
          GitHub repository of another organisation, which a fine-grained token scoped to one
          owner cannot read, and a second checkout wanted outside /workspace/<name>. Since
          25/09; the fold held a token picker that, on github.com, only ever repeated the
          token the GitHub CLI already signs in with. */}
      {filled && (offerToken || offerPlace) ? (
        <div className="flex flex-wrap gap-x-5">
          {offerToken ? (
            <button
              type="button"
              onClick={() => setOtherToken(true)}
              className="inline-flex min-h-11 items-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Use another token
            </button>
          ) : null}
          {offerPlace ? (
            <button
              type="button"
              onClick={() => setElsewhere(true)}
              className="inline-flex min-h-11 items-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Clone into another folder
            </button>
          ) : null}
        </div>
      ) : null}
      {filled && placed && elsewhere ? (
        <div className="mt-3 space-y-1.5">
          <Label htmlFor={`repo-dir-${index}`} className="text-xs text-muted-foreground">
            Folder
          </Label>
          <Input
            id={`repo-dir-${index}`}
            value={repo.dir ?? ""}
            onChange={(event) =>
              onChange({ ...repo, dir: event.target.value === "" ? null : event.target.value })
            }
            placeholder={`/workspace/${repoName(repo.url) || "lib"}`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-11 font-mono"
          />
        </div>
      ) : null}
    </div>
  )
}

/** The host of an address, or "" for one that is not an address yet. */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).hostname
  } catch {
    return ""
  }
}

/** A token name for a host: `gitlab` for gitlab.com, `git-acme` for git.acme.io. */
function hostToken(url: string): string {
  const labels = hostOf(url).replace(/^www\./, "").split(".").slice(0, -1)
  const name = labels.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "")
  return name === "" ? "git" : name
}

/** `app` for https://github.com/me/app.git: the folder a clone lands in by default. */
function repoName(url: string): string {
  return url.trim().replace(/\/+$/, "").split("/").pop()?.replace(/\.git$/, "") ?? ""
}

/**
 * One token of the Tokens part: tapped, the panel that adds it; beside it, for a name added by
 * hand, the way to stop asking for it. Two controls side by side and never one inside the
 * other, as on /new.
 */
function TokenRow({
  name,
  label,
  set,
  onOpen,
  onRemove,
}: {
  name: string
  label: string | undefined
  set: boolean
  onOpen: () => void
  onRemove: (() => void) | undefined
}) {
  const press =
    "transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted"
  return (
    <li className="flex items-stretch">
      <button
        type="button"
        onClick={onOpen}
        className={cn("flex h-12 min-w-0 flex-1 items-center gap-3 px-3 text-left", press)}
      >
        <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">
          <SecretMark name={name} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {label ?? <span className="font-mono">{name}</span>}
        </span>
        <span
          className={cn(
            "shrink-0 text-xs",
            set ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
          )}
        >
          {set ? (
            <span className="inline-flex items-center gap-1">
              <CheckIcon aria-hidden className="size-3.5" />
              Added
            </span>
          ) : (
            "Add"
          )}
        </span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {onRemove === undefined ? null : (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Stop asking for ${name}`}
          className={cn(
            "flex w-12 shrink-0 items-center justify-center border-l border-border text-muted-foreground hover:text-foreground",
            press
          )}
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      )}
    </li>
  )
}

function AddSecret({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = React.useState("")
  const add = () => {
    const trimmed = name.trim()
    if (trimmed === "") return
    onAdd(trimmed)
    setName("")
  }
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1 space-y-1.5">
        <Label htmlFor="add-secret" className="text-xs text-muted-foreground">
          Token name
        </Label>
        <Input
          id="add-secret"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            add()
          }}
          placeholder="openai"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 font-mono"
        />
      </div>
      <Button variant="outline" size="lg" className="h-11" onClick={add}>
        <PlusIcon data-icon="inline-start" />
        Add
      </Button>
    </div>
  )
}

/**
 * The script, as the server would write it.
 *
 * Asked for only when it is opened: it is the answer to "what will this actually run", not
 * something to read on the way past. It is re-rendered whenever the form changes while it is
 * open, because a preview that lags behind the form is worse than none.
 */
function Preview({ spec, ready }: { spec: ProfileSpec; ready: boolean }) {
  const [open, setOpen] = React.useState(false)
  return (
    <div>
      <Button
        variant="outline"
        size="lg"
        className="h-11"
        disabled={!ready}
        onClick={() => setOpen((current) => !current)}
      >
        <FileCode2Icon data-icon="inline-start" />
        {open ? "Hide the script" : ready ? "Show the script" : "Name it to see the script"}
      </Button>
      {open && ready ? <Rendered spec={spec} /> : null}
    </div>
  )
}

function Rendered({ spec }: { spec: ProfileSpec }) {
  // Keyed on the spec itself: the preview follows what the form says, and useAsync drops a
  // result that arrives after the next one was asked for.
  const state = useAsync(() => api.previewProfile(spec), [JSON.stringify(spec)])
  if (state.status === "loading") return <Loading label="Rendering" />
  if (state.status === "failed") {
    return (
      <p className="mt-3 text-sm break-words text-destructive">{state.error}</p>
    )
  }
  return (
    <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
      {state.data.script}
    </pre>
  )
}

/**
 * Removing one, behind a dialog for the reason machine.tsx gives: on a phone, the gesture
 * that takes something away should cut off the rest of the screen.
 *
 * It takes away a form and a file, never a machine - but a machine seeded with this profile
 * could no longer be seeded again, which is why the server refuses while one is running and
 * names it.
 */
/**
 * This profile as a link: whoever opens it finds this form filled in, in their own account.
 *
 * The form as it stands, not the saved row: what is on screen is what the reader means to
 * share, and a link built from a row older than the page would send something they cannot
 * see. A link fills a form and saves nothing (lib/share.ts), so an unsaved field shared by
 * mistake costs the colleague one field to fix, not a profile.
 *
 * The link itself is not drawn: several hundred characters of base64 are not something anyone
 * reads, and a button that says what it copied is the whole of what it offers. Where the
 * clipboard is refused - an insecure origin, a browser that asks first - the link appears in a
 * field that selects itself, which is the fallback that always works.
 */
function Share({ spec }: { spec: ProfileSpec }) {
  const [copied, setCopied] = React.useState<"no" | "yes" | "refused">("no")
  const link = shareLink(spec, window.location.origin)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied("yes")
    } catch {
      setCopied("refused")
    }
  }

  return (
    <div className="mt-10">
      <p className={HEADING}>Share</p>
      <p className="mt-1 text-sm text-muted-foreground">
        A link that opens this form filled in, in the account of whoever opens it. It carries
        names, never a token: they set their own.
      </p>
      <Button
        variant="outline"
        size="lg"
        className="mt-3 h-12 w-full text-base"
        onClick={() => void copy()}
      >
        {copied === "yes" ? (
          <CheckIcon data-icon="inline-start" />
        ) : (
          <Link2Icon data-icon="inline-start" />
        )}
        {copied === "yes" ? "Link copied" : "Copy share link"}
      </Button>
      {copied === "refused" ? (
        <Input
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="Share link"
          className="mt-2 h-11 font-mono text-xs"
        />
      ) : null}
    </div>
  )
}

function Delete({ name }: { name: string }) {
  const navigate = useNavigate()
  const [failure, setFailure] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)

  const run = async () => {
    setSending(true)
    setFailure(null)
    try {
      await api.deleteProfile(name)
      navigate("/profiles")
    } catch (error) {
      setFailure(reason(error))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="mt-10">
      <Dialog>
        <DialogTrigger
          render={
            <Button variant="outline" size="lg" className="h-11 text-destructive" />
          }
        >
          <Trash2Icon data-icon="inline-start" />
          Delete this profile
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete <span className="font-mono">{name}</span>?
            </DialogTitle>
            <DialogDescription>
              No machine is touched, but one set up with this profile could not be set up
              again, and the service refuses while one is running.
            </DialogDescription>
          </DialogHeader>
          {failure === null ? null : (
            <p className="text-sm break-words text-destructive">{failure}</p>
          )}
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" size="lg" className="h-12 text-base" />}
            >
              Keep it
            </DialogClose>
            <Button
              variant="destructive"
              size="lg"
              className="h-12 text-base"
              disabled={sending}
              onClick={() => void run()}
            >
              {sending ? "…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** The anchor the address points at, decoded: `#token-github` is `token-github`. */
function aimedAt(hash: string): string {
  const raw = hash.replace(/^#/, "")
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
