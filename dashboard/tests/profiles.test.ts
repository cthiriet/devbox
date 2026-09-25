import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkedSpec,
  declaredSecrets,
  isAuthored,
  removeAuthored,
  renderProfile,
  requiredSecrets,
  SENTINEL,
  strangerAt,
  syncProfiles,
  writeAuthored,
  type ProfileSpec,
} from "../src/profiles";
import { resolved, SECRET_GUIDES, secretsOf, SOFTWARE } from "../src/software";

/**
 * What this file is defending.
 *
 * A composed profile is a bash script written from a form and run AS ROOT on a machine this
 * service orders. Two things therefore matter more than the happy path:
 *
 *   what the renderer refuses    a note holding a newline forges a header line; a quote in
 *                                a url closes an argument. The validator is an allow-list
 *                                per field, and render() asserts it a second time.
 *   what it will not overwrite   the same directory holds the profiles a real deployment
 *                                deposits by hand, and those name what this repository may
 *                                not. The sentinel is the only thing telling them apart.
 *
 * The third thing is that the file devbox-core reads has to satisfy devbox-core's own rules,
 * and no test in this directory can prove that: it takes the real bash. That proof is
 * cli/tests/core-profiles.test.ts, which renders one of these and runs `devbox profiles
 * --json` against it.
 */

const SHIPPED = ["claude", "opencode"];

const spec = (overrides: Partial<ProfileSpec> = {}): ProfileSpec => ({
  name: "mine",
  note: null,
  software: [],
  optional: [],
  secrets: [],
  repos: [],
  setup: null,
  cpu: null,
  ram: null,
  disk: null,
  ports: [],
  ...overrides,
});

/** A fresh directory per test: these write files and compare what is on disk. */
function directory(): string {
  return mkdtempSync(join(tmpdir(), "devbox-profiles-"));
}

/** The header as profile_meta reads it: `# devbox-<key>: <value>`, first match wins. */
function meta(script: string, key: string): string | null {
  for (const line of script.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "#" && fields[1] === `devbox-${key}:`) return fields.slice(2).join(" ");
  }
  return null;
}

/** Every `# devbox-<key>:` in the file, in order - profile_path refuses a repeat. */
function headerKeys(script: string): string[] {
  return script
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[0] === "#" && /^devbox-[a-z-]+:$/.test(fields[1] ?? ""))
    .map((fields) => fields[1] as string);
}

describe("the catalogue", () => {
  test("every entry's needs name another entry", () => {
    const ids = new Set(SOFTWARE.map((one) => one.id));
    for (const one of SOFTWARE) {
      for (const need of one.needs) expect(ids.has(need)).toBe(true);
    }
  });

  test("what is needed is installed, in the catalogue's order and once", () => {
    // Ticked last, needing two entries that come first: the answer is the catalogue's
    // order, or the browser's MCP package would be installed before npm exists.
    const order = resolved(["claude", "node"]).map((one) => one.id);
    expect(order).toEqual(["node", "chrome", "claude"]);
  });

  test("a required secret beats the same name declared as optional", () => {
    // `github` is optional for gh. No entry requires it today, so the rule is stated on the
    // catalogue itself: whichever entry asks for it hardest is what the page insists on.
    const found = secretsOf(["gh"]).find((one) => one.name === "github");
    expect(found?.required).toBe(false);
  });

  test("every secret the catalogue asks for is described by name", () => {
    // The pages hold a name and nothing else - /secrets lists names, a 412 names what is
    // missing - so a secret without a guide would be the one shown as a bare identifier.
    const described = new Set(SECRET_GUIDES.map((guide) => guide.name));
    for (const one of SOFTWARE) {
      for (const secret of one.secrets) expect(described.has(secret.name), secret.name).toBe(true);
    }
    for (const guide of SECRET_GUIDES) {
      expect(guide.link === null || guide.link.href.startsWith("https://"), guide.name).toBe(true);
    }
  });
});

