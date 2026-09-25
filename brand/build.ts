/**
 * The devbox mark, and everything drawn from it.
 *
 *   bun run brand/build.ts
 *
 * There is one source for the logo, and it is this file. It writes the SVGs the README
 * uses, the React component the dashboard renders, and the favicon inlined in the
 * dashboard's index.html. That last one matters: a favicon copied by hand is a favicon
 * that drifts, and nothing would ever report the tab and the page disagreeing.
 *
 * The symbol is a lowercase `d` whose square bowl doubles as a box, dragging its own
 * volume behind it. The word beside it is drawn from a 5x7 grid rather than set in a
 * typeface, so there is no font to ship and no fallback to go wrong.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL(".", import.meta.url).pathname;
const ROOT = join(OUT, "..");

const INK = "#0B0F14";
const PAPER = "#FAFAFA";
const GREEN = "#3FB950";

type Palette = { fg: string; accent: string };
const DARK: Palette = { fg: PAPER, accent: GREEN };
const LIGHT: Palette = { fg: INK, accent: "#1F8B38" };

// ---------------------------------------------------------------------------
// The word
// ---------------------------------------------------------------------------

const FONT: Record<string, string[]> = {
  d: ["....#", "....#", ".####", "#...#", "#...#", "#...#", ".####"],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
  v: [".....", ".....", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  b: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
};
const WORD = "devbox";
const GAP = 1;
const COLS = WORD.length * 5 + (WORD.length - 1) * GAP;
const ROWS = 7;

function matrix(): boolean[][] {
  const m: boolean[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  let x = 0;
  for (const ch of WORD) {
    const g = FONT[ch];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < 5; c++) if (g[r][c] === "#") m[r][x + c] = true;
    x += 5 + GAP;
  }
  return m;
}

/** Horizontal runs, so one rect covers a row of lit pixels instead of five. */
function runs(m: boolean[][]) {
  const out: { x: number; y: number; w: number }[] = [];
  for (let r = 0; r < m.length; r++) {
    let c = 0;
    while (c < m[r].length) {
      if (!m[r][c]) { c++; continue; }
      let w = 0;
      while (c + w < m[r].length && m[r][c + w]) w++;
      out.push({ x: c, y: r, w });
      c += w;
    }
  }
  return out;
}
const M = matrix();

// ---------------------------------------------------------------------------
// The symbol
// ---------------------------------------------------------------------------

const W = 11;              // stroke weight, on a 52-tall letter
const LX = 12, RX = 52;    // left and right edges
const AY = 6, BY = 21, DY = 58; // ascender, top of the bowl, baseline
const IX1 = LX + W, IX2 = RX - W, IY1 = BY + W, IY2 = DY - W;

const rr = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x + r} A${r},${r} 0 0 1 ${x},${y + h - r} V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`;

// Outline then counter, filled even-odd: the hole is the box.
const D_PATH =
  `M${IX2},${AY} H${RX} V${DY} H${LX + 12} A12,12 0 0 1 ${LX},${DY - 12} V${BY + 12} A12,12 0 0 1 ${LX + 12},${BY} H${IX2} Z ` +
  rr(IX1, IY1, IX2 - IX1, IY2 - IY1, 5);

/**
 * The extrusion is a single offset copy, not a swept stack.
 *
 * Measured side by side: at an offset of 4 against a stroke of 11 the copies overlap
 * completely, so ten of them render the same pixels as one and cost eleven paths instead
 * of two. Two paths is what makes this viable as an inline favicon.
 */
const DEPTH = 4;
const BACK = (DEPTH / 2).toFixed(0);

/** The mark pulls back half its own depth, or it sits off-centre in a square tile. */
function mark(p: Palette): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<g transform="translate(-${BACK} -${BACK})">` +
    `<g transform="translate(${DEPTH} ${DEPTH})"><path fill-rule="evenodd" fill="${p.accent}" d="${D_PATH}"/></g>` +
    `<path fill-rule="evenodd" fill="${p.fg}" d="${D_PATH}"/></g></svg>`
  );
}

