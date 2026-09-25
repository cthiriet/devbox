import { describe, expect, test } from "bun:test";
import {
  cookieAttributes,
  cookieName,
  equalsInConstantTime,
  newToken,
  originAcceptable,
  sessionAlive,
  STATE_COOKIE_SECONDS,
  stateCookieAttributes,
  stateCookieName,
  TOKEN_BYTES,
  tokenDigest,
  type Session,
} from "../src/sessions";

describe("newToken", () => {
  test("draws 256 bits, base64url encoded", () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBe(43); // 32 bytes in base64, without padding
  });

  test("never repeats", () => {
    const drawn = new Set(Array.from({ length: 500 }, () => newToken()));
    expect(drawn.size).toBe(500);
  });

  test("refuses a randomness source that is too short", () => {
    // Rather than silently issuing a session token with less entropy than announced.
    expect(() => newToken(() => new Uint8Array(TOKEN_BYTES - 1))).toThrow();
  });
});

describe("tokenDigest", () => {
  test("is what the database stores, never the token", async () => {
    // A leaked backup must yield no usable session.
    const token = newToken();
    const digest = await tokenDigest(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
  });

  test("is stable for the same token", async () => {
    const token = newToken();
    expect(await tokenDigest(token)).toBe(await tokenDigest(token));
  });
});

describe("equalsInConstantTime", () => {
  test("compares by value", async () => {
    expect(await equalsInConstantTime("abc", "abc")).toBe(true);
    expect(await equalsInConstantTime("abc", "abd")).toBe(false);
  });

  test("handles differing lengths without throwing", async () => {
    // timingSafeEqual refuses buffers of different sizes, which is why both sides are
    // hashed first rather than compared raw.
    expect(await equalsInConstantTime("a", "aaaaaaaaaaaa")).toBe(false);
  });
});

describe("sessionAlive", () => {
  const session: Session = { digest: "d", userId: 1, csrf: "c", createdAt: 1000, seenAt: 1000 };

  test("lives for its lifetime, counted from creation", () => {
    expect(sessionAlive(session, 500, 1400)).toBe(true);
    expect(sessionAlive(session, 500, 1500)).toBe(false);
    expect(sessionAlive(session, 500, 9000)).toBe(false);
  });

  test("does not extend on use", () => {
    // seenAt exists to show when it was last used, not to renew it: a session that never
    // expires while it is used is a session that never expires.
    const used: Session = { ...session, seenAt: 1499 };
    expect(sessionAlive(used, 500, 1500)).toBe(false);
  });
});

describe("the cookie", () => {
  test("takes the __Host- prefix only over HTTPS", () => {
    // The browser enforces it: without Secure, on Path=/ and with no Domain, it refuses
    // the cookie outright. Over plain HTTP locally that would stop it being stored.
    expect(cookieName(true)).toBe("__Host-session");
    expect(cookieName(false)).toBe("session");
  });

  test("is httpOnly, strict and scoped to the root", () => {
    const attributes = cookieAttributes("token", true, 60_000);
    expect(attributes).toEqual({
      name: "__Host-session",
      value: "token",
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      secure: true,
      maxAge: 60,
    });
  });
});

describe("the sign-in's state cookie", () => {
  test("is Lax, the one cookie here that is: the provider's redirect back is a cross-site navigation", () => {
    // Strict, it would not be sent on the callback, and every sign-in would be refused as `state`.
    expect(stateCookieAttributes("google.state.verifier.Lw", true)).toEqual({
      name: "__Host-oauth",
      value: "google.state.verifier.Lw",
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: true,
      maxAge: STATE_COOKIE_SECONDS,
    });
    expect(STATE_COOKIE_SECONDS).toBe(600);
  });

  test("takes the __Host- prefix only over HTTPS, like the session's", () => {
    expect(stateCookieName(true)).toBe("__Host-oauth");
    expect(stateCookieName(false)).toBe("oauth");
    expect(stateCookieAttributes("v", false)).toMatchObject({ name: "oauth", secure: false, sameSite: "lax" });
  });

  test("never shares a name with the session's", () => {
    for (const online of [true, false]) expect(stateCookieName(online)).not.toBe(cookieName(online));
  });
});

describe("originAcceptable", () => {
  test("accepts our origin and nothing else", () => {
    expect(originAcceptable("https://devbox.example.com", "https://devbox.example.com")).toBe(true);
    expect(originAcceptable("https://devbox.example.com.evil.tld", "https://devbox.example.com")).toBe(
      false,
    );
    expect(originAcceptable("http://devbox.example.com", "https://devbox.example.com")).toBe(false);
  });

  test("refuses an absent origin", () => {
    // Every current browser sets one on a request that changes state, so its absence is
    // not a browser we need to support.
    expect(originAcceptable(null, "https://devbox.example.com")).toBe(false);
  });
});
