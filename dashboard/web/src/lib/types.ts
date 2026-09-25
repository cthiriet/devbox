/**
 * The shapes the API renders, and nothing else.
 *
 * These are the same names as dashboard/src/engine.ts and cli/src/types.ts, deliberately:
 * three consumers of a single contract must not each invent their own vocabulary. If a
 * field moves, it moves in devbox-core first and the three files follow.
 *
 * What is added here compared with cli/src/types.ts is what the dashboard knows and a CLI
 * has no business knowing: the secrets this service does not hold (`missing_secrets`), and
 * the floors already resolved by the server (`floors`), because DEVBOX_MIN_* is an environment
 * variable of the server - a browser cannot read it, and a floor recomputed here would be a
 * floor that lies.
 */

/** One floor, and whether the profile asked for it or the template filled it in. */
export type Floor = { value: number; declared: boolean }

export type Floors = { cpu: Floor; ram: Floor; disk: Floor }

export type Profile = {
  name: string
  path: string
  repo: string | null
  secrets: string[]
  note: string | null
  min_cpu: number | null
  min_ram: number | null
  min_disk: number | null
  port: number | null
  /** Every port of `devbox-port:`, the app first. `port` is the first. */
  ports: number[]
  /** The declared secrets this service does not hold: this profile cannot leave. */
  missing_secrets: string[]
  /**
   * Written by hand, clones from github.com, and declares no `github`: a private repository
   * will not clone. See engine.ts#DescribedProfile on the server.
   */
  clones_github_without_token: boolean
  floors: Floors
  /**
   * The form it was composed from, or null for a profile written by hand.
   *
   * It travels with the profile rather than on an address of its own, so the edit screen
   * draws the form from the same answer the list was drawn from - and so a row whose file
   * has been shadowed by a hand-written profile of the same name carries null, which is the
   * truth: what would run is not what that row says.
   */
  authored: ProfileSpec | null
  /**
   * In this account's own directory: composed here, or deposited by hand. False for one the
   * service publishes to every account. See engine.ts#DescribedProfile.
   */
  own: boolean
}

/* --- composing a profile ------------------------------------------------------------ */

/** One repository. `secret` null is public; `dir` is only ever set on an extra one. */
export type ProfileRepo = {
  url: string
  secret: string | null
  dir: string | null
}

/** Exactly what the form holds, and what the server stores: names, never values. */
export type ProfileSpec = {
  name: string
  note: string | null
  software: string[]
  /**
   * The optional secrets of the chosen software that the form turned on: declared, and then
   * required like any other name. One left off is not declared at all.
   */
  optional: string[]
  secrets: string[]
  repos: ProfileRepo[]
  /** A script of the first repository, relative to its root, run last as dev: run_setup. */
  setup: string | null
  cpu: number | null
  ram: number | null
  disk: number | null
  /** Where the machine's app listens, the main one first: one ssh forward each. */
  ports: number[]
}

/** A secret an entry of the catalogue wants, as the catalogue declares it. */
export type SoftwareSecret = {
  name: string
  /** False for one the machine is useful without: the page says so rather than insisting. */
  required: boolean
  label: string
  help: string
}

/**
 * A profile secret told to someone who has never met its name. Keyed by name, served by the
 * catalogue: see src/software.ts#SECRET_GUIDES. `steps` mark commands between backticks.
 * `prefixes` and `mistakes` feed a warning under the field, never a refusal.
 */
export type SecretGuide = {
  name: string
  label: string
  purpose: string
  steps: string[]
  link: { href: string; text: string } | null
  prefixes: string[]
  mistakes: { prefix: string; says: string }[]
}

/** `GET /api/software`: what a profile can install, and every secret by name. */
export type Catalogue = { software: Software[]; secrets: SecretGuide[] }

/** One thing a composed profile can install. `install` names prelude.sh functions. */
export type Software = {
  id: string
  label: string
  note: string
  secrets: SoftwareSecret[]
  needs: string[]
  step: string
  install: string[]
  afterRepos: boolean
}

