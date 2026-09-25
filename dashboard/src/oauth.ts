/**
 * Signing in with Google or GitHub: the two providers, PKCE, the state cookie's contents, the
 * path a sign-in returns to, and the two exchanges of a code for an identity. Decides nothing
 * about accounts - which account an identity opens is admission() in src/accounts.ts and
 * signInWith() in src/db.ts - and opens no session: server.ts does, in one place.
 *
 * NO DEPENDENCY, and not out of thrift. What an OAuth library would bring is discovery documents,
 * JWKS fetching and a provider list, and each of those is a URL decided at run time: the one rule
 * this file keeps is that every address a code, a verifier or a client secret is sent to is a
 * constant written below. Same rule, and same reason, as the GCP key's `token_uri` on 02/09: a
 * value that names where the server posts is a value that makes the server post elsewhere.
 *
 * A flow, as server.ts runs it on 15/09:
 *
 *   GET /api/auth/:provider           a state and a verifier drawn, both in a Lax cookie bound to
 *                                     this browser, and a 302 to the provider's fixed address
 *   GET /api/auth/:provider/callback  the cookie's state against the query's, the code exchanged
 *                                     with the verifier and the client secret, the identity
 *                                     handed to signInWith, and a 303 to where the sign-in began
 *
 * The provider's access token is dropped as soon as the identity is read: never stored, never
 * logged. What a refusal says to the journal names the provider, the step and an HTTP status or a
 * provider's short error code - never the code, a token, a verifier or an address.
 */
import { foldedEmail } from "./accounts";
import { newToken } from "./sessions";

export const PROVIDERS = ["google", "github"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const isProvider = (value: unknown): value is Provider => PROVIDERS.includes(value as Provider);

/** How a sentence names a provider: the journal's lines and the login page's buttons. */
export const PROVIDER_NAMES: Record<Provider, string> = { google: "Google", github: "GitHub" };

/**
 * Every address this file sends anything to, and there is no other. Not configurable, not even
 * for a test: tests/fixtures/oauth-providers.ts answers these very URLs inside the test's server,
 * which is how a flow is exercised without an environment variable able to redirect one.
 */
export const PROVIDER_URLS = {
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
  },
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    user: "https://api.github.com/user",
    emails: "https://api.github.com/user/emails",
  },
} as const;

