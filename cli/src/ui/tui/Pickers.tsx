import { Box, Text } from "ink";
import { floorsOf } from "../../floors.ts";
import { eur, eurPerMonth } from "../../format.ts";
import type { Offer, Orphan, Profile } from "../../types.ts";
import { parseSkipped } from "../Probe.tsx";
import { cloudColor } from "../Table.tsx";
import type { Column } from "../Table.tsx";
import { Frame } from "./Frame.tsx";
import { useKeys } from "./keys.ts";
import { Cursor, Head, List, columnsOf, useSelection } from "./List.tsx";
import type { Intent, Step } from "./window.tsx";

/**
 * The two questions `up` used to answer by itself, and the list that answers none.
 *
 * `up` needs two things nobody should have to remember: what the machine becomes, and what
 * it is made of. It used to take both from a default — a profile, and cloud `hetzner`
 * — and the window made that worse rather than better, because it offered two doors into
 * the same verb and each of them left one of the two answers implicit. Ordering from the
 * offers list pinned a shape and silently took the default profile; ordering from the
 * profiles list pinned a profile and silently took Hetzner, whose cheapest offer is not
 * the cheapest offer.
 *
 * So `up` is one path with two steps: the profile, then a shape ABOVE THAT PROFILE'S
 * FLOORS, from every cloud that could be asked, cheapest first. Nothing is implied, and
 * the row the cursor opens on is the cheapest machine that can do the job.
 *
 * Orphans sit here too, as the list that shares the shape and refuses the verb: adopting a
 * runaway server into a workspace is a Terraform import and not a keystroke.
 *
 * None of them fetches anything. See window.tsx.
 */

/** The keys every list here answers the same way. Returns true when it handled the press. */
function common(
  press: { name: string; ch?: string },
  selection: { up: () => void; down: () => void },
  done: (intent: Intent) => void,
  back: Step,
): boolean {
  if (press.name === "up") return selection.up(), true;
  if (press.name === "down") return selection.down(), true;
  if (press.name === "escape" || press.name === "left") return done({ do: "go", to: back }), true;
  if (press.name === "quit") return done({ do: "quit" }), true;
  if (press.name !== "char") return true;
  if (press.ch === "k") return selection.up(), true;
  if (press.ch === "j") return selection.down(), true;
  if (press.ch === "q") return done({ do: "quit" }), true;
  return false;
}

/**
 * What a profile shows, declared once for the header and the rows both.
 *
 * `floorsText` and not the three numbers apart: the column is measured from the string the
 * reader sees, and `Floors` below draws that same string with each number dimmed or not.
 * Two ways of spelling one cell is how a column starts lying about its own width.
 */
const PROFILE_COLUMNS: Column<Profile>[] = [
  { label: "PROFILE", value: (profile) => profile.name },
  {
    label: "SECRETS",
    value: (profile) => (profile.secrets.length > 0 ? profile.secrets.join(" ") : "—"),
  },
  { label: "CPU/RAM/DISK", value: floorsText },
  { label: "REPOSITORY", value: (profile) => profile.repo ?? "—" },
];

/** Step one of `up`: what the machine becomes. Enter carries the profile to step two. */
export function ProfileStep({
  profiles,
  done,
}: {
  profiles: Profile[];
  done: (intent: Intent) => void;
}) {
  const selection = useSelection(profiles.length);

  useKeys((press) => {
    if (press.name === "enter") {
      const profile = profiles[selection.at()];
      // Nothing is ordered here, and nothing is even asked of a cloud yet: the floors of
      // this profile are what the next screen is fetched with.
      if (profile) done({ do: "go", to: { view: "shape", profile } });
      return;
    }
    common(press, selection, done, { view: "menu" });
  });

  const current = profiles[selection.index];
  const columns = columnsOf(PROFILE_COLUMNS, profiles);

  return (
    <Frame
      title="up 1/2 — the profile"
      right={<Text dimColor>what the machine becomes</Text>}
      keys={[
        { key: "↑↓", does: "move" },
        { key: "⏎", does: "choose the shape" },
        { key: "esc", does: "back" },
      ]}
    >
      <Head>{columns.head}</Head>
      <List
        rows={profiles}
        index={selection.index}
        height={10}
        render={(profile, selected) => (
          <Text wrap="truncate-end">
            <Cursor selected={selected} />
            <Text bold={selected}>{columns.cell(0, profile)}</Text>
            <Text
              color={profile.secrets.length > 0 ? "yellow" : undefined}
              dimColor={profile.secrets.length === 0}
            >
              {columns.cell(1, profile)}
            </Text>
            {/* Drawn rather than printed - each floor is dimmed on its own - so it takes
                the width instead of the string. */}
            <Floors profile={profile} width={columns.width(2)} />
            <Text dimColor>{columns.cell(3, profile)}</Text>
          </Text>
        )}
      />
      {current?.note ? (
        <Box marginTop={1}>
          <Text dimColor>{current.note}</Text>
        </Box>
      ) : null}
    </Frame>
  );
}

