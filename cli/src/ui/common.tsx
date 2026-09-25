import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { CoreError } from "../core.ts";
import { Elapsed, Spinner } from "./Spinner.tsx";

/**
 * One asynchronous read of the core, with the three states a screen has to draw.
 *
 * Every read-only verb has the same life: spawn, wait, then either a table or the reason
 * there is none. The waiting is not a formality — `orphans` asks three cloud APIs and
 * `probe` reads GCP's billing catalogue — so "loading" is a state with a spinner and a
 * clock, not a blank pause.
 */
export type Async<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "failed"; error: unknown };

export function useAsync<T>(run: () => Promise<T>): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    run().then(
      (data) => alive && setState({ status: "ready", data }),
      (error) => alive && setState({ status: "failed", error }),
    );
    return () => {
      alive = false;
    };
    // Once, on mount: the argv a screen was given cannot change without a new process.
  }, []);

  return state;
}

/**
 * Leaves with a status, once the frame holding the answer has been committed.
 *
 * The exit code is the part that must not regress: `devbox ls | wc -l` in a script is one
 * thing, `devbox info missing && ssh missing` is another, and the second only works because
 * a failure leaves non-zero. Ink writes its last frame on unmount, so exiting from an
 * effect — after the commit — shows the answer and still leaves promptly.
 */
export function useExitWhen(done: boolean, code: number): void {
  const { exit } = useApp();
  useEffect(() => {
    if (!done) return;
    process.exitCode = code;
    exit();
  }, [done, code, exit]);
}

/** The wait, named. `label` says what is being asked of whom. */
export function Loading({ label }: { label: string }) {
  const [since] = useState(() => Date.now());
  return (
    <Box>
      <Text> </Text>
      <Spinner />
      <Text> {label}</Text>
      <Elapsed since={since} />
    </Box>
  );
}

/**
 * A failure, with the core's own words.
 *
 * `die` in devbox-core writes a message and often three lines of what to do about it —
 * "devbox probe --all what there is", the whole GitHub fine-grained-token explanation. Those
 * lines are the most useful thing the tool prints and they are reproduced verbatim: this
 * layer must never paraphrase an error it did not diagnose.
 */
export function Failure({ error }: { error: unknown }) {
  const detail =
    error instanceof CoreError
      ? error.detail
      : error instanceof Error
        ? error.message
        : String(error);

  const lines = detail.split("\n").filter((line, index) => index === 0 || line.trim().length > 0);

  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line, index) => (
        <Text key={index} color={index === 0 ? "red" : undefined} dimColor={index > 0}>
          {index === 0 ? `  ✗ ${line.replace(/^x /, "")}` : `    ${line.trim()}`}
        </Text>
      ))}
    </Box>
  );
}

/** The advice under a table: what to type next, in the core's wording. */
export function Hints({ lines }: { lines: (string | null | undefined)[] }) {
  const shown = lines.filter((line): line is string => Boolean(line));
  if (shown.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {shown.map((line, index) => (
        <Text key={index} dimColor>
          {"  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}
