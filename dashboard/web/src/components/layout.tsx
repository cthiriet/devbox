import type { ReactNode } from "react"
import { ChevronLeftIcon, CircleSlashIcon } from "lucide-react"
import { Link } from "react-router"

import { TopNav } from "@/components/nav"
import { useSession } from "@/components/session"
import { shortDigest } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * The column, and what surrounds it.
 *
 * A single column, never two: this dashboard is opened one-handed, on a train, at night.
 * `max-w-2xl` is not a page width but a limit for the computer screen that opens it from
 * time to time; the design is the phone's, and the large screen inherits the same column
 * rather than a second design to maintain.
 *
 * The bottom of the page carries `env(safe-area-inset-bottom)`: on an iPhone the last button
 * of a page otherwise falls under the home bar, where it is half clickable.
 */
export function Screen({
  title,
  subtitle,
  back,
  action,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  /**
   * Where the chevron goes back up to. Absent on the sections the top nav reaches - machines,
   * activity, profiles, secrets, the account - where a chevron would repeat a tab that is
   * already on screen. Kept on what sits one level down: a machine, a job, the order wizard, a
   * profile's form, the untracked machines.
   */
  back?: { to: string; label: string }
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <TopNav />
      <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col px-4 pt-5 pb-[calc(2rem+env(safe-area-inset-bottom))]">
        <EngineMissing />

        {back ? (
          <Link
            to={back.to}
            className="mb-3 -ml-1 inline-flex h-11 items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
          >
            <ChevronLeftIcon className="size-4" />
            {back.label}
          </Link>
        ) : null}

        <header className="mb-4 flex items-start justify-between gap-3">
          {/* No mark here, on any screen. The fleet used to pass the whole logo as its title,
              right under the nav's own mark: the brand twice in 60 px, and the one screen
              whose heading did not say what it listed. The nav carries the brand; a heading
              says where the reader is. */}
          <div className="min-w-0">
            <h1 className="text-2xl leading-tight font-semibold break-words">
              {title}
            </h1>
            {subtitle ? (
              <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </header>

        <main className="flex-1">{children}</main>
      </div>
    </>
  )
}

/**
 * When the engine is missing, every screen says so - at the TOP.
 *
 * Nothing can be ordered from a service without its executor, and the page has to say it
 * before anyone presses "Order". It was a line of red 12 px text under the content until
 * 13/09: on a phone, below the fold on exactly the screens it blocks. One line now, above the
 * back link and the heading, in words a customer can act on; the digest is on the founding
 * account's page (see EngineVersion).
 */
function EngineMissing() {
  const { session } = useSession()
  if (session === null || !session.authenticated || session.engine.ready)
    return null
  return (
    <p className="mb-4 flex min-h-11 items-center gap-2 rounded-lg border border-destructive/30 px-3 py-2 text-sm text-destructive">
      <CircleSlashIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0">Ordering is unavailable right now.</span>
    </p>
  )
}

/**
 * Which executor really runs over there.
 *
 * It is the gap the version handshake filled on the CLI side: devbox-core on the Mac and
 * engine/devbox on the server are two files, and only a deployment renews the second one - a
 * local fix changes nothing to what a job does until it has left. That cost a morning of
 * fixing, of running again, and of watching the same bug survive. Seven characters of sha256
 * are enough to answer "no, your fix is not there".
 *
 * On the account page, and no longer at the foot of every screen. There it was
 * `engine c984135` under a customer's fleet, their secrets and their login - somebody else's
 * debugging, on every page they opened, and the surest sign of an internal tool. The person it
 * serves asks the question on purpose, after a deployment, and a deliberate question can take
 * one tap; the CLI asks it on its own before every remote verb (`GET /api/version`).
 *
 * Since 13/09 it is the value of the "Version" row, on the founding account's page only: the
 * short digest alone, inline, the row's label saying what it is.
 */
export function EngineVersion({ className }: { className?: string }) {
  const { session } = useSession()
  if (session === null || !session.authenticated) return null

  const { engine } = session
  return (
    <span
      className={cn("font-mono", className)}
      title={
        engine.built_at === null ? undefined : `deployed on ${engine.built_at}`
      }
    >
      {engine.ready ? shortDigest(engine.core) : "missing"}
    </span>
  )
}
