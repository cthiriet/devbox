import { afterAll, describe, expect, test } from "bun:test";
import {
  authorizationUrl,
  callbackUrl,
  challengeOf,
  encodeState,
  exchange,
  githubCandidates,
  googleIdentity,
  offeredProviders,
  parseState,
  pkcePair,
  PROVIDER_URLS,
  returnPath,
  RETURN_MAX,
  SUBJECT_MAX,
  takeProviders,
  type ExchangeOptions,
  type FlowState,
} from "../src/oauth";
import { newToken } from "../src/sessions";

/**
 * Google and GitHub sign-in, without a provider and without a server: PKCE, the state cookie, the
 * return path, and each exchange against a fetch that answers what a provider would - and records
 * where it was sent, and with what. The flow end to end, cookies and all, is
 * tests/oauth-api.test.ts's.
 *
 * Every client value planted here carries QZXW, and so does every code and verifier: finding them
 * in a URL they must not reach, in a reason that goes to the journal, or in what a slot serialises
 * to, is the failure.
 */

const PUBLIC_URL = "https://devbox.example.com";
const GOOGLE_ID = "google-client-id.apps.example.com";
const GOOGLE_SECRET = "google-secret-QZXW";
const GITHUB_ID = "github-client-id";
const GITHUB_SECRET = "github-secret-QZXW";
const NOW = Date.UTC(2026, 8, 15, 12);

/** Both providers offered, as a service with the four variables starts. */
function offerBoth(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    GOOGLE_CLIENT_ID: GOOGLE_ID,
    GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
    GITHUB_CLIENT_ID: GITHUB_ID,
    GITHUB_CLIENT_SECRET: GITHUB_SECRET,
    UNRELATED: "kept",
  };
  takeProviders(env);
  return env;
}

// The slot is the process's: leave it as a test process without providers found it.
afterAll(() => {
  takeProviders({});
});

const base64url = (text: string) =>
  btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/** base64url of the UTF-8 bytes, where `base64url` above takes Latin-1 and refuses anything wider. */
const utf8url = (text: string) => Buffer.from(text).toString("base64url");

/** An id_token as Google's token endpoint returns one. The signature is never read: see googleIdentity. */
const idToken = (claims: Record<string, unknown>) =>
  `${utf8url(JSON.stringify({ alg: "RS256", kid: "k" }))}.${utf8url(JSON.stringify(claims))}.c2lnbmF0dXJl`;

const googleClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: GOOGLE_ID,
  azp: GOOGLE_ID,
  sub: "110169484474386276334",
  email: "someone@example.com",
  email_verified: true,
  exp: Math.floor(NOW / 1000) + 3600,
  ...overrides,
});

type Sent = { url: string; init: RequestInit };

/** A fetch that answers from a list, in order, and records every request. */
function provider(answers: (Response | ((sent: Sent) => Promise<Response>))[]) {
  const sent: Sent[] = [];
  const fetch: NonNullable<ExchangeOptions["fetch"]> = async (url, init) => {
    const one = { url, init };
    sent.push(one);
    const next = answers.shift();
    if (next === undefined) throw new Error(`no answer left for ${url}`);
    return typeof next === "function" ? next(one) : next;
  };
  return { sent, fetch };
}

const answer = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

const formOf = (sent: Sent) => new URLSearchParams(String(sent.init.body));

const headerOf = (sent: Sent, name: string) => new Headers(sent.init.headers).get(name);