/**
 * Step two of `up`: what it is made of, from every cloud, cheapest first.
 *
 * The shape is pinned rather than the price, because the price is what it costs today and
 * the shape is what was chosen. `up --type` still goes through the probe, so an offer that
 * went out of stock between this screen and the order is refused before anything is
 * created rather than at apply — and the floors are not passed along with it: `cmd_up`
 * reads them from the same profile header this screen was filtered by.
 */
/**
 * What an offer shows. The three quantities are ONE column, pre-aligned inside itself.
 *
 * `4c  8G   80G` is fixed by construction - two, three and four digits, padded - so the
 * numbers line up under each other while the column as a whole is measured like any other.
 * Splitting them into three would have measured three widths and lost the one alignment
 * that makes a table of shapes comparable at a glance.
 */
const OFFER_COLUMNS: Column<Offer>[] = [
  { label: "EUR/H", value: (offer) => eur(offer.hourly_eur), align: "right" },
  { label: "EUR/MO", value: (offer) => eurPerMonth(offer.hourly_eur), align: "right" },
  { label: "CLOUD", value: (offer) => offer.cloud },
  { label: "SHAPE", value: (offer) => offer.type },
  { label: "WHERE", value: (offer) => offer.location },
  {
    label: "CPU  RAM  DISK",
    value: (offer) =>
      `${String(offer.cpu).padStart(2)}c ${String(offer.ram_gb).padStart(3)}G ` +
      `${String(offer.disk_gb).padStart(4)}G`,
  },
  { label: "AVAIL", value: (offer) => offer.availability ?? "unknown" },
];

