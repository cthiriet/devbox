/**
 * The numbers, spelled the way devbox-core spells them.
 *
 * Three decimals and a comma for the hourly price, two for the day. This is not a
 * preference: the core prints `0,024`, and a screen showing `0.024` - or `0,025` - for the
 * same machine would teach its reader to distrust both numbers. The decimal comma therefore
 * stays even though this interface is in English, and that is a decision rather than a
 * missed translation: `eur() { printf '%.3f' "$1" | tr '.' ','; }` is one line of bash, and
 * the dashboard and the CLI have to agree to the digit on the one number this whole tool
 * exists to keep in view.
 *
 * The old page did `value.toFixed(3)` under a comment claiming to be devbox-core's `eur()`. It
 * is not: C's `printf '%.3f'` rounds half to EVEN, `toFixed` rounds half away from zero, and
 * on 0,0625 - a value a double holds exactly - bash prints 0,062 where toFixed prints 0,063.
 * A thousandth of difference, invisible, on the one number this tool exists for.
 * cli/src/format.ts carries the full demonstration and the test that replays six hundred
 * values against the real bash; this file is its copy, because the browser cannot call bash.
 */

/** How many digits of the double's exact decimal expansion are enough to break a tie. */
const EXACT = 40

/**
 * `printf '%.Nf'`, including its rounding rule.
 *
 * A double is a dyadic rational, so its decimal expansion terminates: forty digits is far
 * past the point where anything this tool prices could still be undecided, and what is left
 * is a plain digit-string comparison. Above the half rounds up, below rounds down, and an
 * exact half goes to the even digit - which is the rule, and the whole reason this is not a
 * call to toFixed.
 */
function printfFixed(value: number, places: number): string {
  const negative = value < 0 || Object.is(value, -0)
  const [whole = "0", fraction = ""] = Math.abs(value).toFixed(EXACT).split(".")

  const kept = fraction.slice(0, places).padEnd(places, "0")
  const rest = fraction.slice(places)
  let scaled = BigInt(whole + kept)

  const half = `5${"0".repeat(Math.max(0, rest.length - 1))}`
  if (rest > half) scaled += 1n
  else if (rest === half && scaled % 2n === 1n) scaled += 1n

  const digits = scaled.toString().padStart(places + 1, "0")
  const cut = digits.length - places
  const text =
    places === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`
  return negative && scaled !== 0n ? `-${text}` : text
}

/**
 * An hourly price: three decimals, decimal comma.
 *
 * The em dash is this layer's alone - a screen has to render an absent price, and the core
 * never has one to print.
 */
export function eur(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-"
  return printfFixed(value, 3).replace(".", ",")
}

/**
 * What a fleet costs in a day if nothing is destroyed. Two decimals, decimal comma.
 *
 * Computed from the raw hourly price and not from the string above: rounding an already
 * rounded number makes the day and the hour disagree as soon as the fleet holds more than
 * one machine.
 */
export function eurPerDay(hourly: number): string {
  return printfFixed(hourly * 24, 2).replace(".", ",")
}

/**
 * The hours in a month, and the only place that number is written.
 *
 * 730 = 365,25 × 24 ÷ 12, the average month. Not 720: thirty days is a month that only
 * February and the four short months ever are, so a 30-day month under-counts seven months
 * out of twelve - and it under-counts the bill, which is the direction a cost figure must
 * never be wrong in. Every layer of this tool carries the same constant under the same name,
 * because the fault this guards against is three screens quoting three months for one
 * machine.
 */
export const MONTH_HOURS = 730

/**
 * What an hourly price comes to over a month. Two decimals, decimal comma.
 *
 * Interpolated, not read: `devbox-core` keeps `price_hourly` and nothing else from the three
 * providers, and this is derived in each interface rather than carried by the API - the
 * hourly price stays the single thing the JSON contract transports.
 *
 * It is therefore not a quote. Hetzner caps its billing past a certain number of hours in
 * the month, so this figure runs about 17 % above what it actually invoices; wherever the
 * number is shown next to an explanation, that explanation has to say so.
 *
 * Computed from the raw hourly price, as `eurPerDay` is, and for the same reason.
 */
export function eurPerMonth(hourly: number): string {
  return printfFixed(hourly * MONTH_HOURS, 2).replace(".", ",")
}

/** How long a job has been running. Taken from the old page, its units turned to English. */
export function since(started: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - started) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")}`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/**
 * When a secret was last written, as a distance: `3 d ago`.
 *
 * A fingerprint says WHICH value is held; this says whether it is the one written this
 * morning or the one from before the leak, which is the question a rotation asks. Past two
 * months a distance stops being a landmark and the day takes over, cut like `stamp` cuts and
 * for its reason. A moment later than `now` - written since the screen froze its clock - is
 * just now, and not a negative number of minutes.
 */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 60) return `${days} d ago`
  return `on ${new Date(at).toISOString().slice(0, 10)}`
}

