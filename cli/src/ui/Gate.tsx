import { Box, Text } from "ink";
import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { getNotices, subscribeNotices } from "../core.ts";
import { envName, held, store } from "../secrets.ts";
import { INTERACTIVE, remote } from "../settings.ts";
import { AskSecret } from "./AskSecret.tsx";
import { useExitWhen } from "./common.tsx";

/**
 * The dashboard token, before anything is asked of the dashboard.
 *
 * When DEVBOX_REMOTE is set, *every* verb goes through the dashboard and every call carries
 * a bearer token — `ls` as much as `up`. devbox-core prompts for it on first use, and that
 * prompt cannot happen under Ink: the core is spawned with stdin closed, so it would read
 * an empty line and die on "empty, nothing sent", which names nothing.
 *
 * So it is asked for here, once, in front of everything. This is the only gate that wraps
 * the read-only screens too, and that is exactly why it is a component of its own rather
 * than part of Task: `devbox ls` against a fresh workstation has to be answerable.
 */
export function Gate({ children }: { children: ReactNode }) {
  const where = remote();
  const [stored, setStored] = useState(false);
  const [aborted, setAborted] = useState(false);

  const wanted = where !== "" && !held("remote") && !stored;
  const refused = wanted && !INTERACTIVE;

  useExitWhen(aborted || refused, 1);

  if (aborted) {
    return (
      <Box marginTop={1}>
        <Text dimColor>{"  nothing done"}</Text>
      </Box>
    );
  }

  if (refused) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="red">{`  ✗ ${where} needs a token and there is no terminal to ask on`}</Text>
        <Text dimColor>{`      ${envName("remote")}=… devbox …`}</Text>
        <Text dimColor>{"      DEVBOX_REMOTE= devbox …    the local state, knowingly"}</Text>
      </Box>
    );
  }

  if (wanted) {
    return (
      <AskSecret
        name="remote"
        onAnswer={(value) => {
          store("remote", value);
          setStored(true);
        }}
        onCancel={() => setAborted(true)}
      />
    );
  }

  return (
    <>
      <Notices />
      {children}
    </>
  );
}

/**
 * What the core said on stderr while a JSON screen was reading it.
 *
 * Mounted here because Gate already wraps every screen exactly once (index.tsx renders
 * `<Gate>{node}</Gate>` and nothing else), so one component covers `ls`, `info`,
 * `profiles` and `orphans` without any of them knowing. Rendered like Run.tsx renders a
 * warn, on purpose: the same sentence must not look like two different things depending
 * on which verb surfaced it.
 */
function Notices() {
  const lines = useSyncExternalStore(subscribeNotices, getNotices, getNotices);
  if (lines.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((line) => (
        <Text key={line} color="yellow">
          {"  /!\\ "}
          {line}
        </Text>
      ))}
    </Box>
  );
}