describe("PKCE", () => {
  test("S256 is RFC 7636's appendix B, byte for byte", async () => {
    expect(await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("a verifier is 43 unreserved characters, and the pair agrees with itself", async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(await challengeOf(verifier));
    expect(challenge).not.toContain(verifier);
  });
});

describe("takeProviders", () => {
  test("takes all four variables out of the environment, and leaves the rest", () => {
    const env = offerBoth();
    expect(offeredProviders()).toEqual(["google", "github"]);
    expect(Object.keys(env)).toEqual(["UNRELATED"]);
  });

  test("removes them even when a provider is half set, and does not offer that one", () => {
    const env: Record<string, string | undefined> = {
      GOOGLE_CLIENT_ID: GOOGLE_ID,
      GITHUB_CLIENT_ID: GITHUB_ID,
      GITHUB_CLIENT_SECRET: GITHUB_SECRET,
    };
    const taken = takeProviders(env);
    expect(taken.offered).toEqual(["github"]);
    expect(taken.halfSet).toEqual([{ provider: "google", set: "GOOGLE_CLIENT_ID", unset: "GOOGLE_CLIENT_SECRET" }]);
    expect(offeredProviders()).toEqual(["github"]);
    expect(env).toEqual({});

    const secretOnly = takeProviders({ GOOGLE_CLIENT_SECRET: GOOGLE_SECRET, GITHUB_CLIENT_ID: "  " });
    expect(secretOnly.offered).toEqual([]);
    expect(secretOnly.halfSet).toEqual([{ provider: "google", set: "GOOGLE_CLIENT_SECRET", unset: "GOOGLE_CLIENT_ID" }]);
  });

  test("offers nothing without variables", () => {
    expect(takeProviders({})).toEqual({ offered: [], halfSet: [] });
    expect(offeredProviders()).toEqual([]);
    expect(authorizationUrl("google", { publicUrl: PUBLIC_URL, state: "s", challenge: "c" })).toBeNull();
  });

  test("keeps no secret where JSON.stringify, Bun.inspect or its answer reach", () => {
    const taken = takeProviders({
      GOOGLE_CLIENT_ID: GOOGLE_ID,
      GOOGLE_CLIENT_SECRET: GOOGLE_SECRET,
      GITHUB_CLIENT_ID: GITHUB_ID,
      GITHUB_CLIENT_SECRET: GITHUB_SECRET,
    });
    const slot = (globalThis as Record<symbol, unknown>)[Symbol.for("devbox.dashboard.oauth")];
    expect(slot).toBeDefined();
    // The ids are there - they are no secret, and a URL carries them - and the secrets are not.
    expect(JSON.stringify(slot)).toContain(GOOGLE_ID);
    for (const shown of [JSON.stringify(slot), Bun.inspect(slot), JSON.stringify(taken), Bun.inspect(taken)]) {
      expect(shown).not.toContain("QZXW");
    }
  });
});

describe("authorizationUrl", () => {
  test("Google: the fixed address and exactly its parameters, the client id and never its secret", () => {
    offerBoth();
    const url = new URL(authorizationUrl("google", { publicUrl: PUBLIC_URL, state: "the-state", challenge: "the-challenge" }) ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(PROVIDER_URLS.google.authorize);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: GOOGLE_ID,
      redirect_uri: "https://devbox.example.com/api/auth/google/callback",
      response_type: "code",
      scope: "openid email",
      state: "the-state",
      code_challenge: "the-challenge",
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    expect(url.href).not.toContain("QZXW");
  });

  test("GitHub: the fixed address and exactly its parameters", () => {
    offerBoth();
    const url = new URL(authorizationUrl("github", { publicUrl: PUBLIC_URL, state: "s", challenge: "c" }) ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(PROVIDER_URLS.github.authorize);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: GITHUB_ID,
      redirect_uri: "https://devbox.example.com/api/auth/github/callback",
      scope: "user:email",
      state: "s",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
    expect(url.href).not.toContain("QZXW");
  });

  test("the callback is under /api/, which the manifest already declares as a whole", () => {
    expect(callbackUrl("google", PUBLIC_URL)).toBe(`${PUBLIC_URL}/api/auth/google/callback`);
  });
});

describe("returnPath", () => {
  test("keeps a path of this origin, its query and its fragment", () => {
    for (const path of ["/", "/machine/devbox-ab12c", "/secrets#secret-github", "/new/shape?profile=bare", "/job/7"]) {
      expect(returnPath(path), path).toBe(path);
    }
  });

  test("refuses anything that could leave the origin, and sends it to /", () => {
    for (const from of [
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/",
      "http:/evil.example",
      "evil.example",
      "javascript:alert(1)",
      // Resolves to //evil.example, which a check on the raw string alone would have passed.
      "/..//evil.example",
      "/./\\evil.example",
    ]) {
      expect(returnPath(from), from).toBe("/");
    }
  });

  test("refuses control characters, which a URL parser strips and a header refuses", () => {
    // `/\t/evil.example` is `//evil.example` once a browser drops the tab.
    for (const from of ["/\t/evil.example", "/a\nLocation: x", "/a\rb", "/\0", "/"]) {
      expect(returnPath(from), JSON.stringify(from)).toBe("/");
    }
  });

  test("refuses what is not a path at all: empty, too long, not a string", () => {
    expect(returnPath("")).toBe("/");
    expect(returnPath(`/${"a".repeat(RETURN_MAX)}`)).toBe("/");
    expect(returnPath(`/${"a".repeat(RETURN_MAX - 1)}`)).toBe(`/${"a".repeat(RETURN_MAX - 1)}`);
    for (const value of [null, undefined, 42, ["/secrets"]]) expect(returnPath(value)).toBe("/");
  });

  test("does not return to the sign-in page, which would be a loop", () => {
    for (const from of ["/login", "/login/", "/login?refused=state", "/login#x"]) expect(returnPath(from), from).toBe("/");
  });

  test("hands back an encoded path, which a Location header can carry", () => {
    expect(returnPath("/machine/é b")).toBe("/machine/%C3%A9%20b");
    expect(returnPath("/secrets#漢")).toBe("/secrets#%E6%BC%A2");
  });
});

describe("the state cookie", () => {
  const flow = (overrides: Partial<FlowState> = {}): FlowState => ({
    provider: "google",
    state: newToken(),
    verifier: newToken(),
    from: "/secrets#secret-github",
    ...overrides,
  });

  test("reads back what it wrote", () => {
    const written = flow();
    expect(parseState(encodeState(written))).toEqual(written);
    const github = flow({ provider: "github", from: "/" });
    // The provider travels with it: the callback refuses a cookie written for the other one.
    expect(parseState(encodeState(github))?.provider).toBe("github");
  });

  test("refuses anything it did not write", () => {
    const good = encodeState(flow());
    const [provider, state, verifier, from] = good.split(".");
    for (const value of [
      null,
      undefined,
      "",
      "google",
      `${provider}.${state}.${verifier}`,
      `${good}.extra`,
      `gitlab.${state}.${verifier}.${from}`,
      `${provider}.short.${verifier}.${from}`,
      `${provider}.${state}.${verifier}!.${from}`,
      `${provider}.${state}.${verifier}.not base64`,
      `${provider}.${state}.${verifier}.${base64url("\xff\xfe")}`,
    ]) {
      expect(parseState(value), String(value)).toBeNull();
    }
  });

  test("puts the return path through returnPath again on the way back", () => {
    const written = encodeState({ ...flow(), from: "//evil.example" });
    expect(parseState(written)?.from).toBe("/");
  });
});

describe("googleIdentity", () => {
  const read = (claims: Record<string, unknown>) => googleIdentity({ id_token: idToken(claims), access_token: "ya29.x" }, GOOGLE_ID, NOW);

  test("a verified address and a subject open", () => {
    expect(read(googleClaims())).toEqual({
      ok: true,
      subject: "110169484474386276334",
      emails: [{ email: "someone@example.com", authoritative: false }],
    });
    expect(read(googleClaims({ iss: "accounts.google.com", azp: undefined })).ok).toBe(true);
  });

  test("Google is authoritative for a Gmail address and a Workspace account's, and for nothing else", () => {
    const authority = (claims: Record<string, unknown>) => {
      const read_ = read(googleClaims(claims));
      return read_.ok ? read_.emails[0]?.authoritative : undefined;
    };
    expect(authority({ email: "someone@gmail.com" })).toBe(true);
    // Folded first: case and a fullwidth letter do not make a Gmail address something else.
    expect(authority({ email: "Someone@GMAIL.com" })).toBe(true);
    expect(authority({ email: "someone@ｇmail.com" })).toBe(true);
    expect(authority({ email: "someone@example.com", hd: "example.com" })).toBe(true);
    for (const [what, claims] of [
      ["another domain", { email: "someone@example.com" }],
      ["an empty hd", { email: "someone@example.com", hd: "" }],
      ["an hd that is not a string", { email: "someone@example.com", hd: true }],
      ["a domain ending in gmail.com", { email: "someone@notgmail.com" }],
      ["gmail.com as a subdomain", { email: "someone@gmail.com.example.com" }],
      ["googlemail.com", { email: "someone@googlemail.com" }],
    ] as const) {
      expect(authority(claims), what).toBe(false);
    }
  });

  test("refuses a token not Google's, not this client's, expired, or with no subject", () => {
    for (const [what, claims] of [
      ["iss", googleClaims({ iss: "https://accounts.example.com" })],
      ["aud", googleClaims({ aud: "someone-elses-client" })],
      ["aud as a list", googleClaims({ aud: [GOOGLE_ID] })],
      ["azp", googleClaims({ azp: "someone-elses-client" })],
      ["exp", googleClaims({ exp: Math.floor(NOW / 1000) })],
      ["exp as a string", googleClaims({ exp: String(Math.floor(NOW / 1000) + 3600) })],
      ["no sub", googleClaims({ sub: undefined })],
      ["empty sub", googleClaims({ sub: "" })],
      ["long sub", googleClaims({ sub: "1".repeat(SUBJECT_MAX + 1) })],
    ] as const) {
      const refused = read(claims);
      expect(refused.ok, what).toBe(false);
      if (!refused.ok) expect(refused.refused, what).toBe("provider");
    }
  });

  test("refuses an address that is not verified, the string \"true\" included", () => {
    for (const claims of [
      googleClaims({ email_verified: false }),
      googleClaims({ email_verified: "true" }),
      googleClaims({ email_verified: undefined }),
      googleClaims({ email: undefined }),
    ]) {
      const refused = read(claims);
      expect(refused).toMatchObject({ ok: false, refused: "unverified" });
    }
  });

  test("refuses an answer that is not a token at all", () => {
    for (const json of [null, {}, { id_token: 42 }, { id_token: "a.b" }, { id_token: "a.!!.c" }, { id_token: `a.${base64url("[1]")}.c` }]) {
      expect(googleIdentity(json, GOOGLE_ID, NOW)).toMatchObject({ ok: false, refused: "provider" });
    }
  });
});

describe("githubCandidates", () => {
  test("verified addresses only, the primary first and then GitHub's order", () => {
    expect(
      githubCandidates([
        { email: "second@example.com", verified: true, primary: false },
        { email: "unverified@example.com", verified: false, primary: false },
        { email: "primary@example.com", verified: true, primary: true },
        { email: "third@example.com", verified: true, primary: false },
      ]),
    ).toEqual(["primary@example.com", "second@example.com", "third@example.com"]);
  });

  test("never a noreply address, and never a verified flag of the wrong type", () => {
    expect(
      githubCandidates([
        { email: "12345+someone@users.noreply.github.com", verified: true, primary: true },
        { email: "x@USERS.NOREPLY.GITHUB.COM", verified: true, primary: false },
        { email: "stringly@example.com", verified: "true", primary: false },
        { email: 7, verified: true },
        null,
      ]),
    ).toEqual([]);
  });

  test("null for an answer that is not a list", () => {
    for (const value of [null, {}, "a@example.com", { emails: [] }]) expect(githubCandidates(value)).toBeNull();
  });
});

describe("exchange", () => {
  const CODE = "the-code-QZXW";
  const VERIFIER = "the-verifier-QZXW-xxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const input = { code: CODE, verifier: VERIFIER, publicUrl: PUBLIC_URL };

  test("Google: one POST to the fixed token address, redirects refused, under a timeout", async () => {
    offerBoth();
    const { sent, fetch } = provider([answer({ access_token: "ya29.QZXW", id_token: idToken(googleClaims()) })]);
    const exchanged = await exchange("google", input, { fetch, now: NOW });
    expect(exchanged).toEqual({
      ok: true,
      subject: "110169484474386276334",
      emails: [{ email: "someone@example.com", authoritative: false }],
    });

    expect(sent.map((one) => one.url)).toEqual([PROVIDER_URLS.google.token]);
    const [token] = sent;
    if (token === undefined) throw new Error("no request");
    expect(token.init.method).toBe("POST");
    expect(token.init.redirect).toBe("error");
    expect(token.init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(formOf(token))).toEqual({
      client_id: GOOGLE_ID,
      client_secret: GOOGLE_SECRET,
      code: CODE,
      redirect_uri: `${PUBLIC_URL}/api/auth/google/callback`,
      code_verifier: VERIFIER,
      grant_type: "authorization_code",
    });
  });

  test("GitHub: the token, then /user and /user/emails with it, each at its fixed address", async () => {
    offerBoth();
    const { sent, fetch } = provider([
      answer({ access_token: "gho_QZXW", token_type: "bearer", scope: "user:email" }),
      answer({ id: 583231, login: "octocat" }),
      answer([
        { email: "old@example.com", verified: true, primary: false },
        { email: "now@example.com", verified: true, primary: true },
      ]),
    ]);
    const exchanged = await exchange("github", input, { fetch, now: NOW });
    // The numeric id, never the login a user can rename.
    // Every one authoritative: GitHub re-verifies an address before it lists it as verified.
    expect(exchanged).toEqual({
      ok: true,
      subject: "583231",
      emails: [
        { email: "now@example.com", authoritative: true },
        { email: "old@example.com", authoritative: true },
      ],
    });

    expect(sent.map((one) => one.url)).toEqual([PROVIDER_URLS.github.token, PROVIDER_URLS.github.user, PROVIDER_URLS.github.emails]);
    for (const one of sent) expect(one.init.redirect).toBe("error");
    const [token, user, emails] = sent;
    if (token === undefined || user === undefined || emails === undefined) throw new Error("missing requests");
    expect(Object.fromEntries(formOf(token))).toEqual({
      client_id: GITHUB_ID,
      client_secret: GITHUB_SECRET,
      code: CODE,
      redirect_uri: `${PUBLIC_URL}/api/auth/github/callback`,
      code_verifier: VERIFIER,
    });
    expect(headerOf(token, "accept")).toBe("application/json");
    for (const read of [user, emails]) {
      expect(read.init.method ?? "GET").toBe("GET");
      expect(headerOf(read, "authorization")).toBe("Bearer gho_QZXW");
      expect(headerOf(read, "x-github-api-version")).toBe("2022-11-28");
      expect(headerOf(read, "user-agent")).toBe("devbox-dashboard");
    }
  });

  test("a provider's refusal is `provider`, named by its status and short code, never by what was sent", async () => {
    offerBoth();
    const cases: [string, Parameters<typeof provider>[0]][] = [
      ["google", [answer({ error: "invalid_grant", error_description: `Bad code ${CODE}` }, 400)]],
      // GitHub refuses a code with a 200.
      ["github", [answer({ error: "bad_verification_code", error_description: `The code ${CODE} is wrong` })]],
      ["github", [answer({ access_token: "gho_x" }), answer({ message: "Bad credentials" }, 401)]],
      ["github", [answer({ access_token: "gho_x" }), answer({ login: "no-id" })]],
      ["github", [answer({ access_token: "gho_x" }), answer({ id: 1 }), answer({ message: "not a list" })]],
      ["google", [new Response("<html>", { status: 200 })]],
    ];
    const reasons: string[] = [];
    for (const [which, answers] of cases) {
      const { fetch } = provider(answers);
      const refused = await exchange(which as "google" | "github", input, { fetch, now: NOW });
      expect(refused, `${which} ${reasons.length}`).toMatchObject({ ok: false, refused: "provider" });
      if (!refused.ok) reasons.push(refused.reason);
    }
    expect(reasons[0]).toBe("the token endpoint answered 400 (invalid_grant)");
    expect(reasons[1]).toBe("the token endpoint answered no access_token (bad_verification_code)");
    expect(reasons[2]).toBe("the user endpoint answered 401");
    for (const reason of reasons) expect(reason).not.toContain("QZXW");
  });

  test("GitHub with no verified address left is `unverified`", async () => {
    offerBoth();
    const { fetch } = provider([
      answer({ access_token: "gho_x" }),
      answer({ id: 9 }),
      answer([{ email: "9+someone@users.noreply.github.com", verified: true, primary: true }, { email: "x@example.com", verified: false }]),
    ]);
    expect(await exchange("github", input, { fetch, now: NOW })).toMatchObject({ ok: false, refused: "unverified" });
  });

  test("a provider that does not answer in time is `provider`, and says it timed out", async () => {
    offerBoth();
    const { fetch } = provider([
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ]);
    const refused = await exchange("google", input, { fetch, now: NOW, timeoutMs: 20 });
    expect(refused).toMatchObject({ ok: false, refused: "provider" });
    if (!refused.ok) expect(refused.reason).toBe("the token endpoint could not be reached (TimeoutError)");
  });

  test("a network failure never quotes its message, which may carry what was sent", async () => {
    offerBoth();
    const { fetch } = provider([
      async () => {
        throw new TypeError(`fetch failed for code=${CODE}`);
      },
    ]);
    const refused = await exchange("github", input, { fetch, now: NOW });
    expect(refused).toEqual({ ok: false, refused: "provider", reason: "the token endpoint could not be reached (TypeError)" });
  });

  test("a provider this process does not offer is `unavailable`, and nothing is sent", async () => {
    takeProviders({ GITHUB_CLIENT_ID: GITHUB_ID, GITHUB_CLIENT_SECRET: GITHUB_SECRET });
    const { sent, fetch } = provider([]);
    expect(await exchange("google", input, { fetch, now: NOW })).toMatchObject({ ok: false, refused: "unavailable" });
    expect(sent).toEqual([]);
  });
});
