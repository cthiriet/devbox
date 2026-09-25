import { Box, Static, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { claimNotice, coreStream, type CoreLine } from "../core.ts";
import { duration } from "../format.ts";
import { INTERACTIVE } from "../settings.ts";
import { Elapsed, Spinner } from "./Spinner.tsx";

/**
 * The verbs that do something, watched while they do it.
 *
 * devbox-core already narrates itself: `log` writes `==> ` and one sentence for every phase
 * it enters. That is the entire protocol this screen reads. No list of expected phases is
 * kept here — a step is whatever the core said it was about to do, so a phase added to the
 * core appears here the day it is added and can never fall out of sync with a table of
 * labels written on this side.
 *
 * What the screen adds is the axis the core cannot show: elapsed time per phase. `up`
 * spends three to six minutes in one of them, and a number that keeps moving is the
 * difference between "cloud-init is slow" and "this has hung".
 */

/** A finished phase, a warning, or the closing summary — the things worth keeping. */
type Record =
  | { kind: "step"; label: string; seconds: number; ok: boolean }
  | { kind: "warn"; text: string };

type Status = "running" | "succeeded" | "failed" | "interrupted";

/** How much raw output stays on screen while a phase runs. */
const TAIL = 8;
/** How much of it is kept, and shown, when the thing fails. */
const TAIL_ON_FAILURE = 60;

export function Run({
  argv,
  onFinished,
}: {
  argv: string[];
  onFinished?: (code: number) => void;
}) {
  const [records, setRecords] = useState<Record[]>([]);
  const [current, setCurrent] = useState<{ label: string; since: number } | null>(null);
  const [tail, setTail] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("running");
  const [code, setCode] = useState(0);

  // Everything since the last `==>`, kept whole. On the way out it is the closing summary
  // the core prints — the Termius card after a seed, the two URLs after a tunnel — and
  // that is reproduced verbatim rather than re-rendered here: it is written to be typed on
  // a phone and this layer has no business rewording it.
  const openStep = useRef<{ label: string; since: number } | null>(null);
  const sinceStep = useRef<string[]>([]);
  const history = useRef<string[]>([]);
  const started = useRef(Date.now());
  const stepStarted = useRef(Date.now());
  const kill = useRef<(() => void) | null>(null);
  const [closing, setClosing] = useState<string[]>([]);
  const [prompted, setPrompted] = useState<string | null>(null);

  useEffect(() => {
    const seconds = () => Math.round((Date.now() - stepStarted.current) / 1000);

    const onLine = (line: CoreLine) => {
      const text = line.text.replace(/\s+$/, "");

      const step = /^==> (.*)$/.exec(text);
      if (step) {
        // The open phase is closed from a ref rather than from inside a state updater: a
        // React updater must stay pure, and this one would otherwise queue a second state
        // change every time React chose to call it again.
        const open = openStep.current;
        if (open) {
          setRecords((all) => [
            ...all,
            { kind: "step", label: open.label, seconds: seconds(), ok: true },
          ]);
        }
        const fresh = { label: step[1] ?? "", since: Date.now() };
        openStep.current = fresh;
        setCurrent(fresh);
        stepStarted.current = Date.now();
        sinceStep.current = [];
        setTail([]);
        return;
      }

      const warned = /^\/!\\ (.*)$/.exec(text);
      if (warned) {
        const text = (warned[1] ?? "").trim();
        // Drawn here, so Notices must not draw it again: a sibling coreJson in the same
        // invocation may already have stored this very line. See claimNotice.
        claimNotice(text);
        setRecords((all) => [...all, { kind: "warn", text }]);
        return;
      }

      // `secret_value` asking for something nobody could answer. stdin is closed, so the
      // read returns empty and the core dies one line later — without this the failure
      // would read as "empty, nothing sent" and name nothing.
      const asking = /^(?:secret (\S+)|token for \S+) \(not echoed\)/.exec(text);
      if (asking) setPrompted(asking[1] ?? "remote");

      if (text.trim().length > 0 || sinceStep.current.length > 0) {
        sinceStep.current = [...sinceStep.current, text].slice(-TAIL_ON_FAILURE);
        history.current = [...history.current, text].slice(-TAIL_ON_FAILURE);
        setTail((lines) => [...lines, text].slice(-TAIL));
      }
    };

    const child = coreStream(argv, onLine);
    kill.current = child.kill;

    child.done.then((exitCode) => {
      const open = openStep.current;
      if (open) {
        setRecords((all) => [
          ...all,
          { kind: "step", label: open.label, seconds: seconds(), ok: exitCode === 0 },
        ]);
      }
      openStep.current = null;
      setCurrent(null);
      setCode(exitCode);
      setStatus((was) => (was === "interrupted" ? was : exitCode === 0 ? "succeeded" : "failed"));
      setClosing(exitCode === 0 ? sinceStep.current : history.current);
      onFinished?.(exitCode);
    });

    return () => child.kill();
    // The argv of a run cannot change: a new command is a new process.
  }, []);

  // Ctrl-C, taken seriously. Killing the shell does not reliably kill a `terraform apply`
  // underneath it, and a half-applied apply is exactly how a server ends up billing with
  // no state recording it. So the interruption says so, and names the command that finds
  // it again.
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c" && status === "running") {
        setStatus("interrupted");
        kill.current?.();
      }
    },
    { isActive: INTERACTIVE },
  );

  const total = Math.round((Date.now() - started.current) / 1000);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Static items={records}>
        {(record, index) =>
          record.kind === "step" ? (
            <Text key={index}>
              {"  "}
              <Text color={record.ok ? "green" : "red"}>{record.ok ? "✔" : "✗"}</Text>
              <Text> {record.label}</Text>
              {/* A phase that took no measurable time is a phase whose duration says
                  nothing. The core's closing `done in 0 min 5s` is one of them, and
                  `done in 0 min 5s 0s` reads like a bug. */}
              {record.seconds > 0 ? <Text dimColor> {duration(record.seconds)}</Text> : null}
            </Text>
          ) : (
            <Text key={index} color="yellow">
              {"  /!\\ "}
              {record.text}
            </Text>
          )
        }
      </Static>

      {current ? (
        <Text>
          {"  "}
          <Spinner />
          <Text> {current.label}</Text>
          <Elapsed since={current.since} />
        </Text>
      ) : null}

      {status === "running" && tail.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {tail.map((line, index) => (
            <Text key={index} dimColor wrap="truncate-end">
              {"    "}
              {line.trim()}
            </Text>
          ))}
        </Box>
      ) : null}

      {status === "succeeded" ? (
        <Box flexDirection="column">
          {closing.map((line, index) => (
            <Text key={index}>{line}</Text>
          ))}
          <Box marginTop={1}>
            {/* The core times its own phases; this is the only number that covers the
                whole command, cloud-init and all, so it names the command it timed. */}
            <Text>
              <Text color="green">{"  ✔ "}</Text>
              <Text dimColor>
                devbox {argv[0]} — {duration(total)}
              </Text>
            </Text>
          </Box>
        </Box>
      ) : null}

      {status === "failed" || status === "interrupted" ? (
        <Failed
          status={status}
          code={code}
          lines={closing}
          prompted={prompted}
          command={argv[0] ?? ""}
        />
      ) : null}
    </Box>
  );
}

