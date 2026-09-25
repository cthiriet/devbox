import type {
  ApiToken,
  CreatedToken,
  Catalogue,
  CloudSaved,
  CloudTest,
  Created,
  Forgotten,
  Imported,
  Job,
  JobLog,
  Machine,
  MachineDetail,
  Orphan,
  Composed,
  Probe,
  Profile,
  ProfileSpec,
  ProfileSecret,
  SecretKind,
  Secrets,
  Session,
  Started,
  Unpushed,
} from "@/lib/types"

/**
 * The only place in this application that talks to the server.
 *
 * There are three things a component must not have to remember, and they are precisely the
 * ones forgotten one time in five: attaching the anti-CSRF token to a write, reading the
 * server's error message rather than displaying "400", and knowing that a 401 does not mean
 * "error" but "the session is over, go back to the login screen". The old page handled them
 * in public/main.js, once, for three forms; a SPA has twenty-odd such calls, and the
 * twentieth is the one that would have been forgotten.
 *
 * The token is kept in memory, never in localStorage: it accompanies a session cookie the
 * browser already holds, and an anti-CSRF token that outlives the closing of the tab
 * protects less well than one asked again of `GET /api/session`.
 */

let csrf = ""

/** What to do with a 401: that is the session provider's business, not the caller's. */
let expired: (() => void) | null = null

export function setCsrf(value: string): void {
  csrf = value
}

export function onExpired(handler: (() => void) | null): void {
  expired = handler
}

/**
 * A response the server refused, with its own text.
 *
 * `payload` is kept whole because two refusals carry more than their sentence: a 409 names
 * the job already running (`job`), which we want to offer to go and follow, and a 429 says
 * how many seconds to wait (`retry_after`).
 */
export class ApiError extends Error {
  readonly status: number
  readonly payload: Record<string, unknown>

  constructor(
    status: number,
    message: string,
    payload: Record<string, unknown>
  ) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.payload = payload
  }
}

