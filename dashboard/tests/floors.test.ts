import { afterEach, describe, expect, test } from "bun:test";
import type { Profile } from "../src/engine";
import { FLOOR_DEFAULTS, floorFor, floorsOf } from "../src/floors";

/**
 * A profile's header answers what it ASKED FOR; a machine is chosen on what devbox-core
 * actually searched above. The two differ every time a header leaves a floor out, which is
 * most of them, and the gap is not cosmetic: `bare` declares no disk and is still filtered
 * at 80 GB, so a screen that showed nothing there would describe a filter the reader could
 * neither act on nor find.
 *
 * These tests pin the two halves of that answer - the number, and which of the two sources
 * it came from.
 */

const profile = (overrides: Partial<Profile> = {}): Profile => ({
  name: "bare",
  path: "/engine/profiles/bare.sh",
  repo: null,
  secrets: [],
  note: null,
  min_cpu: null,
  min_ram: null,
  min_disk: null,
  port: null,
  ports: [],
  ...overrides,
});

/** floorFor reads the environment on every call, so a test that moves it must put it back. */
const MOVED = ["DEVBOX_MIN_CORES", "DEVBOX_MIN_MEMORY_GB", "DEVBOX_MIN_DISK_GB"];
afterEach(() => {
  for (const variable of MOVED) delete process.env[variable];
});

describe("floorsOf", () => {
  test("takes a declared floor from the header, and says the profile asked for it", () => {
    const floors = floorsOf(profile({ min_cpu: 8, min_ram: 32, min_disk: 200 }));
    expect(floors).toEqual({
      cpu: { value: 8, declared: true },
      ram: { value: 32, declared: true },
      disk: { value: 200, declared: true },
    });
  });

  test("fills a blank with devbox-core's own template, and says so", () => {
    /**
     * The three literals are devbox-core's, transcribed from lines 204-206:
     * `MIN_CORES=${DEVBOX_MIN_CORES:-4}` and its two neighbours. They stay literals rather
     * than references to FLOOR_DEFAULTS, which would only prove that a constant equals
     * itself. What this test is about is that the dashboard's copy still spells the same
     * numbers as the executor it is describing.
     */
    expect(floorsOf(profile())).toEqual({
      cpu: { value: 4, declared: false },
      ram: { value: 8, declared: false },
      disk: { value: 80, declared: false },
    });
  });

  test("draws the distinction per floor, not per profile", () => {
    // cpu and ram declared, disk not, as profiles/bare.sh was. This mixed case is the ordinary
    // one, and the reason `declared` is three booleans rather than one.
    const floors = floorsOf(profile({ min_cpu: 2, min_ram: 4 }));
    expect(floors.cpu).toEqual({ value: 2, declared: true });
    expect(floors.ram).toEqual({ value: 4, declared: true });
    expect(floors.disk).toEqual({ value: 80, declared: false });
  });

  test("follows DEVBOX_MIN_* where the header is silent", () => {
    // The service spawns devbox with its own environment, so a variable set in the unit moves
    // the core that is about to run AND this answer. Saying 80 while the core searches
    // above 200 would be worse than saying nothing.
    process.env.DEVBOX_MIN_CORES = "16";
    process.env.DEVBOX_MIN_MEMORY_GB = "64";
    process.env.DEVBOX_MIN_DISK_GB = "200";

    expect(floorsOf(profile())).toEqual({
      cpu: { value: 16, declared: false },
      ram: { value: 64, declared: false },
      disk: { value: 200, declared: false },
    });
  });

  test("never lets DEVBOX_MIN_* overrule a floor the profile declared", () => {
    // The same order as devbox-core's, which reads the profile's value unless a flag set one:
    // the environment is the fallback, not the rule.
    process.env.DEVBOX_MIN_MEMORY_GB = "64";
    expect(floorsOf(profile({ min_ram: 4 })).ram).toEqual({ value: 4, declared: true });
  });

  test("ignores a DEVBOX_MIN_* that is not a number", () => {
    // `DEVBOX_MIN_DISK_GB=` in a unit file is an empty string, not an absent variable, and
    // Number("") is 0: a machine searched above 0 GB of disk is every machine, and the
    // wizard would offer shapes the seed could not fit on.
    for (const value of ["", "beaucoup", "NaN"]) {
      process.env.DEVBOX_MIN_DISK_GB = value;
      expect(floorsOf(profile()).disk).toEqual({ value: 80, declared: false });
    }
  });
});

describe("floorFor", () => {
  test("answers the template for a request that named no floor", () => {
    // This is /api/probe's case: a query string with no ?disk= is not a request for zero,
    // it is a request to search where devbox-core would have searched.
    expect(floorFor("disk", null)).toEqual({ value: 80, declared: false });
    expect(floorFor("disk", 160)).toEqual({ value: 160, declared: true });
  });

  test("names the variables devbox-core reads, spelled the way it spells them", () => {
    // A typo here is invisible: the fallback is returned, the answer looks reasonable, and
    // it disagrees with the core silently.
    expect(FLOOR_DEFAULTS.cpu.env).toBe("DEVBOX_MIN_CORES");
    expect(FLOOR_DEFAULTS.ram.env).toBe("DEVBOX_MIN_MEMORY_GB");
    expect(FLOOR_DEFAULTS.disk.env).toBe("DEVBOX_MIN_DISK_GB");
  });
});
