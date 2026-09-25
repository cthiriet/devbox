import { Box, Text } from "ink";
import { coreJson } from "../core.ts";
import { floorsText } from "../floors.ts";
import { CONFIG_DIR, HERE, remote } from "../settings.ts";
import type { Profile } from "../types.ts";
import { Failure, Hints, Loading, useAsync, useExitWhen } from "./common.tsx";
import { Table } from "./Table.tsx";

/**
 * `devbox profiles` — what a machine can be made into, and what each one needs.
 *
 * The SECRETS column is the reason this screen is consulted at all: it is the list of
 * tokens `seed` will ask for, and knowing it before running is what turns a five-minute
 * provision into something you can walk away from.
 */
export function Profiles() {
  const where = remote();
  const state = useAsync(() => coreJson<Profile[]>(["profiles"], 30_000));

  useExitWhen(state.status !== "loading", state.status === "failed" ? 1 : 0);

  if (state.status === "loading") {
    return <Loading label={where ? `asking ${where}` : "reading the profile directories"} />;
  }
  if (state.status === "failed") return <Failure error={state.error} />;

  const profiles = state.data;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Table
        rows={profiles}
        columns={[
          { label: "PROFILE", value: (p) => p.name, color: () => "white" },
          {
            label: "SECRETS",
            value: (p) => (p.secrets.length > 0 ? p.secrets.join(" ") : "—"),
            color: (p) => (p.secrets.length > 0 ? "yellow" : undefined),
            dim: (p) => p.secrets.length === 0,
          },
          // The floors the machine is actually chosen against, not the ones the header
          // happens to spell: a profile that sets none still gets the core's template.
          { label: "TEMPLATE", value: floorsText },
          {
            label: "PORT",
            value: (p) => (p.port === null ? "—" : String(p.port)),
            align: "right",
            dim: (p) => p.port === null,
          },
          {
            label: "REPOSITORY",
            value: (p) => p.repo ?? "—",
            dim: (p) => p.repo === null,
          },
        ]}
      />
      {/* Saying "yours go in ~/.config/devbox/profiles" would be wrong when these came from
          the dashboard: a profile added here changes nothing about them. */}
      {where ? (
        <Hints
          lines={[
            `These are the dashboard's, at ${where}. A profile added here changes nothing`,
            "for them: ship it with the dashboard, or add it to its own profiles directory.",
          ]}
        />
      ) : (
        <Hints
          lines={[
            `Yours go in ${CONFIG_DIR}/profiles/ and shadow the repository's.`,
            `The shortest, ${HERE}/profiles/claude.sh, is the one to copy: add a devbox-repo line.`,
          ]}
        />
      )}
      {profiles.some((profile) => profile.note) ? (
        <Box flexDirection="column" marginTop={1}>
          {profiles
            .filter((profile) => profile.note)
            .map((profile) => (
              <Text key={profile.name} dimColor>
                {"  "}
                {profile.name}: {profile.note}
              </Text>
            ))}
        </Box>
      ) : null}
    </Box>
  );
}
