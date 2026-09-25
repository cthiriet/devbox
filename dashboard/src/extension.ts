import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Account } from "./accounts";

/**
 * What a private extension of the dashboard may decide, and the loader that installs one.
 *
 * The repository is the dashboard anyone can host: every account orders machines on the cloud
 * accounts it connected itself, and nothing more. A hosted service adds rules of its own on top
 * - who orders on the SERVICE's cloud accounts, whether an order goes through at all, the
 * routes its billing needs - and those rules are its business, not the repository's. They live
 * in a module this file loads, `DEVBOX_EXTENSION` (by default `extension/server.ts` under the
 * dashboard, a directory .gitignore names), and a deployment deposits it there.
 *
 * THE CONTRACT IS SMALL ON PURPOSE. An extension is handed decisions, never the vault: it says
 * whether an account orders on the founding account's cloud accounts, and src/secrets.ts keeps
 * every rule of how a value is then resolved (Sources.service). It may refuse an order before a
 * job is written, never start one. Its routes live under /api/ext/ and go through the same
 * guard as every other.
 *
 * ABSENT OR BROKEN, THE DASHBOARD FAILS CLOSED ON MONEY. With no extension no account orders on
 * another's cloud accounts, so nothing is ever billed to the service for someone else; an
 * extension that does not load is said at startup, `/!\` included when DEVBOX_EXTENSION named
 * it, and the dashboard runs as if there were none. `DEVBOX_EXTENSION=none` sets a deposited one
 * aside: the test harness does, so that a dashboard/extension/ left by a deployment changes
 * nothing the tests prove.
 */

export type OrderRefusal = { status: number; error: string };

export type Allowed = { ok: true; account: Account } | { ok: false; response: Response };

/** What server.ts lends an extension: its database, its guards, and its way of answering. */
export type ExtensionContext = {
  /** The service's database. An extension keeps its own tables in it, prefixed with its name. */
  db: Database;
  /** A read: a session or a CLI token. */
  actor(req: Request): Promise<Allowed>;
  /** A write: a session, the Origin and the anti-CSRF token - or a bearer when `bearer` allows it. */
  guard(req: Request, options?: { bearer?: boolean }): Promise<Allowed>;
  json(body: unknown, status?: number): Response;
  log(line: string): void;
};

export type Extension = {
  name: string;
  /**
   * Whether this account orders on the founding account's cloud accounts for every provider it
   * has connected nothing of. Called on every resolution: it must answer at once.
   */
  ordersOnService?(account: Account): boolean;
  /** Said before a job that orders or seeds a machine is written; null lets it through. */
  refuseOrder?(account: Account, verb: "up" | "seed"): OrderRefusal | null | Promise<OrderRefusal | null>;
  /** Routes of its own, every one under /api/ext/. */
  routes?: Record<string, (req: Request) => Response | Promise<Response>>;
};

export type ExtensionFactory = (context: ExtensionContext) => Extension | Promise<Extension>;

const DASHBOARD = join(import.meta.dir, "..");
const NAMED = process.env.DEVBOX_EXTENSION;
export const EXTENSION_PATH = (() => {
  const path = NAMED === undefined || NAMED === "" || NAMED === "none" ? join("extension", "server.ts") : NAMED;
  return isAbsolute(path) ? path : join(DASHBOARD, path);
})();

export const EXTENSION_ROUTE_PREFIX = "/api/ext/";

let installed: Extension | null = null;

export function installedExtension(): Extension | null {
  return installed;
}

export function ordersOnService(account: Account): boolean {
  return installed?.ordersOnService?.(account) === true;
}

export async function refuseOrder(account: Account, verb: "up" | "seed"): Promise<OrderRefusal | null> {
  return (await installed?.refuseOrder?.(account, verb)) ?? null;
}

export type Loaded = { extension: Extension | null; line: string; warning: boolean };

export async function loadExtension(context: ExtensionContext): Promise<Loaded> {
  const named = NAMED !== undefined && NAMED !== "";
  const without = "every account orders on its own cloud accounts";
  if (NAMED === "none") return { extension: null, warning: false, line: `no extension (DEVBOX_EXTENSION=none): ${without}` };
  if (!existsSync(EXTENSION_PATH)) {
    return named
      ? { extension: null, warning: true, line: `/!\\ DEVBOX_EXTENSION names ${EXTENSION_PATH}, which does not exist: running without an extension, ${without}` }
      : { extension: null, warning: false, line: `no extension: ${without}` };
  }
  try {
    const module = (await import(EXTENSION_PATH)) as { default?: unknown };
    if (typeof module.default !== "function") throw new Error("its default export is not a function");
    const made = await (module.default as ExtensionFactory)(context);
    if (typeof made?.name !== "string" || made.name === "") throw new Error("it has no name");
    for (const path of Object.keys(made.routes ?? {})) {
      if (!path.startsWith(EXTENSION_ROUTE_PREFIX)) throw new Error(`its route ${path} is outside ${EXTENSION_ROUTE_PREFIX}`);
    }
    installed = made;
    return { extension: made, warning: false, line: `extension ${made.name} loaded from ${EXTENSION_PATH}` };
  } catch (error) {
    installed = null;
    const reason = error instanceof Error ? error.message : String(error);
    return { extension: null, warning: true, line: `/!\\ the extension at ${EXTENSION_PATH} did not load (${reason}): running without it, ${without}` };
  }
}
