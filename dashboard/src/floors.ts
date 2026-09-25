import type { Profile } from "./engine";

/**
 * What a profile actually asks of a machine, as opposed to what its header spells out.
 *
 * A header that sets no floor is not a header that wants none. A profile that declares
 * `devbox-min-cpu` and `devbox-min-ram` and no disk at all still gets a machine chosen above
 * 80 GB, because devbox-core fills every blank with its own template - 4 vCPU,
 * 8 GB, 80 GB - before it asks a cloud anything. A screen that printed `?` for the missing
 * disk would be honest about the file and useless about the machine.
 *
 * So the numbers below are devbox-core's, restated in this layer for the one thing that cannot
 * be asked of it: `profiles --json` answers the HEADER, which is what it is for, and there
 * is no verb that answers "and what would you fill the blanks with". They are a single copy
 * on this side - /api/profiles and /api/probe both read these constants - and DEVBOX_MIN_*
 * moves them for both sides at once, because src/engine.ts spawns devbox with this process's
 * environment: whatever moves the answer here moves the core that is about to run.
 *
 * The distinction between the two sources is kept rather than flattened, as `declared`: the
 * `up` wizard dims what the profile did not ask for, and that is a difference a client can
 * only draw if the API hands it over.
 *
 * cli/src/floors.ts holds the same table for the Ink screens. Two copies, deliberately: the
 * rsync ships dashboard/ alone and the server has no workspace root to resolve a sibling
 * package from, so an import there would resolve on a Mac and fail on the machine that
 * serves the fleet.
 */
export const FLOOR_DEFAULTS = {
  cpu: { env: "DEVBOX_MIN_CORES", fallback: 4 },
  ram: { env: "DEVBOX_MIN_MEMORY_GB", fallback: 8 },
  disk: { env: "DEVBOX_MIN_DISK_GB", fallback: 80 },
} as const;

export type FloorName = keyof typeof FLOOR_DEFAULTS;

/** One floor, and whether the profile is the one that asked for it. */
export type Floor = { value: number; declared: boolean };

export type Floors = { cpu: Floor; ram: Floor; disk: Floor };

/**
 * One floor, from what was asked for or from the template that fills the blank.
 *
 * `declared` is null-driven on purpose: a request that names no minimum and a header that
 * names none are the same case, and /api/probe uses this to say which floors it actually
 * searched above.
 *
 * The environment is read on every call rather than at import: the unit can be edited and
 * the service restarted, but a test that moves DEVBOX_MIN_* around must see the move too, and
 * a value frozen at import is the mechanism that makes such a test pass while lying.
 */
export function floorFor(kind: FloorName, declared: number | null): Floor {
  if (declared !== null) return { value: declared, declared: true };
  const set = process.env[FLOOR_DEFAULTS[kind].env];
  const moved = set !== undefined && set !== "" && Number.isFinite(Number(set));
  return { value: moved ? Number(set) : FLOOR_DEFAULTS[kind].fallback, declared: false };
}

export function floorsOf(profile: Profile): Floors {
  return {
    cpu: floorFor("cpu", profile.min_cpu),
    ram: floorFor("ram", profile.min_ram),
    disk: floorFor("disk", profile.min_disk),
  };
}
