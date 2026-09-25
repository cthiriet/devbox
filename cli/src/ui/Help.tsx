import { Box, Text } from "ink";
import { CONFIG_DIR, remote } from "../settings.ts";
import { useExitWhen } from "./common.tsx";

/**
 * `devbox` with nothing after it.
 *
 * devbox-core answers this by printing its own leading comment block — sixty lines that
 * explain why the two phases exist, why there is no fallback to the local state, what a
 * profile is. That essay is the right thing to have and the wrong thing to meet first, so
 * it stays exactly one command away: `devbox help --full`.
 *
 * What is here instead is the shape of the tool: ten verbs, one line each, and the two
 * facts a reader needs before typing any of them — whether this workstation is pointed at
 * a dashboard, and that `--json` is an interface rather than a screen.
 */
const VERBS: [string, string][] = [
  ["up", "order a machine, provision it, build the stack (~5 min)"],
  ["seed [name]", "phase 2 alone: re-runnable, and how you rotate a token"],
  ["info [name]", "the connection details, written to be typed on a phone"],
  ["ls", "every machine, and what they cost per hour"],
  ["profiles", "what a machine can be made into, and what each needs"],
  ["probe", "what each cloud can create right now, cheapest first"],
  ["orphans", "what the providers run that no state knows about"],
  ["ssh [name]", "the session itself, through the Host block"],
  ["tunnel [name]", "the forwards, without a session"],
  ["sync", "reconcile ~/.ssh/config with the dashboard's fleet"],
  ["down [name]", "destroy it, and stop the meter"],
];

const FLAGS: [string, string][] = [
  ["--cloud X", "hetzner, scaleway or gcp — `up` and `probe`"],
  ["--name N", "several machines coexist; the name is optional everywhere"],
  ["--profile P", "what the machine becomes. `devbox profiles` lists them"],
  ["--min-cpu/--min-ram/--min-disk", "floors, not targets: the cheapest offer above them"],
  ["--json", "the interface. ls, info, profiles, probe, orphans"],
];

export function Help() {
  const where = remote();
  useExitWhen(true, 0);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {"  "}
        <Text bold color="white">
          devbox
        </Text>
        <Text dimColor> — one cloud VM per working session, joined over SSH.</Text>
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {VERBS.map(([verb, gloss]) => (
          <Text key={verb}>
            {"  "}
            <Text color="cyan">{verb.padEnd(15)}</Text>
            <Text dimColor>{gloss}</Text>
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {FLAGS.map(([flag, gloss]) => (
          <Text key={flag}>
            {"  "}
            <Text>{flag.padEnd(31)}</Text>
            <Text dimColor>{gloss}</Text>
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {where ? (
          <>
            <Text>
              <Text dimColor>{"  executor: "}</Text>
              <Text color="yellow">{where}</Text>
            </Text>
            <Text dimColor>
              {"            it orders, it holds the state, it keeps the secrets."}
            </Text>
            <Text dimColor>{"            DEVBOX_REMOTE= devbox ls    the local state, knowingly"}</Text>
          </>
        ) : (
          <>
            <Text dimColor>{"  executor: this machine, against the local Terraform state."}</Text>
            <Text dimColor>
              {`            DEVBOX_REMOTE=… in ${CONFIG_DIR}/.env points it at a dashboard`}
            </Text>
          </>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{"  devbox                 the window: the fleet, an ordered machine, the keys"}</Text>
        <Text dimColor>{"  devbox help --full     why any of this is the way it is"}</Text>
        <Text dimColor>{"  DEVBOX_PLAIN=1 devbox …   the same command, without this rendering"}</Text>
      </Box>
    </Box>
  );
}
