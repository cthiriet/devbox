import { Box, Text } from "ink";
import { remote } from "../../settings.ts";
import { Frame } from "./Frame.tsx";
import { useKeys } from "./keys.ts";
import { Cursor, List, useSelection } from "./List.tsx";
import type { Intent } from "./window.tsx";

/**
 * `devbox` with nothing after it.
 *
 * Four entries, and no two of them are a way to do the same thing. `offers` and `profiles`
 * used to sit here as screens of their own, and both could ORDER — which made the menu a
 * place where the same verb was reachable three times, each time with a different half of
 * the decision left implicit. They are now the two steps of `up` and nothing else. Reading
 * the market or the profile directory without ordering anything is still one command away,
 * `devbox probe` and `devbox profiles`, where a list you only want to read belongs.
 *
 * Two of these open a screen and two start a command. The split is not about how long they
 * take but about what they produce: a list is worth navigating, and an `up` is worth a
 * scrollback.
 */
type Entry = { label: string; gloss: string; intent: Intent };

const ENTRIES: Entry[] = [
  {
    label: "machines",
    gloss: "the fleet, its forwards, and what it costs",
    intent: { do: "go", to: { view: "machines" } },
  },
  {
    label: "up",
    gloss: "order a machine: the profile, then the cheapest shape above its floors",
    intent: { do: "go", to: { view: "profile" } },
  },
  {
    label: "orphans",
    gloss: "what the providers run that no state knows about",
    intent: { do: "go", to: { view: "orphans" } },
  },
  {
    label: "sync",
    gloss: "reconcile ~/.ssh/config with the dashboard's fleet",
    intent: { do: "launch", argv: ["sync"] },
  },
];

export function Menu({ done, failure }: { done: (intent: Intent) => void; failure?: string }) {
  const selection = useSelection(ENTRIES.length);
  const where = remote();

  useKeys((press) => {
    if (press.name === "up") return selection.up();
    if (press.name === "down") return selection.down();
    if (press.name === "quit" || press.name === "escape") return done({ do: "quit" });
    if (press.name === "enter" || press.name === "right") {
      const entry = ENTRIES[selection.at()];
      if (entry) done(entry.intent);
      return;
    }
    if (press.name !== "char") return;
    if (press.ch === "k") return selection.up();
    if (press.ch === "j") return selection.down();
    if (press.ch === "q") return done({ do: "quit" });
  });

  return (
    <Frame
      title="devbox"
      right={
        where ? (
          <Text dimColor>
            executor <Text color="yellow">{where}</Text>
          </Text>
        ) : (
          <Text dimColor>executor this machine</Text>
        )
      }
      keys={[
        { key: "↑↓", does: "move" },
        { key: "⏎", does: "open" },
        { key: "q", does: "quit" },
      ]}
    >
      <List
        rows={ENTRIES}
        index={selection.index}
        height={ENTRIES.length}
        render={(entry, selected) => (
          <Text wrap="truncate-end">
            <Cursor selected={selected} />
            <Text bold={selected} color={selected ? "cyan" : undefined}>
              {entry.label.padEnd(11)}
            </Text>
            <Text dimColor>{entry.gloss}</Text>
          </Text>
        )}
      />

      {/* A screen that could not be read says so here rather than replacing the menu: the
          fleet being unreachable is no reason to lose the way to `probe`. */}
      {failure ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="red" wrap="truncate-end">
            ✗ {failure.split("\n")[0]}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Every verb still works typed out: devbox probe, devbox up --cloud gcp, devbox info.</Text>
        <Text dimColor>This window is the same commands, and the same --json underneath.</Text>
      </Box>
    </Frame>
  );
}
