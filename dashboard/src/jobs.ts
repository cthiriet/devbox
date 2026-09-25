import type { Subprocess } from "bun";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUDS, DEVBOX, MAX_JOBS, MAX_JOBS_PER_ACCOUNT } from "./config";
import { finishJob, insertJob, interruptRunning, readJob } from "./db";
import { engineEnv, prepareLaunch, type Launch } from "./engine";
import type { Sources } from "./secrets";
import type { AccountPaths } from "./tree";
import type { Job } from "./schema";

/**
 * A job is a devbox invocation that takes minutes.
 *
 * `devbox up` is five minutes on Hetzner and fourteen on Scaleway, so no HTTP timeout would
 * survive it and no browser tab should have to. The request records a job and hands back
 * its id; the process lives in the service, writes to a file, and outlives the tab that
 * started it. Locking the phone interrupts nothing.
 */

export type Verb = "up" | "down" | "seed";

/** One job this process is running: whose, on which machine, doing what. */
export type ActiveJob = { id: number; account: number; machine: string; verb: Verb };

/**
 * Every job this process has spawned and not yet seen exit, by id.
 *
 * It replaced a single slot, `current`, and the slot was a MEMORY bound rather than a rule:
 * devbox-core runs concurrent `up` safely - a TF_WORKSPACE per invocation, a state lock per
 * workspace, with_lock around ~/.ssh/config, and its own lock around `terraform init` since
 * the plugin cache is shared. One slot for the whole service became, with accounts, one account
 * holding every other one's orders hostage for fourteen minutes of a Scaleway `up`.
 *
 * On globalThis for the reason the vault and the runtime are: `bun --hot` evaluates this module
 * again at each save, and a registry that came back empty under a running `up` would let a
 * `down` of that same machine through.
 */
const REGISTRY_SLOT = Symbol.for("devbox.dashboard.jobs.active");
const registrySlot = globalThis as { [REGISTRY_SLOT]?: Map<number, ActiveJob> };
const active = (): Map<number, ActiveJob> => (registrySlot[REGISTRY_SLOT] ??= new Map());

/** What runs now, oldest first: for the tests, which count what the caps count. */
export function activeJobs(): ActiveJob[] {
  return [...active().values()].sort((a, b) => a.id - b.id);
}

/**
 * The single place a log path is formed. There is no column for it, deliberately.
 *
 * In the ACCOUNT's tree, and that is not decoration: job ids are drawn from one table and are
 * global, and this function reads an id and nothing else. In one shared directory, the only
 * thing between account B and the apply log of account A - which carries ip addresses, machine
 * names and whatever terraform printed - would be a WHERE clause on the row, remembered at
 * every one of the two routes that read a log. Here the path itself cannot be formed.
 */
export function logPath(paths: AccountPaths, id: number): string {
  return join(paths.logDir, `${id}.log`);
}

/**
 * A machine name, drawn here when the form left the field empty.
 *
 * devbox draws its own by the same rule, and this duplicates it on purpose: a job needs an
 * identity from the moment it is recorded, minutes before there is a machine to carry
 * one. Letting devbox name it would leave the job page with nothing to show and the row
 * with a null that could only be filled by parsing a log.
 *
 * Five lowercase alphanumerics, as devbox: enough that two machines a day never meet, short
 * enough to type on a phone.
 */
export function drawName(random: () => number = Math.random): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  for (let i = 0; i < 5; i += 1) {
    suffix += alphabet[Math.floor(random() * alphabet.length)] ?? "0";
  }
  return `devbox-${suffix}`;
}

export type StartInput = {
  verb: Verb;
  argv: string[];
  machine: string;
  cloud: string | null;
  profile: string | null;
  /**
   * The profile secrets this run reads: the declared ones of the profile that `up` or `seed`
   * will run, and none for `down`, which pushes nothing into a machine. Laid out as files for
   * this launch alone - never in `argv`, which the jobs table keeps forever.
   */
  secrets: readonly string[];
};

/**
 * Why a job was not started. `busy` is a job id, and only ever one of the SAME account: the
 * job already running on that machine, which the page offers to follow. A cap names no job at
 * all - the jobs filling the service's cap are, as often as not, other accounts', and an id
 * handed across would be a way to count and to probe what they run.
 */
export type Refused =
  | { ok: false; limit: "machine"; reason: string; busy: number }
  | { ok: false; limit: "account" | "service"; reason: string; busy: null };

export type StartResult = { ok: true; id: number } | Refused;

