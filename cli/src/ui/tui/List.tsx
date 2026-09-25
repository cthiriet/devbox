import { Box, Text } from "ink";
import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { pad, widths } from "../../format.ts";
import type { Column } from "../Table.tsx";

/**
 * A list you move through with the arrows.
 *
 * The selection lives here and the keys are handled by the screen above, which is the
 * split that matters: a screen owns `t` and `d` and everything else its rows can do, and
 * this component owns only "which row". Two components both calling `useInput` on the
 * same terminal would both receive every keystroke.
 *
 * It scrolls by keeping the cursor inside a window rather than by paging, so a long fleet
 * moves one line at a time and the row under the cursor never jumps across the screen.
 */
export function useSelection(count: number) {
  const [index, setIndex] = useState(0);
  // The same number, readable *now*.
  //
  // Two keystrokes can arrive in one read — see useKeys — and are then handled in one
  // callback, before React has re-rendered anything. A handler that read `index` for the
  // second of them would be reading where the cursor was before the first. Measured: `k`
  // then Enter, sent a second apart, opened the row the cursor had just left.
  const live = useRef(0);

  const clamp = (value: number) => (count === 0 ? 0 : ((value % count) + count) % count);
  const move = (by: number) => {
    const next = clamp(live.current + by);
    live.current = next;
    setIndex(next);
  };

  if (live.current !== clamp(live.current)) live.current = clamp(live.current);
  const safe = count === 0 ? 0 : Math.min(index, count - 1);

  return {
    /** For rendering. */
    index: safe,
    /** For handlers: where the cursor is at this instant, mid-chunk included. */
    at: () => clamp(live.current),
    // Wrapping, both ways. With four machines on the screen, "up" from the first meaning
    // "the last" is what everybody expects and costs one line to provide.
    up: () => move(-1),
    down: () => move(1),
  };
}

export function List<Row>({
  rows,
  index,
  height,
  render,
  empty,
}: {
  rows: Row[];
  index: number;
  /** How many rows fit. The window slides to keep the cursor inside it. */
  height: number;
  render: (row: Row, selected: boolean) => ReactNode;
  empty?: ReactNode;
}) {
  if (rows.length === 0) {
    return <Box>{empty ?? <Text dimColor>nothing here</Text>}</Box>;
  }

  const window = Math.max(1, height);
  const first = Math.max(0, Math.min(index - Math.floor(window / 2), rows.length - window));
  const shown = rows.slice(first, first + window);

  return (
    <Box flexDirection="column">
      {first > 0 ? <Text dimColor>{`  ↑ ${first} more`}</Text> : null}
      {shown.map((row, offset) => (
        <Box key={first + offset}>{render(row, first + offset === index)}</Box>
      ))}
      {first + window < rows.length ? (
        <Text dimColor>{`  ↓ ${rows.length - first - window} more`}</Text>
      ) : null}
    </Box>
  );
}

/**
 * A column header, in the gutter the cursor occupies on every row below it.
 *
 * Worth the line it costs for one reason: `2c/4G/80G` and ` 4c   8G   80G` are three
 * numbers and two identical units, and nothing in the row itself says which G is memory
 * and which is disk. devbox-core's own tables print a header for exactly that reason — this
 * is the same header, in the same order, so the window and the terminal read alike.
 */
export function Head({ children }: { children: ReactNode }) {
  return (
    <Text dimColor wrap="truncate-end">
      {"  "}
      {children}
    </Text>
  );
}

/** The cursor column, so every list in the app marks its selection the same way. */
export function Cursor({ selected }: { selected: boolean }) {
  return (
    <Text color={selected ? "cyan" : undefined} bold={selected}>
      {selected ? "▸ " : "  "}
    </Text>
  );
}

/**
 * The widths of a list's columns, read off the rows it is about to draw.
 *
 * `padEnd(12)` was the shape of every list in this window until 30/08, and a profile named
 * in thirteen characters is one too many: on the one screen where the secrets are what you
 * came to read, the profile name ran into them and a two-word secret list ran straight into
 * the floors. A constant cannot be right about a name nobody has typed yet — the same lesson
 * ui/Table.tsx already learned, and this is the same `widths` it learned it with.
 *
 * The HEADER is built here too, from the same specs as the cells, and that is the point
 * rather than a convenience: Table.tsx names the fault it was written against — a format
 * string repeated twice, once for the header and once per row, which drifted the day a
 * column was added. Two hand-padded lists in one component are that fault waiting.
 *
 * The gutter is APPENDED and never folded into the width, which is the whole difference on
 * a right-aligned column: `pad` fills on the left there, so a width carrying its own gutter
 * puts that space before the number and none after it. Measured on the offers list, where
 * EUR/MO and CLOUD are exactly those two — the header read `EUR/MOCLOUD` and every row read
 * `14,74scaleway`.
 *
 * The last column gets neither padding nor gutter. Nothing follows it, and trailing spaces
 * are width a `truncate-end` row would rather spend on the text — which on these screens is
 * a repository URL or an address, the things worth reading to the end.
 */
export function columnsOf<Row>(columns: Column<Row>[], rows: Row[], gutter = 2) {
  const sizes = widths(columns, rows);
  const last = columns.length - 1;
  const gap = " ".repeat(gutter);
  const laid = (text: string, index: number, align?: "left" | "right") =>
    index === last ? text : pad(text, sizes[index] ?? 0, align) + gap;

  return {
    /** The header line, laid out over the columns below it. */
    head: columns.map((column, index) => laid(column.label, index, column.align)).join(""),
    /** One cell, in its column. */
    cell: (index: number, row: Row) => {
      const column = columns[index];
      return column === undefined ? "" : laid(column.value(row), index, column.align);
    },
    /** For a cell drawn as something other than one string — see Pickers.tsx#Floors. */
    width: (index: number) => (index === last ? 0 : (sizes[index] ?? 0) + gutter),
  };
}
