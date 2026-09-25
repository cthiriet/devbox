import { file, type BunRequest } from "bun";
import { join } from "node:path";
import {
  API_TOKEN,
  CAP_REFUSALS,
  CLOUDS,
  DATA_DIR,
  FOUNDER_EMAIL,
  MAX_JOBS,
  MAX_JOBS_PER_ACCOUNT,
  MAX_NEW_ACCOUNTS_PER_HOUR,
  ONLINE,
  PORT,
  PUBLIC_DIR,
  PUBLIC_URL,
  RETIRED,
  SECRETS_DIR,
  SESSION_MS,
  SHELL_DIR,
} from "./src/config";
import {
  admission,
  checkedEmail,
  checkedTokenLabel,
  doors,
  foldedEmail,
  FOUNDING_ACCOUNT,
  type Account,
  type Candidate,
} from "./src/accounts";
import {
  authorizationUrl,
  CODE_MAX,
  encodeState,
  exchange,
  isProvider,
  offeredProviders,
  parseState,
  pkcePair,
  PROVIDER_NAMES,
  returnPath,
  takeProviders,
  type FlowState,
  type Provider,
  type Refusal as SignInRefusal,
} from "./src/oauth";
import {
  checkedCandidates,
  checkedSecretValue,
  cloudEntry,
  cloudFieldEntry,
  cloudGaps,
  clouds,
  cloudsThroughService,
  configured,
  destroySourcesFor,
  forgetSecret,
  importSecrets,
  missing,
  missingSecrets,
  openVault,
  overview,
  profileSecretEntry,
  sealedCount,
  sourcesFor,
  storeCloud,
  storeSecret,
  VaultClosed,
  type Sources,
} from "./src/secrets";
import { loadExtension, ordersOnService, refuseOrder } from "./src/extension";
import {
  checkedSecretKind,
  checkedSecretName,
  CLOUD_NAMES,
  SecretRefused,
  VaultError,
  type SecretKind,
} from "./src/vault";
import {
  accountByToken,
  accountsExist,
  accountsWithoutIdentity,
  closeSession,
  closeSessionsOf,
  createToken,
  labels,
  listAccounts,
  openSession,
  orderedAt,
  setLabel,
  purgeSessions,
  readSession,
  recentJobs,
  recordOrigin,
  revokeToken,
  serviceOriginClouds,
  signInWith,
  tokensOf,
  touchSession,
  userById,
  database,
} from "./src/db";
import {
  describedProfiles,
  engineReady,
  engineVersion,
  machine as engineMachine,
  machines,
  orphans,
  prepareDirectories,
  prepareRuntime,
  probe,
  profiles,
  SecretsMissing,
  testCloud,
  type Machine,
  type Profile,
} from "./src/engine";
import { accountTree, holdsMachine, stageRoots, workspaceClouds, type AccountPaths } from "./src/tree";
import { legacyKeyPath, migrateAccounts, relocateSecrets } from "./src/migrate";
import { floorFor } from "./src/floors";
import {
  checkedSpec,
  declaredSecrets,
  forgetProfile,
  isProfileName,
  renderProfile,
  requiredSecrets,
  shippedProfiles,
  storeProfile,
  strangerAt,
  type Authored,
  type ProfileSpec,
} from "./src/profiles";
import { SECRET_GUIDES, secretGuide, SOFTWARE } from "./src/software";
import { authorizeWrite, type Principal } from "./src/guard";
import { cacheControl, resolveAsset } from "./src/http";
import { drawName, readJobRow, readLog, reconcile, spawnDevbox, start, type Refused } from "./src/jobs";
import { makeUndumpable } from "./src/undumpable";
import {
  csrfFromProtocol,
  knownHostFingerprints,
  openTerminal,
  parseControl,
  SUBPROTOCOL,
  type Terminal,
  type TerminalTarget,
} from "./src/terminal";
import { askUnpushed } from "./src/unpushed";
import {
  checkedLabel,
  checkedMachineName,
  checkedProfile,
  createArgv,
  validateCreate,
  validateProbe,
} from "./src/validate";
import {
  cookieAttributes,
  cookieName,
  equalsInConstantTime,
  newToken,
  sessionAlive,
  stateCookieAttributes,
  stateCookieName,
  tokenDigest,
  type Session,
} from "./src/sessions";

const COOKIE = cookieName(ONLINE);

/** The sign-in's own, set by GET /api/auth/:provider and spent by its callback. */
const STATE_COOKIE = stateCookieName(ONLINE);

/** Those the reverse proxy adds to every site in production, so local behaves like it. */
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/* --- the shell -------------------------------------------------------------- */

const SHELL = join(SHELL_DIR, "index.html");

/**
 * What every address a browser can type answers with: one file, whoever is asking.
 *
 * ALWAYS 200, AND THAT IS A CONSTRAINT OF THE PLATFORM RATHER THAN A TASTE. After a reload
 * the hosting platform checks every address the manifest declares, accepts 200 or 401 and
 * nothing else, 401 being a locked preview. Anything else - a 303 to a login page, a 500
 * because a build never ran - counts as "this address no longer answers" and rolls the whole
 * Caddy configuration back, for every client site at once. Measured on 20/08, on this
 * project's first deployment, when `/` redirected an anonymous visitor to /login.
 *
 * Rendering four session-dependent pages was the old way of satisfying that. The SPA makes
 * it easy instead of delicate: this file has nothing in it that depends on the session, so
 * there is no reason left for it ever to be anything but a 200, and the client asks
 * /api/session to find out whether it draws the fleet or the sign-in buttons.
 *
 * The shell is read from SHELL_DIR and not from public/. See src/config.ts: public/ is the
 * manifest's publicDir, excluded from the application rsync, so on the server this process
 * cannot open it at all.
 *
 * A missing shell is a 200 too, for the same rule. It is exactly the state of
 * scripts/simulate-deploy.sh when the build has not run locally, and a 500 there would fail
 * the very check this comment is about - while saying much less than a page naming the
 * command that fixes it.
 */
const NO_SHELL = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Machines devbox</title>
<body style="font:16px/1.5 system-ui;margin:3rem auto;max-width:40rem;padding:0 1rem">
<h1>No shell</h1>
<p>The interface was never built here: <code>shell/index.html</code> does not exist.</p>
<p>From <code>dashboard/</code>: <code>bun run build</code>.</p>
<p>The API does answer: <code>/api/session</code> says where this service stands.</p>
</body></html>
`;

async function shell(): Promise<Response> {
  const headers = {
    ...HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    // Through cacheControl, so this page obeys the one policy the local server and Caddy
    // share. It holds no session and no anti-CSRF token any more, so `no-store` would only
    // buy a re-download of the same bytes on every navigation from a train.
    "Cache-Control": cacheControl("/index.html"),
  };

  const page = file(SHELL);
  if (!(await page.exists())) return new Response(NO_SHELL, { status: 200, headers });
  return new Response(page, { headers });
}

/* --- who is asking ---------------------------------------------------------- */

/** The session a cookie names, and the account it was opened for: never one without the other. */
async function session(req: BunRequest): Promise<{ session: Session; account: Account } | null> {
  const token = req.cookies.get(COOKIE);
  if (token === null || token === "") return null;

  const found = await readSession(token);
  if (found === null) return null;

  const now = Date.now();
  if (!sessionAlive(found.session, SESSION_MS, now)) {
    closeSession(found.session.digest);
    return null;
  }

  touchSession(found.session.digest, now);
  return found;
}

const presentedToken = (req: Request): string | null => {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length) : null;
};

/**
 * The CLI presents a bearer token where a browser presents a cookie.
 *
 * Both land on the same authorization, so there is only one to get right. A token is not
 * subject to the Origin and anti-CSRF checks, which exist against a page the user did not
 * mean to load: a CLI has no origin and cannot be tricked into calling this.
 *
 * Found by its digest, in one indexed lookup, and never by comparing the tokens this service
 * knows one at a time: N comparisons say which token matched by the moment the loop stops.
 * The digest is a SHA-256, so the lookup leaks nothing a stolen database would not already
 * hold - and the database holds no token.
 */
async function bearer(req: Request): Promise<Account | null> {
  const token = presentedToken(req);
  if (token === null || token === "") return null;
  return accountByToken(await tokenDigest(token));
}

/** Which ways in are open, asked of the database and the unit on every call. */
const doorsNow = () =>
  doors({ accounts: accountsExist(), founderEmail: FOUNDER_EMAIL, providers: offeredProviders() });

/**
 * What a token gets while account 1 is still to be founded, and the reason it is a 503 rather
 * than a 401: nothing is wrong with the token: it is that this service holds nothing anyone
 * can act for yet, and the sentence says what to do about it. Its own adoption is the founding.
 */
const UNCLAIMED =
  "no account has been founded on this service yet: sign in once on its page with Google or GitHub" +
  " as DEVBOX_FOUNDER_EMAIL, and DEVBOX_REMOTE_TOKEN becomes that account's token";

/**
 * Who is asking, and the tree their request is served out of - never one without the other.
 *
 * The paths come with the principal rather than being fetched inside each route, and that is
 * the shape the whole feature rests on: a route cannot read a fleet, start a job or open a
 * terminal without having said which account it is for, because the only way to get an
 * AccountPaths is accountTree(id) and the only id in reach is this one's.
 */
type Allowed =
  | { ok: true; principal: Principal; paths: AccountPaths }
  | { ok: false; response: Response };

/**
 * The account's tree, made at its first use in this process, or the reason there is none.
 *
 * 503 and not 500: what fails here is ssh-keygen missing, a disk that will not take a
 * directory, or - the loud one - a public key without its private half, which accountTree
 * refuses rather than minting over. None of that is the request's fault, and all of it is the
 * kind of thing that used to surface three minutes into an `up`, with a machine already
 * ordered. The reason names paths and commands and never a value.
 */
function allow(principal: Principal): Allowed {
  try {
    return { ok: true, principal, paths: accountTree(principal.account.id) };
  } catch (error) {
    return {
      ok: false,
      response: json(
        {
          error: `account ${principal.account.id}'s directory could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
        },
        503,
      ),
    };
  }
}

const asToken = (account: Account): Allowed =>
  allow({ account, via: "token", session: null });

/**
 * WHO is asking - a session or a token - or the answer to give instead.
 *
 * Every read starts here, and reads what that principal's account holds and nothing else:
 * there is no reader left that answers without one. It replaced a mayRead() that answered
 * yes or no, which was the right shape while the service had one user and exactly the wrong
 * one afterwards - a yes said nothing about whose secrets to serve.
 */
async function actor(req: BunRequest): Promise<Allowed> {
  const token = await bearer(req);
  if (token !== null) return asToken(token);
  if (presentedToken(req) !== null && doorsNow().claim) {
    return { ok: false, response: json({ error: UNCLAIMED }, 503) };
  }

  const found = await session(req);
  if (found === null) return { ok: false, response: json({ error: "unauthorized" }, 401) };
  return allow({ account: found.account, via: "session", session: found.session });
}

/** Reads the body of a guarded call, whether it arrives as JSON or as a form. */
async function body(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    return (await req.json().catch(() => ({}))) as Record<string, unknown>;
  }
  return Object.fromEntries((await req.formData()).entries());
}

