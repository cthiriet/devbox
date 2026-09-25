/**
 * The shapes `devbox-core --json` answers with.
 *
 * Deliberately the same names as dashboard/src/engine.ts, because they describe the same
 * five contracts: two consumers of one interface should not each invent a vocabulary for
 * it. If a field moves, it moves in devbox-core first and both files follow.
 *
 * There WAS a third declaration for a while, in core/src/types.ts, and this file was made
 * to re-export it so that one `tsc` would keep the three packages in step. The port that
 * owned it is gone, and with it the third copy; what is left is the same two consumers
 * this header has always described, kept honest by devbox-core's own `--json` and by the
 * tests that run it.
 */

export type Machine = {
  name: string;
  cloud: string;
  region: string;
  instance_type: string;
  profile: string | null;
  hourly_eur: number | null;
  ip: string;
  user: string;
  port: number | null;
  local_port: number;
  app_port: number;
  /**
   * Every port the profile forwards, the app first, and the forwards the ssh config holds for
   * them. Since 24/09; absent from a dashboard that predates the list.
   */
  app_ports?: number[];
  forwards?: { local: number; remote: number }[];
};

export type MachineDetail = Machine & {
  fingerprint: string | null;
  note: string | null;
  kube_port: number;
};

export type Profile = {
  name: string;
  path: string;
  repo: string | null;
  secrets: string[];
  note: string | null;
  min_cpu: number | null;
  min_ram: number | null;
  min_disk: number | null;
  port: number | null;
  /** Every port of `devbox-port:`, the app first; `port` is the first. */
  ports: number[];
};

/** One creatable shape, as `probe --json` returns it: `table_json` in devbox-core. */
export type Offer = {
  hourly_eur: number;
  cloud: string;
  type: string;
  location: string;
  cpu: number;
  ram_gb: number;
  disk_gb: number;
  cpu_class: string | null;
  availability: string | null;
};

export type Orphan = {
  cloud: string;
  name: string;
  ip: string | null;
  region: string;
  created: string;
};
