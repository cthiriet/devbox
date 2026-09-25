import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { envName } from "../secrets.ts";
import { INTERACTIVE, SECRETS_DIR } from "../settings.ts";

/**
 * A token, typed once and never echoed.
 *
 * The same posture as `secret_value` in devbox-core, for the same reason: read once, cached
 * at 0600, never on a command line and never in the shell history. What is added here is
 * only that the reader can see *how much* they have typed — a bullet per character —
 * which is the one thing a silent `read -rs` cannot show and the reason a mistyped token
 * is normally discovered thirty seconds into a phase 2.
 *
 * The value never leaves this component except through `onAnswer`, and it is never put in
 * the environment of anything: it goes to the file the core reads.
 */
export function AskSecret({
  name,
  onAnswer,
  onCancel,
}: {
  name: string;
  onAnswer: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [empty, setEmpty] = useState(false);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (value.length === 0) {
        setEmpty(true);
        return;
      }
      onAnswer(value);
      return;
    }
    if (key.backspace || key.delete) {
      setEmpty(false);
      setValue((current) => current.slice(0, -1));
      return;
    }
    // Ink is told not to exit on Ctrl-C, so this screen has to honour it itself —
    // otherwise a prompt nobody can answer is a prompt nobody can leave.
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    // Other chords are shortcuts, not characters. Without this a Ctrl-U would be stored
    // as part of the token.
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      return;
    }
    if (!input) return;

    // A pasted token arrives as one chunk, newline and all, and Ink hands the whole chunk
    // over as `input` with no `key.return` — the Enter is inside the string rather than
    // beside it. Tokens are pasted far more often than they are typed, so the newline is
    // read here as what it is: the end of the value.
    const end = input.search(/[\r\n]/);
    if (end === -1) {
      setEmpty(false);
      setValue((current) => current + input);
      return;
    }
    const complete = value + input.slice(0, end);
    if (complete.length === 0) {
      setEmpty(true);
      return;
    }
    onAnswer(complete);
  }, { isActive: INTERACTIVE });

  const label = name === "remote" ? "token for the dashboard" : `secret ${name}`;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        {"  "}
        <Text color="cyan">{label}</Text>
        <Text dimColor> (not echoed): </Text>
        <Text color="cyan">{"•".repeat(value.length)}</Text>
      </Text>
      {empty ? (
        <Text color="red">{"  empty, nothing sent — type it, or Esc to give up"}</Text>
      ) : (
        <Text dimColor>
          {"  cached at "}
          {SECRETS_DIR}/{name}
          {", or set "}
          {envName(name)}
          {" instead"}
        </Text>
      )}
    </Box>
  );
}
