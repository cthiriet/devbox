import { statSync } from "node:fs";
import { join } from "node:path";
import { Box, Text } from "ink";
import { has, numberFlag, type Parsed } from "../args.ts";
import { coreJsonDetailed } from "../core.ts";
import { FLOOR_DEFAULTS } from "../floors.ts";
import { eur, eurPerMonth, MONTH_HOURS } from "../format.ts";
import { CACHE_DIR } from "../settings.ts";
import type { Offer } from "../types.ts";
import { Failure, Hints, Loading, useAsync, useExitWhen } from "./common.tsx";
import { cloudColor, Table } from "./Table.tsx";

/** The text screen shows twelve rows and says how many it held back. So does this one. */
const CAP = 12;

/**
 * `devbox probe` — what each cloud can create right now, cheapest first.
 *
 * The floors are printed under the table because they are the only thing that explains an
 * empty result: "nothing creatable" means nothing creatable *above 4 vCPU and 8 GB*, and
 * a reader who cannot see the template has no way to know that --min-ram is the knob.
 *
 * The clouds that could not be asked are printed too, from the core's stderr. A missing
 * GCP credential must not read as a market where GCP is simply expensive.
 */
export function Probe({ parsed }: { parsed: Parsed }) {
  const state = useAsync(() => coreJsonDetailed<Offer[]>(["probe", ...parsed.rest], 180_000));

  useExitWhen(state.status !== "loading", state.status === "failed" ? 1 : 0);

  if (state.status === "loading") {
    return <Loading label="asking the clouds what they can create right now" />;
  }
  if (state.status === "failed") return <Failure error={state.error} />;

  const offers = state.data.data;
  const skipped = parseSkipped(state.data.stderr);
  const all = has(parsed, "--all");
  const shown = all ? offers : offers.slice(0, CAP);
  const held = offers.length - shown.length;

  // The core's own template, from the one place this layer keeps it. A flag moves it, and
  // so does DEVBOX_MIN_*, exactly as they move it for the core this screen just spawned.
  const cpu = numberFlag(parsed, ["--min-cpu", "--cpu"], FLOOR_DEFAULTS.cpu.env, FLOOR_DEFAULTS.cpu.fallback);
  const ram = numberFlag(parsed, ["--min-ram", "--ram"], FLOOR_DEFAULTS.ram.env, FLOOR_DEFAULTS.ram.fallback);
  const disk = numberFlag(parsed, ["--min-disk", "--disk"], FLOOR_DEFAULTS.disk.env, FLOOR_DEFAULTS.disk.fallback);

  return (
    <Box flexDirection="column" marginTop={1}>
      {shown.length === 0 ? (
        <Text dimColor> nothing creatable</Text>
      ) : (
        <Table
          rows={shown}
          /* Ten columns now, so one space between them instead of two.
             Measured on the widest row this table really draws — `c3d-highmem-8` in
             `europe-southwest1-b`, dedicated, 1000G, available — two spaces put it at 102
             columns. `Table` truncates rather than wraps, so on a 100-column terminal what
             fell off the right was AVAIL: the screen that exists to say what can be
             created right now would have stopped saying whether it can. One space brings
             the same row to 93, and devbox-core's own probe table separates its ten `%-Ns`
             fields by exactly one space too. */
          gutter={1}
          columns={[
            {
              label: "EUR/H",
              value: (offer) => eur(offer.hourly_eur),
              align: "right",
              color: (offer) => (offer === shown[0] ? "greenBright" : "yellow"),
            },
            // Beside the hour and dimmed, like the fleet's: same number, longer lever.
            // Nothing here is sorted by it — ×730 is monotonic, so cheapest by the hour is
            // cheapest by the month, and a second sort order would only be a second way to
            // read the same list.
            {
              label: "EUR/MO",
              value: (offer) => eurPerMonth(offer.hourly_eur),
              align: "right",
              color: (offer) => (offer === shown[0] ? "greenBright" : "yellow"),
              dim: () => true,
            },
            { label: "CLOUD", value: (o) => o.cloud, color: (o) => cloudColor(o.cloud) },
            { label: "SHAPE", value: (o) => o.type, color: () => "white" },
            { label: "WHERE", value: (o) => o.location },
            { label: "vCPU", value: (o) => String(o.cpu), align: "right" },
            { label: "RAM", value: (o) => `${o.ram_gb}G`, align: "right" },
            { label: "DISK", value: (o) => `${o.disk_gb}G`, align: "right" },
            { label: "CPU", value: (o) => o.cpu_class ?? "-", dim: () => true },
            {
              label: "AVAIL",
              value: (o) => o.availability ?? "unknown",
              dim: (o) => o.availability === null,
            },
          ]}
        />
      )}
      {held > 0 ? (
        <Text dimColor>
          {"  … and "}
          {held} more — devbox probe --all
        </Text>
      ) : null}

      {skipped.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow"> not asked:</Text>
          {skipped.map((line) => (
            <Text key={line} dimColor>
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      <Hints
        lines={[
          `template: at least ${cpu} vCPU, ${ram} GB and ${disk} GB of disk.`,
          "          x86 from the three clouds.",
          "          These are FLOORS: everything above is listed, cheapest first, and",
          "          `up` takes the first. --min-cpu/--min-ram/--min-disk move them,",
          "          --type pins an exact shape.",
          "price: hourly, as the API returns it right now.",
          "       hetzner  server + primary IPv4",
          "       scaleway server, local disk included; no API prices the public IPv4",
          "       gcp      instance + disk, assembled from the billing catalogue",
          // The one caveat, in the one place that already explains a price, and nowhere
          // else: a month nobody publishes printed beside an hour three APIs do is a
          // number the reader is entitled to distrust — and on Hetzner they would be
          // right to, by a sixth. Per row it would be a footnote on every line of a table
          // that is read by scanning, which is how a warning becomes noise.
          //
          // Same words as devbox-core's own `probe` help, deliberately: this screen replaces
          // that one, and two renderings of one screen that hedge differently give the
          // reader a third thing to work out.
          `       EUR/MO   that same hourly figure carried over ${MONTH_HOURS} h and nothing`,
          "                more, so it is not a quote: Hetzner caps the hours it",
          "                bills in a month and charges around 17 % less than this",
          "                column says: cpx22 reads 22,78 here, 19,49 published.",
          gcpCacheLine(),
          "availability: published by Hetzner and Scaleway. GCP publishes none, hence",
          "              'unknown': only the regional quota before, the error during.",
        ]}
      />
    </Box>
  );
}

/**
 * The `not asked:` block devbox-core writes to stderr in JSON mode, one cloud per line.
 *
 * Exported for the test: this is a text contract between two files, and the kind of thing
 * that breaks silently — a probe that stopped reporting a missing credential looks exactly
 * like a probe where every credential is present.
 */
export function parseSkipped(stderr: string): string[] {
  const lines = stderr.split("\n");
  const start = lines.findIndex((line) => line.trim() === "not asked:");
  if (start === -1) return [];
  return lines
    .slice(start + 1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** When the GCP catalogue was last read. Absent until a probe has ever asked for it. */
function gcpCacheLine(): string | null {
  try {
    const when = statSync(join(CACHE_DIR, "gcp-skus.jsonl")).mtime;
    const two = (n: number) => String(n).padStart(2, "0");
    return `GCP price cache: ${two(when.getDate())}/${two(when.getMonth() + 1)} ${two(when.getHours())}:${two(when.getMinutes())} — --refresh to renew`;
  } catch {
    return null;
  }
}