/**
 * Guards anything that orders a machine or destroys one.
 *
 * src/guard.ts holds the rule and is tested without a server; this only wires it to a
 * request, and lets a bearer token through the same door - unless `bearer: false`.
 *
 * The secrets' writes say false, and the reason is what the token would become otherwise.
 * Before the vault, whoever held it could spend money: order and destroy. With a PUT on a
 * cloud credential, they could swap in an account of their own, then order or seed a machine
 * there, and every profile secret the seed pushes would land on hardware they control - the
 * token would have turned into a way to READ what the vault exists never to show. No CLI verb
 * writes a secret, so nothing is lost; the page writes them, behind a session and its
 * anti-CSRF token, like the terminal (which refuses the token for the same kind of reason).
 */
async function guard(req: BunRequest, options: { bearer?: boolean } = {}): Promise<Allowed> {
  const who = await authorized(req, options);
  return who.ok ? allow(who.principal) : who;
}

/** A principal, without the tree: for the routes about the account itself. */
type Authorized = { ok: true; principal: Principal } | { ok: false; response: Response };

/**
 * guard()'s verdict, without making the account's tree.
 *
 * The routes of /account close sessions and mint or revoke tokens: nothing in them reads a
 * fleet or spawns a child, and an account whose tree cannot be made - ssh-keygen missing, a
 * public key without its private half - must still be able to revoke a leaked token.
 */
async function authorized(req: BunRequest, options: { bearer?: boolean } = {}): Promise<Authorized> {
  if (options.bearer !== false) {
    const token = await bearer(req);
    if (token !== null) return { ok: true, principal: { account: token, via: "token", session: null } };
    if (presentedToken(req) !== null && doorsNow().claim) {
      return { ok: false, response: json({ error: UNCLAIMED }, 503) };
    }
  }

  const found = await session(req);
  const verdict = await authorizeWrite({
    session: found?.session ?? null,
    origin: req.headers.get("origin"),
    publicUrl: PUBLIC_URL,
    csrfReceived: req.headers.get("x-csrf"),
  });

  if (!verdict.ok) return { ok: false, response: json({ error: verdict.reason }, verdict.status) };
  // Unreachable: authorizeWrite answers 401 for a null session. Written rather than asserted,
  // so that the account below is one the database handed back and not one a cast invented.
  if (found === null) return { ok: false, response: json({ error: "session expired" }, 401) };
  return { ok: true, principal: { account: found.account, via: "session", session: found.session } };
}

/**
 * A READ that a session may make and a token may not: the account's own tokens, the founder's
 * list of accounts.
 *
 * Not guard(), whose Origin and anti-CSRF checks exist against a page that makes a browser
 * WRITE: a same-origin GET carries no Origin, the client sends no token on a read, and a page on
 * another origin cannot read the answer anyway. And not actor(), which lets a token through:
 * whoever holds a leaked token would list which tokens exist and when each was last used - the
 * one list that tells them whether theirs has been noticed.
 */
async function sessionRead(req: BunRequest): Promise<Authorized> {
  const found = await session(req);
  if (found === null) return { ok: false, response: json({ error: "unauthorized" }, 401) };
  return { ok: true, principal: { account: found.account, via: "session", session: found.session } };
}

/* --- the secrets ------------------------------------------------------------ */

/** A refusal from a src/ checker, in the contract's shape: the sentence, and the field. */
const invalid = (checked: { field: string; reason: string }) =>
  json({ error: `${checked.field}: ${checked.reason}`, field: checked.field }, 400);

/**
 * A body that must be a JSON object, or null. Not `body()` above, which falls back to
 * formData() and throws on anything else: a PUT with the wrong type is a 400, not a 500.
 */
async function jsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await req.json().catch(() => null);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * What the secrets and the jobs throw, as the answers the contract names.
 *
 * Every message here names a variable, a version, a kind or a name, which is all src/vault.ts
 * ever puts in one: none of them can carry a value, so they are passed through as they are.
 * Anything else is rethrown, and Bun answers it as the 500 it is.
 */
function secretRefusal(error: unknown, sources: Sources): Response {
  if (error instanceof SecretRefused) {
    return json({ error: `${error.field}: ${error.reason}`, field: error.field }, 400);
  }
  if (error instanceof VaultClosed || error instanceof VaultError) {
    return json({ error: error.message }, 503);
  }
  if (error instanceof SecretsMissing) return missingSecrets412(error.names, sources, null);
  throw error;
}

