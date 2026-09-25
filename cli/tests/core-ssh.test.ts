import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync, rmdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  CORE,
  cleanup,
  fakeMachine,
  fakeTerraform,
  phases,
  runCore,
  sandbox,
  strip,
  verdict,
} from "./harness.ts";

/**
 * ~/.ssh/config, written and unwritten by the real devbox-core.
 *
 * This is the part of the file that touches something the operator did not create and
 * cannot easily rebuild. Everything else devbox writes lives under a directory that belongs
 * to it — tf/, ~/.config/devbox, a cache — and the worst a bug there costs is a re-run.
 * ~/.ssh/config holds every host that Mac talks to, devbox's four lines sit in the middle of
 * a hundred that were typed by hand, and a single malformed line makes ssh reject the
 * WHOLE file: `bad.cfg: terminating, 1 bad configuration options`, for every host in it.
 * So the tests below are less about "the block is right" than about "nothing else moved".
 *
 * The core already says it has paid for this once — with_lock's comment measures three
 * concurrent `down` as three read-modify-writes where the last one wins, two blocks
 * removed and one left behind. That measurement is what the two lock tests here keep.
 *
 * Reached through `devbox sync`, which is the shortest path to these functions with no cloud
 * in it: cmd_sync asks a dashboard for a fleet, then does the two things a server cannot
 * do for a workstation — accept a host key, and write the Host block. A Bun.serve of nine
 * lines is a whole fleet, and every port number below is decided locally, by
 * next_local_port, against this file and this Mac's own sockets.
 *
 * Nothing here reaches the network. ssh-keyscan is shadowed in $HOME/bin, so the
 * addresses in these fleets are documentation rather than destinations, and a typo cannot
 * become an outbound connection.
 */

/** What the dashboard answers with when it is running these very bytes, so the gate is silent. */
const OURS = new Bun.CryptoHasher("sha256").update(readFileSync(CORE)).digest("hex");

/** cmd_sync opens with `need jq`, so without it there is no behaviour left to assert. */
const CANNOT_RUN = Bun.which("jq") === null;

/**
 * ssh itself, when this Mac has one, used as the judge of the file rather than a regex.
 *
 * `ssh -F <file> -G <host>` parses the whole config and prints the effective options for
 * one host without opening a connection — 0 when every line was accepted, 255 when ssh
 * threw the file away. That is the only opinion that matters here, since the damage a
 * malformed block does is not to the block but to every other host in the file.
 */
const SSH = Bun.which("ssh");

type Machine = { name: string } & Record<string, unknown>;

let fleet: Machine[] = [];

/** The dashboard, reduced to the fleet routes cmd_sync reads and the gate it passes through. */
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/version") return Response.json({ core: OURS, built_at: null });
    if (path === "/api/machines") return Response.json(fleet);
    const one = fleet.find((machine) => path === `/api/machines/${machine.name}`);
    if (one) return Response.json(one);
    return new Response("not found", { status: 404 });
  },
});
// So a machine without jq, where the whole block is skipped and afterAll may never run,
// does not sit on an open listener instead of finishing the run.
server.unref();

afterAll(() => {
  server.stop(true);
  cleanup();
});

beforeEach(() => {
  fleet = [];
});

/**
 * One throwaway Mac: a fresh HOME, and the two binaries that would otherwise reach outside
 * it shadowed in $HOME/bin.
 *
 * The key is deposited rather than generated. ensure_key runs at the top of cmd_sync and
 * would mint an ed25519 pair per invocation — a third of a second each, times the sixteen
 * spawns in the concurrency test — and its only contribution to what is under test here is
 * the string `~/.ssh/devbox` on the IdentityFile line.
 *
 * ssh-keyscan is shadowed because refresh_known_hosts runs before every single write with
 * `-T 10` against whatever address the dashboard named. A TEST-NET address black-holes for
 * the full ten seconds, and a real one would be a real connection from a test suite. The
 * stub answers nothing, which is exactly what an unreachable host answers.
 */
