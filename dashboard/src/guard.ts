import type { Account } from "./schema";
import { equalsInConstantTime, originAcceptable, type Session } from "./sessions";

/**
 * Who a request acts for, once a session or a token has said so: the account, and which of
 * the two said it. `session` is null for a token, which has no anti-CSRF token to check.
 *
 * Every route that reads or writes on someone's behalf starts from one of these and derives
 * what it reads from `account` - see sourcesFor in src/secrets.ts. There is no default
 * account anywhere to fall back on, which is the point.
 */
export type Principal = { account: Account; via: "session" | "token"; session: Session | null };

/**
 * Authorizes a request that changes state or costs money. Kept out of the server so it
 * can be exercised without starting one.
 *
 * On this site the second half of that sentence is not a figure of speech: every write
 * here either orders a machine that bills by the hour or destroys one that holds
 * unpushed work.
 *
 * Three conditions: a session, our origin, and that session's anti-CSRF token. The last
 * two are redundant on purpose: one falls without `Origin`, the other if the token
 * leaks.
 */
export type Verdict = { ok: true } | { ok: false; status: 401 | 403; reason: string };

export async function authorizeWrite(input: {
  session: Session | null;
  origin: string | null;
  publicUrl: string;
  csrfReceived: string | null;
}): Promise<Verdict> {
  if (input.session === null) {
    return { ok: false, status: 401, reason: "session expired" };
  }

  if (!originAcceptable(input.origin, input.publicUrl)) {
    return { ok: false, status: 403, reason: "origin refused" };
  }

  // Two empty strings would be declared equal.
  if (input.csrfReceived === null || input.csrfReceived === "" || input.session.csrf === "") {
    return { ok: false, status: 403, reason: "anti-CSRF token absent" };
  }

  if (!(await equalsInConstantTime(input.csrfReceived, input.session.csrf))) {
    return { ok: false, status: 403, reason: "anti-CSRF token invalid" };
  }

  return { ok: true };
}
