import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderProfile, type ProfileSpec } from "../src/profiles";

/**
 * The one test that proves the renderer writes a profile DEVBOX-CORE can read.
 *
 * Everything in tests/profiles.test.ts is about what this service intends; this is about
 * what the bash actually does with it, and the two are not the same question. The header is
 * parsed by five lines of awk and a jq template, `profile_path` refuses a name outside its
 * charset and a key declared twice, and none of that can be asserted by reading the
 * renderer - only by running the real file against a real rendering.
 *
 * So: render, drop it where a deployment's devbox reads it first
 * ($DEVBOX_CONFIG_DIR/profiles), and run devbox-core.
 *
 * HOME is a temporary directory, and that is the safety rail rather than hygiene:
 * devbox-core writes $HOME/.ssh/config through a path with no override, so a test that let
 * the operator's own HOME through could rewrite the file holding every host they ssh to.
 * The environment is built up rather than inherited for the second rail: an HCLOUD_TOKEN
 * exported in a shell is all `up` would need to reach a provider that bills.
 */

const CORE = join(import.meta.dir, "..", "..", "devbox-core");

/** cmd_profiles opens with `need jq`, and profile_meta is awk: without either, no behaviour. */
const CANNOT_RUN = Bun.which("jq") === null || Bun.which("awk") === null;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const spec: ProfileSpec = {
  name: "composed",
  note: "composed by the dashboard",
  software: ["claude", "gh", "python"],
  optional: ["github"],
  secrets: ["extra"],
  repos: [
    { url: "https://github.com/me/app", secret: "github", dir: null },
    { url: "https://github.com/public/lib", secret: null, dir: "/workspace/lib" },
  ],
  setup: "scripts/devbox-setup.sh",
  cpu: 4,
  ram: 8,
  disk: 60,
  ports: [3000, 5173],
};

/** A sandbox whose config directory holds the rendered profile, and nothing else. */
function sandbox(): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), "devbox-composed-"));
  roots.push(root);
  for (const dir of ["home", "home/.ssh", "config", "config/profiles", "secrets", "cache", "tf"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(
    join(root, "config", "profiles", `${spec.name}.sh`),
    renderProfile(spec, Date.parse("2026-09-12T10:00:00Z")),
  );
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    DEVBOX_CONFIG_DIR: join(root, "config"),
    DEVBOX_SECRETS_DIR: join(root, "secrets"),
    DEVBOX_CACHE_DIR: join(root, "cache"),
    DEVBOX_TF_ROOT: join(root, "tf"),
  };
}

async function core(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([CORE, ...argv], {
    env: sandbox(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // The colour escapes devbox-core writes for a terminal, removed.
  return { code, stdout, stderr: stderr.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "") };
}

describe.skipIf(CANNOT_RUN)("a composed profile, read by devbox-core", () => {
  test("`devbox profiles --json` lists it with the header it was given", async () => {
    const run = await core(["profiles", "--json"]);
    expect(run.code).toBe(0);
    // Nothing on stderr: profiles_json names there any header number it could not read, and
    // a rendered profile must never produce one.
    expect(run.stderr).toBe("");

    const rows = JSON.parse(run.stdout) as Record<string, unknown>[];
    const found = rows.find((row) => row.name === spec.name);
    expect(found).toEqual({
      name: "composed",
      path: expect.stringContaining(`/config/profiles/${spec.name}.sh`),
      repo: "https://github.com/me/app",
      // Sorted, and every name the profile declares: the software's, the repositories' and
      // the ones added by hand. This is the list cmd_seed pushes into /run/secrets.
      secrets: ["claude", "extra", "github"],
      note: "composed by the dashboard",
      min_cpu: 4,
      min_ram: 8,
      min_disk: 60,
      // The list the core reads back, the app first, and `port` as the first of it.
      port: 3000,
      ports: [3000, 5173],
    });
  });

  test("`devbox up` gets past profile_path and dies on the credential, not on the file", async () => {
    // profile_path is only reached by up and seed - `profiles` walks the directories itself -
    // and it holds the two refusals that would sink a rendered file: a name outside its
    // charset, and a `# devbox-<key>:` declared twice. Reaching the missing token is the
    // proof that neither fired.
    const run = await core(["up", "--profile", spec.name, "--cloud", "hetzner"]);
    expect(run.code).not.toBe(0);
    expect(run.stdout + run.stderr).toContain(`profile ${spec.name}`);
    expect(run.stderr).toContain("no HCLOUD_TOKEN");
    expect(run.stderr).not.toContain("more than once");
    expect(run.stderr).not.toContain("a profile name must be");
  });

  test("the rendered file is valid bash", async () => {
    const child = Bun.spawn(["bash", "-n"], { stdin: "pipe", stderr: "pipe" });
    child.stdin.write(renderProfile(spec, Date.now()));
    await child.stdin.end();
    expect(await child.exited).toBe(0);
  });

  test("every function it calls is defined by the prelude it will be run against", async () => {
    // The rendered body is a list of calls into prelude.sh, which cmd_seed deposits on the
    // machine at every seed. A catalogue naming a function the prelude does not define would
    // fail nowhere here and die on the machine, minutes into a seed, after it was ordered.
    const prelude = await Bun.file(join(import.meta.dir, "..", "..", "prelude.sh")).text();
    const defined = new Set(
      [...prelude.matchAll(/^([a-z_][a-z0-9_]*)\(\)\s*\{/gm)].map((match) => match[1] as string),
    );
    // The first word of every call line, arguments or not: `run_setup 'scripts/x.sh'` and
    // `clone_repo 'github'` are calls too. `set` is the one builtin the renderer writes.
    const called = renderProfile(spec, Date.now())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[a-z_][a-z0-9_]*( |$)/.test(line))
      .map((line) => line.split(" ")[0] as string)
      .filter((name) => name !== "set");
    expect(called).toContain("run_setup");
    expect(called).toContain("clone_repo");
    for (const name of called) expect(defined).toContain(name);
  });
});
