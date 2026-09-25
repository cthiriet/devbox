import { Box, Text } from "ink";
import type { Parsed } from "../args.ts";
import { coreJson } from "../core.ts";
import { TF_ROOT } from "../settings.ts";
import type { Orphan } from "../types.ts";
import { Failure, Hints, Loading, useAsync, useExitWhen } from "./common.tsx";
import { cloudColor, Table } from "./Table.tsx";

/**
 * `devbox orphans` — what the providers run that no state knows about.
 *
 * An apply killed halfway leaves a server billing with nothing recording it, and no other
 * screen would ever show it again. So a non-empty answer is drawn as a warning and not as
 * a table: the count is the message, the rows are the evidence.
 */
export function Orphans({ parsed }: { parsed: Parsed }) {
  const state = useAsync(() => coreJson<Orphan[]>(["orphans", ...parsed.rest], 180_000));

  useExitWhen(state.status !== "loading", state.status === "failed" ? 1 : 0);

  if (state.status === "loading") {
    return <Loading label="asking the providers what they are running" />;
  }
  if (state.status === "failed") return <Failure error={state.error} />;

  const orphans = state.data;

  if (orphans.length === 0) {
    return (
      <Box marginTop={1}>
        <Text>
          <Text color="green">{"  ✔ "}</Text>
          <Text dimColor>no orphan: every server the providers run is in the state</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow" bold>
        {"  /!\\ "}
        {orphans.length} server{orphans.length > 1 ? "s" : ""} running that no state knows about,
        and they are billing
      </Text>
      <Box marginTop={1}>
        <Table
          rows={orphans}
          columns={[
            { label: "NAME", value: (o) => o.name, color: () => "white" },
            { label: "CLOUD", value: (o) => o.cloud, color: (o) => cloudColor(o.cloud) },
            { label: "WHERE", value: (o) => o.region },
            { label: "CREATED", value: (o) => o.created.slice(0, 16), dim: () => true },
            { label: "HOST", value: (o) => o.ip ?? "-", dim: () => true },
          ]}
        />
      </Box>
      <Hints
        lines={[
          "Destroy them from the provider console, or adopt one into a workspace:",
          `  TF_WORKSPACE=<name> terraform -chdir=${TF_ROOT}/<cloud> import ...`,
        ]}
      />
    </Box>
  );
}
