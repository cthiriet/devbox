import type { ReactNode } from "react"
import { ChevronRightIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react"
import { Link } from "react-router"

import { cn } from "@/lib/utils"

/**
 * A job, as the one line a screen that is not the job's own says about it.
 *
 * Two tones and no third. `running` is grey, with a spinner: worth following, not worth
 * alarming anyone. `failed` is red, and it is drawn without a tap for a reason that is money:
 * a job that did not finish is where a machine can bill with nothing to show for it - an
 * order cut short after the provider's apply left the machine there, half made - and the
 * tap leads to why.
 *
 * A line and not an Alert: an Alert is a title and a paragraph, and all there is to say at
 * rest is what happened and where to read about it.
 */
export function JobLine({
  to,
  tone,
  label,
  action,
  className,
}: {
  to: string
  tone: "running" | "failed"
  label: ReactNode
  /** One or two words on the right: "See why", "Follow". */
  action: string
  className?: string
}) {
  const failed = tone === "failed"
  return (
    <Link
      to={to}
      className={cn(
        "flex min-h-12 items-center gap-3 rounded-xl bg-card px-3 py-2 text-sm ring-1 transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring active:bg-muted",
        failed ? "ring-destructive/40" : "ring-foreground/10",
        className
      )}
    >
      {failed ? (
        <TriangleAlertIcon
          aria-hidden
          className="size-4 shrink-0 text-destructive"
        />
      ) : (
        <Loader2Icon
          aria-hidden
          className="size-4 shrink-0 animate-spin text-muted-foreground"
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-medium",
          failed && "text-destructive"
        )}
      >
        {label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{action}</span>
      <ChevronRightIcon
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
      />
    </Link>
  )
}
