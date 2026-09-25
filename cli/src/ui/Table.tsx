import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { pad, widths } from "../format.ts";

/**
 * A column: what to print, how wide it may be, and what colour it takes.
 *
 * `value` is the string the width is measured from, and `color` is applied to that same
 * string. Splitting them would let a column be coloured by something it does not show,
 * which is how a table starts lying.
 */
export type Column<Row> = {
  label: string;
  value: (row: Row) => string;
  align?: "left" | "right";
  color?: (row: Row) => string | undefined;
  dim?: (row: Row) => boolean;
};

/**
 * The tables, in one component.
 *
 * devbox-core prints five of them and each one repeats its own `printf` format string twice,
 * once for the header and once per row — the pair that drifted on 20/08 when a column was
 * added to `ls` and the header kept the old width. Here a column is declared once.
 *
 * Widths come from the content (see `widths`), so a fourteen-character machine name widens
 * its column instead of pushing the rest of the row out of alignment.
 */
export function Table<Row>({
  columns,
  rows,
  indent = 2,
  gutter = 2,
}: {
  columns: Column<Row>[];
  rows: Row[];
  indent?: number;
  gutter?: number;
}): ReactNode {
  const sizes = widths(columns, rows);
  const gap = " ".repeat(gutter);
  const left = " ".repeat(indent);

  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {left}
        {columns
          .map((column, index) => pad(column.label, sizes[index] ?? 0, column.align))
          .join(gap)
          .trimEnd()}
      </Text>
      {/* Truncated rather than wrapped when the terminal is narrower than the table.
          Alignment is the only reason a table exists, and a wrapped row destroys it for
          every row below as well as its own. What is cut is always still there in
          `--json`, which is the interface this screen was rendered from. */}
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex} wrap="truncate-end">
          {left}
          {columns.map((column, index) => (
            <Text
              key={column.label}
              color={column.color?.(row)}
              dimColor={column.dim?.(row) ?? false}
            >
              {pad(column.value(row), sizes[index] ?? 0, column.align)}
              {index < columns.length - 1 ? gap : ""}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

/** Hetzner red, Scaleway violet, GCP blue — so three clouds in one list are scannable. */
export function cloudColor(cloud: string): string | undefined {
  if (cloud === "hetzner") return "red";
  if (cloud === "scaleway") return "magenta";
  if (cloud === "gcp") return "blue";
  return undefined;
}
