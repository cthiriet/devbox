/**
 * Sessions and the anti-CSRF token. Decides and computes, opens no database.
 *
 * The CSRF token is not entrusted to `Bun.CSRF`: its documentation announces that a
 * `sessionId` binds the token to a session, but measured on Bun 1.3.11 it has no effect,
 * a token issued for one session being accepted for another. Ours is drawn at random and
 * stored in the session row.
 */

const encoder = new TextEncoder();

/** 32 bytes, which is 256 bits. */
export const TOKEN_BYTES = 32;

export type RandomSource = (bytes: number) => Uint8Array;

const defaultRandom: RandomSource = (bytes) => crypto.getRandomValues(new Uint8Array(bytes));

/** base64url: the token travels in a cookie. */
export function newToken(random: RandomSource = defaultRandom): string {
  const bytes = random(TOKEN_BYTES);
  if (bytes.length < TOKEN_BYTES) {
    throw new Error(`randomness source too short: ${bytes.length} bytes`);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The database stores the digest only: a leaked backup must yield no usable session.
 */
export async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison. A `===` stops at the first differing character, which lets a
 * token be reconstructed one attempt at a time.
 */
export async function equalsInConstantTime(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.timingSafeEqual(new Uint8Array(ha), new Uint8Array(hb));
}

export type Session = {
  digest: string;
  /** The account it was opened for. */
  userId: number;
  csrf: string;
  createdAt: number;
  seenAt: number;
};

export function sessionAlive(session: Session, lifetimeMs: number, now: number): boolean {
  return now - session.createdAt < lifetimeMs;
}

/**
 * `__Host-` is enforced by the browser: it refuses the cookie unless it is Secure, on
 * Path=/ and without Domain. Over plain HTTP locally that would stop it being stored at
 * all, hence the parameter.
 */
export function cookieName(online: boolean): string {
  return online ? "__Host-session" : "session";
}

export type CookieAttributes = {
  name: string;
  value: string;
  httpOnly: true;
  /** `strict` for the session, always; `lax` for the sign-in's state cookie alone. */
  sameSite: "strict" | "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
};

export function cookieAttributes(
  token: string,
  online: boolean,
  lifetimeMs: number,
): CookieAttributes {
  return {
    name: cookieName(online),
    value: token,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    secure: online,
    maxAge: Math.floor(lifetimeMs / 1000),
  };
}

/** The sign-in's state cookie, under the same prefix rule as the session's. */
export function stateCookieName(online: boolean): string {
  return online ? "__Host-oauth" : "oauth";
}

/** Ten minutes: a consent screen read slowly, and not a code worth lifting tomorrow. */
export const STATE_COOKIE_SECONDS = 600;

/**
 * The cookie that binds a Google or GitHub sign-in to the browser that started it: its state and
 * PKCE verifier, and where it returns (encodeState in src/oauth.ts).
 *
 * LAX, AND IT HAS TO BE, where the session's is Strict. The callback is the provider sending the
 * browser back - a top-level GET that began on accounts.google.com or github.com, which is a
 * cross-site navigation - and a Strict cookie is not sent on one: every callback would arrive
 * without its state and be refused. Lax is sent on exactly that and on no cross-site POST, fetch or
 * frame, and the cookie opens nothing by itself: it is spent against a code this same browser was
 * handed back. The session cookie set by that callback stays Strict - see openedSession in
 * server.ts for what that means on the navigation that follows.
 */
export function stateCookieAttributes(value: string, online: boolean): CookieAttributes {
  return {
    name: stateCookieName(online),
    value,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: online,
    maxAge: STATE_COOKIE_SECONDS,
  };
}

/**
 * The origin, which the browser sets and a third-party page cannot forge. Its absence is
 * refused: every current browser sets one on requests that change state.
 */
export function originAcceptable(origin: string | null, publicUrl: string): boolean {
  if (origin === null) return false;
  return origin === publicUrl;
}
