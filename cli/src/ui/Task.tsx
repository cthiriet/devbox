import { Box, Text } from "ink";
import { useState } from "react";
import { has, type Parsed } from "../args.ts";
import { coreJson } from "../core.ts";
import { envName, missing, store } from "../secrets.ts";
import { INTERACTIVE } from "../settings.ts";
import type { Machine } from "../types.ts";
import { AskSecret } from "./AskSecret.tsx";
import { Confirm } from "./Confirm.tsx";
import { Failure, Loading, useAsync, useExitWhen } from "./common.tsx";
import { Run } from "./Run.tsx";

/**
 * Everything that has to be settled before devbox-core is spawned, and then the run itself.
 *
 * Two gates, in this order, and the order matters: the tokens first, because a `seed` that
 * discovers a missing secret three minutes in has wasted three minutes; the confirmation
 * second, because there is no point confirming a destruction that was going to fail on a
 * credential anyway.
 *
 * Both gates need a keyboard, and this component may well not have one — the shim
 * guarantees a terminal on stdout and says nothing about stdin. A gate that cannot be
 * answered is therefore refused rather than waited on: `devbox down < /dev/null` prints the
 * flag that would have worked and leaves, instead of hanging on a question nobody will
 * ever see.
 *
 * Once both gates are behind us the core takes over and this component stops deciding.
 */
export function Task({ parsed }: { parsed: Parsed }) {
  // `--yes` is this layer's flag and the core has never heard of it. Left in, it would
  // reach `cmd_down` as the name of the machine to destroy.
  const argv = [
    parsed.command,
    ...parsed.rest.filter((token) => token !== "--yes" && token !== "-y"),
  ];
  const [answered, setAnswered] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [aborted, setAborted] = useState(false);
  const [finished, setFinished] = useState<number | null>(null);

  const plan = useAsync(async () => ({
    wanted: await missing(parsed),
    target: parsed.command === "down" ? await resolveTarget(parsed) : null,
  }));

  const ready = plan.status === "ready" ? plan.data : null;
  const wanted = ready?.wanted ?? [];
  const target = ready?.target ?? null;

  const asking = ready !== null && answered < wanted.length;
  // The target is null when the core is going to refuse anyway — no machine, or several
  // and no name given. Asking "destroy which one?" before the core says "I will not
  // guess" would be one question too many.
  const confirming =
    ready !== null &&
    !asking &&
    !confirmed &&
    parsed.command === "down" &&
    target !== null &&
    !has(parsed, "--yes", "-y");

  const refused = (asking || confirming) && !INTERACTIVE;

  useExitWhen(
    finished !== null || aborted || refused || plan.status === "failed",
    finished ?? (aborted || refused || plan.status === "failed" ? 1 : 0),
  );

  if (plan.status === "loading") return <Loading label="reading what this will need" />;
  if (plan.status === "failed") return <Failure error={plan.error} />;

  if (aborted) {
    return (
      <Box marginTop={1}>
        <Text dimColor>{"  nothing done"}</Text>
      </Box>
    );
  }

  if (refused && asking) {
    const name = wanted[answered] ?? "";
    return (
      <Refusal
        why={`the secret '${name}' is not on this machine, and there is no terminal to ask on`}
        instead={`${envName(name)}=… devbox ${argv.join(" ")}`}
      />
    );
  }

  if (refused && confirming) {
    return (
      <Refusal
        why="down destroys a machine and there is no terminal to confirm on"
        instead={`devbox down ${target?.name ?? ""} --yes`}
      />
    );
  }

  if (asking) {
    const name = wanted[answered] ?? "";
    return (
      <AskSecret
        key={name}
        name={name}
        onAnswer={(value) => {
          store(name, value);
          setAnswered((n) => n + 1);
        }}
        onCancel={() => setAborted(true)}
      />
    );
  }

  if (confirming && target) {
    return (
      <Confirm
        machine={target}
        onAnswer={(yes) => (yes ? setConfirmed(true) : setAborted(true))}
      />
    );
  }

  return <Run argv={argv} onFinished={setFinished} />;
}

function Refusal({ why, instead }: { why: string; instead: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="red">{`  ✗ ${why}`}</Text>
      <Text dimColor>{`      ${instead}`}</Text>
    </Box>
  );
}

/**
 * Which machine `down` is about to destroy, resolved the way devbox-core resolves it.
 *
 * With one machine there is nothing to disambiguate; with several the core refuses rather
 * than guess, and so does this — returning null, which skips the confirmation and lets the
 * core print its own refusal.
 */
async function resolveTarget(parsed: Parsed): Promise<Machine | null> {
  const wanted = parsed.positionals[0];
  try {
    const machines = await coreJson<Machine[]>(["ls"], 60_000);
    if (wanted) return machines.find((machine) => machine.name === wanted) ?? null;
    return machines.length === 1 ? (machines[0] ?? null) : null;
  } catch {
    return null;
  }
}
