import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eur, eurPerMonth } from "../src/format.ts";

/**
 * The parity oracle, and the one thing that survived the TypeScript port of devbox-core.
 *
 * The port is gone — 5041 lines to replace 1455, a second implementation of a tool whose
 * problem was never the bash — but this stayed, because it found a real bug and because it
 * is the only assertion in this package that compares the Ink layer to the executor rather
 * than to itself. cli/src/format.ts carried a comment saying "`eur()` in devbox-core" while
 * quietly disagreeing with it by a thousandth on every price landing on an exact half.
 *
 * So the shape is the point: the bash and the TypeScript are run over the same inputs and
 * their answers compared, rather than the TypeScript being compared to what someone
 * believed the bash did.
 *
 * The bash is invoked once for the whole batch. Spawning a shell per value would make a
 * six-hundred-case test take a minute, and the point of a wide sweep is that it stays
 * cheap enough to keep.
 *
 * It asks devbox-core's own `eur`, sourced like `eur_month` below, and no longer a copy of
 * the idiom. The copy was `printf "%.3f"`, and it was right on the Mac only: bash parses
 * into a long double on x86_64 Linux, and the first CI run on ubuntu (11/09) failed 36
 * values of the sweep against it. The core moved to awk for that reason; an oracle that had
 * kept the old idiom would have gone on testing a function that no longer exists.
 */
function bashEur(values: number[]): string[] {
  const script = `source ${JSON.stringify(CORE)} help >/dev/null 2>&1
for v in "$@"; do eur "$v"; echo; done`;
  const child = Bun.spawnSync(["bash", "-c", script, "bash", ...values.map(String)]);
  return new TextDecoder().decode(child.stdout).trimEnd().split("\n");
}

describe("eur, against the bash it replaces", () => {
  test("agrees on the prices the tool actually shows", () => {
    // The real ones: what Hetzner, Scaleway and GCP charge per hour for the shapes this
    // tool orders. If parity ever breaks here, it breaks on the numbers a user reads.
    const real = [0.0144, 0.0136, 0.0052, 0.0304, 0.062, 0.1078, 0.0092, 0.2333];
    expect(real.map(eur)).toEqual(bashEur(real));
  });

  test("agrees on the exact halves, where the two rules part company", () => {
    // A double holds these exactly, so the rounding rule decides alone: printf goes to the
    // even digit, toFixed goes away from zero. This is the case that was wrong in
    // cli/src/format.ts, and the reason `printfFixed` is written out there at all.
    const halves = [0.0625, 0.0635, 0.0005, 0.0015, 0.0025, 0.1875, 0.3125];
    expect(halves.map(eur)).toEqual(bashEur(halves));
    // Named explicitly, so a future change to the rounding mode fails on the sentence
    // rather than on an opaque list.
    expect(eur(0.0625)).toBe("0,062");
    expect(eur(0.1875)).toBe("0,188");
  });

  test("agrees across six hundred values, decided by the shell and not by this file", () => {
    // A sweep rather than a handful: the disagreement between the two rules only shows on
    // ties, and ties are sparse. Deterministic — no random seed to make a failure
    // unreproducible — and wide enough that the tie cases fall in on their own.
    const swept: number[] = [];
    for (let i = 0; i <= 600; i++) swept.push(i / 1600);
    expect(swept.map(eur)).toEqual(bashEur(swept));
  });

  test("agrees on zero and on prices too small to show", () => {
    // GCP's composed prices reach five decimals, and a row that costs "0,000" per hour is
    // a true statement the table is allowed to make. What it must not do is differ from
    // the same row printed by the bash.
    const tiny = [0, 0.0001, 0.00049, 0.0005, 0.00051, 0.000054];
    expect(tiny.map(eur)).toEqual(bashEur(tiny));
  });
});

