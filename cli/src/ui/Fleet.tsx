import { Box, Text } from "ink";
import { coreJson } from "../core.ts";
import { eur, eurPerDay, eurPerMonth } from "../format.ts";
import { remote } from "../settings.ts";
import type { Machine } from "../types.ts";
import { Failure, Hints, Loading, useAsync, useExitWhen } from "./common.tsx";
import { cloudColor, Table } from "./Table.tsx";

/**
 * `devbox ls` — every machine, and what they cost per hour.
 *
 * The running total is the point of this screen and not a garnish: the failure mode of a
 * tool that can start three machines is forgetting the third. It is the last thing drawn,
 * and it is the only number here that is bright.
 */
export function Fleet() {
  const where = remote();
  const state = useAsync(() => coreJson<Machine[]>(["ls"], 60_000));

  useExitWhen(state.status !== "loading", state.status === "failed" ? 1 : 0);

  if (state.status === "loading") {
    return <Loading label={where ? `asking ${where}` : "reading the state"} />;
  }
  if (state.status === "failed") return <Failure error={state.error} />;

  const machines = state.data;
  if (machines.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor> no machine</Text>
        <Hints lines={["devbox up            one, on the default cloud", "devbox probe         what is creatable right now"]} />
      </Box>
    );
  }

  const total = machines.reduce((sum, machine) => sum + (machine.hourly_eur ?? 0), 0);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Table
        rows={machines}
        columns={[
          { label: "NAME", value: (m) => m.name, color: () => "white" },
          { label: "CLOUD", value: (m) => m.cloud, color: (m) => cloudColor(m.cloud) },
          { label: "WHERE", value: (m) => m.region },
          { label: "SHAPE", value: (m) => m.instance_type },
          { label: "PROFILE", value: (m) => m.profile ?? "?" },
          { label: "EUR/H", value: (m) => eur(m.hourly_eur ?? 0), align: "right", color: () => "yellow" },
          // Dimmed, where the hour is not: the hour is what the machine is priced at and
          // the month is what it adds up to, and only one of the two can be the number the
          // eye lands on. Same reason the day is dim in the total below.
          {
            label: "EUR/MO",
            value: (m) => eurPerMonth(m.hourly_eur ?? 0),
            align: "right",
            color: () => "yellow",
            dim: () => true,
          },
          { label: "HOST", value: (m) => m.ip, dim: () => true },
        ]}
      />
      <Box marginTop={1}>
        <Text>
          {"  total "}
          <Text color="yellow" bold>
            {eur(total)} EUR/h
          </Text>
          {/* The day stays, and the month is added beside it. The day is what a machine
              left on over a weekend costs — the mistake this line was written for — and
              the month is what the same fleet costs if nobody ever thinks about it again.
              Neither answers the other's question. */}
          <Text dimColor>
            , or {eurPerDay(total)} EUR a day and {eurPerMonth(total)} EUR a month if they all keep
            running
          </Text>
        </Text>
      </Box>
      <Hints
        lines={[
          `ssh ${machines[0]?.name ?? "<name>"}      the session and every forward`,
          "devbox info [name]     the connection details, to type on a phone",
          where ? `fleet held by ${where}` : null,
        ]}
      />
    </Box>
  );
}
