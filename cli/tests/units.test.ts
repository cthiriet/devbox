import { describe, expect, test } from "bun:test";
import { has, numberFlag, parse, stringFlag } from "../src/args.ts";
import { stripAnsi } from "../src/core.ts";
import { floorsOf, floorsText } from "../src/floors.ts";
import { duration, eur, eurPerDay, eurPerMonth, MONTH_HOURS, pad, widths } from "../src/format.ts";
import { envName } from "../src/secrets.ts";
import type { Profile } from "../src/types.ts";
import { parseSkipped } from "../src/ui/Probe.tsx";

describe("the command line", () => {
  test("keeps everything after the verb, untouched, for the core", () => {
    const parsed = parse(["up", "--cloud", "gcp", "--min-ram", "16", "--no-seed"]);
    expect(parsed.command).toBe("up");
    expect(parsed.rest).toEqual(["--cloud", "gcp", "--min-ram", "16", "--no-seed"]);
  });

  test("reads a flag that swallows its value, and one that does not", () => {
    const parsed = parse(["up", "--profile", "claude", "--no-seed"]);
    expect(stringFlag(parsed, "--profile")).toBe("claude");
    expect(has(parsed, "--no-seed")).toBe(true);
    expect(has(parsed, "--json")).toBe(false);
  });

  test("a bare word after the verb is a machine name", () => {
    const parsed = parse(["down", "devbox-aaaa1", "--yes"]);
    expect(parsed.positionals).toEqual(["devbox-aaaa1"]);
    expect(has(parsed, "--yes")).toBe(true);
  });

  test("rejects nothing: an unknown flag is forwarded, not refused", () => {
    const parsed = parse(["up", "--wat", "--cloud", "hetzner"]);
    expect(parsed.rest).toContain("--wat");
    expect(stringFlag(parsed, "--cloud")).toBe("hetzner");
  });

  test("with no verb at all", () => {
    expect(parse([]).command).toBe("");
  });

  describe("a floor: the flag, then the environment, then the built-in", () => {
    test("the flag wins under either spelling", () => {
      expect(numberFlag(parse(["probe", "--min-ram", "16"]), ["--min-ram", "--ram"], "X", 8)).toBe(16);
      expect(numberFlag(parse(["probe", "--ram", "32"]), ["--min-ram", "--ram"], "X", 8)).toBe(32);
    });

    test("the environment answers when no flag did", () => {
      process.env["DEVBOX_TEST_FLOOR"] = "12";
      expect(numberFlag(parse(["probe"]), ["--min-ram"], "DEVBOX_TEST_FLOOR", 8)).toBe(12);
      delete process.env["DEVBOX_TEST_FLOOR"];
    });

    test("and the built-in answers when nothing else did", () => {
      expect(numberFlag(parse(["probe"]), ["--min-ram"], "DEVBOX_TEST_FLOOR", 8)).toBe(8);
    });

    test("a flag that is not a number is not a number", () => {
      expect(numberFlag(parse(["probe", "--min-ram", "lots"]), ["--min-ram"], "X", 8)).toBe(8);
    });
  });
});

describe("the numbers, spelled the way devbox-core spells them", () => {
  test("three decimals and a comma, per hour", () => {
    expect(eur(0.014)).toBe("0,014");
    expect(eur(0.0008)).toBe("0,001");
    expect(eur(0)).toBe("0,000");
  });

  test("a price nobody could compute is not a zero", () => {
    expect(eur(null)).toBe("—");
    expect(eur(undefined)).toBe("—");
  });

  test("two decimals and a comma, per day", () => {
    expect(eurPerDay(0.014)).toBe("0,34");
    expect(eurPerDay(0.057)).toBe("1,37");
  });

  test("two decimals and a comma, per month", () => {
    // The three shapes the spec measured against the Hetzner catalogue on 25/08. Written
    // out rather than derived, so a change to the constant fails on a price somebody can
    // look up rather than on an arithmetic identity that would follow the change.
    expect(eurPerMonth(0.0312)).toBe("22,78");
    expect(eurPerMonth(0.0569)).toBe("41,54");
    expect(eurPerMonth(0.0088)).toBe("6,42");
  });

  test("the month is 730 hours, and 720 is the mistake it is not", () => {
    // Named, because every layer of this tool has to answer with the same number: a fleet
    // costing three different amounts depending on which screen shows it is worse than a
    // fleet whose cost is nowhere on screen.
    expect(MONTH_HOURS).toBe(730);
    // 365.25 × 24 ÷ 12 = 730.5, rounded to the whole hour every cloud quotes.
    expect(MONTH_HOURS).toBe(Math.floor((365.25 * 24) / 12));
    // A thirty-day month would print this instead, 1.4% under, in the same direction every
    // time. That is the failure the constant exists to avoid, so it is asserted.
    expect(eurPerMonth(0.0312)).not.toBe("22,46");
  });

  test("a duration reads as minutes only once there are any", () => {
    expect(duration(5)).toBe("5s");
    expect(duration(59)).toBe("59s");
    expect(duration(60)).toBe("1 min 0s");
    expect(duration(273)).toBe("4 min 33s");
  });
});