/**
 * What a save or a preview answers: the spec as it is now held, the script it renders into,
 * and the two lists the page shows - everything the header declares, and what a seed cannot
 * start without.
 *
 * The script comes back from a SAVE as well as from a preview, deliberately: what the page
 * then shows is what was written, not what it believed it asked for.
 */
export type Composed = {
  name: string
  spec: ProfileSpec
  script: string
  declared: string[]
  required: string[]
  created_at: number | null
  updated_at: number | null
}

/** A creatable shape, as `probe --json` renders it: `table_json` in devbox-core. */
export type Offer = {
  hourly_eur: number
  cloud: string
  type: string
  location: string
  cpu: number
  ram_gb: number
  disk_gb: number
  cpu_class: string | null
  availability: string | null
}

export type Probe = {
  offers: Offer[]
  /** The `not asked:` block from stderr: a cloud without credentials, one line per cloud. */
  skipped: string[]
  floors: { cpu: number; ram: number; disk: number }
}

export type Machine = {
  name: string
  cloud: string
  region: string
  instance_type: string
  profile: string | null
  hourly_eur: number | null
  ip: string
  user: string
  port: number | null
  local_port: number
  app_port: number
  /**
   * Every port the profile forwards, the app first, and the forwards the server's ssh config
   * holds for them - local ports a phone may take as they are. Absent from an older engine.
   */
  app_ports?: number[]
  forwards?: { local: number; remote: number }[]
  /** When this dashboard ordered it. Null for one it never did. */
  ordered_at?: number | null
  /** A name a person gave it, displayed instead of the real one. Never an identity. */
  label?: string | null
}

export type MachineDetail = Machine & {
  fingerprint: string | null
  note: string | null
  kube_port: number
}

export type Orphan = {
  cloud: string
  name: string
  ip: string | null
  region: string
  created: string
}

export type JobState = "running" | "succeeded" | "failed" | "interrupted"

export type Job = {
  id: number
  verb: string
  machine: string | null
  cloud: string | null
  profile: string | null
  argv: string
  state: JobState
  exit_code: number | null
  started_at: number
  ended_at: number | null
}

/** A slice of log, read from an offset. `size` is the next offset. */
export type JobLog = {
  text: string
  size: number
  state: JobState
  exit_code: number | null
}

/** The executor actually deployed over there, named by its bytes. See engine.ts. */
export type Engine = {
  core: string | null
  built_at: string | null
  ready: boolean
}

/**
 * Who is signed in. Id 1 is the founding account - founded by the sign-in whose verified address is
 * DEVBOX_FOUNDER_EMAIL, or before 15/09 the one that claimed the service or first signed up - and
 * the one whose cloud accounts are the service's, where an extension shares them.
 */
export type Account = { id: number; email: string }

/** The providers a service signs in with. */
export type Provider = "google" | "github"

/**
 * The ways in, as the server decides them.
 *
 * `providers`: the buttons the login page draws, in the server's order. `claim`: the service has
 * never had an account and names its founder, so the next sign-in with that verified address
 * founds account 1 and every other is refused - the page says so above the buttons.
 */
export type Doors = { claim: boolean; providers: Provider[] }

/**
 * "Who am I": the one route that never answers 401.
 *
 * `disabled` is filled in when no session can be opened at all - no sign-in provider configured,
 * or no account yet and no founder named - and the login screen has to say so rather than draw
 * buttons that lead nowhere.
 *
 * `clouds`, `configured`, `missing` and `secrets_dir` are the signed-in ACCOUNT's, and an
 * anonymous session carries none of it (`[]`, null, `[]`, null): answered to anyone, they told
 * the Internet which credentials the first account held. null means "not asked", never
 * "incomplete" - a page testing `!configured` would call every visitor's service broken.
 */
export type Session = {
  authenticated: boolean
  csrf: string
  account: Account | null
  doors: Doors
  clouds: string[]
  configured: boolean | null
  missing: string[]
  secrets_dir: string | null
  engine: Engine
  disabled: string | null
}

/** A CLI token as its list shows it: a label and two dates, never the token. */
export type ApiToken = {
  id: number
  label: string
  created_at: number
  used_at: number | null
}

