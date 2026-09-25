import type { ProbeQuery } from "@/lib/api"
import type { Floors, Offer, Profile } from "@/lib/types"

/**
 * A profile's floors, and which of them are handed to the probe.
 *
 * Only those the profile's header really declares. A floor left out here falls back on the
 * core's template, and that is exactly the point: `cmd_up` fills the same blanks with the
 * same 4/8/80, so the list step 2 displays is the list `up` is going to choose from - not a
 * neighbouring list computed by the browser. The CLI makes the same gesture in
 * cli/src/ui/tui/window.tsx#floors, for the same reason.
 *
 * `declared` serves the display, never the filtering: on a profile that sets only 2c and 4G,
 * those come from the profile and 80G from the template, and that is the whole difference between a floor that
 * was chosen and a floor that is inherited. What is NOT done is printing `?` for a missing
 * floor: cli/src/floors.ts tells why that was worse than useless - the offers really are
 * filtered at 80 GB, and a column reading `?G` describes a number the reader can neither act
 * on nor lay a hand on.
 */
export function askedFloors(profile: Profile): ProbeQuery {
  const query: ProbeQuery = {}
  if (profile.min_cpu !== null) query.cpu = profile.min_cpu
  if (profile.min_ram !== null) query.ram = profile.min_ram
  if (profile.min_disk !== null) query.disk = profile.min_disk
  return query
}

/**
 * The same three quantities, as plain numbers.
 *
 * `Floors` carries `declared` alongside each value because step 2's subtitle used to be the
 * only place that distinction was drawn. The narrowing below has no such thing to say - a
 * number the reader turned up themselves is neither declared by a profile nor inherited from
 * a template - so it travels as three numbers, and the two shapes meet here.
 */
export type Trio = { cpu: number; ram: number; disk: number }

/**
 * `2 cores / 4 GB / 80 GB` - the effective floors, spelled out, with no distinction drawn.
 *
 * Words and not `2c/4G/80G`, which is what this returned until the rows below it grew icons.
 * It sits inside a sentence, where an icon reads as punctuation rather than as a unit, and
 * it is the one place the three quantities are named in full - so a reader who has just met
 * the chip, the memory stick and the drive on the rows can tie the two together without
 * leaving the screen. See components/marks.tsx#Spec for why the rows are drawn instead.
 *
 * It says the EFFECTIVE floors, which is why the narrowing borrows it: once the reader has
 * turned the memory up to 16, the sentence under the title has to say 16, or the screen
 * describes a filter it is no longer applying.
 */
export function floorsTextOf(floors: Trio): string {
  return `${floors.cpu} cores / ${floors.ram} GB / ${floors.disk} GB`
}

export function floorsText(floors: Floors): string {
  return floorsTextOf(valuesOf(floors))
}

/** A profile's floors, stripped of `declared`. */
export function valuesOf(floors: Floors): Trio {
  return {
    cpu: floors.cpu.value,
    ram: floors.ram.value,
    disk: floors.disk.value,
  }
}

/**
 * The rungs each quantity really offers, ascending, with the floor as the first one.
 *
 * READ OFF THE OFFERS, never written down here. A ladder of 8/16/32/64 typed into this file
 * would advertise a 64 GB machine on a market that has none and hide the 12 and the 24 that
 * Hetzner actually sells - and the reader would have no way to tell which of the two it was.
 * The probe's own floor opens the ladder because it is the rung that means "not narrowed":
 * the list arrives filtered at it, so selecting it is selecting the list as it came.
 *
 * The three ladders are read from the WHOLE list, not from what the other two are showing.
 * A ladder that shrank as its neighbours moved would renumber itself under the thumb between
 * two taps, and the combination that matches nothing is worth an empty list that says so -
 * see the reset in new-shape.tsx.
 */
export function ladders(
  offers: Offer[],
  floor: Trio
): { cpu: number[]; ram: number[]; disk: number[] } {
  const rungs = (values: number[], from: number) =>
    [...new Set([from, ...values.filter((value) => value >= from)])].sort(
      (a, b) => a - b
    )
  return {
    cpu: rungs(
      offers.map((offer) => offer.cpu),
      floor.cpu
    ),
    ram: rungs(
      offers.map((offer) => offer.ram_gb),
      floor.ram
    ),
    disk: rungs(
      offers.map((offer) => offer.disk_gb),
      floor.disk
    ),
  }
}

/** The offers that clear a raised floor. Above, as everywhere on this screen - never equal. */
export function narrow(offers: Offer[], wanted: Trio): Offer[] {
  return offers.filter(
    (offer) =>
      offer.cpu >= wanted.cpu &&
      offer.ram_gb >= wanted.ram &&
      offer.disk_gb >= wanted.disk
  )
}

/**
 * The clouds that really answered, in the order they first appear - which is by price, the
 * list being sorted.
 *
 * Read off the offers for the same reason the ladders are, and NOT taken from the session's
 * `clouds`: that one names what this service could order from, credentials and all, and a
 * provider that answered with nothing above the profile's floors would get a chip there that
 * can only ever empty the list. What is offered as a filter has to be what is on screen.
 */
export function cloudsOf(offers: Offer[]): string[] {
  return [...new Set(offers.map((offer) => offer.cloud))]
}

/**
 * One machine a cloud sells, and every place that can create it right now.
 *
 * The probe answers one row per PLACE: Scaleway's DEV1-M came back three times, from
 * fr-par-1, fr-par-2 and nl-ams-1, at the same price with the same cores, memory and disk.
 * Listed as they came, the rows could not be told apart, and choosing one lit up all three -
 * because the three are, as far as an order goes, one thing. The order names a cloud and a
 * type and no place (lib/api.ts#create), and devbox-core's `up --type` walks every place that
 * sells the type, in the probe's own order, moving to the next when one turns out to be out
 * of stock at apply (hz_up, scw_up, gcp_up). So the list is one row per machine, and the
 * places are what the chosen one unfolds.
 *
 * `places` keeps the probe's order: price, then the provider's own, which is exactly the
 * order `up` tries them in - the first place is where the order goes first, at its price.
 */
export type Shape = {
  cloud: string
  type: string
  cpu: number
  ram_gb: number
  /** As the probe reads it. See clouds.ts#DISK_ASKED for why that is not always the disk. */
  disk_gb: number
  cpu_class: string | null
  places: Offer[]
}

export function shapesOf(offers: Offer[]): Shape[] {
  const shapes = new Map<string, Shape>()
  for (const offer of offers) {
    const key = `${offer.cloud}/${offer.type}`
    const known = shapes.get(key)
    if (known === undefined) {
      shapes.set(key, {
        cloud: offer.cloud,
        type: offer.type,
        cpu: offer.cpu,
        ram_gb: offer.ram_gb,
        disk_gb: offer.disk_gb,
        cpu_class: offer.cpu_class,
        places: [offer],
      })
    } else {
      known.places.push(offer)
    }
  }
  return [...shapes.values()]
}