/**
 * The same oracle for the month, except that this one calls the core's function itself.
 *
 * `eur_month` multiplies before it rounds, and the multiplication is where the two
 * languages get a second chance to disagree: awk and JavaScript both hold `0.0569 * 730`
 * in an IEEE double, so they agree on the product bit for bit, and `printf "%.2f"` and
 * `printfFixed(…, 2)` then have to agree on the same half-way cases `eur` already
 * settles at three decimals. Two places rather than three moves which values land on a
 * tie, so this is not the first test re-run with a different constant.
 *
 * Sourced rather than reimplemented here, like `bashEur` above: asking the real function in
 * devbox-core is the difference between testing the executor and testing a copy of the
 * idiom somebody believed the executor uses. `source … help` runs the dispatcher's help
 * branch into /dev/null and leaves the definitions behind.
 */
const CORE = join(import.meta.dir, "..", "..", "devbox-core");

/**
 * Whether devbox-core has grown `eur_month` yet.
 *
 * The month landed in the three layers at once, and this file is the only one that can
 * compare two of them. While the bash half is missing the parity block SKIPS — visibly, in
 * the run — rather than passing: an oracle that is not there has not agreed with anything.
 * units.test.ts still pins the format and the three measured prices in the meantime.
 */
const coreHasEurMonth = /^\s*eur_month\s*\(\)/m.test(readFileSync(CORE, "utf8"));

function bashEurMonth(values: number[]): string[] {
  const script = `source ${JSON.stringify(CORE)} help >/dev/null 2>&1
for v in "$@"; do eur_month "$v"; echo; done`;
  const child = Bun.spawnSync(["bash", "-c", script, "bash", ...values.map(String)]);
  return new TextDecoder().decode(child.stdout).trimEnd().split("\n");
}

describe.skipIf(!coreHasEurMonth)("eurPerMonth, against the eur_month it mirrors", () => {
  test("agrees on the prices the tool actually shows", () => {
    const real = [0.0144, 0.0136, 0.0052, 0.0304, 0.062, 0.1078, 0.0092, 0.2333];
    expect(real.map(eurPerMonth)).toEqual(bashEurMonth(real));
  });

  test("agrees on the three prices the spec measured against the catalogue", () => {
    // cpx22, cpx32, cx23 on Hetzner fsn1, 25/08 — the numbers the `price:` block under
    // `devbox probe` quotes back at the reader. If the two layers ever part company, they
    // part company on a sentence that names a published price.
    const measured = [0.0312, 0.0569, 0.0088];
    expect(measured.map(eurPerMonth)).toEqual(bashEurMonth(measured));
    expect(eurPerMonth(0.0312)).toBe("22,78");
  });

  test("agrees across six hundred values, decided by the shell and not by this file", () => {
    const swept: number[] = [];
    for (let i = 0; i <= 600; i++) swept.push(i / 1600);
    expect(swept.map(eurPerMonth)).toEqual(bashEurMonth(swept));
  });

  test("agrees on the exact halves — which the multiplication MOVES", () => {
    // Two decimals instead of three puts the ties on entirely different inputs, so this is
    // not the hourly test run again with a larger constant. A tie survives ×730 only where
    // the product is a dyadic rational ending in .125, .375, .625 or .875; 0,0125 an hour
    // is exactly 9,125 a month, and that is where half-to-even and half-away-from-zero
    // give different answers — 9,12 against 9,13.
    const ties = [0.0125, 0.0375, 0.0625, 0.1125, 0.1625, 0.1875];
    expect(ties.map(eurPerMonth)).toEqual(bashEurMonth(ties));
    // Named, so a change of rounding mode fails on the sentence rather than on a list.
    expect(eurPerMonth(0.0125)).toBe("9,12");
    expect(eurPerMonth(0.1125)).toBe("82,12");
  });

  test("agrees on zero and on prices too small to show", () => {
    const tiny = [0, 0.0001, 0.00049, 0.0005, 0.00051, 0.000054];
    expect(tiny.map(eurPerMonth)).toEqual(bashEurMonth(tiny));
  });
});