export function ShapeStep({
  profile,
  offers,
  stderr,
  done,
}: {
  profile: Profile;
  offers: Offer[];
  stderr: string;
  done: (intent: Intent) => void;
}) {
  const selection = useSelection(offers.length);
  const skipped = parseSkipped(stderr);
  const columns = columnsOf(OFFER_COLUMNS, offers);

  useKeys((press) => {
    if (press.name === "enter") {
      const offer = offers[selection.at()];
      if (offer) {
        done({
          do: "launch",
          argv: ["up", "--profile", profile.name, "--cloud", offer.cloud, "--type", offer.type],
        });
      }
      return;
    }
    // Escape goes back one step, to the profile, and not out to the menu: a wizard whose
    // second question cannot be un-answered is a wizard you leave rather than correct.
    if (common(press, selection, done, { view: "profile" })) return;
    if (press.name === "char" && press.ch === "r") done({ do: "reload" });
  });

  return (
    <Frame
      title="up 2/2 — the shape"
      right={
        <Text dimColor>
          {profile.name}, above <Floors profile={profile} />, cheapest first
        </Text>
      }
      keys={[
        { key: "↑↓", does: "move" },
        { key: "⏎", does: "order this one" },
        { key: "r", does: "refresh" },
        { key: "esc", does: "the profile" },
      ]}
    >
      {/* EUR/MO sits next to EUR/H and not at the end of the row, because this is the
          screen where Enter spends money and the eye never has to travel to find the
          consequence. It costs eight columns; the row was 63 wide and is 71, which still
          fits the 80-column terminal this window is smallest in. */}
      <Head>{columns.head}</Head>
      <List
        rows={offers}
        index={selection.index}
        height={12}
        empty={<Text dimColor>nothing creatable above what {profile.name} asks for</Text>}
        render={(offer, selected) => (
          <Text wrap="truncate-end">
            <Cursor selected={selected} />
            <Text color="yellow">{columns.cell(0, offer)}</Text>
            <Text color="yellow" dimColor>
              {columns.cell(1, offer)}
            </Text>
            <Text color={cloudColor(offer.cloud)}>{columns.cell(2, offer)}</Text>
            <Text bold={selected}>{columns.cell(3, offer)}</Text>
            <Text dimColor>{columns.cell(4, offer)}</Text>
            <Text dimColor>{columns.cell(5, offer)}</Text>
            <Text dimColor>{columns.cell(6, offer)}</Text>
          </Text>
        )}
      />
      {skipped.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">not asked:</Text>
          {skipped.map((line) => (
            <Text key={line} dimColor>
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Frame>
  );
}

/**
 * The floors a machine is chosen against, dimmed where the profile did not ask for them.
 *
 * The numbers are always the effective ones — see floors.ts for why a `?` was worse than
 * useless here — and the dimming is what is left of the distinction: on a profile that sets
 * only `2c` and `4G`, those are the profile's and `80G` is the core's template, which is the whole difference
 * between a floor you chose and a floor you inherited.
 *
 * Padded by a plain string rather than by a layout box, so it lines up with the columns
 * around it, which are padded the same way.
 */
function floorsText(profile: Profile): string {
  const floors = floorsOf(profile);
  return `${floors.cpu.value}c/${floors.ram.value}G/${floors.disk.value}G`;
}

function Floors({ profile, width = 0 }: { profile: Profile; width?: number }) {
  const floors = floorsOf(profile);
  const text = floorsText(profile);
  return (
    <Text>
      <Text dimColor={!floors.cpu.declared}>{floors.cpu.value}c</Text>
      <Text dimColor>/</Text>
      <Text dimColor={!floors.ram.declared}>{floors.ram.value}G</Text>
      <Text dimColor>/</Text>
      <Text dimColor={!floors.disk.declared}>{floors.disk.value}G</Text>
      {text.length < width ? <Text>{" ".repeat(width - text.length)}</Text> : null}
    </Text>
  );
}

/** A runaway server: the same four facts `devbox orphans` prints in the terminal. */
const ORPHAN_COLUMNS: Column<Orphan>[] = [
  { label: "NAME", value: (orphan) => orphan.name },
  { label: "CLOUD", value: (orphan) => orphan.cloud },
  { label: "WHERE", value: (orphan) => orphan.region },
  { label: "CREATED", value: (orphan) => orphan.created.slice(0, 16) },
  { label: "IP", value: (orphan) => orphan.ip ?? "-" },
];

/** `orphans`. Nothing to press: what to do about one is a Terraform import, not a key. */
export function OrphansView({
  orphans,
  done,
}: {
  orphans: Orphan[];
  done: (intent: Intent) => void;
}) {
  const selection = useSelection(orphans.length);
  const columns = columnsOf(ORPHAN_COLUMNS, orphans);

  useKeys((press) => {
    if (common(press, selection, done, { view: "menu" })) return;
    if (press.name === "char" && press.ch === "r") done({ do: "reload" });
  });

  return (
    <Frame
      title="orphans"
      color={orphans.length > 0 ? "yellow" : "cyan"}
      keys={[
        { key: "r", does: "refresh" },
        { key: "esc", does: "back" },
      ]}
    >
      {orphans.length === 0 ? (
        <Text>
          <Text color="green">✔ </Text>
          <Text dimColor>no orphan: every server the providers run is in the state</Text>
        </Text>
      ) : (
        <>
          <Text color="yellow" bold>
            {orphans.length} server{orphans.length > 1 ? "s" : ""} that no state knows about, and
            they are billing
          </Text>
          <Box marginTop={1} flexDirection="column">
            {/* This list had no header until 30/08 and its neighbours all had one: two
                dates and an address in a row, and nothing saying which column is which. */}
            <Head>{columns.head}</Head>
            <List
              rows={orphans}
              index={selection.index}
              height={10}
              render={(orphan, selected) => (
                <Text wrap="truncate-end">
                  <Cursor selected={selected} />
                  <Text bold={selected}>{columns.cell(0, orphan)}</Text>
                  <Text color={cloudColor(orphan.cloud)}>{columns.cell(1, orphan)}</Text>
                  <Text dimColor>{columns.cell(2, orphan)}</Text>
                  <Text dimColor>{columns.cell(3, orphan)}</Text>
                  <Text dimColor>{columns.cell(4, orphan)}</Text>
                </Text>
              )}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              Destroy them from the provider console, or import one into a workspace.
            </Text>
          </Box>
        </>
      )}
    </Frame>
  );
}