/** `4 min 12s`, the way `cmd_seed` reports a phase 2. */
export function duration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  return minutes > 0 ? `${minutes} min ${whole % 60}s` : `${whole}s`
}

/**
 * The moment a provider says it created something: `2026-08-20 14:02`.
 *
 * Cut to the minute as in the CLI, and the ISO `T` replaced by a space - this is a date read
 * by someone, not a field read back by a machine. No time zone is converted: the value is
 * the one the provider's API gave, and turning it into local time would make this screen
 * disagree with the console where it is going to be found again.
 */
export function stamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ")
}

/**
 * The first seven characters of a sha256, and not one more.
 *
 * It is the digest `devbox` compares before every remote verb; seven is what can be read at a
 * glance without confusing it with another deployment.
 */
export function shortDigest(digest: string | null): string {
  if (digest === null || digest === "") return "?"
  return digest.slice(0, 7)
}

/**
 * A job's verb, in the words of the button that started it.
 *
 * `up`, `seed` and `down` are devbox-core's verbs and the CLI's, and they stay so in the job's
 * argv and in the API. A customer never typed them: they pressed "Order a machine", "Seed" and
 * "Destroy", and a list reading `down devbox-k2m7v` asked them to learn a vocabulary to
 * recognise their own gesture. A verb this does not know is shown as it is, not guessed at.
 */
export function jobVerb(verb: string): string {
  if (verb === "up") return "Order"
  if (verb === "seed") return "Seed"
  if (verb === "down") return "Destroy"
  return verb
}

/**
 * What a machine has cost since it was ordered.
 *
 * The one figure that decides to destroy tonight rather than tomorrow, and the only one
 * the fleet could not show: it had the price of an hour and no hours. Rounded to the cent
 * it is already spent, not an estimate of anything.
 */
export function eurSince(
  hourly: number | null,
  orderedAt: number | null | undefined,
  now: number
): string | null {
  if (hourly === null || orderedAt === null || orderedAt === undefined)
    return null
  const hours = Math.max(0, (now - orderedAt) / 3_600_000)
  // Two decimals like the day and the month, and not the three of an hourly price: this is
  // money already spent, and a tenth of a cent on it is a precision nobody has.
  return printfFixed(hourly * hours, 2).replace(".", ",")
}

/** `a`, `a and b`, `a, b and c`: things in a sentence. */
export function inSentence(items: readonly string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/**
 * An age at rest: `12 min`, `28 h`, `3 d`.
 *
 * Coarser than `since`, which a job's log wants to the minute: a machine's row and its title
 * want a landmark. The hours run to 48 before the days take over, because a number of hours is
 * what a bill by the hour counts, and "1 d" hid whether that meant 25 or 47 of them.
 */
export function age(started: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - started) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/**
 * A job's verb as a noun, for the lines that name a job without opening it.
 *
 * `seed` is "setup" here, and not jobVerb's "Seed": the gesture that starts one is called
 * "Set up again" on the machine's page since 13/09, and what `cmd_seed` does - send the keys,
 * run the profile's setup again - is a setup to whoever pressed it.
 */
function jobNoun(verb: string): string {
  if (verb === "up") return "order"
  if (verb === "seed") return "setup"
  if (verb === "down") return "destroy"
  return verb
}

/** `Last order failed`, `Last setup was interrupted`: a job that did not finish, in one line. */
export function jobFailure(
  verb: string,
  state: "failed" | "interrupted"
): string {
  const what = jobNoun(verb)
  return state === "failed"
    ? `Last ${what} failed`
    : `Last ${what} was interrupted`
}

/** `Ordering`, `Setting up`, `Destroying`: a job still running, in one word. */
export function jobUnderway(verb: string): string {
  if (verb === "up") return "Ordering"
  if (verb === "seed") return "Setting up"
  if (verb === "down") return "Destroying"
  return verb
}

/**
 * How long a job took, rounded to what a reader keeps in mind: `40 s`, `3 min`, `1 h 05`.
 *
 * The line that closes a job - "Failed after 3 min" - and not `duration`'s `3 min 12s`: the
 * seconds of a job that died are in its log, and the line only has to say whether it died at
 * once or at the end.
 */
export function took(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  if (whole < 60) return `${whole} s`
  const minutes = Math.floor(whole / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`
}

/**
 * A job's verb, for the lines that list and title jobs: `Order`, `Setup`, `Destroy`.
 *
 * jobVerb's words, except `seed`, which is "Setup" wherever a customer reads it: the machine's
 * page calls the gesture "Set up again", and `seed` is a word of the CLI.
 */
export function jobAction(verb: string): string {
  if (verb === "seed") return "Setup"
  return jobVerb(verb)
}