/** The one answer that carries the token itself. Nothing asks for it again. */
export type CreatedToken = {
  id: number
  label: string
  created_at: number
  token: string
}

export type Created = { job: number; machine: string; redirect: string }
export type Started = { job: number; redirect: string }

/**
 * Where the value the NEXT job will use comes from.
 *
 * `db` is the vault, and the only source with a fingerprint: it is the one this service
 * wrote itself. `env` and `file` are the historical fallback - the service's environment and
 * the secrets directory - which the vault shadows, name for name, as soon as it holds one.
 * `service` is the service's cloud account answering for an account that connected none of
 * its own: never with a fingerprint or a date, which are the founder's.
 */
export type SecretSource = "db" | "env" | "file" | "service"

/**
 * One credential a cloud's Terraform root signs in with. Never a value: a name, a place, a
 * fingerprint. `set` is the presence and `source` the place, so an empty file reads as
 * `set: false` rather than as a value that exists.
 */
export type CloudField = {
  name: string
  label: string
  /** The GCP key is a JSON document on several lines: a text zone, not a line. */
  multiline: boolean
  required: boolean
  set: boolean
  source: SecretSource | null
  fingerprint: string | null
  /** Milliseconds, like `started_at` and `ordered_at`. Only the vault dates what it holds. */
  updated_at: number | null
}

/** `usable`: every required field is present, so the probe asks this cloud. */
export type CloudSecrets = {
  cloud: string
  usable: boolean
  /**
   * Whose provider account a machine on this cloud goes to: the account's own, the service's,
   * or none. `fields` describe the account's OWN credentials either way. Absent from a server
   * older than the field - read as own.
   */
  via?: "own" | "service" | null
  fields: CloudField[]
  /**
   * The live machines on this cloud. They are why an unusable cloud is more than a shorter
   * probe: destroying one needs the same credentials as ordering it, and the server refuses
   * (412) while they are missing. Absent from a server older than the field - read as none.
   */
  machines?: string[]
}

/**
 * A name some profile declares, or that the vault or the secrets directory holds.
 *
 * `used_by` empty is a secret nothing reads any more. `machines` are the live ones whose
 * profile declares it: they were seeded with whatever was there then, and keep it in
 * /run/secrets until the next seed.
 */
export type ProfileSecret = {
  name: string
  set: boolean
  source: Exclude<SecretSource, "env"> | null
  fingerprint: string | null
  updated_at: number | null
  used_by: string[]
  machines: string[]
}

/** Closed means DEVBOX_MASTER_KEY or its like: nothing can be written, jobs carry on. */
export type Vault = { available: true } | { available: false; reason: string }

export type Secrets = {
  vault: Vault
  clouds: CloudSecrets[]
  profile: ProfileSecret[]
}

export type SecretKind = "cloud" | "profile"

/** Non-null when a historical value takes over again once the vault's is gone. */
export type Forgotten = {
  deleted: true
  fallback: "env" | "file" | "service" | null
}

/**
 * `imported` as `kind/NAME`; `skipped` one line per value left out, `kind/NAME: why`, in the
 * server's own words - already in the vault, already the vault's business, unreadable.
 */
export type Imported = { imported: string[]; skipped: string[] }

/** What `PUT /api/clouds/:cloud` answers: the cloud as the list draws it, without its machines. */
export type CloudSaved = Omit<CloudSecrets, "machines">

/** A 200 either way: a refused credential is an answer, not a failure of the request. */
export type CloudTest =
  { ok: true; offers: number } | { ok: false; error: string }

/**
 * One checkout on a machine, counted by the machine itself: see src/unpushed.ts.
 *
 * `ahead: null` is a branch with no upstream - every commit on it lives on that disk alone -
 * and it is NOT zero. The dialog draws the two differently.
 */
export type Checkout = {
  dir: string
  branch: string
  changed: number
  ahead: number | null
}

/** What a machine holds, or why the question has no answer. A failure is an answer, not an error. */
export type Unpushed =
  | { known: true; checkouts: Checkout[] }
  | { known: false; why: string }
