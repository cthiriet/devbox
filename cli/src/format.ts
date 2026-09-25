/**
 * The numbers, spelled the way devbox-core spells them.
 *
 * Three decimals and a comma for the hourly price, two for the day. These are not
 * preferences: the core prints `0,024` and this layer replaces the core's screens, so a
 * price that suddenly read `0.024` would be a visible regression for the one number the
 * whole tool exists to keep in view.
 *
 * `eur() { printf '%.3f' "$1" | tr '.' ','; }` — one line of bash, and the only line of
 * devbox-core this layer has ever had to reimplement, because every table in the tool ends
 * in it.
 *
 * IT USED TO BE `value.toFixed(3)`, under a comment claiming it was `eur()` in devbox-core.
 * It is not: C rounds half to EVEN, toFixed rounds half AWAY from zero, and on 0.0625 — a
 * value a double holds exactly — bash prints 0,062 while toFixed prints 0,063. The Ink
 * table and the bash table could therefore disagree by a thousandth on the same fleet:
 * small, invisible, and precisely the kind of difference that teaches someone to distrust
 * both numbers. Nothing here could have caught it, because both sides were only ever
 * compared to themselves.
 *
 * Intl with roundingMode "halfEven" was the obvious replacement and it is ALSO wrong,
 * which the parity test caught on the first run. Intl decides ties on the shortest decimal
 * that round-trips — it reads 0.0005 as a tie and goes to the even digit — while printf
 * reads the double's exact binary value, which for 0.0005 is 0.00050000000000000001, above
 * the tie, and rounds up. Two plausible rounding modes, three different answers.
 *
 * So the exact expansion is what gets rounded here, and tests/eur.test.ts settles it by
 * running the real bash over six hundred values rather than by trusting this comment.
 */

/** How many digits of the double's exact decimal expansion are enough to break a tie. */
const EXACT = 40;

/**
 * `printf '%.Nf'`, including its rounding rule.
 *
 * A double is a dyadic rational, so its decimal expansion terminates: forty digits is far
 * past the point where anything this tool prices could still be undecided, and what is left
 * is a plain digit-string comparison. Above the half rounds up, below rounds down, and an
 * exact half goes to the even digit — which is the rule, and the whole reason this is not
 * a call to toFixed.
 */
function printfFixed(value: number, places: number): string {
  const negative = value < 0 || Object.is(value, -0);
  const [whole = "0", fraction = ""] = Math.abs(value).toFixed(EXACT).split(".");

  const kept = fraction.slice(0, places).padEnd(places, "0");
  const rest = fraction.slice(places);
  let scaled = BigInt(whole + kept);

  const half = `5${"0".repeat(Math.max(0, rest.length - 1))}`;
  if (rest > half) scaled += 1n;
  else if (rest === half && scaled % 2n === 1n) scaled += 1n;

  const digits = scaled.toString().padStart(places + 1, "0");
  const cut = digits.length - places;
  const text = places === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  return negative && scaled !== 0n ? `-${text}` : text;
}

/** An hourly price: three decimals, decimal comma. The em dash is this layer's alone —
 *  a screen has to render an absent price, and the core never has one to print. */
export function eur(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return printfFixed(value, 3).replace(".", ",");
}

/**
 * What a fleet costs in a day if nothing is destroyed. Two decimals, decimal comma.
 *
 * Computed from the raw hourly price and not from the string above: rounding an already
 * rounded number makes the day and the hour disagree on a fleet of any size.
 */
export function eurPerDay(hourly: number): string {
  return printfFixed(hourly * 24, 2).replace(".", ",");
}

/**
 * The hours in an average month, and the only place that number is written.
 *
 * A year is 365.25 days, so a month is 365.25 × 24 ÷ 12 = 730.5 hours, and the whole
 * number every cloud rounds that to is 730 — GCP's billing catalogue included, which is
 * how devbox-core turns a monthly SKU back into an hour (`/ 730`, devbox-core:1278). Taking the
 * same constant means the month this layer shows for a GCP shape is the month GCP priced,
 * travelled to an hour and back.
 *
 * NOT 720. A thirty-day month is short in seven months out of twelve, and it is short by
 * 1.4% every time — always in the same direction, always underneath, on the one screen
 * somebody reads before spending money. An estimate that is reliably low is worse than a
 * coarse one, because nothing about it ever looks wrong.
 */
export const MONTH_HOURS = 730;

/**
 * What one hourly price comes to in a month. Two decimals, decimal comma, like the day.
 *
 * INTERPOLATED, and the screens that have room to say so do: `hourly_eur` is the only
 * price devbox-core carries — the three cloud APIs agree on nothing else — so the month is
 * this multiplication and not a figure anybody published. On Hetzner it is a ceiling
 * rather than a bill: measured 25/08 on the fsn1 catalogue, a cpx22 at 0,0312 interpolates
 * to 22,78 against a published 19,49, because Hetzner stops counting hours partway through
 * the month. Some 17% high, every Hetzner row. That sentence lives in Probe's `price:`
 * block; a table with a caveat on every line is a table nobody finishes reading.
 *
 * Computed from the raw hourly for the same reason `eurPerDay` is: a month derived from
 * the rounded string would disagree with the hour beside it by a euro on a large fleet.
 */
export function eurPerMonth(hourly: number): string {
  return printfFixed(hourly * MONTH_HOURS, 2).replace(".", ",");
}

/** `4 min 12s`, the way `cmd_seed` reports a phase 2. */
export function duration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return minutes > 0 ? `${minutes} min ${whole % 60}s` : `${whole}s`;
}

/**
 * Column widths, from the content rather than from a constant.
 *
 * devbox-core pads to fixed widths — `%-14s` for a name, `%-16s` for a region — which is the
 * only thing printf can do without two passes over the rows. It costs a wrapped line the
 * day a name is fifteen characters long, and a wide gutter every other day. Here the rows
 * are already in memory, so the width is simply the widest thing in the column.
 *
 * Exported and pure because this is the part worth testing: everything else in a table is
 * Ink putting strings next to each other.
 */
export function widths<Row>(
  columns: { label: string; value: (row: Row) => string }[],
  rows: Row[],
): number[] {
  return columns.map((column) =>
    rows.reduce((widest, row) => Math.max(widest, column.value(row).length), column.label.length),
  );
}

/** Left-padded to `width`, and never truncated: a cut machine name is worse than a ragged column. */
export function pad(text: string, width: number, align: "left" | "right" = "left"): string {
  if (text.length >= width) return text;
  const filler = " ".repeat(width - text.length);
  return align === "right" ? filler + text : text + filler;
}
