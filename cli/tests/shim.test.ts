import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, sandbox, strip } from "./harness.ts";

/**
 * WHAT THE SHIM HANDS TO THE EXECUTOR.
 *
 * `devbox` decides one thing: who draws the answer. A terminal gets the Ink app, everything
 * else gets devbox-core, and either way the argv is passed through untouched. That is a claim
 * about a shell script, which no amount of TypeScript testing reaches — this file spawns
 * the real `devbox` and reads which file answered and with what.
 *
 * There WAS a second executor here for a day, behind DEVBOX_TS, and this file was mostly about
 * proving the default had not moved. The port is gone and so is the variable; what remains
 * is the older and duller property, which is also the one that would actually break
 * something: the argv survives, whole, including the cases bash makes awkward.
 *
 * The executor is a STUB in a copy of the repository's shape, not the real one. The question
 * is the dispatch — which file gets the argv, and in how many words — and a stub answers it
 * in one line where the real core would answer with a fleet.
 */

const SHIM = join(import.meta.dir, "..", "..", "devbox");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  cleanup();
});

/**
 * A repository-shaped directory whose executor says who it is.
 *
 * `devbox` is copied rather than symlinked: the shim resolves its own location by following
 * symlinks, precisely so the documented `ln -sfn` install works, and a symlink here would
 * resolve straight back to the real repository and run the real core.
 */
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "devbox-shim-"));
  roots.push(root);

  copyFileSync(SHIM, join(root, "devbox"));
  chmodSync(join(root, "devbox"), 0o755);
  writeFileSync(join(root, "devbox-core"), '#!/usr/bin/env bash\nprintf \'BASH %s\\n\' "$*"\n', {
    mode: 0o755,
  });
  return root;
}

type Answer = { code: number; stdout: string; stderr: string };

async function runShim(
  root: string,
  argv: string[],
  extra: Record<string, string> = {},
): Promise<Answer> {
  const child = Bun.spawn([join(root, "devbox"), ...argv], {
    // PATH alone from the outside, for the reason harness.ts gives: a token exported in the
    // operator's shell is all a real verb would need to reach a real provider.
    env: { PATH: process.env["PATH"] ?? "", ...sandbox(), ...extra },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr: strip(stderr) };
}

describe("the shim runs devbox-core, and hands it the argv untouched", () => {
  test("a verb and a flag arrive as they were typed", async () => {
    // stdout is a pipe here, so `[ -t 1 ]` is false and the renderer is out of the picture
    // — which is the same state as `devbox ls | grep` and as the dashboard's own Bun.spawn.
    const answer = await runShim(fakeRepo(), ["ls", "--json"]);
    expect(answer.stdout).toBe("BASH ls --json\n");
    expect(answer.code).toBe(0);
  });

  test("with no verb at all, the executor is still reached", async () => {
    // `${@+"$@"}` rather than `"$@"`, because bash 3.2 — which is what macOS ships — treats
    // an unset $@ as unbound under `set -u` and would kill the shim before the core ran.
    expect((await runShim(fakeRepo(), [])).stdout).toBe("BASH \n");
  });

  test("an argument holding spaces survives as one word", async () => {
    // `exec "$CORE" ${@+"$@"}` and not `$*`. A profile or a machine name never holds a
    // space, but `devbox` forwards whatever it is given and the day one does, splitting it
    // would pass two arguments to a verb that refuses two names.
    const answer = await runShim(fakeRepo(), ["info", "a b"]);
    expect(answer.stdout).toBe("BASH info a b\n");
  });

  test("DEVBOX_PLAIN is honoured without changing what the core is given", async () => {
    // The way out when the rendering is the problem. It removes a renderer, never a word of
    // the command.
    const answer = await runShim(fakeRepo(), ["ls"], { DEVBOX_PLAIN: "1" });
    expect(answer.stdout).toBe("BASH ls\n");
    expect(answer.code).toBe(0);
  });
});