describe("an optional secret", () => {
  test("is declared only when the form turned it on, and never goes into require_secrets", () => {
    expect(declaredSecrets(spec({ software: ["gh"] }))).toEqual([]);
    const on = spec({ software: ["gh"], optional: ["github"] });
    expect(declaredSecrets(on)).toEqual(["github"]);
    // Declared, so a launch without it is refused before anything is ordered; install_gh
    // still degrades when a seed is run past that by hand.
    expect(requiredSecrets(on)).toEqual([]);
    expect(renderProfile(on, 0)).toContain("# devbox-secrets:  github\n");
    expect(renderProfile(spec({ software: ["gh"] }), 0)).not.toContain("devbox-secrets");
  });

  test("a row from before the field declares what it rendered then", () => {
    // Its absence is every optional secret turned on: a restart re-renders every row, and
    // must not quietly take the token away from the machines a profile seeds.
    const legacy: Record<string, unknown> = { ...spec({ software: ["claude", "gh"] }) };
    delete legacy.optional;
    const checked = checkedSpec("mine", legacy, SHIPPED);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.optional).toEqual(["github"]);
    expect(declaredSecrets(checked.value)).toEqual(["claude", "github"]);
  });

  test("is a whitelist: a name the catalogue does not offer is refused, one nothing chosen reads is dropped", () => {
    for (const optional of [["claude"], ["nope"], [42], "github"]) {
      const checked = checkedSpec("mine", spec({ software: ["claude", "gh"], optional: optional as string[] }), SHIPPED);
      expect(checked.ok, JSON.stringify(optional)).toBe(false);
      if (!checked.ok) expect(checked.field).toBe("optional");
    }
    const unticked = checkedSpec("mine", spec({ software: ["python"], optional: ["github"] }), SHIPPED);
    expect(unticked.ok).toBe(true);
    if (unticked.ok) expect(unticked.value.optional).toEqual([]);
  });
});