/** The service's environment, per provider. Taken once per process by takeProviders. */
export const PROVIDER_VARIABLES = {
  google: { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  github: { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
} as const satisfies Record<Provider, { id: string; secret: string }>;

/**
 * Why a sign-in did not open a session, as the login page reads it in `?refused=`: a fixed
 * vocabulary the page maps to its own sentences, so that nothing a provider or a request wrote
 * ever lands in an address bar - no provider text, and no address.
 */
export const REFUSALS = [
  "unavailable",
  "state",
  "denied",
  "provider",
  "unverified",
  "address",
  "unvouched",
  "unfounded",
  "busy",
  "failed",
] as const;
export type Refusal = (typeof REFUSALS)[number];

/* --- the clients ----------------------------------------------------------- */

type Client = { readonly provider: Provider; readonly id: string };

type Held = { clients: Partial<Record<Provider, Client>>; secrets: WeakMap<Client, string> };

/**
 * ONE PER PROCESS, on globalThis, for the reason the vault's material is (src/vault.ts): `bun
 * --hot` evaluates this module again at every save, while the variables were deleted from
 * process.env at the first evaluation. Read again at a reload they would be gone, and the
 * dashboard under `bun run dev` would lose its sign-in at the first file saved. The secrets sit
 * in a WeakMap keyed by a client, whose entries neither `JSON.stringify` nor `console.log` walks.
 */
const SLOT = Symbol.for("devbox.dashboard.oauth");
const held = globalThis as { [SLOT]?: Held };

export type Taken = {
  offered: Provider[];
  /** A provider with one of its two variables set: not offered, and said at startup. */
  halfSet: { provider: Provider; set: string; unset: string }[];
};

/**
 * The four variables, read once and removed from `env` whatever happens - in a `finally`, so a
 * throw halfway leaves no client secret behind for engineEnv to hand a child. server.ts calls this
 * in its first evaluation, right after the vault, before anything can spawn one. engineEnv
 * withholds the four names as well, in case anything ever sets them back.
 *
 * A provider is offered only when both its values are non-empty: an id alone would draw a button
 * whose every callback fails at the exchange, which is a riddle on a phone and a line here.
 */
export function takeProviders(env: Record<string, string | undefined> = process.env): Taken {
  const clients: Held["clients"] = {};
  const secrets = new WeakMap<Client, string>();
  const halfSet: Taken["halfSet"] = [];
  try {
    for (const provider of PROVIDERS) {
      const names = PROVIDER_VARIABLES[provider];
      const id = env[names.id] ?? "";
      const secret = env[names.secret] ?? "";
      const hasId = id.trim() !== "";
      const hasSecret = secret.trim() !== "";
      if (hasId && hasSecret) {
        const client: Client = { provider, id };
        clients[provider] = client;
        secrets.set(client, secret);
      } else if (hasId || hasSecret) {
        halfSet.push({
          provider,
          set: hasId ? names.id : names.secret,
          unset: hasId ? names.secret : names.id,
        });
      }
    }
  } finally {
    for (const provider of PROVIDERS) {
      delete env[PROVIDER_VARIABLES[provider].id];
      delete env[PROVIDER_VARIABLES[provider].secret];
    }
  }
  held[SLOT] = { clients, secrets };
  return { offered: offeredProviders(), halfSet };
}

/** The providers this process can sign in with, in a fixed order: Google, then GitHub. */
export function offeredProviders(): Provider[] {
  const clients = held[SLOT]?.clients ?? {};
  return PROVIDERS.filter((provider) => clients[provider] !== undefined);
}

/** A provider's id and secret, for the exchange alone. Null when it is not offered. */
function clientOf(provider: Provider): { id: string; secret: string } | null {
  const slot = held[SLOT];
  const client = slot?.clients[provider];
  const secret = client === undefined ? undefined : slot?.secrets.get(client);
  return client === undefined || secret === undefined ? null : { id: client.id, secret };
}

/* --- PKCE and encodings ------------------------------------------------------ */

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Throws on anything that is not base64url: every caller catches it as a malformed input. */
function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("not base64url");
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** RFC 7636's S256: base64url of the SHA-256 of the verifier's ASCII. */
export async function challengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

/**
 * A verifier and its challenge. newToken's 43 base64url characters are a valid verifier as they
 * are - RFC 7636 asks 43 to 128 of [A-Za-z0-9-._~] - and carry its 256 bits.
 *
 * PKCE on top of the client secret, and not instead of it: the secret proves the exchange is this
 * service's, the verifier that the code is the one this browser's flow asked for. A code lifted
 * from a history, a log or a Referer is worth nothing without the cookie that holds the verifier.
 */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = newToken();
  return { verifier, challenge: await challengeOf(verifier) };
}

export const callbackUrl = (provider: Provider, publicUrl: string) => `${publicUrl}/api/auth/${provider}/callback`;

/**
 * Where a sign-in starts, or null for a provider this process does not offer. Built with
 * URLSearchParams, and carries the client id and never its secret.
 *
 * `scope`: an address and nothing else. Google's `openid email` is the non-sensitive pair; GitHub's
 * `user:email` is the one scope that lists verified addresses, `/user` alone showing only a public
 * one, if any. `prompt=select_account` because a phone signed into two Google accounts would
 * otherwise enter with whichever answered last.
 */
export function authorizationUrl(
  provider: Provider,
  input: { publicUrl: string; state: string; challenge: string },
): string | null {
  const client = held[SLOT]?.clients[provider];
  if (client === undefined) return null;
  const common = {
    client_id: client.id,
    redirect_uri: callbackUrl(provider, input.publicUrl),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  };
  const params =
    provider === "google"
      ? new URLSearchParams({ ...common, response_type: "code", scope: "openid email", prompt: "select_account" })
      : new URLSearchParams({ ...common, scope: "user:email" });
  return `${PROVIDER_URLS[provider].authorize}?${params.toString()}`;
}

/* --- the state cookie ---------------------------------------------------------- */

/** What the state cookie carries for one flow: set at the start, read once at the callback. */
export type FlowState = { provider: Provider; state: string; verifier: string; from: string };

const DRAWN = /^[A-Za-z0-9_-]{43}$/;

/**
 * `<provider>.<state>.<verifier>.<base64url(from)>`: dots never occur in base64url, and nothing
 * in it needs quoting in a cookie.
 *
 * A cookie and not this process's memory, because a flow outlives either: a deployment restarting
 * while someone is on the provider's consent screen, or a save under `bun --hot`, would otherwise
 * turn every sign-in in flight into a `state` refusal. The cookie is HttpOnly and Lax and lives ten
 * minutes (stateCookieAttributes in src/sessions.ts): the verifier in it is only worth something
 * with a code this same browser was sent back with.
 */
export function encodeState(flow: FlowState): string {
  return [flow.provider, flow.state, flow.verifier, base64url(encoder.encode(flow.from))].join(".");
}

/** Null for anything this file did not write: a missing part, a provider, a drawn value, a path. */
export function parseState(value: string | null | undefined): FlowState | null {
  if (typeof value !== "string" || value.length > 2 * RETURN_MAX + 128) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [provider, state = "", verifier = "", from = ""] = parts;
  if (!isProvider(provider) || !DRAWN.test(state) || !DRAWN.test(verifier)) return null;
  let path: string;
  try {
    path = utf8(fromBase64url(from));
  } catch {
    return null;
  }
  // Through returnPath again, and not trusted for having been written here: the check is cheap,
  // and a rule held in one direction only is a rule the next change drops.
  return { provider, state, verifier, from: returnPath(path) };
}

/* --- where a sign-in returns ------------------------------------------------------ */

export const RETURN_MAX = 512;

const CONTROL = /\p{Cc}/u;
const RETURN_BASE = "http://return.invalid";

const leavesNoOrigin = (path: string) => path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");

/**
 * The path a sign-in goes back to, or `/`. It becomes a `Location` header, so what it must never
 * be is an address of another origin: `//host` and `/\host` are both read by a browser as one,
 * and an open redirect on the page that has just opened a session is a phishing kit.
 *
 * Checked as given, then NORMALISED through URL and checked again, and the second pass is not
 * redundancy. Measured on Bun 1.3.11 on 15/09: `/..//evil.example` resolves to the path
 * `//evil.example`, which a check on the raw string passes; and a header value holding a character
 * beyond Latin-1 throws where the answer is built. The normalised form is percent-encoded and is
 * what is returned. `?` and `#` are kept - `/secrets#secret-github` is an address whose fragment is
 * the destination. `/login` goes to `/`: returning to the sign-in page after signing in is a loop.
 */
export function returnPath(from: unknown): string {
  if (typeof from !== "string" || from === "" || from.length > RETURN_MAX) return "/";
  if (CONTROL.test(from) || !leavesNoOrigin(from)) return "/";
  let url: URL;
  try {
    url = new URL(from, RETURN_BASE);
  } catch {
    return "/";
  }
  if (url.origin !== RETURN_BASE) return "/";
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (path.length > RETURN_MAX || !leavesNoOrigin(path)) return "/";
  if (url.pathname.replace(/\/+$/, "") === "/login") return "/";
  return path;
}

/* --- the exchanges ------------------------------------------------------------- */

/** RFC 7519 leaves `sub` unbounded; a row does not have to be. Google's are 21 digits. */
export const SUBJECT_MAX = 255;

/** A code, as long as a sane provider draws one. Google's are about 70 characters, GitHub's 20. */
export const CODE_MAX = 2048;

/**
 * An address a provider says it verified, and whether the provider is AUTHORITATIVE for it: whether
 * its verification says who holds the mailbox today, or only that someone once proved they did.
 */
export type VerifiedEmail = { email: string; authoritative: boolean };

/**
 * An identity as a provider vouched for it: the stable subject, and the addresses it says it
 * verified, in the order they are to be tried. The addresses are not checked here - server.ts runs
 * each through checkedEmail - and not folded.
 */
export type Exchanged =
  | { ok: true; subject: string; emails: VerifiedEmail[] }
  | { ok: false; refused: "unavailable" | "provider" | "unverified"; reason: string };

type Failed = Extract<Exchanged, { ok: false }>;

const refuse = (refused: Failed["refused"], reason: string): Failed => ({ ok: false, refused, reason });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Google's answer to the code, read.
 *
 * THE ID TOKEN'S SIGNATURE IS NOT CHECKED, and that is OpenID Connect Core 1.0, 3.1.3.7, item 6:
 * a token received directly from the token endpoint, over TLS, in answer to a request this server
 * authenticated with its client secret, may be validated by that TLS connection in place of its
 * signature. Checking it would mean fetching Google's keys from a URL at run time and caching
 * them - a dependency's worth of code, for a guarantee the connection already gave. What is still
 * checked is what TLS does not say: that the token is Google's (`iss`), for this client (`aud`,
 * `azp`), still current (`exp`), and names a subject.
 *
 * `email_verified` must be the boolean `true`. The string "true" is refused: a claim of the wrong
 * type is a claim nobody specified, and an address is the one thing an identity here is linked by.
 *
 * AND `true` IS NOT ALWAYS ENOUGH, which Google's own OpenID Connect documentation says: Google is
 * authoritative for an address only when it hosts it - a `@gmail.com` address, or an account of a
 * Google Workspace domain, which the `hd` claim names. Any other address was verified once, perhaps
 * when the Google account was created, on a mailbox that may have changed hands since: a former
 * employer's domain, a domain that lapsed and was bought again. Such an address is marked not
 * authoritative, and src/accounts.ts#admission and src/db.ts#signInOn refuse to let it link to an
 * account or found account 1 (15/09). GitHub's are all authoritative: GitHub re-verifies.
 */
