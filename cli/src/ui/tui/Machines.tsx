import { Box, Text } from "ink";
import { useState } from "react";
import { eur, eurPerDay } from "../../format.ts";
import { openInBrowser } from "../../local.ts";
import type { Machine } from "../../types.ts";
import { cloudColor } from "../Table.tsx";
import type { Column } from "../Table.tsx";
import { Frame } from "./Frame.tsx";
import { useKeys } from "./keys.ts";
import { Cursor, Head, List, columnsOf, useSelection } from "./List.tsx";
import type { Intent } from "./window.tsx";

/**
 * What a running machine shows. The price is last because it is the one that grows a digit.
 */
const MACHINE_COLUMNS: Column<Machine>[] = [
  { label: "MACHINE", value: (machine) => machine.name },
  { label: "CLOUD", value: (machine) => machine.cloud },
  { label: "WHERE", value: (machine) => machine.region },
  { label: "SHAPE", value: (machine) => machine.instance_type },
  { label: "PROFILE", value: (machine) => machine.profile ?? "?" },
  { label: "EUR/H", value: (machine) => eur(machine.hourly_eur ?? 0) },
];

/**
 * The fleet, and what can be done to the machine under the cursor.
 *
 * The screen holds no state but the cursor and the confirmation. Everything it asks for
 * goes back to the window as an intent — see window.tsx for why nothing may be fetched or
 * run from inside a screen that is holding the keyboard.
 *
 * The division of the keys is worth stating: `t` and `c` are carried out between mounts
 * and the window comes back; `⏎`, `s`, `d` and `i` LEAVE the window for the ordinary
 * terminal, because their output is minutes long — or, for the session `⏎` opens, is the
 * whole point — and belongs in a scrollback.
 */
export function Machines({
  machines,
  open,
  done,
}: {
  machines: Machine[];
  open: Record<string, boolean>;
  done: (intent: Intent) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const selection = useSelection(machines.length);
  const current = machines[selection.index] ?? null;
  const columns = columnsOf(MACHINE_COLUMNS, machines);

  useKeys((press) => {
    // The confirmation takes every key: `y` destroys, anything at all cancels. A question
    // about destroying a machine is not a place for a key that does nothing.
    if (confirming) {
      const doomed = machines[selection.at()];
      if (press.name === "char" && press.ch === "y" && doomed) {
        done({ do: "launch", argv: ["down", doomed.name, "--yes"] });
      } else {
        setConfirming(false);
      }
      return;
    }

    if (press.name === "up") return selection.up();
    if (press.name === "down") return selection.down();
    if (press.name === "escape" || press.name === "left") return done({ do: "go", to: { view: "menu" } });
    if (press.name === "quit") return done({ do: "quit" });
    // Enter is the machine itself. It leaves the window rather than running a session
    // inside it: the alternate screen has no scrollback, and an agent's afternoon of
    // output would vanish with the frame the moment the session ended.
    if (press.name === "enter" || press.name === "right") {
      const into = machines[selection.at()];
      if (into) done({ do: "launch", argv: ["ssh", into.name] });
      return;
    }
    if (press.name !== "char") return;

    if (press.ch === "k") return selection.up();
    if (press.ch === "j") return selection.down();
    if (press.ch === "q") return done({ do: "quit" });
    if (press.ch === "r") return done({ do: "reload" });

    const on = machines[selection.at()];
    if (!on) return;
    if (press.ch === "t") return done({ do: "core", argv: ["tunnel", on.name] });
    if (press.ch === "c") return done({ do: "core", argv: ["tunnel", on.name, "--close"] });
    if (press.ch === "o") return openInBrowser(`http://localhost:${on.local_port}`);
    if (press.ch === "i") return done({ do: "launch", argv: ["info", on.name] });
    if (press.ch === "s") return done({ do: "launch", argv: ["seed", on.name] });
    if (press.ch === "d") return setConfirming(true);
  });

  const total = machines.reduce((sum, machine) => sum + (machine.hourly_eur ?? 0), 0);

  return (
    <Frame
      title="machines"
      right={
        machines.length > 0 ? (
          <Text>
            <Text color="yellow" bold>
              {eur(total)} EUR/h
            </Text>
            <Text dimColor> · {eurPerDay(total)} a day</Text>
          </Text>
        ) : undefined
      }
      keys={
        confirming
          ? [
              { key: "y", does: "destroy it" },
              { key: "any other key", does: "cancel" },
            ]
          : [
              { key: "↑↓", does: "move" },
              { key: "⏎", does: "ssh in" },
              { key: "t/c", does: "tunnel" },
              { key: "o", does: "browser" },
              { key: "i", does: "info" },
              { key: "s", does: "seed" },
              { key: "d", does: "down" },
              { key: "r", does: "refresh" },
              { key: "esc", does: "back" },
            ]
      }
    >
      {/* The two extra spaces are the open/closed dot the rows carry and the header does
          not: a lamp is not a column, and giving it a label would name a thing the legend
          in Detail already explains. */}
      <Head>
        {"  "}
        {columns.head}
      </Head>
      <List
        rows={machines}
        index={selection.index}
        height={Math.max(3, machines.length)}
        empty={<Text dimColor>no machine — esc, then `up`</Text>}
        render={(machine, selected) => (
          <Text wrap="truncate-end">
            <Cursor selected={selected} />
            <Text color={open[machine.name] ? "green" : undefined} dimColor={!open[machine.name]}>
              {open[machine.name] ? "●" : "○"}
            </Text>
            <Text bold={selected}> {columns.cell(0, machine)}</Text>
            <Text color={cloudColor(machine.cloud)}>{columns.cell(1, machine)}</Text>
            <Text dimColor>{columns.cell(2, machine)}</Text>
            <Text dimColor>{columns.cell(3, machine)}</Text>
            <Text dimColor>{columns.cell(4, machine)}</Text>
            <Text color="yellow">{columns.cell(5, machine)}</Text>
          </Text>
        )}
      />

      {current ? <Detail machine={current} open={open[current.name] ?? false} /> : null}

      {confirming && current ? (
        <Box marginTop={1}>
          <Text color="red">destroy {current.name}? everything uncommitted on it goes with it.</Text>
        </Box>
      ) : null}
    </Frame>
  );
}

/**
 * The selected machine, in the fields you would type somewhere else.
 *
 * Address, port and user are what Termius asks for; the forward is what the browser wants.
 * All four are already in `ls --json`, so this pane costs nothing — the fingerprint is the
 * only thing `info` adds, and it is one keystroke away.
 */
function Detail({ machine, open }: { machine: Machine; open: boolean }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text dimColor>{"ssh        "}</Text>
        <Text color="cyan">
          {machine.user}@{machine.ip}
        </Text>
        <Text dimColor> port {machine.port ?? 22}</Text>
        <Text dimColor>{"   or simply "}</Text>
        <Text color="cyan">ssh {machine.name}</Text>
      </Text>
      <Text>
        <Text dimColor>{"forward    "}</Text>
        <Text color={open ? "green" : undefined} dimColor={!open}>
          localhost:{machine.local_port}
        </Text>
        <Text dimColor>
          {" → "}
          {machine.app_port} inside
          {open ? "   open — o for the browser" : "   closed — t to open it"}
        </Text>
      </Text>
    </Box>
  );
}