describe("what a spec may say", () => {
  test("a name is devbox-core's charset, and a published profile is refused", () => {
    for (const name of ["mine", "a-b_c", "x1"]) {
      expect(checkedSpec(name, spec({ name }), SHIPPED).ok).toBe(true);
    }
    for (const name of ["", "-lead", "a/b", "a b", "a.b", "é", "x".repeat(33)]) {
      const checked = checkedSpec(name, spec(), SHIPPED);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.field).toBe("name");
    }
  });

  test("a published profile's name is refused, because it would be shadowed", () => {
    const checked = checkedSpec("claude", spec({ name: "claude" }), SHIPPED);
    expect(checked.ok).toBe(false);
    // Named, and the reason given: $CONFIG_DIR comes first in PROFILE_DIRS, so this would
    // not collide - it would silently replace the published profile everywhere.
    if (!checked.ok) expect(checked.reason).toContain("shadow");
  });

  test("a note holding a newline is refused: it would forge a header line", () => {
    const forged = checkedSpec("mine", spec({ note: "fine\n# devbox-repo: https://elsewhere/x" }), SHIPPED);
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.field).toBe("note");
  });

  test("a url is https and holds no quote", () => {
    const ok = checkedSpec("mine", spec({ repos: [{ url: "https://github.com/me/x.git", secret: null, dir: null }] }), SHIPPED);
    expect(ok.ok).toBe(true);

    for (const url of [
      "git@github.com:me/x.git",
      "ssh://git@github.com/me/x",
      "http://github.com/me/x",
      "https://github.com/me/x';touch /tmp/pwned;'",
      "https://github.com/me/x$(id)",
      "https://github.com/me/x`id`",
      "https://github.com/me/x y",
    ]) {
      const checked = checkedSpec("mine", spec({ repos: [{ url, secret: null, dir: null }] }), SHIPPED);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.field).toBe("repos");
    }
  });

  test("a repository's secret obeys the vault's own rule, reserved names included", () => {
    for (const secret of ["gcp", "remote", "../x", ""]) {
      const checked = checkedSpec(
        "mine",
        spec({ repos: [{ url: "https://github.com/me/x", secret, dir: null }] }),
        SHIPPED,
      );
      // An empty secret is not a refusal: it is how the form says "this one is public".
      if (secret === "") expect(checked.ok).toBe(true);
      else expect(checked.ok).toBe(false);
    }
  });

  test("the first repository takes no directory of its own", () => {
    // $REPO_DIR is derived from the header's url, and the Claude Code trust gate is written
    // for it: a first repository cloned elsewhere would leave that gate naming nothing.
    const first = checkedSpec(
      "mine",
      spec({ repos: [{ url: "https://github.com/me/x", secret: null, dir: "/workspace/other" }] }),
      SHIPPED,
    );
    expect(first.ok).toBe(false);

    const second = checkedSpec(
      "mine",
      spec({
        repos: [
          { url: "https://github.com/me/x", secret: null, dir: null },
          { url: "https://github.com/me/y", secret: "github", dir: "/workspace/y" },
        ],
      }),
      SHIPPED,
    );
    expect(second.ok).toBe(true);
  });

  test("an unknown software id is refused rather than dropped", () => {
    const checked = checkedSpec("mine", spec({ software: ["node", "rm-rf"] }), SHIPPED);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.field).toBe("software");
  });

  test("floors and ports keep src/validate.ts's bounds", () => {
    expect(checkedSpec("mine", spec({ cpu: 2, ram: 4, disk: 40, ports: [3000] }), SHIPPED).ok).toBe(true);
    expect(checkedSpec("mine", spec({ cpu: 0 }), SHIPPED).ok).toBe(false);
    expect(checkedSpec("mine", spec({ disk: 5 }), SHIPPED).ok).toBe(false);
    expect(checkedSpec("mine", spec({ ports: [3000, 70000] }), SHIPPED).ok).toBe(false);
    expect(checkedSpec("mine", spec({ ports: [1.5] }), SHIPPED).ok).toBe(false);
    expect(checkedSpec("mine", spec({ ports: [0] }), SHIPPED).ok).toBe(false);
  });

  /**
   * Several since 24/09, each a forward on the workstation, where ssh refuses the ENTIRE config
   * on one it cannot read: a list, deduplicated in order, eight at most.
   */
  test("ports are a list, the app first, each once", () => {
    const checked = checkedSpec("mine", spec({ ports: [9010, "5173", 9010, 3000] as never }), SHIPPED);
    expect(checked.ok && checked.value.ports).toEqual([9010, 5173, 3000]);
    expect(checkedSpec("mine", spec({ ports: "9010" as never }), SHIPPED).ok).toBe(false);
    expect(checkedSpec("mine", spec({ ports: ["9010 5173"] as never }), SHIPPED).ok).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => 3000 + i);
    expect(checkedSpec("mine", spec({ ports: nine }), SHIPPED).ok).toBe(false);
  });

  /**
   * A row stored before the list has `port`, one number or null, and no `ports`. Read as a
   * list of one - the header it renders is the same byte for byte, so a restart rewrites no
   * profile - and null as none.
   */
  test("reads the single port of a row stored before the list", () => {
    const { ports: _ports, ...rest } = spec();
    const legacy = (port: unknown) => checkedSpec("mine", { ...rest, port } as never, SHIPPED);
    const one = legacy(9010);
    expect(one.ok && one.value.ports).toEqual([9010]);
    const none = legacy(null);
    expect(none.ok && none.value.ports).toEqual([]);
    expect(legacy(70000).ok).toBe(false);
  });

  test("renders the ports on one header line, the app first", () => {
    const script = renderProfile(spec({ ports: [9010, 5173] }), Date.UTC(2026, 8, 24));
    expect(script).toContain("# devbox-port:     9010 5173\n");
    expect(renderProfile(spec({ ports: [] }), Date.UTC(2026, 8, 24))).not.toContain("devbox-port");
  });
});

