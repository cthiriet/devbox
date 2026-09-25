import type { ProfileRepo, ProfileSpec } from "./types"

/**
 * A composed profile as a link: `/profiles/new#import=<spec>`, which opens the form filled in.
 *
 * WHAT TRAVELS is the spec and nothing else, which is why a profile can be shared at all: names
 * of software from the catalogue, repository URLs, names of secrets, floors, a setup path. No
 * value - the vault hands none back to anyone - so a colleague who opens the link sees the
 * tokens it needs in red on their own page and sets their own.
 *
 * IN THE FRAGMENT, not the query string, because a fragment is never sent to a server: the
 * names of a team's repositories do not land in the reverse proxy's access log, nor in this
 * service's. They still land in the browser's history and wherever the link is pasted, which
 * is what sharing a link means.
 *
 * AND OUT OF IT at once. The page stashes the spec in this tab's sessionStorage and strips the
 * fragment before the router renders anything, for the colleague who is not signed in yet -
 * the likely case. Left in the address, the fragment rode into `from` on the way to /login,
 * and `from` is a query parameter of `/api/auth/<provider>`: the spec would have reached the
 * server after all, then been dropped by returnPath() on the way back, landing the reader on
 * an empty form. sessionStorage survives the round trip to the provider in the same tab.
 *
 * A LINK FILLS THE FORM; IT NEVER SAVES. The profile it describes clones a repository and runs
 * its setup script as `dev`, with passwordless sudo and the reader's tokens beside it, so the
 * only gesture that makes it exist is the reader's own Save, under a banner that says so. The
 * server checks the spec then exactly as it checks a typed one (checkedSpec); what this module
 * checks is only the SHAPE, so a mangled link reads as "not a profile" rather than as a crash.
 */

const PREFIX = "#import="

/** This tab's copy, across the sign-in. The key names a purpose, not a value. */
const KEY = "devbox.shared-profile"

/** Several times any real spec: a guard against a pasted novel, not a policy. */
const MAX_ENCODED = 16 * 1024

/**
 * The spec taken off the address at load, for the rest of this page's life.
 *
 * Beside sessionStorage rather than instead of it: a private window can refuse storage, and the
 * link must still fill the form on the load it was opened with. It is the sign-in round trip
 * alone that needs the storage.
 */
let held: string | null = null

/** `https://…/profiles/new#import=…`, for a spec as the form holds it. */
export function shareLink(spec: ProfileSpec, origin: string): string {
  return `${origin}/profiles/new${PREFIX}${encode(spec)}`
}

/**
 * Moves a shared spec off the address and into this tab, before anything renders.
 *
 * Called once, at the top of main.tsx. Replacing the history entry rather than pushing one, so
 * Back does not return to an address carrying it.
 */
export function stashShared(): void {
  const { hash, pathname, search } = window.location
  if (!hash.startsWith(PREFIX)) return
  held = hash.slice(PREFIX.length)
  try {
    sessionStorage.setItem(KEY, held)
  } catch {
    // Storage refused: `held` still fills the form on this load, and a sign-in in between
    // will land on an empty one. Nothing better is available without sending it somewhere.
  }
  window.history.replaceState(window.history.state, "", pathname + search)
}

/** The shared spec, if one is waiting. Pure: safe in a state initializer. */
export function peekShared(): ProfileSpec | null {
  let raw = held
  if (raw === null) {
    try {
      raw = sessionStorage.getItem(KEY)
    } catch {
      raw = null
    }
  }
  return raw === null ? null : decode(raw)
}

/** Forgets it, once the form has taken it: a second visit to the page starts blank. */
export function clearShared(): void {
  held = null
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Nothing was stored, or nothing can be.
  }
}

/** UTF-8 JSON, base64url: a note may hold any character, and a URL may not. */
export function encode(spec: ProfileSpec): string {
  const bytes = new TextEncoder().encode(JSON.stringify(spec))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** The spec back, or null for anything that is not the shape of one. */
export function decode(raw: string): ProfileSpec | null {
  if (raw === "" || raw.length > MAX_ENCODED || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
  let parsed: unknown
  try {
    const binary = atob(raw.replace(/-/g, "+").replace(/_/g, "/"))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const body = parsed as Record<string, unknown>

  const name = typeof body.name === "string" ? body.name : ""
  const note = nullableString(body.note)
  const setup = nullableString(body.setup)
  const software = strings(body.software)
  // Absent is "all switched on" on the server (checkedSpec), for a row older than the field;
  // a link has no such history, and an absent field is an empty one.
  const optional = strings(body.optional)
  const secrets = strings(body.secrets)
  const repos = Array.isArray(body.repos) ? body.repos.map(repo) : []
  const cpu = nullableNumber(body.cpu)
  const ram = nullableNumber(body.ram)
  const disk = nullableNumber(body.disk)
  // `ports` since 24/09; a link made before carries `port`, one number or null.
  const legacy = nullableNumber(body.port)
  const ports =
    body.ports !== undefined
      ? numbers(body.ports)
      : legacy === undefined
        ? null
        : legacy === null
          ? []
          : [legacy]

  if (
    note === undefined || setup === undefined || software === null || optional === null ||
    secrets === null || repos.some((one) => one === null) || cpu === undefined ||
    ram === undefined || disk === undefined || ports === null
  ) {
    return null
  }
  return {
    name,
    note,
    software,
    optional,
    secrets,
    repos: repos as ProfileRepo[],
    setup,
    cpu,
    ram,
    disk,
    ports,
  }
}

/** A string, null, or undefined for anything else: absent reads as null. */
function nullableString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  return typeof value === "string" ? value : undefined
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** A list of numbers, null for anything else. */
function numbers(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  return value.every((one) => typeof one === "number" && Number.isFinite(one))
    ? (value as number[])
    : null
}

/** A list of strings, an empty one for an absent field, null for anything else. */
function strings(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((one) => typeof one === "string")) return null
  return value as string[]
}

function repo(value: unknown): ProfileRepo | null {
  if (typeof value !== "object" || value === null) return null
  const body = value as Record<string, unknown>
  const secret = nullableString(body.secret)
  const dir = nullableString(body.dir)
  if (typeof body.url !== "string" || secret === undefined || dir === undefined) return null
  return { url: body.url, secret, dir }
}