/**
 * The three rules, in the order they are asked, or null when the job may start.
 *
 *   one job per machine   an `up` and a `down` on one workspace, two `seed` writing the same
 *                         /run/secrets: the only real conflicts, keyed by the account AND the
 *                         machine, since two accounts may hold the same name.
 *   the account's cap     what one account may hold of the service's memory at once.
 *   the service's cap     what the unit's MemoryMax is assumed to hold. See src/config.ts.
 *
 * The machine first: a second order on a busy machine is refused for what it is, even by an
 * account at its cap, and the answer is the one job worth following.
 */
export function refusal(account: number, machine: string): Refused | null {
  const running = activeJobs();
  const same = running.find((job) => job.account === account && job.machine === machine);
  if (same !== undefined) {
    return {
      ok: false,
      limit: "machine",
      reason: `${machine} already has a job running - ${same.verb}, job ${same.id}: one job at a time on a machine, so wait for it to end`,
      busy: same.id,
    };
  }
  const mine = running.filter((job) => job.account === account).length;
  if (mine >= MAX_JOBS_PER_ACCOUNT) {
    return {
      ok: false,
      limit: "account",
      reason: `this account already runs ${mine} jobs, which is its limit (DEVBOX_MAX_JOBS_PER_ACCOUNT): wait for one to end`,
      busy: null,
    };
  }
  if (running.length >= MAX_JOBS) {
    return {
      ok: false,
      limit: "service",
      reason: `this service already runs ${running.length} jobs, which is its limit (DEVBOX_MAX_JOBS): wait for one to end`,
      busy: null,
    };
  }
  return null;
}

/**
 * How a job's process comes into being. A parameter so the state machine can be exercised
 * without ordering a machine: the same reason src/ takes its clock and its paths from the
 * outside rather than reading them itself.
 *
 * It receives the environment rather than building it, so that the launch around it - the
 * directory of secrets, and its removal - is the same whichever spawner runs.
 */
export type Spawner = (argv: string[], env: Record<string, string>) => Subprocess;

export const spawnDevbox: Spawner = (argv, env) =>
  // stdin explicitly closed. devbox asks for a missing secret at the keyboard, and a service
  // has none: left inheriting, a seed could block forever with a machine already billing.
  // src/secrets.ts refuses before that, and this is the second lock on the same door.
  Bun.spawn([DEVBOX, ...argv], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

/**
 * Starts one job, or refuses: a job already on that machine, or a cap reached - see refusal.
 *
 * Several at once, where it used to be one: two `terraform apply` under one MemoryMax was the
 * worry, and it is now a number the unit states (DEVBOX_MAX_JOBS) rather than a slot that let
 * one account's fourteen-minute `up` refuse every other account's order.
 *
 * The check and the registration happen in one synchronous stretch - no await between the
 * refusal and the moment the job is in the registry - so two requests arriving together cannot
 * both see a free machine. JavaScript runs one of them to the end of this function first.
 *
 * The secrets are laid out BEFORE the row is written. A profile secret nothing holds, or a
 * profile secret's sealed row that no longer opens, throws from here - SecretsMissing,
 * VaultError - and the route answers it; a row would only show a job that never ran. A CLOUD
 * credential that cannot be read does not: that cloud is left out of the launch, and the log
 * says so on its second line - see prepareLaunch for the `down` it used to block. Once
 * written, the directory goes when the child does, whatever its exit code.
 *
 * Every argument is stated, `sources` above all: they are the account's, and a default here
 * was the road by which a second account's order would have been handed the first one's cloud
 * token and profile secrets, pushed into its machine's /run/secrets. The spawner is stated too,
 * rather than defaulted in front of a required parameter: a route passes spawnDevbox.
 *
 * `paths` is the other half of the same sentence, and it is the one that decides WHERE the
 * machine is recorded: the child runs in that account's tree, so its state, its ssh config and
 * its log all land in the tree of the account that asked. The two are checked against each
 * other rather than trusted - see prepareLaunch.
 */
export function start(
  paths: AccountPaths,
  input: StartInput,
  now: number,
  spawner: Spawner,
  sources: Sources,
): StartResult {
  const account = paths.account;
  const refused = refusal(account, input.machine);
  if (refused !== null) return refused;

  // Every cloud's credentials, as the environment carried them before the vault: `down`
  // reads the cloud off the state, and `up` may pin one the route did not name. The tree is
  // handed with them, and prepareLaunch refuses the pair if the two name two accounts.
  const launch: Launch = prepareLaunch(paths, { clouds: CLOUDS, profile: input.secrets }, sources);

  let id: number;
  try {
    id = insertJob(account, {
      verb: input.verb,
      machine: input.machine,
      cloud: input.cloud,
      profile: input.profile,
      argv: input.argv,
      startedAt: now,
    });
  } catch (error) {
    launch.dispose();
    throw error;
  }

  // Created at 0600 before the writer opens it, rather than left to the umask: the log holds
  // ip addresses, machine names and everything terraform printed, and the directory it sits
  // in is the account's own. A mode set afterwards would have a window; this one has none.
  const path = logPath(paths, id);
  writeFileSync(path, "", { mode: 0o600 });
  const writer = Bun.file(path).writer();
  writer.write(`$ devbox ${input.argv.join(" ")}\n`);
  // Before anything the child says, so a job that fails on a cloud it could not be handed
  // explains itself above the failure rather than leaving the reader to guess.
  for (const { cloud, reason } of launch.skipped) writer.write(`/!\\ ${cloud}: ${reason}\n`);

  let child: Subprocess;
  try {
    child = spawner(input.argv, engineEnv(paths, launch));
  } catch (error) {
    // Said in the log and on the row, so the job page explains itself: a missing engine
    // throws here, before any process exists to fail on its own.
    launch.dispose();
    writer.write(`\nthe dashboard could not start devbox: ${String(error)}\n`);
    void writer.end();
    finishJob(account, id, "failed", 1, Date.now());
    return { ok: true, id };
  }
  active().set(id, { id, account, machine: input.machine, verb: input.verb });

  // Both streams into the one file, in the order they arrive. devbox writes progress to
  // stdout and warnings to stderr, and a reader wants them interleaved as they happened
  // rather than one block after the other.
  // getReader rather than `for await`: the DOM lib does not declare an async iterator on
  // ReadableStream, and Bun's runtime support for one would only typecheck by widening
  // the lib for every file.
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        writer.write(value);
        await writer.flush();
      }
    } finally {
      reader.releaseLock();
    }
  };

  void (async () => {
    let code = 1;
    try {
      await Promise.all([
        pump(child.stdout as ReadableStream<Uint8Array>),
        pump(child.stderr as ReadableStream<Uint8Array>),
      ]);
      code = await child.exited;
    } catch (error) {
      writer.write(`\nthe dashboard lost the process: ${String(error)}\n`);
    } finally {
      // First, before anything that could throw: the plaintext has no reason to outlive the
      // process it was laid out for, and a crash of this service later is what the sweep in
      // server.ts is for.
      launch.dispose();
      // Out of the registry before anything that awaits, so a job that has exited never holds
      // its machine or a place under the caps for as long as a log takes to close.
      active().delete(id);
      await writer.end();
      finishJob(account, id, code === 0 ? "succeeded" : "failed", code, Date.now());
    }
  })();

  return { ok: true, id };
}

