import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import { makeUndumpable } from "../src/undumpable";

/**
 * A child of the same account must not read back what openVault deleted from process.env.
 *
 * The delete only unlinks the variable from libc's list; the bytes stay in the block the
 * kernel laid out at exec, which /proc/<pid>/environ serves to any process of the same uid -
 * devbox-core, terraform, a provider plugin. Measured on 11/09.
 * src/undumpable.ts closes it on Linux, and these pin both halves: that the
 * leak is real before the call, and gone after it.
 *
 * In a process of its own, never in the test runner: an undumpable runner would change what
 * every later test can read of itself, and prove nothing about a fresh process.
 */

if (!DATA_DIR.endsWith(".test-data")) {
  throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);
}

describe("makeUndumpable", () => {
  test("does nothing off Linux, and never throws there", () => {
    expect(makeUndumpable("darwin")).toBeNull();
    expect(makeUndumpable("win32")).toBeNull();
    if (process.platform !== "linux") expect(makeUndumpable()).toBeNull();
  });

  test.skipIf(process.platform !== "linux")(
    "closes /proc/<pid>/environ to a child of the same account, and leaves the process its own /proc/self",
    () => {
      const directory = join(DATA_DIR, "undumpable");
      mkdirSync(directory, { recursive: true });
      const fixture = join(directory, "child.ts");
      const probe = ["sh", "-c", 'tr "\\0" "\\n" < /proc/$PPID/environ'];
      writeFileSync(
        fixture,
        [
          'import { readdirSync, readFileSync, readlinkSync } from "node:fs";',
          `import { makeUndumpable } from ${JSON.stringify(join(import.meta.dir, "..", "src", "undumpable.ts"))};`,
          `const probe = ${JSON.stringify(probe)};`,
          'const read = () => Bun.spawnSync(probe, { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });',
          // What openVault does to the key, before and after which a child looks.
          "delete process.env.PLANTED;",
          "const before = read();",
          "const result = makeUndumpable();",
          "const after = read();",
          "const self = {",
          '  status: readFileSync("/proc/self/status", "utf8").includes("Pid:"),',
          '  maps: readFileSync("/proc/self/maps", "utf8").length > 0,',
          '  fd: readdirSync("/proc/self/fd").length > 0,',
          '  exe: readlinkSync("/proc/self/exe").length > 0,',
          "};",
          "console.log(JSON.stringify({",
          "  result,",
          '  before: before.stdout.toString().includes("PLANTED=QZXW"),',
          '  after: after.stdout.toString().includes("PLANTED=QZXW"),',
          "  afterCode: after.exitCode,",
          "  self,",
          "}));",
          "",
        ].join("\n"),
      );

      const run = Bun.spawnSync([process.execPath, fixture], {
        env: { PATH: process.env.PATH ?? "", PLANTED: "QZXW-a-master-key" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.stderr.toString()).toBe("");
      const answer = JSON.parse(run.stdout.toString()) as {
        result: unknown;
        before: boolean;
        after: boolean;
        afterCode: number;
        self: Record<string, boolean>;
      };
      expect(answer.result).toEqual({ applied: true });
      // The mechanism, measured: the delete alone left it readable.
      expect(answer.before).toBe(true);
      // And the repair: refused, not merely empty.
      expect(answer.after).toBe(false);
      expect(answer.afterCode).not.toBe(0);
      expect(answer.self).toEqual({ status: true, maps: true, fd: true, exe: true });
    },
  );
});
