import * as React from "react"
import { TriangleAlertIcon } from "lucide-react"
import { Navigate, useLocation, useNavigate } from "react-router"

import { Logo } from "@/components/logo"
import { GithubMark } from "@/components/marks"
import { Fold } from "@/components/panel"
import { useSession } from "@/components/session"
import { Loading, Trouble } from "@/components/states"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { buttonVariants } from "@/components/ui/button"
import type { Provider } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * The sign-in screen: the mark, and one button per provider the server offers.
 *
 * Since 15/09 there is nothing to type. Each button is a plain link to `/api/auth/<provider>`,
 * a full-page navigation and not a fetch: the provider's consent screen is a page of its own,
 * and the server answers with a redirect there that a fetch could not follow into. The path the
 * reader was sent here from travels as `from`, and the server brings them back to it.
 *
 * `disabled` comes from `/api/session`: a service that can open no session at all - no provider
 * configured, or no account yet and no founder named. The buttons are then not drawn at all,
 * rather than drawn and leading nowhere. The server's own words are under Details, for whoever
 * deploys it.
 *
 * The founding is said above the buttons, short but drawn as an alert, since it is the one
 * handover here that cannot be undone: on a service that has never had an account, the sign-in
 * with the address it was set up with takes everything it holds.
 *
 * A refusal comes back as `?refused=<word>`, from a fixed vocabulary, and the sentence is the
 * page's: nothing a provider wrote reaches an address bar. It is read once and the address is
 * cleaned, so that a reload or a second try does not show it again.
 */
export function Login() {
  const { session, status, error, refresh } = useSession()
  const navigate = useNavigate()
  const location = useLocation()
  // Read at the first render, when the server's redirect has just landed here: the address is
  // cleaned right after, and the sentence has to outlive it.
  const [refused] = React.useState(() => refusalSentence(location.search))

  React.useEffect(() => {
    if (new URLSearchParams(location.search).has("refused"))
      navigate(
        { pathname: location.pathname, hash: location.hash },
        { replace: true, state: location.state }
      )
  }, [location.search, location.pathname, location.hash, location.state, navigate])

  const from = (location.state as { from?: string } | null)?.from ?? "/"

  if (session !== null && session.authenticated)
    return <Navigate to={from} replace />

  let body: React.ReactNode
  if (session === null) {
    // No buttons before the answer: which providers there are is the answer.
    body =
      status === "failed" ? (
        <Trouble detail={error ?? ""} onRetry={refresh} />
      ) : (
        <Loading label="Checking the session" />
      )
  } else if (session.disabled) {
    body = (
      <div role="status">
        <p className="text-base font-medium">Sign-in isn't available yet.</p>
        <Fold title="Details" className="mt-2 border-t border-border">
          <p className="font-mono text-xs break-words text-muted-foreground">
            {session.disabled}
          </p>
        </Fold>
      </div>
    )
  } else {
    body = (
      <>
        {session.doors.claim ? (
          <Alert className="mb-4">
            <TriangleAlertIcon />
            <AlertTitle>First sign-in</AlertTitle>
            <AlertDescription>
              This service has no account yet: only the address it was set up
              with can sign in now, and that account will own everything
              already here.
            </AlertDescription>
          </Alert>
        ) : null}

        {refused ? (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{refused}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-3">
          {session.doors.providers.map((provider) => (
            <a
              key={provider}
              href={`/api/auth/${provider}?from=${encodeURIComponent(from)}`}
              className={cn(
                buttonVariants({ variant: "outline", size: "lg" }),
                "h-12 w-full gap-3 text-base"
              )}
            >
              {provider === "github" ? (
                <GithubMark className="size-5" />
              ) : (
                <GoogleMark className="size-5" />
              )}
              Continue with {NAMES[provider]}
            </a>
          ))}
        </div>
      </>
    )
  }

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center px-4 py-10">
      {/* The one screen where the mark belongs at full size: nothing else is on it yet,
          and it is the only page a stranger ever reaches. */}
      <Logo className="mb-8" />
      {body}
    </div>
  )
}

const NAMES: Record<Provider, string> = { google: "Google", github: "GitHub" }

/**
 * The server's refusal word, as a sentence. The provider is named when the answer names one the
 * page knows, and only then: `provider` is a query parameter anyone can write.
 */
function refusalSentence(search: string): string | null {
  const query = new URLSearchParams(search)
  const refused = query.get("refused")
  if (refused === null) return null
  const named = query.get("provider")
  const provider = named === "google" || named === "github" ? NAMES[named] : null

  switch (refused) {
    case "state":
      return "That sign-in expired or was started in another tab. Try again."
    case "denied":
      return "Sign-in was cancelled."
    case "unverified":
      return `Your ${provider === null ? "" : `${provider} `}account has no verified email address. Verify one there, then try again.`
    case "provider":
      return `${provider ?? "The provider"} didn't answer as expected. Try again in a moment.`
    case "address":
      return "That email address can't be used here."
    case "unvouched":
      return "Google doesn't vouch for this address. Sign in with GitHub, or with a Gmail or Google Workspace account."
    case "unfounded":
      return "This service hasn't been set up yet: only the address it was set up with can sign in first."
    case "busy": {
      const minutes = Number(query.get("minutes"))
      return Number.isInteger(minutes) && minutes > 0
        ? `Too many new accounts this hour. Try again in ${minutes} min.`
        : "Too many new accounts this hour. Try again later."
    }
    case "unavailable":
      return provider === null
        ? "That sign-in isn't available here."
        : `Sign-in with ${provider} isn't available here.`
    default:
      return "Sign-in didn't complete. Try again."
  }
}

/**
 * Google's "G", drawn here like GithubMark in components/marks.tsx and for its reason: lucide has
 * no brand icons. In its own four colours, which is how Google asks a sign-in button to show it.
 */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.28A7.2 7.2 0 0 1 4.91 12c0-.79.14-1.56.38-2.28V6.61H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.39l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.23 0 12 0A12 12 0 0 0 1.28 6.61l4.01 3.11C6.23 6.88 8.88 4.77 12 4.77Z"
      />
    </svg>
  )
}