/** Null for another account's job as for a missing one: the route answers both with a 404. */
export function readJobRow(account: number, id: number): Job | null {
  return readJob(account, id);
}

/**
 * Terminal colours, removed for display.
 *
 * devbox and terraform both colour their output, and a browser shows the escape sequences as
 * literal text: `[31m-` in front of every destroyed line, which is most of a destroy plan.
 * The file on disk keeps them, so reading it with `less -R` still has its colours.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
    // Progress lines rewrite themselves with a carriage return, which a <pre> renders as
    // a line that never advances.
    .replace(/\r(?!\n)/g, "");
}

/**
 * The log from a byte offset, so a browser follows it without re-reading the whole.
 *
 * While the job runs it stops at the last complete line. An escape sequence split across
 * two polls would survive the stripping above and land on screen in pieces, and the cut
 * is made on BYTES rather than on decoded characters so the offset arithmetic stays exact
 * under UTF-8.
 */
export async function readLog(
  paths: AccountPaths,
  id: number,
  offset = 0,
  complete = false,
): Promise<{ text: string; size: number }> {
  const file = Bun.file(logPath(paths, id));
  if (!(await file.exists())) return { text: "", size: 0 };
  const end = file.size;
  if (offset >= end) return { text: "", size: end };

  const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
  let usable = bytes.length;
  if (!complete) {
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) return { text: "", size: offset };
    usable = lastNewline + 1;
  }
  return {
    text: stripAnsi(new TextDecoder().decode(bytes.subarray(0, usable))),
    size: offset + usable,
  };
}

/**
 * Called once at startup, before anything is served.
 *
 * A job left `running` belonged to a process this one did not start, so it is marked
 * interrupted rather than assumed finished. That distinction is the point: a service
 * restarted mid-apply may have left a machine with the provider that no state records,
 * and only `devbox orphans` can find it.
 */
export function reconcile(now = Date.now()): number {
  return interruptRunning(now);
}