function workstation(): Record<string, string> {
  const env = sandbox();
  const home = env["HOME"] ?? "";
  writeFileSync(join(home, ".ssh", "devbox"), "not a real key\n", { mode: 0o600 });
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "ssh-keyscan"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  // ssh-keygen is shadowed, and the temporary HOME is NOT what makes that unnecessary.
  // OpenSSH expands ~ from the PASSWD DATABASE rather than from $HOME, so an unshadowed
  // ssh-keygen under a temporary HOME still rewrites the operator's own ~/.ssh/known_hosts,
  // backup file and all. Measured before this line existed: 34 real invocations per run of
  // this file. core/tests/fakebin.ts states the same rule; this rig had the other two
  // shadows and not this one.
  //
  // refresh_known_hosts now passes -f, which is what makes the purge land on the file the
  // keyscan appends to — the test at the foot of this file holds that. The shadow stays:
  // it is the operator's file this protects, and -f is a line of the core that a future
  // edit can drop.
  writeFileSync(join(bin, "ssh-keygen"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return { ...env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
}

/**
 * An lsof that reports nothing listening, so the allocation is arithmetic rather than a
 * property of whoever is running the suite.
 *
 * next_local_port asks lsof about every candidate port, which is right — two devbox tunnels
 * and a Vite dev server all want 9010 — and it means the real first port on a developer's
 * Mac is whatever is free that day. Measured while writing this: 9010 was already held
 * here by a tunnel to a live machine, so an unshadowed run allocated 9011 and 16444. The
 * numbers the core documents are the numbers on a Mac holding nothing, and that is the Mac
 * this stub describes. The skipping itself is tested separately, against a real listener.
 */
function noListeners(env: Record<string, string>): void {
  writeFileSync(join(env["HOME"] ?? "", "bin", "lsof"), "#!/usr/bin/env bash\nexit 1\n", {
    mode: 0o755,
  });
}

const configPath = (env: Record<string, string>): string => join(env["HOME"] ?? "", ".ssh", "config");
const config = (env: Record<string, string>): string => readFileSync(configPath(env), "utf8");

const sync = (env: Record<string, string>, extra: Record<string, string | undefined> = {}) =>
  runCore(["sync"], {
    ...env,
    DEVBOX_REMOTE: server.url.origin,
    DEVBOX_REMOTE_TOKEN: "t",
    ...extra,
  });

const beginMark = (name: string): string => `# >>> devbox:${name} >>>`;
const endMark = (name: string): string => `# <<< devbox:${name} <<<`;

/** Every name the markers declare, in file order — what ssh_config_names reads. */
const marked = (text: string): string[] =>
  [...text.matchAll(/^# >>> devbox:(.+) >>>$/gm)].map((match) => match[1] ?? "");

/** The lines between one pair of markers, indentation removed. */
function inside(text: string, name: string): string[] {
  const lines = text.split("\n");
  const from = lines.indexOf(beginMark(name));
  const to = lines.indexOf(endMark(name));
  if (from === -1 || to === -1 || to < from) return [];
  return lines.slice(from + 1, to).map((line) => line.trim());
}

/** The local port of the first forward in a block, which is the one the app is reached on. */
function appForward(text: string, name: string): number {
  const line = inside(text, name).find((candidate) => candidate.startsWith("LocalForward "));
  return Number(line?.split(/\s+/)[1]);
}

/** The local port of the cluster forward, the second one. */
function kubeForward(text: string, name: string): number {
  const lines = inside(text, name).filter((candidate) => candidate.startsWith("LocalForward "));
  return Number(lines[1]?.split(/\s+/)[1]);
}

/** A machine as the dashboard describes one, with only the fields cmd_sync reads. */
const described = (name: string, over: Record<string, unknown> = {}): Machine => ({
  name,
  cloud: "hetzner",
  region: "fsn1",
  ip: "203.0.113.9",
  user: "devbox",
  port: 22,
  app_port: 9010,
  profile: "claude",
  ...over,
});

describe.skipIf(CANNOT_RUN)("the Host block devbox writes into ~/.ssh/config", () => {
  test("writes one marked block holding everything ssh needs to reach the machine", async () => {
    const env = workstation();
    noListeners(env);
    fleet = [described("devbox-aaa", { ip: "203.0.113.9", user: "dev", port: 2222, app_port: 4000 })];

    const { code, stdout, stderr } = await sync(env);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(phases(stdout)).toEqual(["1 block(s) written, 0 removed"]);

    const text = config(env);
    // The markers are asserted as whole lines and not as a substring: they are the registry
    // — ssh_config_names, local_port and profile_of all match them with `==` on the entire
    // line — so a stray space added to begin_mark would orphan every block already written.
    expect(text).toContain(`${beginMark("devbox-aaa")}\n`);
    expect(text).toContain(`${endMark("devbox-aaa")}\n`);

    // The whole block, in order, rather than a handful of toContain: this file is read by
    // ssh and by three awk one-liners in the core, and a line that moved is as much of a
    // change as a line that went missing.
    expect(inside(text, "devbox-aaa")).toEqual([
      "Host devbox-aaa",
      "HostName 203.0.113.9",
      "User dev",
      "Port 2222",
      // Tilde-collapsed, which is `${KEY/#$HOME/~}` and not cosmetic: the block is what
      // `info` reads back to print for a phone, and an absolute /Users/... path from
      // another Mac is not a thing anyone can type.
      "IdentityFile ~/.ssh/devbox",
      "IdentitiesOnly yes",
      "StrictHostKeyChecking accept-new",
      // Asserted as a PAIR and in this order. The guard is what keeps an ssh older than
      // 9.5 from refusing the whole file — every host in it — over a keyword it does not
      // know, and a guard that arrives after the line it guards guards nothing.
      "IgnoreUnknown ObscureKeystrokeTiming",
      "ObscureKeystrokeTiming no",
      // The app port comes from the dashboard's answer, the local one from this Mac.
      "LocalForward 9010 127.0.0.1:4000",
      "LocalForward 16443 127.0.0.1:6443",
      "# devbox-profile claude",
    ]);

    // 600, because ssh refuses a config it considers world-readable and the failure shows
    // up as a permission error on an unrelated host hours later.
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);

    // And the lock was given back. Left behind, the next `devbox sync` on this Mac spends
    // fifteen seconds waiting for a process that exited long ago.
    expect(existsSync(join(env["HOME"] ?? "", ".ssh", ".devbox-config.lock"))).toBe(false);
  });

  /**
   * Several ports since 24/09. The app's forward stays first and the cluster's second, which
   * every reader of the first forward relies on; the others follow, each on the app's local
   * port plus 1000 per rank, so the machine's offset still names it: 10011 and 11011 beside
   * 9011.
   */
  test("writes one forward per port the profile declares, after the app's and the cluster's", async () => {
    const env = workstation();
    noListeners(env);
    fleet = [
      described("devbox-aaa", { app_ports: [9010] }),
      described("devbox-bbb", { app_port: 4000, app_ports: [4000, 5173, 3000] }),
    ];

    expect((await sync(env)).code).toBe(0);

    const forwards = inside(config(env), "devbox-bbb").filter((line) => line.startsWith("LocalForward "));
    expect(forwards).toEqual([
      "LocalForward 9011 127.0.0.1:4000",
      "LocalForward 16444 127.0.0.1:6443",
      "LocalForward 10011 127.0.0.1:5173",
      "LocalForward 11011 127.0.0.1:3000",
    ]);
    if (SSH) {
      const judged = Bun.spawnSync([SSH, "-F", configPath(env), "-G", "devbox-bbb"]);
      expect(judged.exitCode).toBe(0);
    }
  });

  /**
   * An extra port that something on this Mac already listens on - a Vite of its own on
   * 10010 - is not taken over: the first free one from 20000 is, and the block says which.
   */
  test("moves an extra forward to a free port when its own is taken", async () => {
    const env = workstation();
    writeFileSync(
      join(env["HOME"] ?? "", "bin", "lsof"),
      '#!/usr/bin/env bash\ncase "$*" in *":10010 "*) exit 0 ;; esac\nexit 1\n',
      { mode: 0o755 },
    );
    fleet = [described("devbox-aaa", { app_ports: [9010, 5173, 3000] })];

    expect((await sync(env)).code).toBe(0);

    const forwards = inside(config(env), "devbox-aaa").filter((line) => line.startsWith("LocalForward "));
    expect(forwards).toEqual([
      "LocalForward 9010 127.0.0.1:9010",
      "LocalForward 16443 127.0.0.1:6443",
      "LocalForward 20000 127.0.0.1:5173",
      "LocalForward 11010 127.0.0.1:3000",
    ]);
  });

  test("gives the first machine 9010 and 16443, and the second 9011 and 16444", async () => {
    const env = workstation();
    noListeners(env);
    fleet = [described("devbox-aaa"), described("devbox-bbb", { app_port: 3000 })];

    const { code } = await sync(env);
    expect(code).toBe(0);

    const text = config(env);
    // The rule next_local_port encodes: the first free port from 9010 upwards, where "free"
    // means absent from every LocalForward already in the file and unbound on this Mac. Two
    // machines therefore do not both take 9010 — which is the whole point, since only the
    // first forward to ask for a port can bind it and the second ssh would simply fail.
    expect(appForward(text, "devbox-aaa")).toBe(9010);
    expect(appForward(text, "devbox-bbb")).toBe(9011);
    // The offset carries, so one number identifies a machine everywhere: 16443 rather than
    // 6443 so that Docker Desktop's own cluster is never the one kubectl reaches.
    expect(kubeForward(text, "devbox-aaa")).toBe(16443);
    expect(kubeForward(text, "devbox-bbb")).toBe(16444);
  });

  test.skipIf(Bun.which("lsof") === null)(
    "steps over a local port something else is already listening on",
    async () => {
      // The half of the rule the stub above cannot show. A port free in the file but bound
      // by a browser, a dev server or another devbox tunnel is not free: ssh -L would fail to
      // bind it and the session would open with no forward at all, which looks like the app
      // being down rather than like a port clash.
      let squatted = 0;
      for (let port = 9010; port <= 9060; port++) {
        if (Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).exitCode !== 0) {
          squatted = port;
          break;
        }
      }
      expect(squatted).toBeGreaterThan(0);
      const decoy = Bun.serve({ port: squatted, fetch: () => new Response("busy") });

      try {
        const env = workstation();
        fleet = [described("devbox-aaa")];
        const { code } = await sync(env);
        expect(code).toBe(0);

        const text = config(env);
        const allocated = appForward(text, "devbox-aaa");
        // Not an exact number: whatever else this Mac happens to be listening on is part of
        // the input, and that is the behaviour, not a flaw in the test.
        expect(allocated).not.toBe(squatted);
        expect(allocated).toBeGreaterThanOrEqual(9010);
        expect(kubeForward(text, "devbox-aaa")).toBe(16443 + allocated - 9010);
      } finally {
        decoy.stop(true);
      }
    },
  );

  test("re-running on the same name reclaims its own port instead of drifting one higher", async () => {
    const env = workstation();
    noListeners(env);
    fleet = [described("devbox-aaa"), described("devbox-bbb")];

    await sync(env);
    const first = config(env);
    await sync(env);
    const second = config(env);

    // write_ssh_config strips its own block BEFORE allocating, and this is the assertion
    // that keeps that ordering. Allocating first would see its own forward as taken, hand
    // out the next one up, and `devbox sync` run in a loop would walk a machine from 9010 to
    // 9060 and then die on "no free local port" with nothing actually listening.
    expect(second).toBe(first);
    expect(marked(second)).toEqual(["devbox-aaa", "devbox-bbb"]);
    // One block per name, not two. Appended rather than rewritten, a second block for the
    // same host silently wins or loses depending on which one ssh reads first.
    expect(second.split(beginMark("devbox-aaa"))).toHaveLength(2);
    expect(appForward(second, "devbox-aaa")).toBe(9010);
    expect(appForward(second, "devbox-bbb")).toBe(9011);
  });
});

describe.skipIf(CANNOT_RUN)("what devbox removes, and what it must not touch", () => {
  /** A config as an operator leaves it: hand-written hosts, one before and one after. */
  const HANDWRITTEN = [
    "Host laptop-relay",
    "  HostName 10.9.9.9",
    "  User relay",
    "  LocalForward 5432 127.0.0.1:5432",
    "",
    "Host archive.example.test",
    "  HostName 10.9.9.8",
    "  IdentityFile ~/.ssh/archive_ed25519",
    "",
  ].join("\n");

  test("gives the file back byte for byte once the machine is gone", async () => {
    const env = workstation();
    noListeners(env);
    writeFileSync(configPath(env), HANDWRITTEN);

    fleet = [described("devbox-aaa")];
    await sync(env);
    const withBlock = config(env);
    // Written after everything that was already there, never into the middle of it.
    expect(withBlock.startsWith(HANDWRITTEN)).toBe(true);
    expect(marked(withBlock)).toEqual(["devbox-aaa"]);
    // The hand-written forward is part of the input to the allocator, and stepping over it
    // is right: 5432 is outside the window anyway, but a hand-written 9010 would not be.
    expect(appForward(withBlock, "devbox-aaa")).toBe(9010);

    fleet = [];
    const { code, stdout } = await sync(env);
    expect(code).toBe(0);
    expect(phases(stdout)).toEqual(["0 block(s) written, 1 removed"]);

    // The assertion this whole file exists for. Not "the devbox block is gone" — that is easy
    // to get right — but "everything else is exactly as it was", down to the blank lines,
    // because drop_ssh_config filters the file through awk and moves the result back over
    // a file the operator has been editing by hand for years.
    expect(config(env)).toBe(HANDWRITTEN);
  });

  test("removes one machine's block and leaves the other machine's alone", async () => {
    const env = workstation();
    noListeners(env);
    fleet = [described("devbox-aaa"), described("devbox-bbb")];
    await sync(env);
    const both = config(env);

    fleet = [described("devbox-bbb")];
    const { stdout } = await sync(env);
    expect(phases(stdout)).toEqual(["1 block(s) written, 1 removed"]);

    const text = config(env);
    expect(marked(text)).toEqual(["devbox-bbb"]);
    expect(inside(text, "devbox-aaa")).toEqual([]);
    // Identical, port included. A surviving machine whose forward moved because a NEIGHBOUR
    // was destroyed is a machine whose bookmarks and kubectl context silently stopped
    // pointing at it.
    expect(inside(text, "devbox-bbb")).toEqual(inside(both, "devbox-bbb"));
    expect(appForward(text, "devbox-bbb")).toBe(9011);
  });

  test("takes the names it removes from the markers, not from the Host lines", async () => {
    const env = workstation();
    noListeners(env);
    // A block whose marker and whose Host line disagree. Contrived, but it is the only way
    // to tell which of the two ssh_config_names reads, and the answer decides what `devbox
    // sync` deletes from a file it did not write all of. Two hand-written hosts stand
    // around it: neither carries a marker, so neither is devbox's to remove, however much
    // `Host devbox-something` a hand-written block might look like.
    writeFileSync(
      configPath(env),
      [
        "Host devbox-lookalike",
        "  HostName 10.0.0.1",
        "",
        beginMark("ghost-one"),
        "Host not-the-name",
        "  HostName 198.51.100.7",
        "  LocalForward 9010 127.0.0.1:9010",
        endMark("ghost-one"),
        "Host archive",
        "  HostName 10.9.9.8",
        "",
      ].join("\n"),
    );

    fleet = [];
    const { code, stdout } = await sync(env);
    expect(code).toBe(0);
    // One, and it is the marked one. Two would mean the hand-written lookalike was counted.
    expect(phases(stdout)).toEqual(["0 block(s) written, 1 removed"]);

    const text = config(env);
    expect(marked(text)).toEqual([]);
    expect(text).not.toContain("not-the-name");
    expect(text).toContain("Host devbox-lookalike");
    expect(text).toContain("Host archive");
  });
});

describe.skipIf(CANNOT_RUN)("the config as the registry", () => {
  /**
   * The core keeps no side file of "which port did machine X get". The Host block is the
   * answer AND the record, so `info` re-reads what `sync` wrote. These two tests close that
   * loop across two invocations and two modes: written against a dashboard, read back with
   * DEVBOX_REMOTE emptied, which is the local path through local_port, profile_of and
   * app_port_of.
   */
  function withState(env: Record<string, string>, name: string): void {
    fakeMachine(env, "hetzner", name);
    fakeTerraform(env, {
      cloud: { value: "hetzner" },
      region: { value: "fsn1" },
      instance_type: { value: "cx33" },
      ip: { value: "203.0.113.9" },
      user: { value: "devbox" },
      port: { value: 22 },
      hourly_eur: { value: 0.014 },
    });
  }

  test("reads back the port and the profile that were written into the block", async () => {
    const env = workstation();
    noListeners(env);
    // A profile of this workstation, not the repository's: $CONFIG_DIR/profiles comes first
    // in PROFILE_DIRS, so the test owns the header app_port_of will read.
    const profiles = join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "web.sh"), "#!/bin/bash\n# devbox-port:  4000\n# devbox-note: alice@acme\n");

    withState(env, "devbox-aaa");
    fleet = [described("devbox-aaa", { app_port: 4000, profile: "web" })];
    expect((await sync(env)).code).toBe(0);

    const { code, stdout } = await runCore(["info", "devbox-aaa", "--json"], {
      ...env,
      DEVBOX_REMOTE: "",
    });
    expect(code).toBe(0);
    const detail = JSON.parse(stdout);

    // local_port and profile_of, both reading the block by its markers.
    expect(detail.local_port).toBe(9010);
    expect(detail.profile).toBe("web");
    // app_port_of, reading the profile the block recorded rather than assuming 9010 — a
    // forward aimed at the wrong port inside reaches nothing, and the screen that prints
    // this is the one someone types into Termius with no way to check it.
    expect(detail.app_port).toBe(4000);
    expect(detail.kube_port).toBe(16443);
    expect(detail.note).toBe("alice@acme");
  });

  /**
   * `devbox tunnel` builds its -L pairs by hand rather than reading the Host block, so it has
   * to carry the extra ports itself - on the local ports the block gave them.
   */
  test("tunnel opens every port the profile forwards, on the block's local ports", async () => {
    const env = workstation();
    noListeners(env);
    const argv = join(env["HOME"] ?? "", "ssh.argv");
    writeFileSync(join(env["HOME"] ?? "", "bin", "ssh"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > ${JSON.stringify(argv)}\nexit 0\n`, {
      mode: 0o755,
    });
    fleet = [described("devbox-aaa", { app_port: 4000, app_ports: [4000, 5173], local_port: 9010 })];
    expect((await sync(env)).code).toBe(0);

    const tunnel = await runCore(["tunnel", "devbox-aaa"], {
      ...env,
      DEVBOX_REMOTE: server.url.origin,
      DEVBOX_REMOTE_TOKEN: "t",
    });
    expect(tunnel.code, tunnel.stderr).toBe(0);
    const asked = readFileSync(argv, "utf8");
    expect(asked).toContain("-L 9010:127.0.0.1:4000");
    expect(asked).toContain("-L 16443:127.0.0.1:6443");
    expect(asked).toContain("-L 10010:127.0.0.1:5173");
    expect(strip(tunnel.stdout)).toContain("http://localhost:10010");
  });

  test("reads back every forward, the cluster's aside, and every port the profile declares", async () => {
    const env = workstation();
    noListeners(env);
    const profiles = join(env["DEVBOX_CONFIG_DIR"] ?? "", "profiles");
    mkdirSync(profiles, { recursive: true });
    writeFileSync(join(profiles, "web.sh"), "#!/bin/bash\n# devbox-port:  4000 5173\n");

    withState(env, "devbox-aaa");
    fleet = [described("devbox-aaa", { app_port: 4000, app_ports: [4000, 5173], profile: "web" })];
    expect((await sync(env)).code).toBe(0);

    const { code, stdout } = await runCore(["info", "devbox-aaa", "--json"], {
      ...env,
      DEVBOX_REMOTE: "",
    });
    expect(code).toBe(0);
    const detail = JSON.parse(stdout);
    expect(detail.app_port).toBe(4000);
    expect(detail.app_ports).toEqual([4000, 5173]);
    expect(detail.forwards).toEqual([
      { local: 9010, remote: 4000 },
      { local: 10010, remote: 5173 },
    ]);
    expect(detail.kube_port).toBe(16443);

    // And the card for a phone names the extra one, with the local port this block gave it.
    const card = await runCore(["info", "devbox-aaa"], { ...env, DEVBOX_REMOTE: "" });
    expect(strip(card.stdout)).toContain("10010 → localhost:5173");
  });

  test("still describes a machine whose profile has since been renamed away", async () => {
    const env = workstation();
    noListeners(env);
    withState(env, "devbox-aaa");
    // The block records `gone`, and no such profile exists anywhere. app_port_of falls back
    // rather than dies, on purpose: it is called to DESCRIBE a machine, and a machine that
    // cannot be printed is a machine that cannot be reached or destroyed either.
    fleet = [described("devbox-aaa", { profile: "gone" })];
    expect((await sync(env)).code).toBe(0);

    const { code, stdout, stderr } = await runCore(["info", "devbox-aaa", "--json"], {
      ...env,
      DEVBOX_REMOTE: "",
    });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const detail = JSON.parse(stdout);
    expect(detail.profile).toBe("gone");
    expect(detail.app_port).toBe(9010);
    expect(detail.note).toBeNull();
  });

  test("records the default profile when the dashboard names none", async () => {
    const env = workstation();
    noListeners(env);
    // field_of turns a JSON null into an empty string, and write_ssh_config falls back to
    // $PROFILE — this invocation's profile, not a constant, which is why DEVBOX_PROFILE is set
    // to something other than the default here. Pinned because the recorded name is what a
    // later `devbox seed` with no --profile re-provisions with: a wrong one there rebuilds the
    // machine as something else entirely.
    fleet = [described("devbox-aaa", { profile: null })];
    expect((await sync(env, { DEVBOX_PROFILE: "opencode" })).code).toBe(0);
    expect(inside(config(env), "devbox-aaa")).toContain("# devbox-profile opencode");
  }, 10_000);

  /**
   * With no default profile since 24/09, the dashboard naming none and DEVBOX_PROFILE unset
   * leave nothing to record - and an empty `# devbox-profile` line would be read back by
   * profile_of as a profile named "", which a later `seed` would then refuse to find.
   */
  test("records no profile when neither the dashboard nor DEVBOX_PROFILE names one", async () => {
    const env = workstation();
    noListeners(env);
    fleet = [described("devbox-aaa", { profile: null })];
    expect((await sync(env)).code).toBe(0);
    expect(inside(config(env), "devbox-aaa")).not.toContain("devbox-profile");
  }, 10_000);
});

describe.skipIf(CANNOT_RUN)("the lock around the read-modify-write", () => {
  test("waits for a lock another process holds, then writes", async () => {
    const env = workstation();
    noListeners(env);
    writeFileSync(configPath(env), "Host laptop-relay\n  HostName 10.9.9.9\n");
    const lock = join(env["HOME"] ?? "", ".ssh", ".devbox-config.lock");
    mkdirSync(lock);

    fleet = [described("devbox-aaa")];
    const running = sync(env);

    // Long enough that an unlocked write would certainly have landed — the same invocation
    // finishes in well under a fifth of a second when the lock is free.
    await Bun.sleep(1_000);
    expect(marked(config(env))).toEqual([]);

    rmdirSync(lock);
    const { code } = await running;
    expect(code).toBe(0);
    // It waited rather than gave up, and then did the work.
    expect(marked(config(env))).toEqual(["devbox-aaa"]);
    expect(config(env)).toContain("Host laptop-relay");
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  test(
    "gives up on a lock nobody is going to release, and leaves the file untouched",
    async () => {
      const env = workstation();
      noListeners(env);
      const before = "Host laptop-relay\n  HostName 10.9.9.9\n";
      writeFileSync(configPath(env), before);
      mkdirSync(join(env["HOME"] ?? "", ".ssh", ".devbox-config.lock"));

      fleet = [described("devbox-aaa")];
      const { code, stderr } = await sync(env);

      // Bounded, and it says what to do. A lock taken with mkdir survives the death of the
      // process that took it — a Ctrl-C in the middle of a `down` is enough — so "wait
      // forever" would turn one interrupted command into a workstation where `devbox sync`
      // never returns again.
      expect(code).toBe(1);
      expect(verdict(stderr)).toContain(".devbox-config.lock");
      expect(verdict(stderr)).toContain("remove it if nothing is running");
      // And it did not write half a block on the way out.
      expect(config(env)).toBe(before);
    },
    // The wait is 300 iterations of `sleep 0.05`, which is fifteen seconds of sleeping plus
    // three hundred spawns: measured at 19 s here. Slow, and kept anyway — a lock that
    // never gives up is a workstation that stops working, and nothing cheaper proves it.
    60_000,
  );

  test("survives four concurrent syncs with one block and one port per machine", async () => {
    const env = workstation();
    noListeners(env);
    const names = ["devbox-a", "devbox-b", "devbox-c", "devbox-d"];
    fleet = names.map((name) => described(name));

    // The measured failure, as a test. Four processes, sixteen writes, one file: without
    // with_lock these are read-modify-writes on the same bytes and the last one wins — the
    // core's own comment records three destroyed machines leaving two blocks removed and
    // one behind. Convergent under the lock because write_ssh_config strips its own block
    // and then takes the lowest free port, so whatever the interleaving, four blocks end up
    // holding 9010 to 9013 between them.
    const runs = await Promise.all([sync(env), sync(env), sync(env), sync(env)]);
    for (const run of runs) expect(run.code).toBe(0);

    const text = config(env);
    expect(marked(text).sort()).toEqual(names);
    for (const name of names) expect(text.split(beginMark(name))).toHaveLength(2);

    const allocated = names.map((name) => appForward(text, name)).sort();
    expect(allocated).toEqual([9010, 9011, 9012, 9013]);
    const cluster = names.map((name) => kubeForward(text, name)).sort();
    expect(cluster).toEqual([16443, 16444, 16445, 16446]);
  }, 60_000);
});

describe.skipIf(CANNOT_RUN)("the port window, when it has nothing left to give", () => {
  test("refuses the write rather than leave a block ssh cannot parse", async () => {
    const env = workstation();
    // Every port of the window already spoken for by forwards in the file, which is what
    // fifty-one machines — or one hand-written block — look like to next_local_port. lsof is
    // never consulted here: the grep matches first. laptop-relay is a host typed by hand and
    // owed nothing to devbox, present so that the file has something to lose.
    const filler = ["Host laptop-relay", "  HostName 10.9.9.9", "Host filler", "  HostName 10.0.0.1"];
    for (let port = 9010; port <= 9060; port++) filler.push(`  LocalForward ${port} 127.0.0.1:1`);
    const before = `${filler.join("\n")}\n`;
    // 644, so that the one thing the aborted write DOES change to the file is visible below.
    writeFileSync(configPath(env), before, { mode: 0o644 });

    fleet = [described("devbox-zzz", { app_port: 9010 })];
    const { code, stdout, stderr } = await sync(env);

    // The failure this test was born from, and which every assertion below now denies.
    // next_local_port died — correctly — but it was called as `app=$(next_local_port "$tmp")`,
    // and a `die` inside a command substitution kills only that subshell; with_lock then
    // invokes its argument as `"$@" || rc=$?`, which disarms set -e for the whole call. So
    // write_ssh_config carried on with $app empty and wrote, into ~/.ssh/config:
    //   LocalForward  127.0.0.1:9010
    //   LocalForward 7433 127.0.0.1:6443
    // — no local port at all on the first, and `16443 + "" - 9010` = 7433 on the second,
    // six thousand ports from where anything looks for it. A LocalForward missing its target
    // is not a line ssh skips, it is a file ssh refuses; measured verbatim on this Mac:
    //   config line 9: Missing target argument.
    //   config: terminating, 1 bad configuration options
    // with `ssh -G` exiting 255 for laptop-relay, a host that has nothing to do with devbox. One
    // exhausted port window turned every host on the workstation off until somebody found the
    // block and deleted it by hand — and the command that did it had printed
    // "1 block(s) written, 0 removed" and left with 0, so neither the Ink layer nor the
    // dashboard's job runner had any reason to mention it. write_ssh_config now checks the
    // substitution twice — `|| return 1` for its status, `[ -n "$app" ]` for its value — which
    // makes it the fourth site in the file guarded against this trap, after the three the
    // core's own comments name: remote_token, remote_resolve and resolve.
    expect(verdict(stderr)).toBe("no free local port between 9010 and 9060");
    // The sentence is still said — the operator has fifty-one forwards in this file and needs
    // to know that is why — and it is the whole of stderr: the two `return 1` that carry the
    // refusal up through with_lock and cmd_sync are silent on purpose.
    expect(stderr.trim().split("\n")).toEqual(["x no free local port between 9010 and 9060"]);
    // Nothing claimed. The count line is printed at the end of cmd_sync, and cmd_sync no
    // longer reaches its end.
    expect(phases(stdout)).toEqual([]);
    expect(stdout).toBe("");
    // And it says so in the only way a caller reads: `devbox sync` is spawned by the Ink layer
    // and by the job runner, and both branch on the exit code, not on the text.
    expect(code).toBe(1);

    const text = config(env);
    // No block for the machine that could not be given a port — not a truncated one, not one
    // with an empty field. A half-written block is worse than none: `devbox info` reads its
    // LocalForward back, and `ssh_config_names` would offer the name to `devbox down`.
    expect(inside(text, "devbox-zzz")).toEqual([]);
    expect(marked(text)).toEqual([]);
    // Byte for byte what was there before. The write is prepared in a temporary file and only
    // then moved over the real one, so a refusal costs ~/.ssh/config nothing at all — with one
    // loose end that is not asserted here because it is outside HOME: the mktemp copy is never
    // removed on this path, so a refused write leaves a full duplicate of the operator's ssh
    // config (mode 600) in the machine's temp directory. Measured: 1664 bytes, verbatim.
    expect(text).toBe(before);

    // Except this, which is the single trace the aborted write leaves: write_ssh_config
    // touches and chmods before it asks for a port. Tighter, never looser, and 600 is what
    // ssh demands of a config anyway.
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);

    // The lock was still given back on the way out, so the next `devbox sync` does not spend
    // fifteen seconds waiting for a process that already exited.
    expect(existsSync(join(env["HOME"] ?? "", ".ssh", ".devbox-config.lock"))).toBe(false);

    // And the verdict that matters, from ssh rather than from a regex: laptop-relay still
    // resolves. This is the assertion the old malformed block failed, with 255 and
    // "terminating, 1 bad configuration options", for a host devbox never touched.
    if (SSH !== null) {
      const parsed = Bun.spawnSync([SSH, "-F", configPath(env), "-G", "laptop-relay"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(parsed.exitCode).toBe(0);
      expect(parsed.stdout.toString()).toContain("hostname 10.9.9.9");
    }
  }, 30_000);
});

/**
 * `devbox ssh`, which is the one verb that reads ~/.ssh/config instead of writing it.
 *
 * The block is the whole point: it carries the address, the user, the port, the key and
 * both forwards, so going through the ALIAS is what makes `devbox ssh` the same session as
 * `ssh <name>` rather than a second, weaker way to reach the machine. That is asserted
 * here by what the stub receives — one argument, the name — because an implementation
 * that reassembled `-i key -p port user@ip` would pass every other test in this file and
 * silently drop the forwards.
 *
 * ssh is shadowed, so nothing below opens a connection. The real one would try: the whole
 * command ends in `exec ssh`.
 */
describe("devbox ssh", () => {
  /** A workstation whose ssh prints its arguments and exits, standing in for the session. */
  function withSsh(blocks: string[]): Record<string, string> {
    const env = workstation();
    writeFileSync(
      join(env["HOME"] ?? "", "bin", "ssh"),
      '#!/usr/bin/env bash\necho "SSH ARGV: $*"\n',
      { mode: 0o755 },
    );
    const text = blocks
      .map((name) => [beginMark(name), `Host ${name}`, "  HostName 10.0.0.1", endMark(name)].join("\n"))
      .join("\n");
    writeFileSync(configPath(env), `Host laptop-relay\n  HostName 10.9.9.9\n\n${text}\n`, {
      mode: 0o600,
    });
    return env;
  }

  test("goes through the Host block, by its alias and nothing else", async () => {
    const env = withSsh(["devbox-aaaa1"]);
    const run = await runCore(["ssh", "devbox-aaaa1"], env);
    expect(run.code).toBe(0);
    // One argument. Reassembling the connection here would work and would lose both
    // forwards, which is the failure this line exists to catch.
    expect(strip(run.stdout)).toContain("SSH ARGV: devbox-aaaa1");
    expect(phases(run.stdout)).toContain("ssh devbox-aaaa1");
  });

  test("with one machine and no name, that is the machine", async () => {
    const env = withSsh(["devbox-aaaa1"]);
    const run = await runCore(["ssh"], env);
    expect(run.code).toBe(0);
    expect(strip(run.stdout)).toContain("SSH ARGV: devbox-aaaa1");
  });

  test("with several and no name, refuses and lists them", async () => {
    const env = withSsh(["devbox-aaaa1", "devbox-bbbb2"]);
    const run = await runCore(["ssh"], env);
    expect(run.code).toBe(1);
    expect(strip(run.stdout)).not.toContain("SSH ARGV");
    expect(verdict(run.stderr)).toContain("several machines");
    expect(strip(run.stderr)).toContain("devbox-aaaa1");
    expect(strip(run.stderr)).toContain("devbox-bbbb2");
  });

  test("a name with no block names `devbox sync`, which is what writes one", async () => {
    const env = withSsh(["devbox-aaaa1"]);
    const run = await runCore(["ssh", "devbox-bbbb2"], env);
    expect(run.code).toBe(1);
    expect(verdict(run.stderr)).toContain("no Host block for 'devbox-bbbb2'");
    expect(strip(run.stderr)).toContain("devbox sync");
  });

  test("a workstation with no block at all says so, rather than letting ssh guess", async () => {
    const env = withSsh([]);
    const run = await runCore(["ssh"], env);
    expect(run.code).toBe(1);
    expect(verdict(run.stderr)).toContain("no machine has a Host block");
  });
});

/**
 * The purge lands on the file the keyscan writes, and nothing else.
 *
 * `ssh-keygen -R` resolves ~ through getpwuid and IGNORES HOME, so without -f the removal
 * edits the known_hosts of whatever account runs devbox while `ssh-keyscan >> "$KNOWN_HOSTS"`
 * appends to the one HOME names. On a Mac those are the same file and nothing shows. In the
 * dashboard, which runs with HOME=<data>/home, they never are: its known_hosts was never
 * purged and grew one line per machine.
 *
 * That was invisible until a provider rented an address out twice. On 27/08 a Scaleway
 * address carried a destroyed machine's key ABOVE the live one, the terminal compared
 * against the first line, and refused a machine this service had created itself. The user
 * read `host key changed` on a machine nobody had touched.
 *
 * Asserted on the ARGV rather than on the file: the shadowed ssh-keygen removes nothing, so
 * what is under test is the instruction the core gives, which is where the bug was.
 */
describe.skipIf(CANNOT_RUN)("the file refresh_known_hosts purges", () => {
  test("is named with -f, since ssh-keygen -R ignores HOME", async () => {
    const env = workstation();
    noListeners(env);
    const home = env["HOME"] ?? "";
    const log = join(home, "keygen.argv");
    writeFileSync(
      join(home, "bin", "ssh-keygen"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>${JSON.stringify(log)}\nexit 0\n`,
      { mode: 0o755 },
    );

    fleet = [described("devbox-aaa", { ip: "203.0.113.9", port: 22 })];
    const { code } = await sync(env);
    expect(code).toBe(0);

    const argv = readFileSync(log, "utf8");
    expect(argv).toContain(`-f ${join(home, ".ssh", "known_hosts")}`);
    expect(argv).toContain("-R 203.0.113.9");
  });
});