export function googleIdentity(tokenJson: unknown, clientId: string, now: number): Exchanged {
  if (!isObject(tokenJson) || typeof tokenJson.id_token !== "string") {
    return refuse("provider", "the token endpoint answered no id_token");
  }
  const parts = tokenJson.id_token.split(".");
  if (parts.length !== 3) return refuse("provider", "the id_token is not a JWT");
  let claims: unknown;
  try {
    claims = JSON.parse(utf8(fromBase64url(parts[1] ?? "")));
  } catch {
    return refuse("provider", "the id_token's payload does not decode");
  }
  if (!isObject(claims)) return refuse("provider", "the id_token's payload is not an object");
  if (claims.iss !== "https://accounts.google.com" && claims.iss !== "accounts.google.com") {
    return refuse("provider", "the id_token was not issued by Google");
  }
  if (claims.aud !== clientId) return refuse("provider", "the id_token is for another client");
  if (claims.azp !== undefined && claims.azp !== clientId) {
    return refuse("provider", "the id_token was authorized for another client");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) {
    return refuse("provider", "the id_token has expired");
  }
  if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub.length > SUBJECT_MAX) {
    return refuse("provider", "the id_token names no subject");
  }
  if (typeof claims.email !== "string" || claims.email_verified !== true) {
    return refuse("unverified", "no verified address");
  }
  const authoritative = GMAIL.test(foldedEmail(claims.email)) || (typeof claims.hd === "string" && claims.hd !== "");
  return { ok: true, subject: claims.sub, emails: [{ email: claims.email, authoritative }] };
}

