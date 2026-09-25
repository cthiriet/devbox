import type { Profile } from "./types.ts";

/**
 * What a profile actually asks of a machine, as opposed to what its header spells out.
 *
 * A header that sets no floor is not a header that wants none. A profile that declares
 * `devbox-min-cpu` and `devbox-min-ram` and no disk at all still gets a machine chosen above
 * 80 GB, because devbox-core fills every blank with its own template — 4 vCPU,
 * 8 GB, 80 GB — before it asks a cloud anything.
 *
 * So `?` is not printed for a missing floor any more. It was honest about the file and
 * useless about the machine: the offers listed under such a profile ARE filtered at 80 GB, and a
 * column reading `?G` described a number the reader could neither act on nor find. What is
 * kept instead is `declared`, so a screen can draw the distinction rather than spell it —
 * the two `up` steps dim what the profile did not ask for.
 *
 * The defaults below are devbox-core's, restated in this layer for the one thing that cannot
 * be asked of it: `profiles --json` answers the header, which is what it is for. They are
 * a single copy — Probe.tsx reads these very constants — and DEVBOX_MIN_* moves them for both
 * sides at once, since the core is spawned in this process's environment.
 */
export const FLOOR_DEFAULTS = {
  cpu: { env: "DEVBOX_MIN_CORES", fallback: 4 },
  ram: { env: "DEVBOX_MIN_MEMORY_GB", fallback: 8 },
  disk: { env: "DEVBOX_MIN_DISK_GB", fallback: 80 },
} as const;

/** One floor, and whether the profile is the one that asked for it. */
export type Floor = { value: number; declared: boolean };

export type Floors = { cpu: Floor; ram: Floor; disk: Floor };

function floor(declared: number | null, from: { env: string; fallback: number }): Floor {
  if (declared !== null) return { value: declared, declared: true };
  const set = process.env[from.env];
  const moved = set !== undefined && set !== "" && Number.isFinite(Number(set));
  return { value: moved ? Number(set) : from.fallback, declared: false };
}

export function floorsOf(profile: Profile): Floors {
  return {
    cpu: floor(profile.min_cpu, FLOOR_DEFAULTS.cpu),
    ram: floor(profile.min_ram, FLOOR_DEFAULTS.ram),
    disk: floor(profile.min_disk, FLOOR_DEFAULTS.disk),
  };
}

/** `4c/8G/80G` — the TEMPLATE column, with no distinction drawn. */
export function floorsText(profile: Profile): string {
  const floors = floorsOf(profile);
  return `${floors.cpu.value}c/${floors.ram.value}G/${floors.disk.value}G`;
}
