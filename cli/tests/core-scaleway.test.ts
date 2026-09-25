import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fakeTerraform, runCore, sandbox, verdict } from "./harness.ts";

/**
 * Scaleway's three credentials, and the one devbox-core used not to ask for.
 *
 * scw_credentials() checked SCW_SECRET_KEY and SCW_DEFAULT_PROJECT_ID and only exported
 * SCW_ACCESS_KEY: the probe signs its calls with the secret alone, so `probe` answered with
 * a full list of offers - and `up` then died at the plan. Measured on 11/09 against scaleway
 * provider 2.81.0: without the access key terraform stops on "scaleway-sdk-go: access key
 * cannot be empty", before it asks anything. A list of offers that can never be ordered is
 * worse than no list, and the dashboard's own catalogue already wanted all three.
 *
 * `curl` is a stub that records its arguments and answers nothing useful, so "no provider
 * was asked" is an assertion here and not a hope: before the fix, the probe below reached
 * for api.scaleway.com with a secret and no access key.
 */

type Env = Record<string, string>;

/** Stubs in HOME/bin, first in PATH, each writing its arguments to a log beside it. */
function stubbed(env: Env): { env: Env; curl: string; terraform: string } {
  const terraform = fakeTerraform(env);
  const bin = join(env["HOME"] ?? "", "bin");
  mkdirSync(bin, { recursive: true });
  const curl = join(bin, "curl.log");
  // What scw_api reads back is the body, a newline, and the status code: an error it can
  // name, so a probe that did get this far says so in its `not asked:` block.
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(curl)}`,
      `printf '%s\\n%s' '{"message":"stubbed"}' 503`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // `up` wants both before it reads a profile. Neither is reached in these tests, and a
  // machine without netcat must not fail for a reason that has nothing to do with Scaleway.
  for (const tool of ["nc", "ssh-keyscan"]) {
    writeFileSync(join(bin, tool), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  }
  return {
    env: { ...env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, DEVBOX_REMOTE: "" },
    curl,
    terraform,
  };
}

const called = (log: string): string => (existsSync(log) ? readFileSync(log, "utf8") : "");

/** The one line `probe` prints for a cloud it could not ask. */
function notAsked(stderr: string): string {
  const lines = stderr.split("\n");
  const start = lines.findIndex((line) => line.trim() === "not asked:");
  return (
    lines
      .slice(start + 1)
      .map((line) => line.trim())
      .find((line) => line.startsWith("scaleway:")) ?? ""
  );
}

afterAll(cleanup);

describe("scw_credentials", () => {
  test("probe names the missing access key rather than answering without it", async () => {
    const { env, curl } = stubbed({
      ...sandbox(),
      SCW_SECRET_KEY: "11111111-2222-3333-4444-555555555555",
      SCW_DEFAULT_PROJECT_ID: "66666666-7777-8888-9999-000000000000",
    });

    const { code, stdout, stderr } = await runCore(["probe", "--cloud", "scaleway", "--json"], env);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
    expect(notAsked(stderr)).toBe("scaleway: the environment holds no SCW_ACCESS_KEY.");
    // The point of the fix: no offer is fetched for a cloud the apply would refuse.
    expect(called(curl)).toBe("");
  });

  test("up refuses on the same line, before terraform is ever run", async () => {
    const { env, curl, terraform } = stubbed({
      ...sandbox(),
      SCW_SECRET_KEY: "11111111-2222-3333-4444-555555555555",
      SCW_DEFAULT_PROJECT_ID: "66666666-7777-8888-9999-000000000000",
    });

    const { code, stderr } = await runCore(
      ["up", "--cloud", "scaleway", "--name", "devbox-scw", "--profile", "claude"],
      env,
    );

    expect(code).toBe(1);
    expect(verdict(stderr)).toBe("the environment holds no SCW_ACCESS_KEY.");
    // Where it used to die, three minutes of catalogue later: at the plan.
    expect(stderr).toContain("access key cannot be empty");
    expect(called(terraform)).toBe("");
    expect(called(curl)).toBe("");
  });

  test("a .env.tf missing it is named as the file's", async () => {
    const base = sandbox();
    const file = join(base["DEVBOX_CONFIG_DIR"] ?? "", ".env.tf");
    writeFileSync(
      file,
      "SCW_SECRET_KEY=11111111-2222-3333-4444-555555555555\n" +
        "SCW_DEFAULT_PROJECT_ID=66666666-7777-8888-9999-000000000000\n",
    );
    const { env, curl } = stubbed(base);

    const { stderr } = await runCore(["probe", "--cloud", "scaleway", "--json"], env);

    expect(notAsked(stderr)).toBe(`scaleway: ${file} holds no SCW_ACCESS_KEY.`);
    expect(called(curl)).toBe("");
  });

  test("with all three, the check lets the probe through to the API", async () => {
    // The other half, so the refusal above cannot be passed by refusing everything.
    const { env, curl } = stubbed({
      ...sandbox(),
      SCW_ACCESS_KEY: "SCWXXXXXXXXXXXXXXXXX",
      SCW_SECRET_KEY: "11111111-2222-3333-4444-555555555555",
      SCW_DEFAULT_PROJECT_ID: "66666666-7777-8888-9999-000000000000",
    });

    const { stderr } = await runCore(["probe", "--cloud", "scaleway", "--json"], env);

    expect(called(curl)).toContain("api.scaleway.com");
    expect(notAsked(stderr)).toContain("answered 503");
    expect(notAsked(stderr)).not.toContain("SCW_ACCESS_KEY");
  });
});
