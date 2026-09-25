import { PlugZapIcon, TriangleAlertIcon } from "lucide-react"
import { Link } from "react-router"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * What an account that cannot order anything yet is told, instead of an error.
 *
 * Until 13/09 the fleet drew a red "Incomplete configuration - Missing: HCLOUD_TOKEN" above
 * "No machines." and an Order button. Every account starts in that state - a sign-up holds
 * no credential - so the first screen a new customer ever saw said the service was broken,
 * named an environment variable they had never met, and offered a button leading to a wizard
 * where nothing could be ordered. It is not a fault, it is the first step, and it is drawn as
 * one.
 *
 * The variable was never this account's either: the server answers `missing: ["HCLOUD_TOKEN"]`
 * whenever NO cloud can be ordered (dashboard/src/secrets.ts#missing), a stand-in for "any of
 * the three". So the callers read `configured === false` - null is "not asked" and must not
 * read as a first run.
 *
 * CALM, since 13/09, like the Keys page: a title and one button. The description, the three
 * cloud badges and the paragraph on step 2 said what the next screen says better - which
 * clouds there are is the settings page's, and what a profile needs is step 1's.
 *
 * No word here on WHOSE cloud account a machine goes to: the account's own, or - where a hosted
 * service's extension says so - the service's, which the Account page tells cloud by cloud.
 */

/** The fleet of an account with no cloud and no machine: the one next step, and a hint of the second. */
export function GetStarted() {
  return (
    <section className="rounded-xl bg-card px-4 pt-6 pb-4 text-center ring-1 ring-foreground/10">
      <PlugZapIcon
        aria-hidden
        className="mx-auto size-6 text-muted-foreground"
      />
      <h2 className="mt-2 text-lg font-semibold">Your first machine</h2>
      {/* A `Link` in the button's classes rather than a Button rendering one: see
          fleet.tsx. Straight to Hetzner's panel, which is the one to start with. */}
      <Link
        to="/account#cloud-hetzner"
        className={cn(
          buttonVariants({ size: "lg" }),
          "mt-4 h-12 w-full text-base"
        )}
      >
        Connect a cloud
      </Link>
      <p className="mt-3 text-xs text-muted-foreground">
        Then order a machine.
      </p>
    </section>
  )
}

/**
 * The same fact, one line, where a card would push the screen's own content away.
 *
 * Without `stranded`: the wizard, where nothing can be ordered yet. A title and a way out, and
 * no sentence - the title is the sentence.
 *
 * `stranded`: machines listed and no cloud to reach them, because a credential was removed
 * after they were ordered. That one is a danger and is red, as the Keys page draws the same
 * cloud: they bill, and the server refuses to destroy them (412) until the credential is back.
 * Said once, here, where the gesture that fixes it is.
 */
export function ConnectCloud({
  stranded = false,
  className,
}: {
  stranded?: boolean
  className?: string
}) {
  return (
    <div
      role={stranded ? "alert" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl py-2 pr-2 pl-3 ring-1",
        stranded ? "bg-card ring-destructive/40" : "bg-card ring-foreground/10",
        className
      )}
    >
      {stranded ? (
        <TriangleAlertIcon
          aria-hidden
          className="size-4 shrink-0 text-destructive"
        />
      ) : (
        <PlugZapIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      )}
      <p className="min-w-0 flex-1 text-sm">
        <span
          className={cn("block font-medium", stranded && "text-destructive")}
        >
          {stranded
            ? "No cloud connected"
            : "Connect a cloud first"}
        </span>
        {stranded ? (
          <span className="block text-xs text-muted-foreground">
            These machines bill, and cannot be destroyed until it is.
          </span>
        ) : null}
      </p>
      <Link
        to={stranded ? "/account" : "/account#cloud-hetzner"}
        className={cn(
          buttonVariants({ variant: "outline", size: "lg" }),
          "h-11 shrink-0"
        )}
      >
        Connect
      </Link>
    </div>
  )
}