/** A Gmail address once folded, the one kind besides a Workspace account's that Google hosts. */
const GMAIL = /@gmail\.com$/;

const NOREPLY = /@users\.noreply\.github\.com$/i;

/**
 * GitHub's `/user/emails`, as candidates: verified ones only, the primary first, then GitHub's own
 * order. Null for an answer that is not a list at all.
 *
 * Every verified address and not only the primary, because the address an account was made with
 * may well be a secondary one today. A `@users.noreply.github.com` address never: it is verified
 * by construction, belongs to no mailbox, and would link nothing a person ever typed.
 */
export function githubCandidates(emails: unknown): string[] | null {
  if (!Array.isArray(emails)) return null;
  const verified = emails.filter(
    (one): one is { email: string; primary?: unknown } =>
      isObject(one) && typeof one.email === "string" && one.verified === true && !NOREPLY.test(one.email),
  );
  return [...verified.filter((one) => one.primary === true), ...verified.filter((one) => one.primary !== true)].map(
    (one) => one.email,
  );
}

export type ExchangeOptions = {
  /** Injected by tests/oauth.test.ts; the server's is the global one. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: number;
  timeoutMs?: number;
};

/**
 * Ten seconds per request. A provider that does not answer is a sign-in refused with a sentence,
 * and not a callback held open under the reverse proxy's own timeout.
 */
const TIMEOUT_MS = 10_000;

/** A provider's short error code, when it gave one that looks like a code: `invalid_grant`. */
function codeOf(json: unknown): string {
  return isObject(json) && typeof json.error === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(json.error)
    ? ` (${json.error})`
    : "";
}

/**
 * One request to a fixed address, and its JSON.
 *
 * `redirect: "error"`: a 307 or 308 from a token endpoint would replay the POST - client secret,
 * code and verifier - to wherever it pointed. No provider answers one, and a request that meets
 * one fails rather than follows. The reason names the step and a status or an error's class,
 * never its message, which for a network failure can quote what was sent.
 */
async function reach(
  step: string,
  url: string,
  init: RequestInit,
  options: ExchangeOptions,
): Promise<{ ok: true; json: unknown } | Failed> {
  const send = options.fetch ?? ((to: string, with_: RequestInit) => fetch(to, with_));
  let response: Response;
  let json: unknown = null;
  try {
    response = await send(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
    json = await response.json().catch(() => null);
  } catch (error) {
    return refuse("provider", `${step} could not be reached (${error instanceof Error ? error.name : "unknown"})`);
  }
  if (!response.ok) return refuse("provider", `${step} answered ${response.status}${codeOf(json)}`);
  if (json === null) return refuse("provider", `${step} answered no JSON`);
  return { ok: true, json };
}

/**
 * A code and its verifier, exchanged for an identity. The access token a provider answers with is
 * used for GitHub's two reads and then dropped with the function's frame: nothing keeps it.
 */
export async function exchange(
  provider: Provider,
  input: { code: string; verifier: string; publicUrl: string },
  options: ExchangeOptions = {},
): Promise<Exchanged> {
  const client = clientOf(provider);
  if (client === null) return refuse("unavailable", "not offered by this service");
  const now = options.now ?? Date.now();
  const form = new URLSearchParams({
    client_id: client.id,
    client_secret: client.secret,
    code: input.code,
    redirect_uri: callbackUrl(provider, input.publicUrl),
    code_verifier: input.verifier,
  });

  if (provider === "google") {
    form.set("grant_type", "authorization_code");
    const token = await reach(
      "the token endpoint",
      PROVIDER_URLS.google.token,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: form,
      },
      options,
    );
    return token.ok ? googleIdentity(token.json, client.id, now) : token;
  }

  // GitHub answers a refused code with a 200 and `{ error }`: the token's presence is the answer.
  const token = await reach(
    "the token endpoint",
    PROVIDER_URLS.github.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
    },
    options,
  );
  if (!token.ok) return token;
  const accessToken = isObject(token.json) ? token.json.access_token : undefined;
  if (typeof accessToken !== "string" || accessToken === "") {
    return refuse("provider", `the token endpoint answered no access_token${codeOf(token.json)}`);
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub's API refuses a request without one.
    "User-Agent": "devbox-dashboard",
  };
  const user = await reach("the user endpoint", PROVIDER_URLS.github.user, { headers }, options);
  if (!user.ok) return user;
  // The numeric id and never `login`, which a user renames and someone else may then take.
  const id = isObject(user.json) ? user.json.id : undefined;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    return refuse("provider", "the user endpoint answered no id");
  }

  const emails = await reach("the emails endpoint", PROVIDER_URLS.github.emails, { headers }, options);
  if (!emails.ok) return emails;
  const candidates = githubCandidates(emails.json);
  if (candidates === null) return refuse("provider", "the emails endpoint answered no list");
  if (candidates.length === 0) return refuse("unverified", "no verified address");
  return { ok: true, subject: String(id), emails: candidates.map((email) => ({ email, authoritative: true })) };
}