describe("a setup script", () => {
  const repo = { url: "https://github.com/me/x", secret: null, dir: null };
  const withSetup = (setup: unknown, repos = [repo]) =>
    checkedSpec("mine", { ...spec({ repos }), setup }, SHIPPED);

  test("is a path inside the repository, and `./` names the same file", () => {
    for (const [typed, kept] of [
      ["scripts/devbox-setup.sh", "scripts/devbox-setup.sh"],
      ["./setup.sh", "setup.sh"],
      ["  tools/v1.2/boot_strap.py ", "tools/v1.2/boot_strap.py"],
      [".devbox/setup", ".devbox/setup"],
    ] as const) {
      const checked = withSetup(typed);
      expect({ typed, ok: checked.ok }).toEqual({ typed, ok: true });
      if (checked.ok) expect(checked.value.setup).toBe(kept);
    }
  });

  test("absent, empty or null is no script, which is what a row from before 17/09 holds", () => {
    for (const setup of [undefined, null, ""]) {
      const checked = withSetup(setup);
      expect(checked.ok).toBe(true);
      if (checked.ok) expect(checked.value.setup).toBe(null);
    }
    // Byte for byte what such a row rendered: syncProfiles rewrites none of them at a restart.
    expect(renderProfile(spec({ repos: [repo] }), 0)).not.toContain("run_setup");
  });

  test("refuses what would leave the checkout or become more than one shell word", () => {
    for (const setup of [
      "/etc/profile",
      "../elsewhere.sh",
      "scripts/../../etc/x",
      "scripts/./x.sh",
      "scripts//x.sh",
      "scripts/",
      "x';touch /tmp/pwned;'",
      "x.sh; id",
      "$(id).sh",
      "`id`",
      "two words.sh",
      "é.sh",
      "x\n.sh",
      "a".repeat(201),
      42,
    ]) {
      const checked = withSetup(setup);
      expect({ setup, ok: checked.ok }).toEqual({ setup, ok: false });
      if (!checked.ok) expect(checked.field).toBe("setup");
    }
  });

  test("needs a repository to be read from", () => {
    const checked = withSetup("setup.sh", []);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.field).toBe("setup");
      expect(checked.reason).toContain("repository");
    }
  });
});

describe("what it declares", () => {
  test("the header carries every name, an optional one turned on included", () => {
    const one = spec({
      software: ["claude", "gh"],
      optional: ["github"],
      secrets: ["extra"],
      repos: [{ url: "https://gitlab.com/me/x", secret: "gitlab", dir: null }],
    });
    expect(declaredSecrets(one)).toEqual(["claude", "extra", "github", "gitlab"]);
    // require_secrets holds only what a seed cannot start without: `github` degrades inside
    // install_gh, a private repository's credential does not.
    expect(requiredSecrets(one)).toEqual(["claude", "gitlab"]);
  });
});

describe("the render", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");

  test("a header key is never written twice", () => {
    const script = renderProfile(
      spec({
        note: "a note",
        software: ["claude"],
        repos: [
          { url: "https://github.com/me/x", secret: "github", dir: null },
          { url: "https://github.com/me/y", secret: null, dir: "/workspace/y" },
        ],
        cpu: 2,
        ram: 4,
        disk: 40,
        ports: [9010, 5173],
      }),
      now,
    );
    const keys = headerKeys(script);
    // profile_path refuses a file that declares one twice, and would refuse the whole
    // profile - not just the extra line.
    expect(new Set(keys).size).toBe(keys.length);
    expect(meta(script, "repo")).toBe("https://github.com/me/x");
    expect(meta(script, "secrets")).toBe("claude github");
    expect(meta(script, "min-cpu")).toBe("2");
    expect(meta(script, "note")).toBe("a note");
  });

  test("the sentinel is the second line, and is not shaped like a header key", () => {
    const script = renderProfile(spec(), now);
    expect(script.split("\n")[0]).toBe("#!/bin/bash");
    expect(script.split("\n")[1]).toBe(SENTINEL);
    expect(headerKeys(script)).not.toContain("devbox-dashboard:");
  });

  test("every argument is single-quoted, and the agents come after the clone", () => {
    const script = renderProfile(
      spec({
        software: ["claude", "python"],
        repos: [
          { url: "https://github.com/me/x", secret: "github", dir: null },
          { url: "https://github.com/me/y", secret: null, dir: "/workspace/y" },
        ],
      }),
      now,
    );
    // The first repository takes url and directory from the header, so $REPO_DIR names what
    // was cloned; an empty first argument is how clone_repo is told a repository is public.
    expect(script).toContain("clone_repo 'github'\n");
    expect(script).toContain("clone_repo '' 'https://github.com/me/y' '/workspace/y'");
    expect(script.indexOf("clone_repo")).toBeLessThan(script.indexOf("install_claude_code"));
    expect(script.indexOf("install_python")).toBeLessThan(script.indexOf("clone_repo"));
    expect(script).toContain("require_secrets 'claude' 'github'");
  });

  test("the setup script runs last, after every clone and every tool", () => {
    const script = renderProfile(
      spec({
        software: ["claude", "python"],
        repos: [
          { url: "https://github.com/me/x", secret: "github", dir: null },
          { url: "https://github.com/me/y", secret: null, dir: "/workspace/y" },
        ],
        setup: "scripts/devbox-setup.sh",
      }),
      now,
    );
    const call = script.indexOf("run_setup 'scripts/devbox-setup.sh'\n");
    expect(call).toBeGreaterThan(-1);
    expect(script.lastIndexOf("clone_repo")).toBeLessThan(call);
    expect(script.indexOf("install_claude_code")).toBeLessThan(call);
    expect(call).toBeLessThan(script.indexOf("step 'done'"));
    // A path is not a secret: nothing new is declared or required for it.
    expect(meta(script, "secrets")).toBe("claude github");
  });

  test("a value the validator would have refused throws rather than being escaped", () => {
    // The second belt. checkedSpec is the first, and the day the two drift apart this is
    // what stops a quote from closing an argument in a file that runs as root.
    expect(() =>
      renderProfile(spec({ repos: [{ url: "https://x/y';id;'", secret: null, dir: null }] }), now),
    ).toThrow();
    expect(() => renderProfile(spec({ note: "two\nlines" }), now)).toThrow();
    const repos = [{ url: "https://github.com/me/x", secret: null, dir: null }];
    expect(() => renderProfile(spec({ repos, setup: "../x.sh" }), now)).toThrow();
    expect(() => renderProfile(spec({ repos, setup: "x';id;'" }), now)).toThrow();
  });

  test("the same spec renders the same bytes", () => {
    // syncProfiles compares the disk with this, so anything varying between two calls would
    // rewrite every profile at every start.
    expect(renderProfile(spec({ software: ["claude"] }), now)).toBe(
      renderProfile(spec({ software: ["claude"] }), now),
    );
  });
});

