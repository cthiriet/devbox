/**
 * Google and GitHub, answered inside a test's server.
 *
 * Preloaded into the server child by tests/server-harness.ts (`bun --preload`), it replaces
 * globalThis.fetch for exactly the four addresses src/oauth.ts sends a code or a token to, and
 * hands every other request to the real fetch. It reads the four client variables when it loads,
 * before server.ts takes them out of the environment, and checks what a provider would: the
 * client's id and secret, the redirect URI, the PKCE verifier against the challenge, and that the
 * request refuses redirects.
 *
 * THE CODE IS THE SCENARIO: base64url JSON of `{ sub, email?, email_verified?, emails?, hd?,
 * challenge, error? }`, written by the harness's signIn. So a test says who signs in by what it sends, and
 * nothing here keeps a state between two requests - GitHub's access token carries the scenario
 * on to `/user` and `/user/emails` the same way.
 *
 * WHY IT CANNOT RUN IN PRODUCTION, which is the whole of its safety: nothing in server.ts or src/
 * names it or branches on anything that would load it; it lives under tests/, which deploy.json
 * excludes and scripts/simulate-deploy.sh proves absent from the rsynced copy; the unit starts
 * `bun run server.ts` without `--preload`; and no environment variable redirects a provider's
 * address, those being constants in src/oauth.ts.
 */

type Provider = "google" | "github";

type Scenario = {
  sub?: unknown;
  hd?: unknown;
  email?: unknown;
  email_verified?: unknown;
  emails?: unknown;
  challenge?: unknown;
  error?: unknown;
};

const real = globalThis.fetch;

const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3021}`).replace(/\/+$/, "");

const clients: Record<Provider, { id: string; secret: string }> = {
  google: { id: process.env.GOOGLE_CLIENT_ID ?? "", secret: process.env.GOOGLE_CLIENT_SECRET ?? "" },
  github: { id: process.env.GITHUB_CLIENT_ID ?? "", secret: process.env.GITHUB_CLIENT_SECRET ?? "" },
};

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function decoded(text: string): Scenario | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Scenario) : null;
  } catch {
    return null;
  }
}

async function s256(verifier: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

async function token(provider: Provider, init: RequestInit | undefined): Promise<Response> {
  // Google refuses a code with a 400; GitHub with a 200 and `{ error }`.
  const refuse = () =>
    provider === "google" ? json({ error: "invalid_grant" }, 400) : json({ error: "bad_verification_code" });

  if (init?.method !== "POST" || init.redirect !== "error") return refuse();
  const form = new URLSearchParams(String(init.body ?? ""));
  const client = clients[provider];
  if (client.id === "" || form.get("client_id") !== client.id || form.get("client_secret") !== client.secret) return refuse();
  if (form.get("redirect_uri") !== `${PUBLIC_URL}/api/auth/${provider}/callback`) return refuse();
  if (provider === "google" && form.get("grant_type") !== "authorization_code") return refuse();

  const scenario = decoded(form.get("code") ?? "");
  if (scenario === null || scenario.error !== undefined || typeof scenario.sub !== "string") return refuse();
  if ((await s256(form.get("code_verifier") ?? "")) !== scenario.challenge) return refuse();

  if (provider === "google") {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      aud: client.id,
      azp: client.id,
      sub: scenario.sub,
      iat: now,
      exp: now + 3600,
      ...(scenario.email === undefined ? {} : { email: scenario.email }),
      ...(scenario.hd === undefined ? {} : { hd: scenario.hd }),
      email_verified: "email_verified" in scenario ? scenario.email_verified : true,
    };
    return json({
      access_token: `ya29.${encoded(scenario.sub)}`,
      token_type: "Bearer",
      id_token: `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded(claims)}.c2lnbmF0dXJl`,
    });
  }
  return json({ access_token: `gho_${encoded(scenario)}`, token_type: "bearer", scope: "user:email" });
}

function github(read: "user" | "emails", init: RequestInit | undefined): Response {
  const authorization = new Headers(init?.headers).get("authorization") ?? "";
  const scenario = authorization.startsWith("Bearer gho_") ? decoded(authorization.slice("Bearer gho_".length)) : null;
  if (init?.redirect !== "error" || scenario === null) return json({ message: "Bad credentials" }, 401);

  if (read === "user") return json({ id: Number(scenario.sub), login: `someone-${String(scenario.sub)}` });
  if (scenario.emails !== undefined) return json(scenario.emails);
  return json(
    scenario.email === undefined
      ? []
      : [{ email: scenario.email, verified: scenario.email_verified ?? true, primary: true, visibility: "private" }],
  );
}

const answered: Record<string, (init: RequestInit | undefined) => Response | Promise<Response>> = {
  "https://oauth2.googleapis.com/token": (init) => token("google", init),
  "https://github.com/login/oauth/access_token": (init) => token("github", init),
  "https://api.github.com/user": (init) => github("user", init),
  "https://api.github.com/user/emails": (init) => github("emails", init),
};

const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const answer = answered[url];
  return answer === undefined ? real(input, init) : answer(init);
};

globalThis.fetch = Object.assign(fake, real) as typeof fetch;
