import { Box, Text, useInput } from "ink";
import { eur, eurPerDay } from "../format.ts";
import { INTERACTIVE } from "../settings.ts";
import type { Machine } from "../types.ts";
import { cloudColor } from "./Table.tsx";

/**
 * The one question this tool has ever needed to ask.
 *
 * `down` is the only command here that destroys work, and devbox-core asks nothing before
 * running it: it resolves a name, applies `terraform destroy -auto-approve`, and the
 * machine is gone with whatever was uncommitted on it. That was defensible while the
 * verb was typed at a keyboard with the fleet on the screen above it. It is not
 * defensible now that `devbox ls` can list three machines on three clouds and the names are
 * five random characters apart.
 *
 * So the confirmation lives here rather than in the core, and deliberately: the core is
 * also what the dashboard runs from a systemd unit, where there is nobody to answer. The
 * screen asks, the executor does not.
 *
 * `--yes` skips it, and so does a stdin that is not a terminal.
 */
export function Confirm({
  machine,
  onAnswer,
}: {
  machine: Machine;
  onAnswer: (yes: boolean) => void;
}) {
  useInput(
    (input, key) => {
      if (key.return || key.escape) {
        onAnswer(false);
        return;
      }
      if (input.toLowerCase() === "y") onAnswer(true);
      if (input.toLowerCase() === "n" || (key.ctrl && input === "c")) onAnswer(false);
    },
    { isActive: INTERACTIVE },
  );

  const hourly = machine.hourly_eur ?? 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {"  destroy "}
        <Text bold color="white">
          {machine.name}
        </Text>
        <Text dimColor> — </Text>
        <Text color={cloudColor(machine.cloud)}>{machine.cloud}</Text>
        <Text dimColor>
          {" / "}
          {machine.region} / {machine.instance_type} / {machine.profile ?? "?"}
        </Text>
      </Text>
      <Text dimColor>
        {"  it holds "}
        {machine.ip}
        {" and costs "}
        {eur(hourly)} EUR/h, {eurPerDay(hourly)} EUR a day
      </Text>
      <Box marginTop={1}>
        <Text>
          <Text color="red">{"  everything uncommitted on it goes with it. "}</Text>
          <Text bold>y</Text>
          <Text dimColor>/N </Text>
        </Text>
      </Box>
    </Box>
  );
}