describe("the file", () => {
  const now = Date.parse("2026-09-12T10:00:00Z");

  test("it is written 0600, whole, and recognised afterwards", () => {
    const dir = directory();
    writeAuthored(spec(), now, dir);
    const path = join(dir, "mine.sh");
    expect(isAuthored(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // No temporary left behind: the write goes through one and renames.
    expect(existsSync(join(dir, ".mine.tmp"))).toBe(false);
  });

  test("a file this service did not write is neither claimed nor removed", () => {
    const dir = directory();
    const path = join(dir, "mine.sh");
    writeFileSync(path, "#!/bin/bash\n# devbox-secrets: private\n", { mode: 0o600 });

    expect(isAuthored(path)).toBe(false);
    expect(strangerAt("mine", dir)).toBe(true);
    expect(removeAuthored("mine", dir)).toBe(false);
    // Untouched, byte for byte: this is the profile a real deployment deposits by hand.
    expect(readFileSync(path, "utf8")).toBe("#!/bin/bash\n# devbox-secrets: private\n");
  });

  test("syncProfiles rewrites what is missing or stale and keeps a stranger", () => {
    const dir = directory();
    const mine = { spec: spec({ name: "mine" }), created_at: now, updated_at: now };
    const theirs = { spec: spec({ name: "theirs" }), created_at: now, updated_at: now };
    writeFileSync(join(dir, "theirs.sh"), "#!/bin/bash\n# by hand\n", { mode: 0o600 });

    const first = syncProfiles([mine, theirs], dir);
    expect(first.written).toEqual(["mine"]);
    expect(first.kept).toEqual(["theirs"]);
    expect(readFileSync(join(dir, "theirs.sh"), "utf8")).toBe("#!/bin/bash\n# by hand\n");

    // Idempotent: a second start rewrites nothing.
    expect(syncProfiles([mine, theirs], dir).written).toEqual([]);

    // And a file removed by hand comes back.
    removeAuthored("mine", dir);
    expect(syncProfiles([mine, theirs], dir).written).toEqual(["mine"]);
  });

  test("a directory that does not exist yet is made", () => {
    const dir = join(directory(), "profiles");
    writeAuthored(spec(), now, dir);
    expect(existsSync(join(dir, "mine.sh"))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
