import type { Subprocess } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * server.ts, started the way the unit starts it, for the tests that can only be written
 * against a running server.
 *
 * Not a `.test.ts`: it declares nothing and asserts nothing. It exists because there were
 * about to be three copies of "spawn bun server.ts, wait for the line naming its port, talk
 * JSON to it" - tests/secrets-api.test.ts wrote the first, tests/profiles-api.test.ts the
 * second, and a third copy is where two of them start disagreeing about what a login is.
 *
 * Everything a test cares about is a parameter: the data directory, the environment, and the
 * fake `devbox` to put in the engine directory. What is fixed is what must not vary - PORT=0
 * so the kernel chooses and nothing fights for 3021, and NODE_ENV=test.
 */

export type Server = {
  child: Subprocess;
  base: string;
  /** Everything the process has said so far, read while it runs: startup lines are answers. */
  out: { stdout: string; stderr: string };
};

export type ServerOptions = {
  /** The test's own directory: DATA_DIR, the engine and the shell all sit under it. */
  root: string;
  /** Added to - and able to override - the environment below. */
  env?: Record<string, string>;
  /** Writes the fake devbox into the engine directory it is given. */
  engine?: (directory: string) => void;
  /** `bun --hot <entry>`, as `bun run dev` runs it, instead of `bun server.ts`. */
  hot?: string;
  /**
   * The fake Google and GitHub, and the four client variables they accept - unless false, for a
   * test of a service with no provider at all. `env` can still override one of the four.
   */
  providers?: boolean;
};

/** Google and GitHub, answered inside the server child: see the fixture's header. */
export const FAKE_PROVIDERS = join(import.meta.dir, "fixtures", "oauth-providers.ts");

/** The client variables a test server signs in with, which the fixture alone accepts. */
export const PROVIDER_ENV: Record<string, string> = {
  GOOGLE_CLIENT_ID: "google-client-of-the-tests.apps.example.com",
  GOOGLE_CLIENT_SECRET: "google-secret-of-the-tests",
  GITHUB_CLIENT_ID: "github-client-of-the-tests",
  GITHUB_CLIENT_SECRET: "github-secret-of-the-tests",
};

/**
 * `bun` as a test starts server.ts. `--no-env-file` always: Bun loads a `.env` of the working
 * directory by itself, and a development app's real client secret left in dashboard/.env would
 * otherwise be the one a test signs in with. `--preload` the fake providers unless told not to.
 */
export function serverCommand(entry: readonly string[], providers = true): string[] {
  return [process.execPath, "--no-env-file", ...(providers ? ["--preload", FAKE_PROVIDERS] : []), ...entry];
}

function collect(stream: ReadableStream<Uint8Array>, into: { text: string }): void {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      into.text += decoder.decode(value, { stream: true });
    }
  })();
}

/** A devbox that answers an empty list to everything: enough for a server to come up. */
export function silentEngine(directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "devbox"), "#!/usr/bin/env bash\nprintf '[]'\n", { mode: 0o755 });
  // engineReady() looks for the terraform roots beside it.
  mkdirSync(join(directory, "tf"), { recursive: true });
}

export async function startServer(options: ServerOptions): Promise<Server> {
  const engineDir = join(options.root, "engine");
  (options.engine ?? silentEngine)(engineDir);

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: join(options.root, "home"),
    NODE_ENV: "test",
    PORT: "0",
    DATA_DIR: join(options.root, "data"),
    ENGINE_DIR: engineDir,
    SHELL_DIR: join(options.root, "shell"),
    PUBLIC_DIR: join(options.root, "public"),
    DEVBOX_SECRETS_DIR: join(options.root, "legacy"),
    DEVBOX_RUNTIME_DIR: join(options.root, "run"),
    DEVBOX_KEY: join(options.root, "home", "devbox"),
    // Never the extension a deployment may have left in dashboard/extension/: a test that wants
    // one names it (tests/fixtures/extension-service.ts).
    DEVBOX_EXTENSION: "none",
    ...(options.providers === false ? {} : PROVIDER_ENV),
    ...options.env,
  };

  const argv = options.hot === undefined ? ["server.ts"] : ["--hot", options.hot];
  const child = Bun.spawn(serverCommand(argv, options.providers !== false), {
    cwd: join(import.meta.dir, ".."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = { text: "" };
  const stderr = { text: "" };
  collect(child.stdout as ReadableStream<Uint8Array>, stdout);
  collect(child.stderr as ReadableStream<Uint8Array>, stderr);

  for (let i = 0; i < 300; i += 1) {
    const found = /devbox on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout.text);
    if (found !== null) {
      return {
        child,
        base: `http://127.0.0.1:${found[1]}`,
        out: {
          get stdout() {
            return stdout.text;
          },
          get stderr() {
            return stderr.text;
          },
        },
      };
    }
    if (child.exitCode !== null) break;
    await Bun.sleep(50);
  }
  child.kill();
  throw new Error(`server.ts never said its port:\n${stdout.text}\n${stderr.text}`);
}

export async function stopServer(server: Server | null): Promise<void> {
  if (server === null) return;
  server.child.kill();
  await server.child.exited;
}

export type Call = { status: number; text: string; body: Record<string, unknown> };

export async function call(base: string, path: string, init: RequestInit = {}): Promise<Call> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Left empty: a test that wanted JSON says so on `status` or `body`.
  }
  return { status: response.status, text, body };
}

