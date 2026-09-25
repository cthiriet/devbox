/**
 * Preloaded by bunfig.toml before any test. `src/config.ts` freezes DATA_DIR at first
 * import: setting it inside a test file would arrive too late, and the tests would write
 * into the real state.
 *
 * On this site that is not a matter of tidiness. The real data directory holds the
 * Terraform state of machines that bill by the hour and the ssh config that reaches them.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DIRECTORY = join(import.meta.dir, "..", ".test-data");

// Empty on every run, or counts vary between them.
rmSync(DIRECTORY, { recursive: true, force: true });
mkdirSync(DIRECTORY, { recursive: true });

process.env.DATA_DIR = DIRECTORY;

/**
 * The engine is diverted for the same reason as the data directory, and it was not until
 * tests/engine.test.ts planted a fake state inside the real `engine/` to prove it was not
 * copied. A build artefact is still a real directory.
 */
process.env.ENGINE_DIR = join(DIRECTORY, "engine");
mkdirSync(process.env.ENGINE_DIR, { recursive: true });

process.env.NODE_ENV = "test";

/**
 * No test may reach a provider, even on a workstation that holds the credentials.
 *
 * Every one of these is worth money or access: the first three order machines, the next
 * two are pushed into a running machine's tmpfs, and the last opens this dashboard.
 * Deleting them here means a test that accidentally spawns devbox fails on a missing
 * credential rather than succeeding on a real account.
 */
for (const variable of [
  "HCLOUD_TOKEN",
  "SCW_ACCESS_KEY",
  "SCW_SECRET_KEY",
  "SCW_DEFAULT_PROJECT_ID",
  "DEVBOX_CLAUDE_TOKEN",
  "DEVBOX_GITHUB_TOKEN",
  "DEVBOX_OPENAI_TOKEN",
  "PASSWORD_HASH",
  "DEVBOX_REMOTE_TOKEN",
  // Not a secret, but a test has to stay reproducible.
  "PUBLIC_URL",
  "DEVBOX_KEY",
  // The GCP road that needs no browser: a variable exported in the operator's shell
  // would point a test at a real service account key, and that key can order machines.
  "GOOGLE_APPLICATION_CREDENTIALS",
  // A cloud field like the three at the top: src/secrets.ts reads it as the fallback, and
  // one exported in the shell would make clouds() answer differently on each workstation.
  "DEVBOX_GCP_PROJECT",
  // The vault's master key, and the one a rotation keeps beside it. A key from the
  // operator's shell would open, or fail to open, a database it was never meant for - and
  // a test that passed on the strength of it would say nothing about the code.
  "DEVBOX_MASTER_KEY",
  "DEVBOX_MASTER_KEY_PREVIOUS",
  // The fallback directory. Exported in the shell, it would be the operator's REAL secrets
  // directory, and tests/config.test.ts deletes the `gcp` key it finds there after each test.
  "DEVBOX_SECRETS_DIR",
  // Read by nothing since 15/09, and warned about at every start while set: exported in the
  // shell, it would put a warning in every test server's journal that the tests did not ask for.
  "DEVBOX_INVITE_CODE",
  // How many jobs run at once. Exported in the shell, the caps the tests count against would
  // be the operator's and not the defaults src/config.ts documents.
  "DEVBOX_MAX_JOBS",
  "DEVBOX_MAX_JOBS_PER_ACCOUNT",
  // The sign-in providers' clients. A development app's secret exported in the shell would be
  // taken by a test's takeProviders as though it were the test's own - and a test that passed on
  // a real client would say nothing about the code. The same for who founds account 1, and for
  // how many accounts an hour may be created.
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "DEVBOX_FOUNDER_EMAIL",
  "DEVBOX_MAX_NEW_ACCOUNTS_PER_HOUR",
]) {
  delete process.env[variable];
}

/**
 * Where each launch's secrets are laid out, under the test data like everything else - and
 * not /dev/shm, which a Linux runner shares with whatever else runs there.
 */
process.env.DEVBOX_RUNTIME_DIR = join(DIRECTORY, "run");