/**
 * What went wrong, with enough of the output to act on it.
 *
 * The core's own errors say "see above" — `hz_up` does, about a terraform apply it just
 * printed — so a failure screen that kept only the last eight lines would cut the sentence
 * off from its evidence. Sixty lines is what a failed apply needs.
 */
function Failed({
  status,
  code,
  lines,
  prompted,
  command,
}: {
  status: Status;
  code: number;
  lines: string[];
  prompted: string | null;
  command: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {/* `die` writes `x ` and then, usually, three indented lines of what to do
              about it. Those lines are the most useful thing the tool prints, so the
              verdict is lifted out in red and its advice is left exactly as written. */}
          {lines.map((line, index) => {
            const spoken = /^x (.*)$/.exec(line);
            return spoken ? (
              <Text key={index} color="red">
                {"    ✗ "}
                {spoken[1]}
              </Text>
            ) : (
              <Text key={index} dimColor>
                {"    "}
                {line}
              </Text>
            );
          })}
        </Box>
      ) : null}

      {status === "interrupted" ? (
        <Box flexDirection="column">
          <Text color="yellow">{"  /!\\ interrupted"}</Text>
          <Text dimColor>
            {"      Terraform may have been mid-apply. A machine can exist that no state"}
          </Text>
          <Text dimColor>{"      knows about, and it bills: devbox orphans"}</Text>
        </Box>
      ) : (
        <Text color="red">
          {"  ✗ devbox "}
          {command} left with {code}
        </Text>
      )}

      {prompted ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">
            {"  /!\\ it wanted the secret '"}
            {prompted}
            {"' and there was no way to ask for it here."}
          </Text>
          <Advice
            options={[
              [`DEVBOX_${prompted.toUpperCase().replace(/-/g, "_")}_TOKEN=… devbox ${command}`, "to hand it over"],
              [`DEVBOX_PLAIN=1 devbox ${command}`, "to be asked for it by the shell"],
            ]}
          />
        </Box>
      ) : null}
    </Box>
  );
}

/** Two columns of "type this / to get that", aligned on the longest command. */
function Advice({ options }: { options: [string, string][] }) {
  const width = options.reduce((widest, [command]) => Math.max(widest, command.length), 0) + 4;
  return (
    <>
      {options.map(([command, gloss]) => (
        <Text key={command} dimColor>
          {"      "}
          {command.padEnd(width)}
          {gloss}
        </Text>
      ))}
    </>
  );
}