/* --- signing in, as a browser does ------------------------------------------ */

/** Who signs in: what the fake provider will say about them. */
export type Who = {
  /** Google's `sub`, or GitHub's numeric user id as a string. */
  sub: string;
  email?: string;
  /** Anything, for a test of what is refused: `"true"`, `false`. True when absent. */
  email_verified?: unknown;
  /** GitHub's `/user/emails` as it is, instead of one primary address. */
  emails?: readonly { email: string; verified: unknown; primary: boolean }[];
  /** Makes the fake token endpoint refuse the code. */
  error?: string;
  /**
   * Google's `hd`, the Workspace domain: with it, or with a @gmail.com address, Google vouches for
   * the address, and it may link or found. Without either it may only create (src/oauth.ts).
   */
  hd?: string;
};

export type Provider = "google" | "github";

/** The `name=value` of the first Set-Cookie line of that name with a value, or "". */
function cookieNamed(response: Response, name: RegExp): string {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0 && name.test(pair.slice(0, at)) && pair.slice(at + 1) !== "") return pair;
  }
  return "";
}

export type Begun = { status: number; location: string; state: string; challenge: string; cookie: string };

/** GET /api/auth/:provider, not followed: the provider's address, and the state cookie. */
export async function beginSignIn(base: string, provider: string, from?: string): Promise<Begun> {
  const query = from === undefined ? "" : `?from=${encodeURIComponent(from)}`;
  const response = await fetch(`${base}/api/auth/${provider}${query}`, { redirect: "manual" });
  await response.arrayBuffer();
  const location = response.headers.get("location") ?? "";
  const url = location.startsWith("https://") ? new URL(location) : null;
  return {
    status: response.status,
    location,
    state: url?.searchParams.get("state") ?? "",
    challenge: url?.searchParams.get("code_challenge") ?? "",
    cookie: cookieNamed(response, /^(__Host-)?oauth$/),
  };
}

/** The code the fake provider reads its scenario out of. */
export const codeFor = (who: Who, challenge: string) =>
  Buffer.from(JSON.stringify({ ...who, challenge })).toString("base64url");

export type Returned = { status: number; location: string; setCookies: string[]; cookie: string };

/** GET the callback, as the provider's redirect would, with whatever cookie the test chooses. */
export async function returnFrom(
  base: string,
  provider: string,
  query: Record<string, string>,
  cookie: string | null,
): Promise<Returned> {
  const response = await fetch(`${base}/api/auth/${provider}/callback?${new URLSearchParams(query).toString()}`, {
    redirect: "manual",
    headers: cookie === null || cookie === "" ? {} : { Cookie: cookie },
  });
  await response.arrayBuffer();
  return {
    status: response.status,
    location: response.headers.get("location") ?? "",
    setCookies: response.headers.getSetCookie(),
    cookie: cookieNamed(response, /^(__Host-)?session$/),
  };
}

export type SignedIn = {
  /** The callback's: 303 either way. */
  status: number;
  location: string;
  /** The session cookie's `name=value`, or "" when the sign-in was refused. */
  cookie: string;
  csrf: string;
  account: { id: number; email: string } | null;
};

/**
 * A whole sign-in: the start, the provider's redirect back with a code saying `who`, and the
 * page's own read of /api/session - which is where a browser learns its anti-CSRF token.
 */
export async function signIn(base: string, provider: Provider, who: Who, from?: string): Promise<SignedIn> {
  const begun = await beginSignIn(base, provider, from);
  const back = await returnFrom(base, provider, { code: codeFor(who, begun.challenge), state: begun.state }, begun.cookie);
  if (back.cookie === "") return { status: back.status, location: back.location, cookie: "", csrf: "", account: null };
  const session = await call(base, "/api/session", { headers: { Cookie: back.cookie } });
  return {
    status: back.status,
    location: back.location,
    cookie: back.cookie,
    csrf: String(session.body.csrf ?? ""),
    account: (session.body.account as SignedIn["account"]) ?? null,
  };
}
