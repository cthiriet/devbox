import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Isolates the tests from the operator's own devbox.
 *
 * src/settings.ts reads the environment at import time, and its defaults point at
 * ~/.config/devbox: without this preload a test would read the real dashboard address, the
 * real cached tokens, and — the one that would actually hurt — could write a secret over
 * one of them. Everything is redirected into a fresh temporary directory instead.
 *
 * DEVBOX_REMOTE is set to the empty string on purpose rather than left unset. Empty is how
 * `DEVBOX_REMOTE= devbox ls` says "the local state, knowingly", and it is what stops `remote()`
 * from falling back to reading ~/.config/devbox/.env.
 */
const root = mkdtempSync(join(tmpdir(), "devbox-cli-tests-"));

process.env["DEVBOX_HOME"] = join(root, "repo");
process.env["DEVBOX_CONFIG_DIR"] = join(root, "config");
process.env["DEVBOX_SECRETS_DIR"] = join(root, "config", "secrets");
process.env["DEVBOX_CACHE_DIR"] = join(root, "cache");
process.env["DEVBOX_REMOTE"] = "";

/**
 * The tokens, removed rather than redirected.
 *
 * Redirecting the directories is not enough: secrets.held() reads the ENVIRONMENT before
 * it looks on disk, so a DEVBOX_REMOTE_TOKEN exported in the operator's shell — which
 * Gate.tsx itself documents as the way to hand one over — made the suite pass or fail
 * depending on whose terminal ran it. Measured: `DEVBOX_REMOTE_TOKEN=xyz bun test` failed
 * "a dashboard whose token nothing holds", a test that has nothing to do with any of them.
 * dashboard/tests/prepare.ts has always done this; this side had not.
 */
for (const variable of [
  "DEVBOX_REMOTE_TOKEN",
  "DEVBOX_CLAUDE_TOKEN",
  "DEVBOX_GITHUB_TOKEN",
  "DEVBOX_OPENAI_TOKEN",
  "HCLOUD_TOKEN",
  "SCW_ACCESS_KEY",
  "SCW_SECRET_KEY",
  "DEVBOX_KEY",
  // The GCP road that needs no browser: a variable exported in the operator's shell
  // would point a test at a real service account key, and that key can order machines.
  "GOOGLE_APPLICATION_CREDENTIALS",
]) {
  delete process.env[variable];
}

export const TEST_ROOT = root;
