import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Running the real devbox-core from a test, safely.
 *
 * The bash is the executor and it had no tests at all until the version handshake needed
 * one. Two of the bugs that cost this repository a morning lived in it — an argv silently
 * truncated, a `die` inside a substitution that killed only its subshell — and both were
 * reachable without touching a cloud. This module is what makes reaching them cheap, so
 * the rest of the suite can be about behaviour rather than about plumbing.
 *
 * Black box on purpose. devbox-core cannot be sourced: it runs migrate_from_devbox at load
 * and dispatches unconditionally at the end, so there is no way to reach one function. A
 * test spawns the file and reads what came out, which is also how every real caller uses
 * it — the Ink layer, the dashboard's job runner, and a shell pipeline all see exactly
 * this surface.
 */
export const CORE = join(import.meta.dir, "..", "..", "devbox-core");

/** Terminal colour, off, so an opening word can be asserted. */
export const strip = (text: string): string => text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

/** The lines warn() wrote, with its marker taken off. */
export const warnings = (stderr: string): string[] =>
  strip(stderr)
    .split("\n")
    .filter((line) => line.startsWith("/!\\"))
    .map((line) => line.replace(/^\/!\\\s*/, ""));

/** The lines log() wrote, which is how the core narrates a phase. */
export const phases = (stdout: string): string[] =>
  strip(stdout)
    .split("\n")
    .filter((line) => line.startsWith("==>"))
    .map((line) => line.replace(/^==>\s*/, ""));

/** The verdict die() wrote, if it did. */
export const verdict = (stderr: string): string | null => {
  const line = strip(stderr)
    .split("\n")
    .find((candidate) => candidate.startsWith("x "));
  return line ? line.slice(2) : null;
};

export type Run = { code: number; stdout: string; stderr: string; ms: number };

const roots: string[] = [];

/** Removes every temporary root this module handed out. Call from afterAll. */
export function cleanup(): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
}

/** A fresh, isolated set of directories for one invocation. */
export function sandbox(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "devbox-core-test-"));
  roots.push(root);
  for (const dir of ["home", "config", "secrets", "cache", "tf"]) mkdirSync(join(root, dir));
  mkdirSync(join(root, "home", ".ssh"));
  return {
    HOME: join(root, "home"),
    DEVBOX_CONFIG_DIR: join(root, "config"),
    DEVBOX_SECRETS_DIR: join(root, "secrets"),
    DEVBOX_CACHE_DIR: join(root, "cache"),
    DEVBOX_TF_ROOT: join(root, "tf"),
  };
}

/**
 * One invocation of the real file.
 *
 * HOME is a fresh temporary directory and that is NOT hygiene, it is the safety rail:
 * devbox-core writes $HOME/.ssh/config and $HOME/.ssh/known_hosts through paths built from
 * HOME with no DEVBOX_* override anywhere, so a test that let the operator's own HOME through
 * could rewrite the file that holds every host they ssh to. DEVBOX_TF_ROOT is the second
 * rail, keeping any local state read away from the repository's own tf/.
 *
 * The environment is built up rather than inherited from process.env for the third: an
 * HCLOUD_TOKEN or a SCW_SECRET_KEY exported in the operator's shell is all `probe` would
 * need to start talking to a real provider, and a real provider bills. Only PATH crosses
 * over.
 *
 * stdin is closed, exactly as the Ink layer spawns this file — which is what makes "never
 * prompts" a testable property rather than a hope.
 */
export async function runCore(
  argv: string[],
  extra: Record<string, string | undefined> = {},
): Promise<Run> {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", ...sandbox() };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const started = Bun.nanoseconds();
  const child = Bun.spawn([CORE, ...argv], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    code,
    stdout,
    stderr: strip(stderr),
    ms: (Bun.nanoseconds() - started) / 1e6,
  };
}

/**
 * A Terraform state that says a machine exists, without Terraform having run.
 *
 * `instances` reads the state files directly rather than through `terraform output` — a
 * deliberate choice, documented in the core, so that "is there anything here" costs no
 * init. That choice is what lets a test describe a fleet with a JSON file, and it is why
 * `resolve` and its refusal to guess can be exercised with no cloud and no binary.
 */
export function fakeMachine(env: Record<string, string>, cloud: string, name: string): void {
  const dir = join(env["DEVBOX_TF_ROOT"] ?? "", cloud, "terraform.tfstate.d", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "terraform.tfstate"),
    JSON.stringify({ resources: [{ mode: "managed", type: "hcloud_server", name: "devbox" }] }),
  );
}

/**
 * The operator's PATH, minus every directory that holds this executable.
 *
 * A stub can make a binary FAIL and it cannot make one ABSENT: `need` asks `command -v`,
 * which finds a stub that exits 1 exactly as well as a working install. Where a test means
 * "this machine has no gcloud at all" — a different path through the GCP probe than "gcloud
 * answered badly" — a stub cannot say it, and the suite would be green on CI and red on the
 * author's laptop. Removing the directory is the only way to say absent and mean it.
 */
export function pathWithout(name: string, path = process.env["PATH"] ?? ""): string {
  return path
    .split(":")
    .filter((dir) => dir !== "" && !existsSync(join(dir, name)))
    .join(":");
}

/** A `terraform` that records its arguments instead of talking to a provider. */
export function fakeTerraform(env: Record<string, string>, outputs: unknown = {}): string {
  const bin = join(env["HOME"] ?? "", "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "terraform.log");
  // Written synchronously and executable at once: the caller spawns the core immediately
  // after, and a promise still in flight would leave it running the real terraform.
  writeFileSync(
    join(bin, "terraform"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `case "$*" in *output*) printf '%s' ${JSON.stringify(JSON.stringify(outputs))} ;; esac`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return log;
}