/** The message to show, wherever it comes from: a refusal from the server or an absent network. */
export function reason(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * A refusal as a form shows it: the sentence, and the field it is about.
 *
 * A 429 says how many seconds to wait, and the number is repeated rather than turned into
 * "try again later": a number of seconds is actionable, "later" is not. A 400 may name the
 * field it refused (`field`), and that field is the one the form marks - on a phone the
 * sentence can be above the fold while the field is below it.
 */
export type Refusal = { text: string; field: string | null }

export function refusal(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return { text: reason(error), field: null }
  const wait = error.payload.retry_after
  const text =
    error.status === 429 && typeof wait === "number"
      ? `Too many attempts. Try again in ${wait} s.`
      : error.message
  const field =
    error.status === 400 && typeof error.payload.field === "string"
      ? error.payload.field
      : null
  return { text, field }
}

/**
 * No call here OPENS a session any more: since 15/09 a session is opened by the server, at the
 * end of a Google or GitHub sign-in the browser navigates through, and read back with
 * `GET /api/session`. So every 401 means one thing - the session is over - and there is no
 * call left for which it would be the server refusing what was typed.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
      // The session cookie is `__Host-`: same origin, always.
      credentials: "same-origin",
    })
  } catch {
    // A train going through a tunnel, and nothing else. Said as such, because a "failure"
    // with no cause sends people looking for the fault on the server's side.
    throw new ApiError(0, "No network, or the service is not answering.", {})
  }

  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >

  if (response.status === 401) {
    // Neither an error to display nor an exception to swallow: the session is over, and
    // the login screen is the only possible sequel.
    expired?.()
    throw new ApiError(401, "Session over.", payload)
  }

  if (!response.ok) {
    const said =
      typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`
    throw new ApiError(response.status, said, payload)
  }

  return payload as T
}

/**
 * A write: never without the anti-CSRF token, which the server demands and checks.
 *
 * Whatever the verb. The vault brought the first PUT and DELETE into this client, and a
 * token attached by `post` alone would have been the twentieth call forgetting it.
 */
function write<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  return request<T>(path, {
    method,
    headers:
      body === undefined
        ? { "X-CSRF": csrf }
        : { "Content-Type": "application/json", "X-CSRF": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function post<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  return write<T>("POST", path, body)
}

/** The floors passed to the probe. See lib/floors.ts for which ones we pass, and why. */
export type ProbeQuery = {
  cpu?: number
  ram?: number
  disk?: number
  cloud?: string
}

export const api = {
  session: () => request<Session>("/api/session"),

  logout: () => post<{ redirect: string }>("/api/logout"),

  /** Every session of the account, the one making the call included. */
  closeSessions: () => post<{ ok: true }>("/api/account/sessions/close"),

  tokens: () => request<ApiToken[]>("/api/account/tokens"),

  /** The token is in this answer and in no other: nothing can ask for it again. */
  createToken: (label: string) =>
    post<CreatedToken>("/api/account/tokens", { label }),

  revokeToken: (id: number) =>
    write<{ ok: true }>("DELETE", `/api/account/tokens/${id}`),

  machines: () => request<Machine[]>("/api/machines"),

  machine: (name: string) =>
    request<MachineDetail>(`/api/machines/${encodeURIComponent(name)}`),

  profiles: () => request<Profile[]>("/api/profiles"),

  /**
   * What a composed profile can install, what each entry demands in exchange, and every
   * secret by name. Read through hooks/use-catalogue.ts, which asks once per page load.
   */
  software: () => request<Catalogue>("/api/software"),

  /**
   * The script a spec would render into, writing nothing.
   *
   * Rendered by the server and never here: a preview drawn in the browser would be a second
   * renderer, and on the day the two disagreed the reassuring one would be the wrong one.
   */
  previewProfile: (spec: ProfileSpec) =>
    write<Composed>("POST", "/api/profiles/preview", spec),

  saveProfile: (spec: ProfileSpec) =>
    write<Composed>(
      "PUT",
      `/api/profiles/${encodeURIComponent(spec.name)}`,
      spec
    ),

  /** Refused with a 412, naming them, while a live machine still runs it. */
  deleteProfile: (name: string) =>
    write<{ deleted: boolean; removed: boolean }>(
      "DELETE",
      `/api/profiles/${encodeURIComponent(name)}`
    ),

  probe: (query: ProbeQuery = {}) => {
    const search = new URLSearchParams()
    if (query.cpu !== undefined) search.set("cpu", String(query.cpu))
    if (query.ram !== undefined) search.set("ram", String(query.ram))
    if (query.disk !== undefined) search.set("disk", String(query.disk))
    if (query.cloud !== undefined) search.set("cloud", query.cloud)
    const written = search.toString()
    return request<Probe>(
      written === "" ? "/api/probe" : `/api/probe?${written}`
    )
  },

  orphans: () => request<Orphan[]>("/api/orphans"),

  jobs: () => request<Job[]>("/api/jobs"),

  job: (id: number) => request<Job>(`/api/jobs/${id}`),

  log: (id: number, offset: number) =>
    request<JobLog>(`/api/jobs/${id}/log?offset=${offset}`),

  /**
   * The order. The shape is pinned by its `type`, never by its price: the price is what it
   * costs today, the shape is what was chosen. The server goes back through the probe, so
   * an offer that ran out between the screen and the order is refused before anything at
   * all is created.
   *
   * No place: devbox-core tries every place that sells the type, cheapest first, and falls
   * through to the next when one is out of stock at apply. `disk` only when the reader raised
   * it: on Scaleway and GCP the disk is asked for at the order (lib/clouds.ts#DISK_ASKED), and
   * a list probed at 160 GB must not create the profile's 40.
   */
  create: (input: {
    profile: string
    cloud: string
    type: string
    disk?: number
    name?: string
  }) => post<Created>("/api/machines", input),

  label: (name: string, label: string) =>
    post<{ label: string | null }>(
      `/api/machines/${encodeURIComponent(name)}/label`,
      { label }
    ),

  seed: (name: string, profile?: string) =>
    post<Started>(
      `/api/machines/${encodeURIComponent(name)}/seed`,
      profile === undefined ? {} : { profile }
    ),

  /**
   * What the machine is holding that nowhere else has, asked when the destroy dialog opens.
   *
   * A POST for a read: it opens an SSH connection with this account's key, and the server
   * guards it like the destroy it stands in front of. It can take a few seconds against a
   * large checkout, and it answers `known: false` with a reason rather than throwing - the
   * dialog has to draw something either way.
   */
  unpushed: (name: string) =>
    post<Unpushed>(`/api/machines/${encodeURIComponent(name)}/unpushed`, {}),

  destroy: (name: string, confirm: string) =>
    post<Started>(`/api/machines/${encodeURIComponent(name)}/destroy`, {
      confirm,
    }),

  /** Names, places and fingerprints: never a value. See screens/secrets.tsx. */
  secrets: () => request<Secrets>("/api/secrets"),

  /**
   * A cloud's credentials, saved together or not at all: one PUT per field left a Scaleway
   * pair half written when the second was refused. The answer is the cloud as the vault now
   * holds it - fingerprints and dates, nothing of what was sent.
   */
  saveCloud: (cloud: string, values: Record<string, string>) =>
    write<CloudSaved>("PUT", `/api/clouds/${encodeURIComponent(cloud)}`, {
      values,
    }),

  setProfileSecret: (name: string, value: string) =>
    write<ProfileSecret>(
      "PUT",
      `/api/secrets/profile/${encodeURIComponent(name)}`,
      { value }
    ),

  /** Out of the vault. `fallback` says what the next job reads instead, if anything. */
  forgetSecret: (kind: SecretKind, name: string) =>
    write<Forgotten>(
      "DELETE",
      `/api/secrets/${kind}/${encodeURIComponent(name)}`
    ),

  /** The files and the environment, copied once. Nothing already held is overwritten. */
  importSecrets: () => post<Imported>("/api/secrets/import"),

  /**
   * Whether a cloud accepts these credentials, writing nothing. A field left out of `values`
   * is taken from wherever the next job would take it, so one replaced token can be tried
   * against the rest as they stand.
   */
  testCloud: (cloud: string, values: Record<string, string>) =>
    post<CloudTest>(`/api/clouds/${encodeURIComponent(cloud)}/test`, {
      values,
    }),
}
