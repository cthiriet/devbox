import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Parsed } from "../args.ts";
import { coreJson } from "../core.ts";
import { eur, eurPerMonth } from "../format.ts";
import type { MachineDetail } from "../types.ts";
import { Failure, Loading, useAsync, useExitWhen } from "./common.tsx";
import { cloudColor } from "./Table.tsx";

/**
 * `devbox info` — the connection details, written to be typed on a phone.
 *
 * Termius on iOS has no desktop and no cloud sync, so ~/.ssh/config is never imported:
 * these are the fields, named as the app names them, in the order it asks for them. That
 * ordering is the whole design of this screen and it is preserved exactly — the boxes are
 * new, the sequence is not.
 *
 * The fingerprint costs an ssh-keyscan against a live host, which is why this screen can
 * take a few seconds where the others are instant.
 */
export function Info({ parsed }: { parsed: Parsed }) {
  const state = useAsync(() => coreJson<MachineDetail>(["info", ...parsed.rest], 40_000));

  useExitWhen(state.status !== "loading", state.status === "failed" ? 1 : 0);

  if (state.status === "loading") return <Loading label="reading the machine, and its host key" />;
  if (state.status === "failed") return <Failure error={state.error} />;

  const machine = state.data;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {"  "}
        <Text bold color="white">
          {machine.name}
        </Text>
        <Text dimColor> — </Text>
        <Text color={cloudColor(machine.cloud)}>{machine.cloud}</Text>
        <Text dimColor>
          {" / "}
          {machine.region} / {machine.instance_type} —{" "}
        </Text>
        <Text color="yellow">{eur(machine.hourly_eur)} €/h</Text>
        {/* `, 0,00 €/mo` is devbox-core's own punctuation on this line (cmd_info prints the
            same header), and only when there is an hour to multiply: `hourly_eur` is null
            when no API priced the shape, `eur` prints an em dash for it, and a month
            beside that dash would be the one number on this screen that is invented. */}
        {typeof machine.hourly_eur === "number" ? (
          <Text color="yellow" dimColor>
            , {eurPerMonth(machine.hourly_eur)} €/mo
          </Text>
        ) : null}
      </Text>

      <Section title="Termius > Hosts > +">
        <Field label="Address" value={machine.ip} highlight />
        <Field label="Port" value={String(machine.port ?? 22)} highlight />
        <Field label="Username" value={machine.user} highlight />
        <Field label="Key" value="devbox" note="(the one already in your keychain)" />
        <Field
          label="Fingerprint"
          value={machine.fingerprint ?? "—"}
          below="(compare with what Termius shows on first connect)"
        />
      </Section>

      <Section title="Termius > this host > Port forwarding > + > Local">
        <Field label="Local" value={String(machine.local_port)} highlight />
        <Field label="Dest host" value="localhost" />
        {/* Read from the profile, never assumed: this line printed a hardcoded 9010 until
            20/08, handing a wrong forward to every profile not serving on that port. */}
        <Field label="Dest port" value={String(machine.app_port)} highlight />
        <Text dimColor>
          {"      then http://localhost:"}
          {machine.local_port} in Safari
        </Text>
        {machine.note ? <Text dimColor>{`      ${machine.note}`}</Text> : null}
        {/* The profile's other ports, one Termius rule each, on the local ports the block
            gave them: the first forward is the app's, drawn above. */}
        {(machine.forwards ?? []).slice(1).length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{"    and one more rule per port:"}</Text>
            {(machine.forwards ?? []).slice(1).map((forward) => (
              <Field
                key={forward.local}
                label="Local"
                value={`${forward.local} → localhost:${forward.remote}`}
                highlight
              />
            ))}
          </Box>
        ) : null}
      </Section>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>
          {"    kubectl, if you want it: "}
          {machine.kube_port} → localhost:6443
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{"  From the Mac, the block is already in ~/.ssh/config:"}</Text>
        <Text>
          <Text dimColor>{"    "}</Text>
          <Text color="cyan">ssh {machine.name}</Text>
          <Text dimColor>{"          the session and every forward"}</Text>
        </Text>
        <Text>
          <Text dimColor>{"    "}</Text>
          <Text color="cyan">ssh -fN {machine.name}</Text>
          <Text dimColor>{"      the forwards alone, backgrounded"}</Text>
        </Text>
      </Box>
    </Box>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        {"  "}
        {title}
      </Text>
      {children}
    </Box>
  );
}

/**
 * One field, at the width Termius asks for it.
 *
 * `highlight` marks the values that are actually typed into the app. The rest — the key
 * name, the fingerprint to compare — are read, not typed, and are dimmed so the eye goes
 * straight to the four things that have to be copied correctly.
 */
function Field({
  label,
  value,
  note,
  below,
  highlight = false,
}: {
  label: string;
  value: string;
  note?: string;
  /** A note too long to sit beside a 64-character fingerprint. Goes under it, aligned. */
  below?: string;
  highlight?: boolean;
}) {
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {"    "}
        <Text dimColor>{label.padEnd(12)}</Text>
        <Text color={highlight ? "cyan" : undefined} bold={highlight}>
          {value}
        </Text>
        {note ? <Text dimColor> {note}</Text> : null}
      </Text>
      {below ? <Text dimColor>{`                ${below}`}</Text> : null}
    </Box>
  );
}
