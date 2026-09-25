import { describe, expect, test } from "bun:test";
import { authorizeWrite } from "../src/guard";
import type { Session } from "../src/sessions";

/**
 * On this site every write either orders a machine that bills by the hour or destroys one
 * that holds unpushed work. These four refusals are the only thing between a stray page
 * and a bill.
 */

const PUBLIC_URL = "https://devbox.example.com";
const session: Session = { digest: "d", userId: 1, csrf: "the-csrf-token", createdAt: 0, seenAt: 0 };

const input = (overrides: Partial<Parameters<typeof authorizeWrite>[0]> = {}) => ({
  session,
  origin: PUBLIC_URL,
  publicUrl: PUBLIC_URL,
  csrfReceived: "the-csrf-token",
  ...overrides,
});

describe("authorizeWrite", () => {
  test("authorizes a request that satisfies all three conditions", async () => {
    expect(await authorizeWrite(input())).toEqual({ ok: true });
  });

  test("refuses without a session, with 401", async () => {
    const verdict = await authorizeWrite(input({ session: null }));
    expect(verdict).toEqual({ ok: false, status: 401, reason: "session expired" });
  });

  test("refuses another origin, with 403", async () => {
    for (const origin of [null, "https://evil.tld", "https://devbox.example.com.evil.tld", ""]) {
      const verdict = await authorizeWrite(input({ origin }));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.status).toBe(403);
    }
  });

  test("refuses an absent anti-CSRF token", async () => {
    for (const csrfReceived of [null, ""]) {
      const verdict = await authorizeWrite(input({ csrfReceived }));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("anti-CSRF token absent");
    }
  });

  test("refuses a session whose own token is empty", async () => {
    // Two empty strings would otherwise be declared equal, and a session row written
    // wrongly would authorize everything.
    const verdict = await authorizeWrite(
      input({ session: { ...session, csrf: "" }, csrfReceived: "" }),
    );
    expect(verdict.ok).toBe(false);
  });

  test("refuses a token belonging to another session", async () => {
    const verdict = await authorizeWrite(input({ csrfReceived: "someone-elses-token" }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("anti-CSRF token invalid");
  });

  test("keeps both checks, which are redundant on purpose", async () => {
    // One falls without Origin, the other if the token leaks. A request carrying our
    // origin but the wrong token is still refused, and the reverse too.
    expect((await authorizeWrite(input({ origin: "https://evil.tld" }))).ok).toBe(false);
    expect((await authorizeWrite(input({ csrfReceived: "wrong" }))).ok).toBe(false);
  });
});
