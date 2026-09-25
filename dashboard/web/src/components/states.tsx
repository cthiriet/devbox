import type { ReactNode } from "react"
import { TriangleAlertIcon } from "lucide-react"

import { Fold } from "@/components/panel"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

/**
 * The three states that are not data: we are waiting, it failed, there is nothing.
 *
 * They are here because they come back on every screen and have to come back identical. A
 * screen that invents its own way of saying "it failed" ends up not offering to retry, and on
 * a phone in a train that is the only useful gesture: the most frequent fault here is not the
 * server, it is the tunnel.
 *
 * Quiet since 13/09, like the Keys page. A wait is a spinner and nothing else: "Reading the
 * machine, and its host key" described the mechanism to someone who only wanted the machine.
 * The label stays, for a screen reader, and is no longer drawn. A failure says that it failed
 * and offers Retry at once; the server's own sentence is folded under Details, where it is
 * one tap away for whoever needs it and not the first thing a customer reads.
 */

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex justify-center py-10 text-muted-foreground">
      <Spinner aria-label={label} />
    </div>
  )
}

/**
 * The skeleton of a list, so the screen does not jump when the data arrives: the shape of
 * `Rows` in components/panel.tsx, which is what every list here now draws.
 */
export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" className="py-2">
      <span className="sr-only">Loading</span>
      <div
        aria-hidden
        className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"
      >
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex h-12 items-center gap-3 px-3">
            <Skeleton className="size-4 shrink-0 rounded" />
            <Skeleton className={index % 2 === 0 ? "h-3 w-1/2" : "h-3 w-1/3"} />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * A load that failed: what failed, Retry beside it, and the raw reason folded.
 *
 * A neutral border and not a red card: a red block the width of the column was the loudest
 * thing on a screen whose only fault was a tunnel. The mark stays red, since it is a failure.
 */
export function Trouble({
  title = "Couldn't load.",
  detail,
  onRetry,
}: {
  title?: string
  detail: string
  onRetry?: () => void
}) {
  return (
    <div
      role="alert"
      className="my-4 rounded-xl border border-border px-3 py-2"
    >
      <div className="flex min-h-11 items-center gap-2">
        <TriangleAlertIcon
          aria-hidden
          className="size-4 shrink-0 text-destructive"
        />
        <p className="min-w-0 flex-1 text-sm font-medium break-words">
          {title}
        </p>
        {onRetry ? (
          <Button
            variant="outline"
            size="lg"
            className="h-11 shrink-0"
            onClick={onRetry}
          >
            Retry
          </Button>
        ) : null}
      </div>
      {detail.trim() === "" ? null : (
        <Fold title="Details">
          <p className="font-mono text-xs break-words text-muted-foreground select-text">
            {detail}
          </p>
        </Fold>
      )}
    </div>
  )
}

export function Nothing({ children }: { children: ReactNode }) {
  return <p className="py-6 text-sm text-muted-foreground">{children}</p>
}
