import { Box, Text, useWindowSize } from "ink";
import type { ReactNode } from "react";

/**
 * The window: a title, a body between two rules, and the keys that work in it.
 *
 * The key bar is not decoration and is never hidden. A full-screen program that does not
 * say what its keys are has to be learned before it can be used, and this one is opened
 * once a day at most — the bar is what makes `t` discoverable without a manual.
 *
 * **There is no `borderStyle` here, and that is a finding rather than a taste.** Measured
 * against ink 7.1.1: a Box carrying `borderStyle` together with either `flexGrow` or an
 * imposed height silently stops every `useInput` in the tree from ever firing. Rendering
 * carries on — a ticking counter keeps ticking — so the window draws perfectly and answers
 * no key, which is close to the worst way a bug can present itself. A bordered box that
 * sizes itself to its content is fine; a full-height pane is exactly what this has to be.
 * Rules cost two rows and always work.
 */
export type Key = { key: string; does: string };

export function Frame({
  title,
  right,
  keys,
  children,
  color = "cyan",
}: {
  title: string;
  right?: ReactNode;
  keys: Key[];
  children: ReactNode;
  color?: string;
}) {
  const { rows, columns } = useWindowSize();

  // The rows the frame itself spends: the title, the key bar, and the line the shell
  // prompt comes back to. The body takes the rest, so the bar sits at the bottom rather
  // than wherever the content happened to end.
  //
  // The bar is MEASURED rather than assumed to be one line. `machines` carries eight
  // actions, which is longer than eighty columns, and `truncate-end` quietly ate the end
  // of it — the reader saw `r ag…` and no `esc back` at all, which is the one key someone
  // stuck in a screen needs. So it wraps, and the body gives up exactly the rows it takes.
  const bar = keys.map((entry) => `${entry.key} ${entry.does}`).join("   ");
  // Spaces INSIDE one action are non-breaking, so a bar that wraps breaks between two
  // actions and never inside one: `r` alone at the end of a line with `read again` under
  // it is a key nobody can read, and the wrap is exactly where that would happen.
  const glue = (text: string) => text.replace(/ /g, "\u00A0");
  const barRows = Math.max(1, Math.ceil(bar.length / Math.max(1, columns - 2)));
  const body = Math.max(3, rows - 2 - barRows);
  const rule = "-".repeat(Math.max(1, columns - 2));

  return (
    <Box flexDirection="column" width={columns}>
      <Box paddingX={1}>
        <Text bold color={color}>
          {title}
        </Text>
        <Box flexGrow={1} />
        {right}
      </Box>

      <Box height={body} flexDirection="column" paddingX={1} overflow="hidden">
        <Text dimColor>{rule}</Text>
        {children}
      </Box>

      <Box paddingX={1}>
        <Text>
          {keys.map((entry, index) => (
            <Text key={entry.key}>
              {index > 0 ? <Text dimColor>{"   "}</Text> : null}
              <Text color={color} bold>
                {entry.key}
              </Text>
              <Text dimColor>{"\u00A0"}{glue(entry.does)}</Text>
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  );
}