describe("column widths", () => {
  const rows = [{ name: "devbox-aaaa1" }, { name: "a-much-longer-name" }];
  const columns = [{ label: "NAME", value: (row: { name: string }) => row.name }];

  test("come from the widest value, not from a constant", () => {
    expect(widths(columns, rows)).toEqual(["a-much-longer-name".length]);
  });

  test("never fall below the header", () => {
    expect(widths(columns, [{ name: "x" }])).toEqual(["NAME".length]);
  });

  test("with no rows at all, the header is the whole table", () => {
    expect(widths(columns, [])).toEqual(["NAME".length]);
  });

  test("padding never truncates: a cut name is worse than a ragged column", () => {
    expect(pad("devbox-aaaa1", 4)).toBe("devbox-aaaa1");
    expect(pad("ab", 5)).toBe("ab   ");
    expect(pad("ab", 5, "right")).toBe("   ab");
  });
});

describe("the core's colour", () => {
  test("is removed before a line is parsed or redrawn", () => {
    expect(stripAnsi("\u001B[1;36m==>\u001B[0m profile claude")).toBe("==> profile claude");
    expect(stripAnsi("\u001B[1;33m/!\\\u001B[0m out of stock")).toBe("/!\\ out of stock");
    expect(stripAnsi("plain")).toBe("plain");
  });
});

describe("the clouds a probe could not ask", () => {
  test("are read back from the core's stderr", () => {
    const stderr = "not asked:\n  gcp: no usable Application Default Credentials.\n";
    expect(parseSkipped(stderr)).toEqual(["gcp: no usable Application Default Credentials."]);
  });

  test("and are nothing at all when every cloud answered", () => {
    expect(parseSkipped("")).toEqual([]);
    expect(parseSkipped("some other noise\n")).toEqual([]);
  });
});

describe("the environment variable a secret can arrive in", () => {
  test("is the name the core builds with tr 'a-z-' 'A-Z_'", () => {
    expect(envName("github")).toBe("DEVBOX_GITHUB_TOKEN");
    expect(envName("openai-admin")).toBe("DEVBOX_OPENAI_ADMIN_TOKEN");
  });

  test("except the dashboard token, which has always been spelled out", () => {
    expect(envName("remote")).toBe("DEVBOX_REMOTE_TOKEN");
  });
});

describe("what a profile asks of a machine", () => {
  /** Only the four fields floorsOf reads; the rest of a Profile is not its business. */
  const profile = (over: Partial<Profile> = {}): Profile => ({
    name: "p",
    path: "/x/p.sh",
    repo: null,
    secrets: [],
    note: null,
    min_cpu: null,
    min_ram: null,
    min_disk: null,
    port: null,
    ports: [],
    ...over,
  });

  test("a declared floor is the profile's, and says so", () => {
    const floors = floorsOf(profile({ min_cpu: 2, min_ram: 4, min_disk: 40 }));
    expect(floors.cpu).toEqual({ value: 2, declared: true });
    expect(floors.disk).toEqual({ value: 40, declared: true });
  });

  /**
   * The case that started this: `bare`, removed since, set no disk floor, and the offers listed under it
   * are still filtered at 80 GB. A screen printing `?G` there described a number nobody
   * could act on.
   */
  test("a floor the header omits is the core's template, and says that too", () => {
    const floors = floorsOf(profile({ min_cpu: 2, min_ram: 4 }));
    expect(floors.disk).toEqual({ value: 80, declared: false });
    expect(floorsText(profile({ min_cpu: 2, min_ram: 4 }))).toBe("2c/4G/80G");
  });

  test("DEVBOX_MIN_* moves the template, for this layer as it does for the core", () => {
    process.env["DEVBOX_MIN_DISK_GB"] = "200";
    try {
      expect(floorsOf(profile()).disk).toEqual({ value: 200, declared: false });
      // A declared floor is still the profile's: the variable moves the DEFAULT, which is
      // what the core does with it too.
      expect(floorsOf(profile({ min_disk: 40 })).disk).toEqual({ value: 40, declared: true });
    } finally {
      delete process.env["DEVBOX_MIN_DISK_GB"];
    }
  });
});