/** Mark and word on one line. This is the logo the README shows. */
function logo(p: Palette): string {
  const s = 6;
  const inner = mark(p).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const word = runs(M)
    .map((r) => `<rect x="${r.x * s}" y="${r.y * s}" width="${r.w * s}" height="${s}" fill="${p.fg}"/>`)
    .join("");
  const gap = 20;
  const width = 64 + gap + COLS * s;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 64" width="${width}" height="64">` +
    `<g>${inner}</g>` +
    `<g transform="translate(${64 + gap} ${(64 - ROWS * s) / 2})">${word}</g></svg>`
  );
}

// A tab has no colour of its own, so the favicon carries a filled ground. The letter sits
// at 72% so it does not touch the corners at sixteen pixels.
const favicon =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" rx="14" fill="${INK}"/>` +
  `<g transform="translate(32 32) scale(0.72) translate(-32 -32) translate(-${BACK} -${BACK})">` +
  `<g transform="translate(${DEPTH} ${DEPTH})"><path fill-rule="evenodd" fill="${GREEN}" d="${D_PATH}"/></g>` +
  `<path fill-rule="evenodd" fill="${PAPER}" d="${D_PATH}"/></g></svg>`;

const files: Record<string, string> = {
  "logo-dark.svg": logo(DARK),
  "logo-light.svg": logo(LIGHT),
  "mark-dark.svg": mark(DARK),
  "mark-light.svg": mark(LIGHT),
  "favicon.svg": favicon,
};
for (const [name, body] of Object.entries(files)) writeFileSync(join(OUT, name), body);

// ---------------------------------------------------------------------------
// What the dashboard consumes
// ---------------------------------------------------------------------------

// The letter is currentColor and follows the text. Only the extrusion is coloured, and it
// carries two values because that page switches themes under it.
const component = `// GENERATED by brand/build.ts. Do not edit; rerun \`bun run brand/build.ts\`.
//
// A lowercase \`d\` whose square bowl doubles as a box. The letter is currentColor so it
// follows the text; the extrusion is the only coloured part, in two values because this
// page switches themes.
import { cn } from "@/lib/utils"

const D =
  "${D_PATH}"

export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("size-8 shrink-0", className)}
      role="img"
      aria-label="devbox"
    >
      <g transform="translate(-${BACK} -${BACK})">
        <g transform="translate(${DEPTH} ${DEPTH})">
          <path
            d={D}
            fillRule="evenodd"
            className="fill-[${LIGHT.accent}] dark:fill-[${DARK.accent}]"
          />
        </g>
        <path d={D} fillRule="evenodd" fill="currentColor" />
      </g>
    </svg>
  )
}

/** The word, drawn from a 5x7 grid: no font to ship, and no fallback to go wrong. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 ${COLS * 8} ${ROWS * 8}"
      className={cn("h-4 w-auto shrink-0", className)}
      fill="currentColor"
      aria-hidden
    >
${runs(M).map((r) => `      <rect x="${r.x * 8}" y="${r.y * 8}" width="${r.w * 8}" height="8" />`).join("\n")}
    </svg>
  )
}

/** Mark and word on one line, for the sign-in screen. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-3", className)}>
      <Mark className="size-10" />
      <Wordmark className="h-5" />
    </span>
  )
}
`;
writeFileSync(join(ROOT, "dashboard/web/src/components/logo.tsx"), component);

// The favicon is written INTO the index rather than left in a file to paste. A hand copy
// is what drifts, and a tab that disagrees with the page it opens reports to no one.
const indexPath = join(ROOT, "dashboard/web/index.html");
const index = readFileSync(indexPath, "utf8");
const uri = "data:image/svg+xml," + encodeURIComponent(favicon).replace(/%20/g, " ");
const HREF = /href="data:image\/svg\+xml,[^"]*"/;
// Absence, not sameness: an unchanged mark rewrites the identical string, and a check on
// the result would call that a missing tag on every second run.
if (!HREF.test(index)) throw new Error(`no favicon data: URI in ${indexPath}`);
writeFileSync(indexPath, index.replace(HREF, `href="${uri}"`));

console.log(`${Object.keys(files).length} svg, logo.tsx, and the favicon in index.html`);
