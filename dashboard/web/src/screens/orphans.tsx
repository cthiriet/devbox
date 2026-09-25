import { AlertTriangleIcon, CheckIcon, RefreshCwIcon } from "lucide-react"

import { Screen } from "@/components/layout"
import { CloudMark } from "@/components/marks"
import { Fold } from "@/components/panel"
import { useSession } from "@/components/session"
import { Loading, LoadingRows, Nothing, Trouble } from "@/components/states"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useAsync } from "@/hooks/use-async"
import { api } from "@/lib/api"
import { cloudName } from "@/lib/clouds"
import { stamp } from "@/lib/format"

/**
 * What the providers run that no state knows about.
 *
 * An apply killed mid-flight leaves a server that bills without anything recording it: no
 * other screen will ever show it, since they all start from the Terraform state. A non-empty
 * answer is therefore drawn as a warning and not as a table - the count is the message, the
 * rows are the proof.
 *
 * Here, unlike the fleet's banner, the call goes out on opening: this is the screen one
 * opens on purpose to ask the question, and waiting on three cloud APIs is exactly what one
 * came to do.
 *
 * Nothing to press on a row: what to do about one is the provider's console, and that is the
 * sentence at rest.
 *
 * "Untracked machines" on the page, `orphans` everywhere else - the address, the API,
 * `devbox orphans`. It is no longer a tab either (nav.tsx): it sits one level under Machines,
 * with the chevron that says so. No subtitle since 13/09: the title and the answer say it.
 */
export function Orphans() {
  const { session } = useSession()
  const state = useAsync(() => api.orphans(), [])
  // An account with no cloud gets an empty answer, and "nothing untracked" would be a
  // reassurance about providers nobody asked.
  const noCloud = session?.configured === false

  return (
    <Screen
      title="Untracked machines"
      back={{ to: "/", label: "Machines" }}
      action={
        <Button
          variant="ghost"
          size="lg"
          className="h-11"
          onClick={state.reload}
          disabled={state.status === "loading"}
        >
          <RefreshCwIcon />
          <span className="sr-only">Refresh</span>
        </Button>
      }
    >
      {state.status === "loading" ? (
        <>
          <Loading label="Asking the providers" />
          <LoadingRows rows={3} />
        </>
      ) : null}

      {state.status === "failed" ? (
        // A cloud that refuses makes the whole answer false: "no orphan" while a provider
        // has not answered would be the worst of this screen's lies.
        <Trouble
          title="Incomplete answer"
          detail={state.error}
          onRetry={state.reload}
        />
      ) : null}

      {state.status === "ready" && state.data.length === 0 ? (
        noCloud ? (
          <Nothing>
            No cloud account is connected, so there is nothing to check yet.
          </Nothing>
        ) : (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <CheckIcon className="size-4 shrink-0 text-emerald-500" />
            Nothing untracked: every machine your providers run is on Machines.
          </p>
        )
      ) : null}

      {state.status === "ready" && state.data.length > 0 ? (
        <>
          <Alert variant="destructive">
            <AlertTriangleIcon />
            <AlertTitle>
              {state.data.length} untracked machine
              {state.data.length > 1 ? "s" : ""}, still billing
            </AlertTitle>
            <AlertDescription>
              Delete {state.data.length > 1 ? "them" : "it"} in your provider's
              console.
            </AlertDescription>
          </Alert>

          {/* A name, a cloud and a date at rest: what finds it again in the console. The
              address and the region are one tap down. The cloud's mark is monochrome, as on
              the offers: a red Hetzner badge under a red alert read as a second alarm. */}
          <ul className="mt-4 divide-y divide-border rounded-xl bg-card ring-1 ring-foreground/10">
            {state.data.map((orphan) => (
              <li key={`${orphan.cloud}/${orphan.name}`} className="px-3 pt-3">
                <p className="font-mono text-base break-all">{orphan.name}</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                  <CloudMark
                    cloud={orphan.cloud}
                    className="size-3.5 shrink-0"
                  />
                  {cloudName(orphan.cloud)} · {stamp(orphan.created)}
                </p>
                <Fold title="Details">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 pb-2 font-mono text-xs">
                    <dt className="text-muted-foreground">ip</dt>
                    <dd className="break-all">{orphan.ip ?? "-"}</dd>
                    <dt className="text-muted-foreground">region</dt>
                    <dd className="break-all">{orphan.region}</dd>
                  </dl>
                </Fold>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Screen>
  )
}