/** `a`, `a and b`, `a, b and c`. */
function inSentence(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * A profile that cannot leave, as a 412: the sentence, the profile, and the names.
 *
 * The sentence is read on a phone by someone who has never met the name `github`: what the
 * profile needs, by the label the catalogue gives it (src/software.ts), and the page that
 * sets it. It said "this service holds no github: set it on /secrets" until 13/09 - true, and
 * a riddle. A name the catalogue does not describe - a hand-written profile may call its
 * secret anything - is named as the name it is. The names travel apart, in `missing`, for
 * whatever reads the answer rather than the sentence.
 *
 * The directory is named only to an account the service's own files answer for. To any other
 * one, depositing a file there would change nothing: its fallback is closed, and the page is
 * the only road. See sourcesFor in src/secrets.ts.
 */
function missingSecrets412(names: readonly string[], sources: Sources, profile: string | null): Response {
  const needed = names.map((name) => {
    const label = secretGuide(name)?.label;
    return label === undefined ? `a secret named ${name}` : `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;
  });
  const it = names.length === 1 ? "it" : "them";
  const files = names.length === 1 ? `a file named ${names[0]}` : `files named ${inSentence(names)}`;
  const where = sources.secretsDir === null ? "" : ` Or deposit ${files} in ${sources.secretsDir}.`;
  const error = `${profile ?? "This profile"} needs ${inSentence(needed)}: add ${it} on the Keys & tokens page.${where}`;
  return json({ error, profile, missing: names }, 412);
}

/**
 * A job not started, as a 409. `job` only when the refusal names one - the job already running
 * on that machine, of the same account. A cap names none: see Refused in src/jobs.ts for why an
 * id handed across accounts is a way to count and probe what another account runs.
 */
function busy(refused: Refused): Response {
  return json(refused.busy === null ? { error: refused.reason } : { error: refused.reason, job: refused.busy }, 409);
}

/**
 * The one answer for a machine this account's tree does not hold - another account's included,
 * deliberately. A 403 would say that it exists, somewhere, and is someone else's.
 */
const noMachine = (name: string) => json({ error: `no machine named '${name}'` }, 404);

/** An account as an answer carries it: an id and an address. */
const shownAccount = (account: Account) => ({
  id: account.id,
  email: account.email,
});

/**
 * Who declares what, and which machine runs which profile - or nothing, when the engine does
 * not answer. The vault's answer does not depend on either, and a page listing every secret
 * with two empty columns is worth more than a 502 listing none.
 */
async function declarers(
  paths: AccountPaths,
  sources: Sources,
): Promise<{ declared: Profile[]; fleet: Machine[] }> {
  const [declared, fleet] = await Promise.allSettled([
    profiles(paths, sources),
    machines(paths, sources),
  ]);
  return {
    declared: declared.status === "fulfilled" ? declared.value : [],
    fleet: fleet.status === "fulfilled" ? fleet.value : [],
  };
}

/**
 * The names a composed profile may not take: every profile devbox ALREADY lists that this
 * service did not render.
 *
 * Asked of the engine rather than read off the disk, because devbox is what decides: it
 * searches $CONFIG_DIR before its own directory, so a composed `claude` would not collide
 * with the published one - it would silently replace it, for every order and every seed, on
 * the page and on the CLI alike. The published profiles and any deposited by hand are the
 * same case and are found the same way.
 *
 * A listing that fails falls back to what the engine directory holds, which is the half that
 * matters most and needs no child to answer.
 */
async function shadowable(paths: AccountPaths, sources: Sources): Promise<string[]> {
  try {
    // The prefix is THIS account's profile directory, drawn from the same paths the listing
    // was made with. Drawn from anywhere else, a composed profile of one account would read
    // as a stranger's file in another's, and the save would be refused for a file that
    // account cannot even see.
    return (await profiles(paths, sources))
      .filter((one) => !one.path.startsWith(`${paths.profilesDir}/`))
      .map((one) => one.name);
  } catch {
    return shippedProfiles();
  }
}

/**
 * What the profile routes answer with: the spec as it is now held, the script it renders
 * into, and the secrets it declares - separated into what a seed cannot start without and
 * what it merely reads.
 *
 * The script is returned on a save as well as on a preview, deliberately: the page then
 * shows what was actually written rather than what it believed it asked for.
 */
function composed(spec: ProfileSpec, script: string, saved: Authored | null = null) {
  return {
    name: spec.name,
    spec,
    script,
    declared: declaredSecrets(spec),
    required: requiredSecrets(spec),
    created_at: saved?.created_at ?? null,
    updated_at: saved?.updated_at ?? null,
  };
}

/** The entry PUT answers with: the same shape as its row in GET /api/secrets. */
async function secretEntry(
  paths: AccountPaths,
  kind: SecretKind,
  name: string,
  sources: Sources,
): Promise<unknown> {
  if (kind === "cloud") return cloudFieldEntry(name, sources);
  const { declared, fleet } = await declarers(paths, sources);
  return profileSecretEntry(name, declared, fleet, sources);
}

/* --- startup ---------------------------------------------------------------- */

prepareDirectories();

/**
 * The data directory of the one-user service, turned into account 1's tree - once, before
 * anything is served and before the roots are staged.
 *
 * Nothing reads tf/, home/, config/ and logs/ at the top of DATA_DIR any more, so a service
 * that came up without moving them would answer an empty fleet with the machines still
 * billing. It throws rather than starting when a live state has no key to go with it: see
 * src/migrate.ts, which is where the whole argument is.
 */
{
  const migration = migrateAccounts({ dataDir: DATA_DIR, keyPath: legacyKeyPath() });
  for (const line of migration?.lines ?? []) console.log(line);

  // Before the vault opens: its first opening reads the fallback directory, and a directory
  // still sitting inside account 1's tree would be read as empty. See src/migrate.ts.
  const relocation = relocateSecrets({
    dataDir: DATA_DIR,
    secretsDirVariable: process.env.DEVBOX_SECRETS_DIR,
  });
  for (const line of relocation?.lines ?? []) console.log(line);
  for (const line of relocation?.warnings ?? []) console.warn(`/!\\ ${line}`);
}

/**
 * The Terraform sources prepared once, for every account: accountTree copies them into a tree
 * only when its `tf/.roots` names a different digest. See src/tree.ts.
 */
stageRoots();

/**
 * ONCE PER PROCESS, and `bun run dev` is why it has to be said. It runs `bun --hot`, which
 * evaluates this file again at every save and keeps globalThis. Three things below are a
 * process's first moments and nothing else, and each did harm when repeated - measured on
 * 11/09:
 *
 *   the vault     the key is read and then deleted from process.env, so the second reading
 *                 found nothing and closed the vault until the next restart;
 *   the sweep     removes every launch directory, and "later" is exactly when it pulls a
 *                 running job's secrets from under it - see sweepLaunches;
 *   reconcile     marks every running job interrupted, a job this very process is running.
 *
 * So they run at the first evaluation, and every later one finds the state they left where
 * src/secrets.ts and src/engine.ts keep it, on globalThis.
 */
const STARTED = Symbol.for("devbox.dashboard.started");
const once = globalThis as { [STARTED]?: true };
const firstEvaluation = once[STARTED] === undefined;
once[STARTED] = true;

if (firstEvaluation) {
  /**
   * Before the vault, and before anything can spawn a child. Deleting the key from
   * process.env keeps it out of what a child is HANDED; this keeps a child of the same
   * account from reading it back out of /proc/<pid>/environ, which the delete does not
   * touch. Linux only: see src/undumpable.ts.
   */
  const undumpable = makeUndumpable();
  if (undumpable !== null && !undumpable.applied) {
    console.warn(
      `/!\\ this process could not be made undumpable (${undumpable.reason}):` +
        " any process of this account - devbox-core, terraform, a provider plugin - can read" +
        " its initial environment, the master key included, from /proc.",
    );
  }

  /**
   * The vault first, before anything can spawn a child: openVault reads the master key and
   * removes it from process.env, which engineEnv hands to every child. See src/secrets.ts.
   */
  const opening = openVault();
  if (opening.status.available) {
    console.log(
      opening.rewrapped > 0
        ? `vault open; ${opening.rewrapped} owner(s) moved to the new master key, with a new data key and every value resealed: DEVBOX_MASTER_KEY_PREVIOUS can go at the next restart`
        : "vault open",
    );
    // Names only, like everything this service says about a secret.
    if (opening.imported.length > 0) {
      console.log(
        `first opening: ${opening.imported.length} secret(s) taken in from the environment and ${SECRETS_DIR}: ${opening.imported.join(", ")}`,
      );
    }
  } else {
    // Started anyway, like an incomplete configuration below, and for the same reason. What
    // changes the tone is whether anything sealed is being left unread.
    const sealed = sealedCount();
    if (sealed > 0) {
      console.warn(
        `/!\\ the vault is closed (${opening.status.reason}) and the database seals ${sealed} value(s):` +
          " no job can read them, and the environment and the files answer in their place.",
      );
    } else {
      console.log(`vault closed (${opening.status.reason}): secrets come from the environment and ${SECRETS_DIR}`);
    }
  }

  /**
   * The sign-in providers, taken like the master key and for its two reasons: once, since the
   * four variables leave process.env as they are read and a second evaluation would find none;
   * and before anything can spawn a child, which would otherwise inherit two client secrets. See
   * takeProviders in src/oauth.ts. Which of them are offered is said with the doors, below.
   */
  const taken = takeProviders();
  for (const half of taken.halfSet) {
    console.warn(`/!\\ ${half.set} is set without ${half.unset}: ${PROVIDER_NAMES[half.provider]} sign-in is not offered`);
  }

  /**
   * Where each launch's secrets are laid out, said once: it is the one place the plaintext of
   * a sealed value ever sits outside this process. See prepareLaunch in src/engine.ts.
   */
  const { runtime, swept, kept } = prepareRuntime();
  if (runtime.note !== null) console.warn(`/!\\ ${runtime.note}`);
  const where = `launch secrets under ${runtime.path} (${runtime.chosen})`;
  if (runtime.medium === "memory") console.log(`${where}, in memory`);
  else {
    console.warn(
      `/!\\ ${where}, ON DISK: a deleted file's bytes stay in freed blocks.` +
        " Point DEVBOX_RUNTIME_DIR at a tmpfs to keep them in memory.",
    );
  }
  if (swept > 0) {
    console.warn(`/!\\ removed ${swept} launch directory(ies) left by a previous run that stopped mid-launch`);
  }
  for (const line of kept) console.warn(`/!\\ ${line}`);

  // The composed profiles a row can no longer be read back from are named at each account's
  // first use now, by accountTree, with the account: the rows are an account's since 13/09,
  // and a startup line naming every account's would put one account's profile names in a
  // sentence about all of them.

  const leftOver = reconcile();
  if (leftOver > 0) {
    console.warn(
      `/!\\ ${leftOver} job(s) were still running when this service last stopped.` +
        " They are marked interrupted. A machine may exist that no state knows about:" +
        " check the orphans on the fleet page.",
    );
  }
} else {
  console.log("reloaded: the vault, the launch directories and the jobs are as this process's first evaluation left them");
}

/**
 * The caps, said once: how many jobs may run at once is the unit's, and the number an operator
 * reads after a 409 has to be the one this process actually took. See src/config.ts.
 */
console.log(`jobs: at most ${MAX_JOBS} at once, ${MAX_JOBS_PER_ACCOUNT} per account`);
console.log(`accounts: at most ${MAX_NEW_ACCOUNTS_PER_HOUR} new per hour`);
for (const refused of CAP_REFUSALS) console.warn(`/!\\ ${refused}`);

if (!engineReady()) {
  console.warn(
    "/!\\ engine/ is missing or incomplete: `bun run build` was never run here." +
      " Nothing can be ordered until it is.",
  );
}

/**
 * Which way in is open, said at every start - the table of doors() in src/accounts.ts - and what
 * the password era left in the unit. The founding is the line worth reading twice: the next
 * sign-in with that verified address takes account 1 and everything this service holds.
 */
{
  const open = doorsNow();
  if (open.providers.length > 0) console.log(`sign-in: ${open.providers.join(", ")}`);

  if (open.closed === "no-provider") {
    console.warn(
      "/!\\ no sign-in provider (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or GITHUB_CLIENT_ID and" +
        " GITHUB_CLIENT_SECRET): this service can open no session at all; CLI tokens still answer",
    );
  } else if (open.closed === "no-founder") {
    console.warn(
      "/!\\ no account yet and no DEVBOX_FOUNDER_EMAIL: this service can open no session at all." +
        " Name the address that is to found account 1, and restart.",
    );
  }

  if (open.claim) {
    console.log(
      "no account yet: the first sign-in whose verified address is DEVBOX_FOUNDER_EMAIL founds account 1," +
        " and every secret, machine and job this service holds becomes that account's; every other" +
        " sign-in is refused until then",
    );
  } else if (accountsExist()) {
    // Both are read until account 1 exists and by nothing after. Left in the unit, the address
    // would look like it still decides something, and DEVBOX_REMOTE_TOKEN like the CLI's key,
    // when the key is now a row of api_tokens that removing the variable does not revoke.
    if (FOUNDER_EMAIL !== "") {
      console.log("DEVBOX_FOUNDER_EMAIL is set and read by nothing: account 1 exists. It can leave the service's environment");
    }
    if (API_TOKEN !== "") {
      console.log(
        "DEVBOX_REMOTE_TOKEN is set and read by nothing any more: it was adopted as a token of" +
          " account 1, and removing the variable revokes nothing",
      );
    }
    // A count, never an address: the accounts of the password era, each waiting for a sign-in
    // whose verified address folds to its own. Until then only a CLI token of theirs answers.
    const waiting = accountsWithoutIdentity();
    if (waiting > 0) {
      console.log(
        `${waiting} account(s) have no Google or GitHub identity yet: each opens at the first sign-in whose verified address is its own`,
      );
    }
  }

  // The password era's two variables open nothing since 15/09, and are only asked whether they
  // are set. Said at every start while they are: a stale digest in a unit file is an offline guess
  // at a password its owner may use elsewhere.
  for (const [name, set] of Object.entries(RETIRED)) {
    if (set) {
      console.warn(
        `/!\\ ${name} is set and read by nothing since sign-in moved to Google and GitHub: it can leave the service's environment`,
      );
    }
  }

  // The founder's, explicitly: it is the account the service's own credentials were deposited
  // for, and the only one a service with no session open can say anything about.
  const founder = userById(FOUNDING_ACCOUNT);
  if (founder !== null && !configured(sourcesFor(founder))) {
    console.warn(
      `/!\\ account ${founder.id} can order from no cloud, missing: ${missing(sourcesFor(founder)).join(", ")}`,
    );
  }
}

/** What /api/session says when no session can open, under Details on the login page. */
const NO_PROVIDER = "No sign-in provider is configured: this service can open no session at all.";
const NO_FOUNDER = "This service has never had an account and names no founder: it can open no session at all.";

/** A redirect that no cache keeps: every one below carries a cookie or a refusal. */
function redirect(location: string, status: 302 | 303): Response {
  return new Response(null, { status, headers: { ...HEADERS, Location: location, "Cache-Control": "no-store" } });
}

/** The state cookie, gone: on every answer of the callback, a session opened or not. */
const clearedState = () => serialiseCookie({ ...stateCookieAttributes("", ONLINE), maxAge: 0 });

/**
 * A sign-in that opened nothing: back to the login page with a word from a fixed vocabulary, and
 * the page says the sentence. No provider text and no address ever goes into this URL - it lands
 * in a history, a Referer, a screenshot - and the journal is where the reason is named.
 *
 * A 303 and not a 401, deliberately, for the reason the shell is always a 200: the answer arrives
 * as a top-level navigation, and a browser shows a status code as a broken page.
 */
function refusedSignIn(refused: SignInRefusal, provider: Provider | null, minutes?: number): Response {
  const query = new URLSearchParams({ refused });
  if (provider !== null) query.set("provider", provider);
  if (minutes !== undefined) query.set("minutes", String(minutes));
  const response = redirect(`/login?${query.toString()}`, 303);
  response.headers.append("Set-Cookie", clearedState());
  return response;
}

/**
 * The callback's steps once its state has been checked, from the provider's error to the session:
 * see the route in the table below for the order and each refusal. A function of its own so that
 * the route can answer whatever it throws with the state cookie cleared.
 */
async function afterState(provider: Provider, query: URLSearchParams, flow: FlowState): Promise<Response> {
  if (query.get("error") !== null) return refusedSignIn("denied", provider);

  const code = query.get("code") ?? "";
  if (code === "" || code.length > CODE_MAX) {
    console.log(`${provider} sign-in refused: the provider sent back no usable code`);
    return refusedSignIn("provider", provider);
  }

  const exchanged = await exchange(provider, { code, verifier: flow.verifier, publicUrl: PUBLIC_URL });
  if (!exchanged.ok) {
    console.log(`${provider} sign-in refused: ${exchanged.reason}`);
    return refusedSignIn(exchanged.refused, provider);
  }

  // The addresses as this service stores them. One a provider verified can still be one no
  // account here can hold - too long once folded, a second `@` out of NFKC - and is dropped.
  const candidates = exchanged.emails.flatMap(({ email, authoritative }): Candidate[] => {
    const checked = checkedEmail(email);
    return checked.ok ? [{ email: checked.value, folded: foldedEmail(checked.value), authoritative }] : [];
  });
  if (candidates.length === 0) {
    console.log(`${provider} sign-in refused: no verified address this service can hold`);
    return refusedSignIn("address", provider);
  }

  const now = Date.now();
  const founderFolded = FOUNDER_EMAIL === "" ? "" : foldedEmail(FOUNDER_EMAIL);
  const adopted = API_TOKEN === "" ? null : await tokenDigest(API_TOKEN);
  const signed = signInWith(
    { provider, subject: exchanged.subject, candidates },
    now,
    (facts) => admission({ ...facts, founderFolded, cap: MAX_NEW_ACCOUNTS_PER_HOUR }),
    adopted,
  );

  if (signed.outcome === "unfounded") {
    console.log(`${provider} sign-in refused: no account has been founded, and no verified address is DEVBOX_FOUNDER_EMAIL`);
    return refusedSignIn("unfounded", provider);
  }
  if (signed.outcome === "unvouched") {
    // Named without the address, and without saying whose account holds it.
    console.log(`${provider} sign-in refused: its address is an account's, or the founder's, and ${provider} does not vouch for it`);
    return refusedSignIn("unvouched", provider);
  }
  if (signed.outcome === "busy") {
    console.warn(
      `/!\\ ${provider} sign-in refused: ${MAX_NEW_ACCOUNTS_PER_HOUR} account(s) were created in the last hour (DEVBOX_MAX_NEW_ACCOUNTS_PER_HOUR)`,
    );
    return refusedSignIn("busy", provider, signed.minutes);
  }

  const id = signed.account.id;
  if (signed.outcome === "known") console.log(`account ${id} signed in with ${provider}`);
  if (signed.outcome === "linked") console.log(`${provider} identity linked to account ${id}`);
  if (signed.outcome === "created") console.log(`account ${id} created with ${provider}`);
  if (signed.outcome === "founded") {
    console.log(`account ${id} founded with ${provider} as DEVBOX_FOUNDER_EMAIL: the variable is read by nothing from now on`);
    if (adopted !== null) {
      console.log(
        `DEVBOX_REMOTE_TOKEN adopted as account ${id}'s first token: the CLI keeps working, and removing the variable revokes nothing`,
      );
    }
  }
  return await openedSession(signed.account, now, flow.from);
}

/**
 * The one place a session is opened: the cookie, and a 303 to where the sign-in began. The
 * anti-CSRF token is not in this answer, which is a redirect nobody reads: the page learns it
 * from GET /api/session, as it does on every load (SessionProvider in web/src/components).
 *
 * THE SESSION COOKIE STAYS STRICT, and what that does here is worth knowing before it looks like
 * a bug. It is set on a response to a navigation that began on the provider's site, and a browser
 * stores it; it is then NOT sent on the navigation to `from` that follows, the chain having started
 * cross-site. That costs nothing: `from` is served the shell, which depends on no session, and the
 * shell's own same-origin fetch of /api/session carries the cookie. Lax would have bought nothing
 * but a cookie sent on cross-site navigations, which is what Strict exists to refuse.
 */
async function openedSession(account: Account, now: number, from: string): Promise<Response> {
  purgeSessions(now - SESSION_MS);
  const { token } = await openSession(account.id, now);
  const response = redirect(from, 303);
  response.headers.append("Set-Cookie", serialiseCookie(cookieAttributes(token, ONLINE, SESSION_MS)));
  response.headers.append("Set-Cookie", clearedState());
  return response;
}

/* --- the terminals ---------------------------------------------------------- */

/**
 * What a connected socket carries. `terminal` is filled in `open` and not before: the
 * route decides WHETHER to connect, the socket is what the connection talks through, and
 * one exists only after the other.
 */
type Attached = {
  machine: string;
  /** Whose terminal it is: the per-account limit counts these. */
  account: number;
  target: TerminalTarget;
  /**
   * The key of the account whose terminal this is, carried on the socket rather than read
   * from a constant when the connection opens. There is no service-wide key any more: a
   * machine was created with ITS account's pair, and any other one is refused by the machine.
   */
  keyPath: string;
  terminal: Terminal | null;
};

/**
 * Four at once, and the number comes from the unit rather than from taste: deploy.json
 * declares its `memory` - 256M when this was counted, 1G since jobs run several at once,
 * src/config.ts says why - shared with everything else this service does: the SQLite
 * database, the running jobs' logs, three cloud probes. Each terminal is an SSH connection and
 * a buffer per direction; four is comfortable, forty is a service that dies in the middle of a
 * `terraform apply` and takes a machine's creation with it.
 *
 * Two of the four per account, since there is more than one: without it one account's tabs,
 * left reloading in a pocket, would be every other account's refusal. The refusal says which
 * limit it met - "close a tab of yours" and "the service is full" are two different gestures.
 *
 * Counted rather than trusted to the browser: one tab per machine is the ordinary use, and
 * this is what stops a page left reloading in a pocket from opening the fifth.
 */
const MAX_TERMINALS = 4;
const MAX_TERMINALS_PER_ACCOUNT = 2;
const live = new Set<Bun.ServerWebSocket<Attached>>();

/**
 * Machines being asked what they hold, keyed `<account>/<machine>`.
 *
 * In memory and per process, like the terminal counts above: it guards a burst of clicks,
 * not a distributed system, and a restart clearing it costs one extra SSH connection.
 */
const asking = new Set<string>();

/** Why one more terminal cannot open for this account, or null when it can. */
function terminalRefusal(account: number): string | null {
  const mine = [...live].filter((ws) => ws.data.account === account).length;
  if (mine >= MAX_TERMINALS_PER_ACCOUNT) {
    return `this account already has ${mine} terminals open, which is its limit: close one of them first`;
  }
  if (live.size >= MAX_TERMINALS) {
    return `this service already has ${live.size} terminals open, which is its limit: try again once one closes`;
  }
  return null;
}

/** Text frames, server to browser: everything that is not the shell's own bytes. */
const notice = (ws: Bun.ServerWebSocket<Attached>, text: string) =>
  ws.send(JSON.stringify({ notice: text }));

/**
 * The private extension a hosted service deposits, or none: see src/extension.ts. Loaded before
 * the routes are built, because its own are part of them, and said in one line either way.
 */
const extension = await loadExtension({
  db: database,
  actor: async (req) => {
    const who = await actor(req as BunRequest);
    return who.ok ? { ok: true, account: who.principal.account } : { ok: false, response: who.response };
  },
  guard: async (req, options) => {
    const who = await guard(req as BunRequest, options);
    return who.ok ? { ok: true, account: who.principal.account } : { ok: false, response: who.response };
  },
  json,
  log: (line) => console.log(line),
});
(extension.warning ? console.warn : console.log)(extension.line);

/**
 * The terminal's four moments. The connection is opened here and not in the route,
 * because it is the socket that talks through it and the socket does not exist yet when
 * the route decides.
 */
const websocket: Bun.WebSocketHandler<Attached> = {
  /**
   * Two minutes, against a client that sends nothing back.
   *
   * A phone that went into a tunnel and a tab closed by iOS look identical from here, and
   * both would otherwise hold an SSH connection to a machine for as long as the process
   * lives. lib/terminal.ts pings every thirty seconds, so a live tab resets this four
   * times over, and a dead one costs at most two minutes of one of the four slots. What
   * it costs the user is nothing: tmux still holds the session, and reconnecting lands
   * back in it.
   */
  idleTimeout: 120,

  /** A paste is the big frame here, and a megabyte of it is already an odd paste. */
  maxPayloadLength: 1024 * 1024,

  open(ws) {
    live.add(ws);
    ws.data.terminal = openTerminal(
      ws.data.target,
      ws.data.keyPath,
      // What the browser measured arrives as the first control frame, milliseconds from
      // now. These are the numbers a pty is born with in the meantime.
      { cols: 80, rows: 24 },
      {
        onData: (chunk) => {
          // A negative answer is backpressure: the socket has more queued than it can
          // write, and `cat` of a large file will otherwise fill this process's memory
          // with a terminal nobody is reading. Stopping the shell is what a real terminal
          // does when its reader stops reading.
          if (ws.send(chunk) <= 0) ws.data.terminal?.pause();
        },
        onNotice: (text) => notice(ws, text),
        onClose: (reason) => {
          ws.send(JSON.stringify({ closed: reason }));
          ws.close();
        },
      },
    );
  },

  message(ws, message) {
    // Binary is the stream, text is control, and the split is what stops a paste
    // containing a JSON object from being read as one. See src/terminal.ts.
    if (typeof message !== "string") {
      ws.data.terminal?.write(message);
      return;
    }

    const control = parseControl(message);
    if (control === null) return;
    if (control.type === "resize") ws.data.terminal?.resize(control.cols, control.rows);
  },

  drain(ws) {
    ws.data.terminal?.resume();
  },

  close(ws) {
    live.delete(ws);
    ws.data.terminal?.close();
    ws.data.terminal = null;
  },
};

/* --- routes ----------------------------------------------------------------- */

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  development: false,

  /**
   * Bun closes an idle connection after ten seconds by default, and a probe is not idle -
   * it is a request whose answer takes longer than that to compute.
   *
   * Measured on 31/08, the day GCP joined the list: Caddy logged `EOF` with a duration of
   * 12,0027 s, twice, to the millisecond, and answered 502 with an empty body. The probe
   * itself had SUCCEEDED - the price cache it writes was on disk, complete, byte for byte
   * the workstation's - so nothing in a log said the answer had been thrown away. Two
   * clouds took 10,6 s warm and fitted under the ceiling by half a second; three with a
   * cold catalogue do not.
   *
   * 200 s rather than a number that merely clears today's measurement. src/engine.ts gives
   * the probe 180 s and kills the child there, so this has to sit ABOVE that ceiling or it
   * becomes the real one - and a timeout that fires before the one meant to fire reports
   * `EOF` instead of naming the cloud that was slow.
   */
  idleTimeout: 200,

  /**
   * 1 MiB, where Bun's default is 128: a body is read whole into memory before a route can refuse
   * it, and every job of the service runs under the same MemoryMax - a few large bodies at once
   * would be paid for by the `apply` in flight, not by the request.
   *
   * Sized to the largest body a legitimate request sends, with room to spare. That is a cloud saved
   * whole or tried (PUT /api/clouds/:cloud, POST /api/clouds/:cloud/test): GCP's key, 64 KiB at most
   * (MAX_SECRET_BYTES in src/vault.ts), beside its project, or Scaleway's three fields at 64 KiB
   * each. JSON doubles a quote, a backslash or a newline and writes any other control character in
   * six bytes, and a single-line field refuses control characters: at worst 384 KiB for GCP's key
   * escaped end to end plus 128 KiB for its project, 384 KiB for Scaleway's three. A real key is a
   * few KiB; a profile spec, an address or a label, far less.
   *
   * Refused with a 413 before any route runs, on the Content-Length - and ONLY on it. Measured on
   * 15/09 with Bun 1.3.11: 1 MiB and 10 bytes sent chunked, without a Content-Length, were read
   * whole. A page's fetch and the CLI send a Content-Length with every body they write, so this
   * bounds what they send; a client that sends chunked is bounded by the reverse proxy's own limit,
   * when one is set, and by nothing here.
   */
  maxRequestBodySize: 1024 * 1024,

  routes: {
    /* --- the SPA, one file for every address a browser arrives at ------------- */

    "/": shell,
    "/login": shell,
    "/account": shell,
    "/machine/:name": shell,
    "/job/:id": shell,
    "/jobs": shell,
    "/orphans": shell,
    "/new": shell,
    "/new/*": shell,
    "/profiles": shell,
    "/profiles/*": shell,
    "/secrets": shell,

    /* --- the API, shared by the browser and the CLI --------------------------- */

    /**
     * Who am I - and never a 401, which is the whole point of the route.
     *
     * "Nobody" is a valid answer here: it is what the shell asks before it knows whether to
     * draw the fleet or the sign-in buttons, and answering 401 would turn the ordinary state
     * of a first visit into an error the client has to special-case. Everything it carries
     * unauthenticated is deliberately a name and never a value: which providers sign in here,
     * whether account 1 is still to be founded - the login screen has to be able to say "this
     * service can open no session at all" rather than draw buttons that lead nowhere.
     *
     * `csrf` is empty for a bearer holder as well as for an anonymous caller, and that is
     * not an oversight: a token is exempt from the anti-CSRF check (see bearer above), so
     * there is no token to hand it and nothing it could do with one. A browser that has just
     * come back from a provider learns its token HERE: the callback that opened its session is
     * a redirect, and nobody reads a redirect's body.
     *
     * WHAT AN ANONYMOUS CALLER IS TOLD CHANGED WITH ACCOUNTS, and it had to. This answer used
     * to carry which clouds the service could order from, what it was missing and where its
     * secrets live, to whoever asked - which was a description of account 1's credentials,
     * published on the open internet. Those three are now an account's, computed for the
     * account asking and for nobody else: no session and no token, no clouds, no directory,
     * and `configured` null rather than false - not "incomplete", but "not a question about
     * you". What a login screen needs is still here for everyone: `doors`, the providers and
     * whether the founding is ahead, and `disabled`, the service that can open no session at all.
     */
    "/api/session": async (req) => {
      const found = await session(req);
      const account = found?.account ?? (await bearer(req));
      const open = doorsNow();
      const sources = account === null ? null : sourcesFor(account);
      return json({
        authenticated: account !== null,
        account: account === null ? null : shownAccount(account),
        csrf: found?.session.csrf ?? "",
        doors: { claim: open.claim, providers: open.providers },
        // clouds(), not the constant: this is the list the creation form draws its
        // choices from, and validateCreate refuses anything outside the same list. Serving
        // the wider one would put a cloud in the form that POST /api/machines then rejects.
        clouds: sources === null ? [] : clouds(sources),
        configured: sources === null ? null : configured(sources),
        missing: sources === null ? [] : missing(sources),
        // The service's directory is named to the account its profile files answer for.
        secrets_dir: sources?.profileFiles === true ? sources.secretsDir : null,
        engine: { ...engineVersion(), ready: engineReady() },
        disabled: open.closed === "no-provider" ? NO_PROVIDER : open.closed === "no-founder" ? NO_FOUNDER : null,
      });
    },

    /**
     * Where a Google or GitHub sign-in starts: a state and a PKCE verifier drawn, bound to this
     * browser in the state cookie together with the path to come back to, and a 302 to the
     * provider's fixed address. See src/oauth.ts.
     *
     * No Origin check, unlike every write here, and not by oversight. A page of another origin
     * that sends a visitor here only starts a sign-in with the VISITOR's own provider account, in
     * the visitor's own browser - nothing it could not do by linking to the provider itself. The
     * reverse, someone else's account signed into this browser, is login CSRF, and that is what
     * the state cookie refuses at the callback; `__Host-` keeps a sibling subdomain from planting
     * one.
     *
     * Under /api/, and never declared as an address of its own: deploy.json's `/api/*` already
     * sends it to Bun, and a declared address has to answer 200 or 401 to the platform's check,
     * which a redirect never does. See CLAUDE.md, "Web app and routes".
     */
    "/api/auth/:provider": {
      GET: async (req) => {
        const named = req.params.provider;
        const provider = isProvider(named) ? named : null;
        if (provider === null || !offeredProviders().includes(provider)) return refusedSignIn("unavailable", provider);

        const state = newToken();
        const { verifier, challenge } = await pkcePair();
        const from = returnPath(new URL(req.url).searchParams.get("from"));
        const location = authorizationUrl(provider, { publicUrl: PUBLIC_URL, state, challenge });
        if (location === null) return refusedSignIn("unavailable", provider);

        const response = redirect(location, 302);
        response.headers.append(
          "Set-Cookie",
          serialiseCookie(stateCookieAttributes(encodeState({ provider, state, verifier, from }), ONLINE)),
        );
        return response;
      },
    },

    /**
     * The provider sending the browser back - and, on a service that has never had an account,
     * the founding of account 1. In this order, every refusal a 303 to the login page with the
     * state cookie cleared, and the session a 303 to where the sign-in began:
     *
     *   provider   offered by this process                                   else `unavailable`
     *   state      the cookie's, for this provider, equal to the query's     else `state`
     *   error      the person declined at the provider                       `denied`
     *   code       present, and no longer than a code is                     else `provider`
     *   exchange   code, verifier and client secret, for a subject and its
     *              verified addresses (src/oauth.ts)                         `provider`, `unverified`
     *   addresses  each through checkedEmail                                 none left: `address`
     *   account    signInWith: known, linked, founded or created             `unvouched`, `unfounded`,
     *                                                                        `busy`
     *
     * The state is compared in constant time and BEFORE anything is sent to a provider: a code
     * arriving without the cookie this browser was handed is someone else's sign-in, and
     * exchanging it would sign this browser into their account. The journal names the provider,
     * the step and the account's id - never the code, a token or an address.
     *
     * Everything after the state check runs inside one catch, and the reason is the cookie. A throw
     * there - the database busy past its timeout under signInWith, a disk refusing the session row -
     * was a 500 that Bun wrote without it, and a state cookie left behind is a verifier left in a
     * browser for ten minutes after a flow that is over. Caught, it is `failed`: the journal names
     * the error's class or SQLite code, never its message, and the cookie leaves with the answer.
     */
    "/api/auth/:provider/callback": {
      GET: async (req) => {
        const named = req.params.provider;
        const provider = isProvider(named) ? named : null;
        if (provider === null || !offeredProviders().includes(provider)) return refusedSignIn("unavailable", provider);

        const query = new URL(req.url).searchParams;
        const flow = parseState(req.cookies.get(STATE_COOKIE));
        const state = query.get("state") ?? "";
        if (flow === null || flow.provider !== provider || state === "" || !(await equalsInConstantTime(flow.state, state))) {
          console.log(`${provider} sign-in refused: its state is not the one this browser was given`);
          return refusedSignIn("state", provider);
        }
        try {
          return await afterState(provider, query, flow);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          const named = typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
          console.error(`/!\\ ${provider} sign-in failed after its state was checked (${named})`);
          return refusedSignIn("failed", provider);
        }
      },
    },

    "/api/logout": {
      POST: async (req) => {
        const found = await session(req);
        if (found !== null) closeSession(found.session.digest);
        const response = json({ redirect: "/" });
        response.headers.append(
          "Set-Cookie",
          serialiseCookie({ ...cookieAttributes("", ONLINE, 0), maxAge: 0 }),
        );
        return response;
      },
    },

    /* --- the account itself: a session, never the CLI token ------------------- */

    /** Every session of the account, the one asking included. Tokens are not sessions. */
    "/api/account/sessions/close": {
      POST: async (req) => {
        const allowed = await authorized(req, { bearer: false });
        if (!allowed.ok) return allowed.response;
        const closed = closeSessionsOf(allowed.principal.account.id, null);
        console.log(`account ${allowed.principal.account.id} signed out everywhere: ${closed} session(s) closed`);
        const response = json({ ok: true });
        response.headers.append(
          "Set-Cookie",
          serialiseCookie({ ...cookieAttributes("", ONLINE, 0), maxAge: 0 }),
        );
        return response;
      },
    },

    /**
     * The CLI's tokens, each shown ONCE: the answer that creates one is the only one that ever
     * carries it, and only its SHA-256 is stored, like a session's. `dvb_` in front so that a
     * token pasted where it should not be - a log, a chat, a repository - is recognisable, by a
     * reader and by a secret scanner, for what it is.
     */
    "/api/account/tokens": {
      GET: async (req) => {
        const who = await sessionRead(req);
        if (!who.ok) return who.response;
        return json(tokensOf(who.principal.account.id));
      },

      POST: async (req) => {
        const allowed = await authorized(req, { bearer: false });
        if (!allowed.ok) return allowed.response;
        const label = checkedTokenLabel((await jsonObject(req))?.label);
        if (!label.ok) return invalid(label);

        const now = Date.now();
        const token = `dvb_${newToken()}`;
        const id = createToken(allowed.principal.account.id, await tokenDigest(token), label.value, now);
        console.log(`account ${allowed.principal.account.id} created token ${id}`);
        return json({ id, label: label.value, created_at: now, token }, 201);
      },
    },

    /**
     * Scoped in the statement itself - `WHERE id = ? AND user_id = ?` - so that another
     * account's token and a token that does not exist are one answer, the same 404, and the
     * ids of api_tokens say nothing about who holds what.
     */
    "/api/account/tokens/:id": {
      DELETE: async (req) => {
        const allowed = await authorized(req, { bearer: false });
        if (!allowed.ok) return allowed.response;
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || !revokeToken(allowed.principal.account.id, id)) {
          return json({ error: "no such token" }, 404);
        }
        console.log(`account ${allowed.principal.account.id} revoked token ${id}`);
        return json({ ok: true });
      },
    },

    "/api/machines": {
      GET: async (req) => {
        const who = await actor(req);
        if (!who.ok) return who.response;
        // Plus the hour it was ordered, which devbox does not know and this database does.
        // Without it the fleet shows a price per hour and no hours: the number that
        // decides to destroy tonight rather than tomorrow is what a machine has already
        // cost, and it cannot be read anywhere else. Null for a machine this dashboard
        // never ordered, and the screen then says nothing rather than guessing.
        const account = who.principal.account.id;
        const fleet = await machines(who.paths, sourcesFor(who.principal.account));
        const named = labels(account);
        return json(
          fleet.map((one) => ({
            ...one,
            ordered_at: orderedAt(account, one.name),
            label: named.get(one.name) ?? null,
          })),
        );
      },

      POST: async (req) => {
        const allowed = await guard(req);
        if (!allowed.ok) return allowed.response;
        // An extension's refusal - a subscription, a quota - comes before anything is read.
        const refused = await refuseOrder(allowed.principal.account, "up");
        if (refused !== null) return json({ error: refused.error }, refused.status);
        // Everything below reads what THIS account holds, and nothing of any other's: its
        // vault, and the service's cloud accounts only where an extension puts it on them.
        const sources = sourcesFor(allowed.principal.account);

        const available = await profiles(allowed.paths, sources);
        const checked = validateCreate(
          await body(req),
          available.map((one) => one.name),
          clouds(sources),
        );
        if (!checked.ok) {
          return json({ error: `${checked.field}: ${checked.reason}` }, 400);
        }

        // Refused before anything is ordered. A machine created and then unable to seed
        // is a machine on the meter with nothing on it, and the failure would only show
        // three minutes in.
        const chosen = available.find((one) => one.name === checked.value.profile);
        const needed = chosen?.secrets ?? [];
        const absent = missingSecrets(needed, sources);
        if (absent.length > 0) return missingSecrets412(absent, sources, checked.value.profile);

        // Named here rather than by devbox, so the job has an identity from the moment it is
        // recorded. See src/jobs.ts#drawName.
        const request = { ...checked.value, name: checked.value.name ?? drawName() };
        const now = Date.now();
        let started;
        try {
          started = start(
            allowed.paths,
            {
              verb: "up",
              argv: createArgv(request),
              machine: request.name,
              cloud: request.cloud,
              profile: request.profile,
              secrets: needed,
            },
            now,
            spawnDevbox,
            sources,
          );
        } catch (error) {
          return secretRefusal(error, sources);
        }
        if (!started.ok) return busy(started);
        // Whose credentials this machine went to, read off the resolution that has just laid them
        // out for the job - in the same synchronous stretch as start(), so no request in between
        // can connect or delete a token and make the two disagree. The destroy reads it back and
        // cannot learn it anywhere else: see destroySourcesFor in src/secrets.ts.
        recordOrigin(allowed.principal.account.id, {
          machine: request.name,
          cloud: request.cloud,
          via: cloudEntry(request.cloud, sources).via === "service" ? "service" : "own",
          orderedAt: now,
        });
        return json({ job: started.id, machine: request.name, redirect: `/job/${started.id}` });
      },
    },

    "/api/machines/:name": async (req) => {
      const who = await actor(req);
      if (!who.ok) return who.response;
      const name = checkedMachineName(req.params.name);
      if (!name.ok) return json({ error: `${name.field}: ${name.reason}` }, 400);
      // A machine of another account is one this tree's state does not name: a 404 before any
      // devbox is launched, and never a 403, which would confirm it exists somewhere.
      if (!holdsMachine(who.paths, name.value)) return noMachine(name.value);
      try {
        const account = who.principal.account.id;
        const detail = await engineMachine(who.paths, name.value, sourcesFor(who.principal.account));
        return json({
          ...detail,
          label: labels(account).get(name.value) ?? null,
          ordered_at: orderedAt(account, name.value),
        });
      } catch (error) {
        return json({ error: String(error) }, 404);
      }
    },

    /**
     * A name for a person, beside the name for the machine.
     *
     * It changes nothing but what is displayed: the Terraform workspace, the ssh Host
     * alias, the resource at the provider and the machine's own hostname all keep the one
     * name devbox drew, which is the point (see the labels table in src/schema.ts). Guarded
     * like any other write all the same - it is a row this service stores on behalf of
     * whoever is logged in, and there is exactly one door into that.
     *
     * Keyed by the account and the name, and not checked against the fleet: a label on a name
     * this account does not hold labels nothing it can see, and touches no other account's
     * machine of that name - which is the whole of what has to be true.
     */
    "/api/machines/:name/label": {
      POST: async (req) => {
        const allowed = await guard(req);
        if (!allowed.ok) return allowed.response;

        const name = checkedMachineName(req.params.name);
        if (!name.ok) return json({ error: `${name.field}: ${name.reason}` }, 400);

        const label = checkedLabel((await body(req)).label ?? "");
        if (!label.ok) return json({ error: `${label.field}: ${label.reason}` }, 400);

        // The empty string is a removal, so one control both names and un-names.
        setLabel(allowed.principal.account.id, name.value, label.value, Date.now());
        return json({ label: label.value === "" ? null : label.value });
      },
    },

    /**
     * What this machine is holding that nowhere else has, for the dialog that destroys it.
     *
     * A POST for a read, like `POST /api/clouds/:cloud/test` and for the same reason: it
     * reaches out of this server with THIS account's key, on an address whoever holds a
     * session may name, and that is guarded like a write whatever the verb says. Same door as
     * the destroy it stands in front of, so an account that may destroy the machine may see
     * what destroying it costs - and nothing is offered here that a terminal on the same
     * machine would not show in one command.
     *
     * One at a time per machine: a dialog opened twice, or a thumb on a slow connection, would
     * otherwise be two SSH connections asking the same question. 409 rather than a queue,
     * because the answer to the first is the answer to the second.
     *
     * A failure is an ANSWER here (`known: false`, with a reason), never a status: the page
     * has a red button to draw either way, and a 500 would leave it saying nothing about a
     * machine it is about to destroy. See src/unpushed.ts.
     */
    "/api/machines/:name/unpushed": {
      POST: async (req) => {
        const allowed = await guard(req);
        if (!allowed.ok) return allowed.response;

        const name = checkedMachineName(req.params.name);
        if (!name.ok) return json({ error: `${name.field}: ${name.reason}` }, 400);
        // Another account's machine is a 404 here as everywhere, before anything is opened.
        if (!holdsMachine(allowed.paths, name.value)) return noMachine(name.value);

        const key = `${allowed.principal.account.id}/${name.value}`;
        if (asking.has(key)) {
          return json({ error: "already looking at that machine" }, 409);
        }
        asking.add(key);
        try {
          let detail;
          try {
            detail = await engineMachine(
              allowed.paths,
              name.value,
              sourcesFor(allowed.principal.account),
            );
          } catch {
            // A machine `ls` cannot resolve - half created, state gone - is one to destroy,
            // not one to refuse: the dialog opens on a doubt rather than on an error.
            return json({ known: false, why: "this machine has no address in the state" });
          }
          const port = detail.port ?? 22;
          const recorded = await file(join(allowed.paths.home, ".ssh", "known_hosts"))
            .text()
            .catch(() => "");
          const answer = await askUnpushed(
            {
              host: detail.ip,
              port,
              user: detail.user,
              fingerprints: knownHostFingerprints(recorded, detail.ip, port),
            },
            allowed.paths.sshKey,
          );
          return json(answer);
        } finally {
          asking.delete(key);
        }
      },
    },

    "/api/machines/:name/destroy": {
      POST: async (req) => {
        const allowed = await guard(req);
        if (!allowed.ok) return allowed.response;
        const account = allowed.principal.account;

        const name = checkedMachineName(req.params.name);
        if (!name.ok) return json({ error: `${name.field}: ${name.reason}` }, 400);

        // The browser retypes the name, and the server checks it again: a confirmation
        // enforced only in a page is no confirmation at all for anything holding the
        // bearer token.
        const confirm = (await body(req)).confirm;
        if (confirm !== name.value) {
          return json({ error: "retype the machine name to confirm" }, 400);
        }

        // Before anything else is asked, and read off this account's own state: another
        // account's machine is a 404 here, with no job written and no devbox launched. See
        // holdsMachine for why a workspace directory and not the `ls` below, which skips the
        // half-created machine a destroy exists for.
        if (!holdsMachine(allowed.paths, name.value)) return noMachine(name.value);

        // Its cloud, as its state names it: `ls`, which reads the state and no provider - and is
        // handed no credential, whoever's - and for the half-created machine `ls` skips, the one
        // cloud whose state holds its workspace. A name held under two clouds, or a cloud this
        // service does not know, is left to devbox-core, whose own refusal names it better than a
        // guess here.
        const listed = await machines(allowed.paths, sourcesFor(account)).catch(() => null);
        const workspaces = workspaceClouds(allowed.paths, name.value);
        const named =
          listed?.find((m) => m.name === name.value)?.cloud ?? (workspaces.length === 1 ? workspaces[0] : undefined);
        const cloud = CLOUDS.find((one) => one === named);

        // The credentials this machine was ordered with, and no others: see destroySourcesFor for
        // the `down` that would otherwise reach another provider account's project, and succeed.
        const sources = destroySourcesFor(account, name.value, cloud);

        // Still reachable, asked BEFORE a job is recorded. Since 11/09 a cloud's credentials can be
        // deleted from a page while machines still run on it, and without this the destroy was
        // accepted, written as a job, and died three lines into the log on "HCLOUD_TOKEN is not
        // set" - the machine still on the meter, and the fleet page showing a failed job instead of
        // the one thing to do about it.
        if (cloud !== undefined) {
          const gaps = cloudGaps(cloud, sources);
          if (gaps.length > 0) {
            return json(
              {
                // In the words of the page that fixes it: the variable names are in `missing`.
                error: `${name.value} runs on ${CLOUD_NAMES[cloud]}, which is no longer connected here: connect ${CLOUD_NAMES[cloud]} again on the Account page, then destroy it. It bills until then.`,
                cloud,
                missing: gaps,
              },
              412,
            );
          }
        }

        let started;
        try {
          started = start(
            allowed.paths,
            {
              verb: "down",
              argv: ["down", "--quiet", name.value],
              machine: name.value,
              cloud: null,
              profile: null,
              // A destroy pushes nothing into the machine: its cloud's credentials, no more.
              secrets: [],
            },
            Date.now(),
            spawnDevbox,
            sources,
          );
        } catch (error) {
          return secretRefusal(error, sources);
        }
        if (!started.ok) return busy(started);
        return json({ job: started.id, redirect: `/job/${started.id}` });
      },
    },

    "/api/machines/:name/seed": {
      POST: async (req) => {
        const allowed = await guard(req);
        if (!allowed.ok) return allowed.response;
        const refused = await refuseOrder(allowed.principal.account, "seed");
        if (refused !== null) return json({ error: refused.error }, refused.status);
        const sources = sourcesFor(allowed.principal.account);

        const name = checkedMachineName(req.params.name);
        if (!name.ok) return json({ error: `${name.field}: ${name.reason}` }, 400);
        // Another account's machine: a 404 before a job is written, as for a destroy.
        if (!holdsMachine(allowed.paths, name.value)) return noMachine(name.value);

        // Phase 2 alone, and the way a token is rotated. No confirmation here: seeding is
        // re-runnable by design and destroys nothing, which is the whole difference
        // between it and destroy.
        const input = await body(req);
        // See createArgv: the closing card belongs to whoever is watching, and here
        // that is a browser looking at a job log, not this server.
        const argv = ["seed", name.value, "--quiet"];

        const available = await profiles(allowed.paths, sources);
        let asked: string | null = null;
        if (input.profile !== undefined && input.profile !== "") {
          const profile = checkedProfile(
            input.profile,
            available.map((one) => one.name),
          );
          if (!profile.ok) return json({ error: `${profile.field}: ${profile.reason}` }, 400);
          argv.push("--profile", profile.value);
          asked = profile.value;
        }

        // No --repo here either: the repository is a property of the profile.
        if (input.repo !== undefined && input.repo !== "") {
          return json(
            { error: "repo: the repository belongs in the profile, not in a request" },
            400,
          );
        }

        // Which profile will actually run, which is also whose secrets the launch is handed:
        // the one asked for, or the one recorded in the ssh config for this machine, or -
        // with neither - DEVBOX_PROFILE, which the child inherits: a launch holding another
        // profile's secrets would seed one that asks for none. With none of the three, no
        // secret is laid out and the core refuses on its own, in its own words: there is no
        // default profile since 24/09 (`PROFILE=${DEVBOX_PROFILE:-}` in devbox-core).
        //
        // Read off `ls`, which carries the same recorded profile as `info` without the thirty
        // seconds of ssh-keyscan against a live host that `info` spends on a fingerprint.
        const detail =
          asked === null
            ? ((await machines(allowed.paths, sources).catch(() => null))?.find((one) => one.name === name.value) ?? null)
            : null;
        const runningName = asked ?? detail?.profile ?? (process.env.DEVBOX_PROFILE || null);
        const running = available.find((one) => one.name === runningName);
        const needed = running?.secrets ?? [];
        const absent = missingSecrets(needed, sources);
        if (absent.length > 0 && runningName !== null) return missingSecrets412(absent, sources, runningName);

        let started;
        try {
          started = start(
            allowed.paths,
            {
              verb: "seed",
              argv,
              machine: name.value,
              cloud: null,
              profile: null,
              secrets: needed,
            },
            Date.now(),
            spawnDevbox,
            sources,
          );
        } catch (error) {
          return secretRefusal(error, sources);
        }
        if (!started.ok) return busy(started);
        return json({ job: started.id, redirect: `/job/${started.id}` });
      },
    },

    /**
     * A shell on the machine, in this browser - the whole of the web terminal's server side.
     *
     * WHY THIS ROUTE IS NOT GUARDED LIKE THE OTHERS, though it lands on the same verdict.
     * A WebSocket handshake gets none of the protections an ordinary request has: CORS does
     * not apply to it, so a page on any origin may open one here and only this code refuses
     * it; and `new WebSocket(url)` sets no headers, so the anti-CSRF token cannot arrive in
     * `X-CSRF`. It travels in `Sec-WebSocket-Protocol`, which src/terminal.ts unpacks, and
     * then authorizeWrite decides exactly as it does for `down` - a session, our origin,
     * that session's token.
     *
     * A bearer token is deliberately NOT accepted. The CLI already has `devbox ssh`, which is
     * a better shell than this one, and every door that opens a root prompt is worth having
     * one fewer key to.
     *
     * It is a write in every sense that matters: what comes out of the other end is a root
     * prompt on a machine holding unpushed work. It is guarded as one.
     *
     * The host key is read from the dashboard's own known_hosts, written when the machine
     * was created - see src/terminal.ts#knownHostFingerprints for why `devbox info`'s live
     * keyscan is not an anchor.
     */
    "/api/machines/:name/terminal": async (req, server) => {
      const name = checkedMachineName(req.params.name);
      if (!name.ok) return json({ error: `${name.field}: ${name.reason}` }, 400);

      const found = await session(req);
      const verdict = await authorizeWrite({
        session: found?.session ?? null,
        origin: req.headers.get("origin"),
        publicUrl: PUBLIC_URL,
        // Either header, and the second is what makes a refusal legible. A browser is told
        // nothing about a handshake the server declined - no status, no body, just close
        // code 1006 - so lib/terminal.ts asks this same address again as a plain GET, with
        // the token in X-CSRF, and reads the real answer: 503 when the four slots are
        // taken, 404 for a machine that no longer exists, 426 when the connection would
        // have been fine and something else broke it. The check is the same one either
        // way; only the envelope differs.
        csrfReceived:
          csrfFromProtocol(req.headers.get("sec-websocket-protocol")) ??
          req.headers.get("x-csrf"),
      });
      if (!verdict.ok) return json({ error: verdict.reason }, verdict.status);
      // Unreachable with an ok verdict, which refuses a null session; written out so the
      // machine below is resolved for an account the database named.
      if (found === null) return json({ error: "session expired" }, 401);

      const tree = allow({ account: found.account, via: "session", session: found.session });
      if (!tree.ok) return tree.response;

      const full = terminalRefusal(found.account.id);
      if (full !== null) return json({ error: full }, 503);

      // Another account's machine resolves nowhere in this tree: the same 404 an unknown name
      // gets, before a devbox is launched to say so.
      if (!holdsMachine(tree.paths, name.value)) return noMachine(name.value);

      let detail;
      try {
        detail = await engineMachine(tree.paths, name.value, sourcesFor(found.account));
      } catch (error) {
        // A machine of another account resolves nowhere in this tree, so it is a 404 here
        // too, and deliberately the same one an unknown name gets: a 403 would say that the
        // machine exists and belongs to someone else.
        return json({ error: String(error) }, 404);
      }

      const port = detail.port ?? 22;
      // The account's own known_hosts, written by devbox-core at `up` in this same tree. The
      // service-wide one is gone with the service-wide HOME, and that is the point: a host
      // key recorded for one account's machine anchors nothing for another's.
      const recorded = await file(join(tree.paths.home, ".ssh", "known_hosts"))
        .text()
        .catch(() => "");

      // Asked again after the awaits above, which is where two handshakes of one account can
      // both have passed the first count.
      const stillFull = terminalRefusal(found.account.id);
      if (stillFull !== null) return json({ error: stillFull }, 503);

      const upgraded = server.upgrade(req, {
        data: {
          machine: name.value,
          account: found.account.id,
          target: {
            host: detail.ip,
            port,
            user: detail.user,
            fingerprints: knownHostFingerprints(recorded, detail.ip, port),
          },
          keyPath: tree.paths.sshKey,
          terminal: null,
        } satisfies Attached,
        // Echoed, because a browser that named a subprotocol fails the connection outright
        // when the server names none back. Only the first entry: the second was the token.
        headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL },
      });
      if (!upgraded) return json({ error: "this address speaks WebSocket only" }, 426);
      return undefined;
    },

    /**
     * The profiles, each carrying what only this service knows about it.
     *
     * devbox's own answer, plus the secrets this disk is missing and the floors devbox-core would
     * fill the blanks with. See engine.ts#describeProfiles for why the enrichment is a
     * second function rather than a richer `profiles --json`.
     */
    "/api/profiles": async (req) => {
      const who = await actor(req);
      if (!who.ok) return who.response;
      return json(await describedProfiles(who.paths, sourcesFor(who.principal.account)));
    },

    /**
     * What a composed profile can install, and what each entry demands in exchange.
     *
     * A read, and a constant: the catalogue is code. It is an address rather than a copy in
     * the bundle because the rule it carries - this software wants that secret - has to be
     * the same one the save is checked against, and a copy in the interface would be right
     * until the day the server learned a new entry.
     */
    "/api/software": async (req) => {
      const who = await actor(req);
      if (!who.ok) return who.response;
      // The secrets by name beside the software, for the pages that hold a name and nothing
      // else - /secrets, /new - and would otherwise show `github` to someone who asked for a
      // machine. See SECRET_GUIDES.
      return json({ software: SOFTWARE, secrets: SECRET_GUIDES });
    },

    /**
     * The script a spec would be rendered into, without writing anything.
     *
     * So the page can show exactly what will run as root on the machine, from the one
     * renderer - a preview drawn in the browser would be a second renderer, and the day the
     * two disagreed the preview would be the reassuring one.
     *
     * A POST because it carries a body, and guarded like a write for the same reason: the
     * spec names repositories and secrets, and this is the dashboard's own shape, not
     * something the CLI token composes.
     */
    "/api/profiles/preview": {
      POST: async (req) => {
        const allowed = await guard(req, { bearer: false });
        if (!allowed.ok) return allowed.response;

        const input = await jsonObject(req);
        if (input === null) return invalid({ field: "spec", reason: "expected a JSON body" });
        const spec = checkedSpec(
          input.name,
          input,
          await shadowable(allowed.paths, sourcesFor(allowed.principal.account)),
        );
        if (!spec.ok) return invalid(spec);

        return json(composed(spec.value, renderProfile(spec.value, Date.now())));
      },
    },

    /**
     * One composed profile, written or removed.
     *
     * The row first and the rendered file second - see storeProfile. Guarded with
     * `bearer: false`, like the writes on /secrets and for a relative of their reason: a
     * profile decides what runs AS ROOT on a machine this service orders, and which of its
     * secrets are pushed into that machine's /run/secrets. Whoever held the CLI token could
     * otherwise compose a profile that mails them every secret the seed lays out. No CLI verb
     * writes a profile, so nothing is lost.
     */
    "/api/profiles/:name": {
      PUT: async (req) => {
        const allowed = await guard(req, { bearer: false });
        if (!allowed.ok) return allowed.response;

        const input = await jsonObject(req);
        if (input === null) return invalid({ field: "spec", reason: "expected a JSON body" });
        const spec = checkedSpec(
          req.params.name,
          input,
          await shadowable(allowed.paths, sourcesFor(allowed.principal.account)),
        );
        if (!spec.ok) return invalid(spec);

        // A file of that name this service did not write: a profile deposited by hand, which
        // is how a real deployment carries the ones this repository may not name. devbox-core
        // would read that file and not this row, so saving would compose a profile nobody
        // could see running. Refused by naming the file rather than silently shadowed.
        if (strangerAt(spec.value.name, allowed.paths.profilesDir)) {
          return json(
            {
              error: `${spec.value.name}.sh already exists in ${allowed.paths.profilesDir} and was not written here: it is yours, and this service does not overwrite it`,
              field: "name",
            },
            409,
          );
        }

        const { saved, script } = storeProfile(allowed.paths, spec.value, Date.now());
        return json(composed(saved.spec, script, saved));
      },

      DELETE: async (req) => {
        const allowed = await guard(req, { bearer: false });
        if (!allowed.ok) return allowed.response;

        const name = req.params.name;
        if (name === "") return invalid({ field: "name", reason: "empty" });
        // Before anything else touches it: Bun decodes `%2f` in a path parameter, and this
        // name becomes a file name. A name devbox-core could never resolve is a profile that
        // does not exist - the same 404, so a traversal attempt learns nothing either. See
        // isProfileName in src/profiles.ts for what reached another account's tree without it.
        if (!isProfileName(name)) return json({ error: "no composed profile by that name" }, 404);

        // A machine seeded with it is a machine `devbox seed` could no longer reprovision:
        // cmd_seed reads the profile back out of its ssh config and resolves the FILE. Named
        // before anything is removed, the way a destroy names a missing credential.
        const { fleet } = await declarers(allowed.paths, sourcesFor(allowed.principal.account));
        const running = fleet.filter((machine) => machine.profile === name).map((m) => m.name);
        if (running.length > 0) {
          return json(
            {
              error: `${running.join(", ")} ${running.length === 1 ? "runs" : "run"} this profile: seeding ${running.length === 1 ? "it" : "them"} again would have no profile to read`,
              machines: running,
            },
            412,
          );
        }

        const { deleted, removed } = forgetProfile(allowed.paths, name);
        if (!deleted && !removed) return json({ error: "no composed profile by that name" }, 404);
        return json({ deleted, removed });
      },
    },

    /**
     * Every secret this service can hand a job: names, where each comes from, a fingerprint
     * when the vault holds it - and never a value, on any road. See src/secrets.ts#overview,
     * which reads no ciphertext and opens no file to answer. Each cloud carries the live
     * machines on it, which its credentials are still needed to destroy.
     *
     * A read, guarded like the others: the names alone say which clouds and which
     * repositories this service reaches, which is not something to hand to anyone asking.
     */
    "/api/secrets": {
      GET: async (req) => {
        const who = await actor(req);
        if (!who.ok) return who.response;
        const sources = sourcesFor(who.principal.account);
        const { declared, fleet } = await declarers(who.paths, sources);
        return json(overview(declared, fleet, sources));
      },
    },

    /**
     * What the service held before the vault - the cloud variables of its environment, the
     * files of SECRETS_DIR - copied in once. Never over a value the vault already holds: see
     * importLegacy in src/vault.ts for why a replay would undo a rotation.
     */
    "/api/secrets/import": {
      POST: async (req) => {
        const allowed = await guard(req, { bearer: false });
        if (!allowed.ok) return allowed.response;
        const sources = sourcesFor(allowed.principal.account);
        // The founder's alone: the service's variables and files become the founding account's
        // vault rows, which is where the service's cloud accounts are set. Any other account
        // would be copying the service's credentials into a vault they were never meant for.
        if (allowed.principal.account.id !== FOUNDING_ACCOUNT) {
          return json(
            { error: "only the founding account imports the service's own credentials" },
            403,
          );
        }
        try {
          return json(importSecrets(Date.now(), sources));
        } catch (error) {
          return secretRefusal(error, sources);
        }
      },
    },

    /**
     * One secret, written or removed - and written ONLY: nothing on this address ever answers
     * with what it was sent. The answer is the entry as the vault now holds it, a fingerprint
     * and a date.
     */
    "/api/secrets/:kind/:name": {
      PUT: async (req) => {
        const allowed = await guard(req, { bearer: false });
        if (!allowed.ok) return allowed.response;

        const kind = checkedSecretKind(req.params.kind);
        if (!kind.ok) return invalid(kind);
        const name = checkedSecretName(kind.value, req.params.name);
        if (!name.ok) return invalid(name);

        const input = await jsonObject(req);
        if (input === null) return invalid({ field: "value", reason: "expected a JSON body { value }" });
        const value = checkedSecretValue(kind.value, name.value, input.value);
        if (!value.ok) return invalid(value);

        const sources = sourcesFor(allowed.principal.account);
        try {
          storeSecret(kind.value, name.value, value.value, Date.now(), sources);
        } catch (error) {
          return secretRefusal(error, sources);
        }
        return json(await secretEntry(allowed.paths, kind.value, name.value, sources));
      },

      /**
       * The name is looked up as given and never checked against today's rule, like
       * deleteSecret itself: a rule tightened later must not strand a row that can then be
       * neither read nor removed. It only ever reaches a bound SQL parameter.
       *
       * `fallback` is what takes over: the variable or the file the vault was shadowing, now
       * the value the next job reads - or nothing, and the page says the secret is gone.
       */
      DELETE: async (req) => {
        const allowed = await guard(req, { bearer: false });
        if (!allowed.ok) return allowed.response;

        const kind = checkedSecretKind(req.params.kind);
        if (!kind.ok) return invalid(kind);
        const name = req.params.name;
        if (name === "") return invalid({ field: "name", reason: "empty" });

        const { deleted, fallback } = forgetSecret(
          kind.value,
          name,
          Date.now(),
          sourcesFor(allowed.principal.account),
        );
        if (!deleted) return json({ error: `the vault holds no ${kind.value} secret by that name` }, 404);
        return json({ deleted: true, fallback });
      },
    },

    /**
     * A cloud's credentials, saved together: every value given, or none of them.
     *
     * The page saved a cloud one PUT per field until 13/09, and a refusal at the second left
     * the first written - a new Scaleway access key beside the old secret, a pair that answers
     * nothing, on a cloud that worked a minute before. See setSecrets in src/vault.ts.
     *
     * The same checks as PUT /api/secrets/cloud/:name, all before the transaction opens: a name
     * of THIS cloud, one line where one line is due, the vault's emptiness and size. A refusal
     * names the field and writes nothing. Any non-empty subset of the cloud's fields, so that
     * replacing one Scaleway secret is still one value. Guarded like every secret's write, for
     * its reason: the CLI token never writes a credential.
     *
     * The answer is the cloud as GET /api/secrets draws it, without the machines: a save does
     * not change them, and listing them costs a child.
     */
    "/api/clouds/:cloud": {
      PUT: async (req) => {
        const allowed = await guard(req, { bearer: false });
        if (!allowed.ok) return allowed.response;

        const cloud = CLOUDS.find((one) => one === req.params.cloud);
        if (cloud === undefined) {
          return invalid({ field: "cloud", reason: `expected one of ${CLOUDS.join(", ")}` });
        }
        const input = await jsonObject(req);
        if (input === null) return invalid({ field: "values", reason: "expected a JSON body { values }" });
        const values = checkedCandidates(cloud, input.values);
        if (!values.ok) return invalid(values);

        const sources = sourcesFor(allowed.principal.account);
        try {
          if (Object.keys(values.value).length === 0) {
            return invalid({ field: "values", reason: "nothing to save" });
          }
          storeCloud(values.value, Date.now(), sources);
        } catch (error) {
          return secretRefusal(error, sources);
        } finally {
          for (const bytes of Object.values(values.value)) bytes.fill(0);
        }
        return json(cloudEntry(cloud, sources));
      },
    },

    /**
     * Whether a cloud accepts these credentials, writing nothing: see testCloud in
     * src/engine.ts. A POST and a write in every other sense - it carries credentials, and
     * it spends a provider's API calls on this service's behalf - so it is guarded as one.
     *
     * Any cloud devbox-core implements, and not only the usable ones: trying a credential
     * before it is saved is the whole point, and a cloud with nothing set yet is the first
     * one anybody tries.
     */
    "/api/clouds/:cloud/test": {
      POST: async (req) => {
        const allowed = await guard(req, { bearer: false });
        if (!allowed.ok) return allowed.response;

        const cloud = CLOUDS.find((one) => one === req.params.cloud);
        if (cloud === undefined) {
          return invalid({ field: "cloud", reason: `expected one of ${CLOUDS.join(", ")}` });
        }
        const input = await jsonObject(req);
        const values = checkedCandidates(cloud, input?.values);
        if (!values.ok) return invalid(values);

        try {
          return json(
            await testCloud(allowed.paths, cloud, values.value, sourcesFor(allowed.principal.account)),
          );
        } finally {
          for (const bytes of Object.values(values.value)) bytes.fill(0);
        }
      },
    },

    /**
     * What can be created right now, cheapest first - the first step of the `up` wizard.
     *
     * Slow by nature: three cloud APIs over the network, and a GCP catalogue assembled from
     * the billing SKUs the first time it is asked. It is a GET because it changes nothing,
     * but it is never a page load's incidental request - a screen asks for it deliberately.
     *
     * `floors` says what the search was actually run above, and it is not decoration: an
     * empty `offers` means "nothing creatable ABOVE these numbers", and a reader who cannot
     * see them has no way to know that the disk floor is the knob. The values are the
     * request's own where it named them, and devbox-core's template where it did not.
     *
     * 502 rather than 500 when devbox fails: what broke is upstream - a provider's API, a
     * credential, a timeout - and the distinction is the difference between "this dashboard
     * is broken" and "Hetzner did not answer".
     */
    "/api/probe": async (req) => {
      const who = await actor(req);
      if (!who.ok) return who.response;
      const sources = sourcesFor(who.principal.account);

      const query = new URL(req.url).searchParams;
      const checked = validateProbe(Object.fromEntries(query), clouds(sources));
      if (!checked.ok) return json({ error: `${checked.field}: ${checked.reason}` }, 400);

      try {
        const { offers, skipped } = await probe(who.paths, checked.value, sources);
        return json({
          offers,
          skipped,
          floors: {
            cpu: floorFor("cpu", checked.value.cpu ?? null).value,
            ram: floorFor("ram", checked.value.ram ?? null).value,
            disk: floorFor("disk", checked.value.disk ?? null).value,
          },
        });
      } catch (error) {
        return json({ error: String(error) }, 502);
      }
    },

    /**
     * What this dashboard actually runs, so a workstation can see that its fix is not
     * deployed.
     *
     * The gap this closes: devbox-core on a Mac and engine/devbox here are two files, and only
     * a deployment renews the second. A correction to the first changes nothing about
     * what a job does until then - which cost a morning of correcting, re-running, and
     * watching the same bug survive.
     *
     * Guarded like every other read here. The CLI always holds the token once DEVBOX_REMOTE
     * is set, and - more to the point - a 401 has to stay distinguishable from the 404 an
     * older dashboard answers: the client reads that 404 as proof it is talking to a
     * build made before this route existed, which is the one gap it can be certain about
     * without comparing anything at all.
     */
    "/api/version": async (req) => {
      const who = await actor(req);
      if (!who.ok) return who.response;
      return json({ ...engineVersion(), ready: engineReady() });
    },

    /**
     * What the providers run that no state of THIS account knows about - or a 409, when that
     * question has no honest answer for this account.
     *
     * An orphan is "at the provider, and not in my state". On a provider account that several
     * accounts of this service order on - the service's own credentials, spent by every account
     * granted the fallback - another account's machine answers that definition exactly: it is
     * at the provider, and it is in no state of this tree. Listed, it would read as this
     * account's own forgotten machine, billing, on a page that says to go and destroy it.
     *
     * Refused rather than filtered, because the provider cannot say whose machine it is: a name
     * drawn by devbox-core is five characters, a filter on names is a guess, and the one
     * mistake a guess can make here is showing someone else's machine as garbage. See
     * cloudsThroughService in src/secrets.ts for the two ways an account can be on such a
     * provider account. An account whose clouds all resolve from its own vault keeps its orphans.
     */
    "/api/orphans": async (req) => {
      const who = await actor(req);
      if (!who.ok) return who.response;
      const account = who.principal.account;
      const sources = sourcesFor(account);
      // The accounts that may be ordering on THIS account's cloud accounts: only the founder's
      // are ever shared - with those an extension puts on them today, and with every account
      // holding a machine it ordered on them, which an extension may have taken off them since.
      const founder = account.id === FOUNDING_ACCOUNT;
      const shared = cloudsThroughService(
        sources,
        founder
          ? listAccounts()
              .filter((one) => one.id !== account.id && ordersOnService(one))
              .map((one) => one.id)
          : [],
        founder ? serviceOriginClouds(account.id) : new Set<string>(),
      );
      if (shared.length > 0) {
        return json(
          {
            error:
              `${shared.join(", ")} ${shared.length === 1 ? "is" : "are"} reached with credentials other accounts of this service may be ordering on too:` +
              " an orphan is a machine at the provider that no state of THIS account names, and theirs would be listed as yours." +
              " Nothing is listed rather than someone else's machine; the provider's console lists them all.",
            clouds: shared,
          },
          409,
        );
      }
      try {
        return json(await orphans(who.paths, sources));
      } catch (error) {
        return json({ error: String(error) }, 502);
      }
    },

    "/api/jobs": async (req) => {
      const who = await actor(req);
      if (!who.ok) return who.response;
      return json(recentJobs(who.principal.account.id, 50));
    },

    /** One job's row. The log is a second call, because it is polled and this is not. */
    "/api/jobs/:id": async (req) => {
      const who = await actor(req);
      if (!who.ok) return who.response;
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return json({ error: "not a job id" }, 400);
      // Another account's job is a 404 like a missing one, never a 403: ids are global and
      // consecutive, and a 403 would let anyone count what the others run.
      const job = readJobRow(who.principal.account.id, id);
      if (job === null) return json({ error: "no such job" }, 404);
      return json(job);
    },

    "/api/jobs/:id/log": async (req) => {
      const who = await actor(req);
      if (!who.ok) return who.response;
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return json({ error: "not a job id" }, 400);
      const job = readJobRow(who.principal.account.id, id);
      if (job === null) return json({ error: "no such job" }, 404);
      const offset = Number(new URL(req.url).searchParams.get("offset") ?? 0);
      // The whole remainder once the job is over, so a last line without a trailing
      // newline is not withheld forever.
      const log = await readLog(
        who.paths,
        id,
        Number.isInteger(offset) && offset >= 0 ? offset : 0,
        job.state !== "running",
      );
      return json({ ...log, state: job.state, exit_code: job.exit_code });
    },

    /**
     * Anything else under /api/, in the shape the caller is parsing.
     *
     * Without this an unknown verb fell through to the static handler and answered
     * `not found` as text/plain, which a fetch() reading JSON reports as a parse error -
     * "Unexpected token n" instead of "no such route". The client deserves the truth in the
     * one format it asked for.
     */
    // An extension's own, every one under /api/ext/ (src/extension.ts checked it at load).
    ...(extension.extension?.routes ?? {}),

    "/api/*": (req: BunRequest) => json({ error: `no such route: ${new URL(req.url).pathname}` }, 404),
  },

  websocket,

  /** Static files, which Caddy serves in production and this serves locally. */
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const resolved = resolveAsset(pathname, PUBLIC_DIR);
    if (resolved === null) return new Response("not found", { status: 404, headers: HEADERS });

    const asset = file(resolved);
    if (!(await asset.exists())) return new Response("not found", { status: 404, headers: HEADERS });

    return new Response(asset, {
      headers: { ...HEADERS, "Cache-Control": cacheControl(pathname) },
    });
  },
});

/** Bun.serve does not set cookies from an object outside a route's own `cookies` map. */
function serialiseCookie(attributes: ReturnType<typeof cookieAttributes>): string {
  const parts = [
    `${attributes.name}=${attributes.value}`,
    `Path=${attributes.path}`,
    `Max-Age=${attributes.maxAge}`,
    `SameSite=${attributes.sameSite === "strict" ? "Strict" : "Lax"}`,
  ];
  if (attributes.httpOnly) parts.push("HttpOnly");
  if (attributes.secure) parts.push("Secure");
  return parts.join("; ");
}

// The port the socket is bound to, not the one asked for: PORT=0 lets the kernel choose, which
// is how tests/secrets-api.test.ts starts this file without fighting anything for a port.
console.log(`devbox on http://127.0.0.1:${server.port}, public at ${PUBLIC_URL}`);
