import { ChevronDownIcon, Cpu, HardDrive, MemoryStick } from "lucide-react"

import { CloudMark } from "@/components/marks"
import { cloudName } from "@/lib/clouds"
import { cn } from "@/lib/utils"

/**
 * One of the three quantities, turned up or down along the rungs a market really offers.
 *
 * A NATIVE `<select>`, and that is the whole design. The ladders are read off the offers
 * (lib/floors.ts#ladders) and the disk one came back with twelve rungs on a two-cloud probe:
 * a row of twelve chips is four lines on a 375 px phone, and a `[-] 16 GB [+]` stepper is
 * four taps to cross them. The native control is one tap and one flick, it is the picker the
 * thumb already knows, and it costs no width whatever the ladder's length. It is also the
 * only one that stays legible when iOS decides how a picker looks.
 *
 * The icons are the ones from marks.tsx#Specs, deliberately: the same chip, memory stick and
 * drive that the rows below carry. A reader who has met them on a card must not have to
 * learn a second vocabulary one line higher to filter by them.
 *
 * Out loud it is a sentence - "at least 16 GB of memory" - because a select whose whole
 * accessible name is `16` names a number and not a quantity, on a screen that shows three
 * numbers in a row.
 *
 * ONE WIDTH for the three, whatever they hold. Sized by its content, `2` made a narrow pill
 * and `40 GB` a wide one, and in the Filter panel's column - label left, control right - the
 * three left edges stepped in and out like a mistake. Wide enough for eight characters -
 * `11776 GB` - past which the value truncates rather than widening one pill; the select fills
 * it, so the whole pill is the target and the chevron sits at the same place on all three.
 */
const MARKS = {
  cpu: { icon: Cpu, unit: "", said: "cores" },
  ram: { icon: MemoryStick, unit: "GB", said: "GB of memory" },
  disk: { icon: HardDrive, unit: "GB", said: "GB of disk" },
} as const

export function Rung({
  what,
  rungs,
  value,
  onPick,
}: {
  what: keyof typeof MARKS
  rungs: number[]
  value: number
  onPick: (value: number) => void
}) {
  const { icon: Icon, unit, said } = MARKS[what]
  // A rung the ladder no longer has still has to be shown: `Refresh` re-reads the market,
  // and a market that stopped selling 24 GB would otherwise leave a `<select>` displaying
  // its first option while filtering at the value it no longer names. The list below goes
  // empty and says so, which is the truth; a control lying about its own value is not.
  const shown = rungs.includes(value)
    ? rungs
    : [...rungs, value].sort((a, b) => a - b)
  return (
    <span
      className={cn(
        "relative inline-flex h-11 w-32 shrink-0 items-center gap-1.5 rounded-lg border border-input pr-2 pl-2.5",
        // Raised above its floor, the control says so on its own. The subtitle says it in
        // words too, but the subtitle is one sentence for three controls and cannot point at
        // the one that was moved.
        value > (rungs[0] ?? value) && "border-primary/60 bg-primary/5"
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0 opacity-70" />
      <select
        aria-label={`at least ${value} ${said}`}
        value={value}
        onChange={(event) => onPick(Number(event.target.value))}
        // `appearance-none` and a chevron of our own: the platform arrow lands in a
        // different place on every browser, and this one sits where the border ends.
        className="h-full min-w-0 flex-1 appearance-none truncate bg-transparent pr-4 font-mono text-sm tabular-nums outline-none focus-visible:ring-0"
      >
        {shown.map((rung) => (
          <option key={rung} value={rung}>
            {rung}
            {unit === "" ? "" : ` ${unit}`}
          </option>
        ))}
      </select>
      <ChevronDownIcon
        aria-hidden
        className="pointer-events-none absolute right-2 size-3.5 opacity-50"
      />
    </span>
  )
}

/**
 * One cloud, kept or let go.
 *
 * Chips and not a fourth `<select>`: two or three providers answer, and a picker would hide
 * behind one line of text the one axis the Filter panel can show at a glance.
 *
 * The provider's mark and its name, monochrome since 13/09, like the offers they filter: the
 * badge's red read as an error for Hetzner, and the state that matters here - kept or not -
 * is the chip's own border, which a colour of the provider's would only compete with.
 *
 * NOTHING SELECTED MEANS EVERY CLOUD, which is the state the screen opens in - a filter that
 * could be turned all the way off would be a dead end reachable in two taps, and "none of
 * them" is not a thing anyone wants to see. Turning the last one back off therefore widens
 * rather than empties, and the chips that are not chosen dim as soon as one is, so that
 * "none, meaning all" and "one of three" never look alike.
 */
export function CloudChip({
  cloud,
  active,
  dimmed,
  onToggle,
}: {
  cloud: string
  active: boolean
  dimmed: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        "inline-flex h-11 items-center gap-1.5 rounded-lg border px-3 text-sm",
        active ? "border-primary/60 bg-primary/5" : "border-input",
        !active && dimmed && "opacity-50"
      )}
    >
      <CloudMark cloud={cloud} className="size-3.5 shrink-0" />
      {cloudName(cloud)}
    </button>
  )
}
