import * as React from "react"
import type { LucideIcon } from "lucide-react"
import {
  CircleUserRoundIcon,
  KeyRoundIcon,
  LayersIcon,
  ListChecksIcon,
  ServerIcon,
} from "lucide-react"
import { Link, useLocation } from "react-router"

import { Mark } from "@/components/logo"
import { useSession } from "@/components/session"
import { cn } from "@/lib/utils"

/**
 * The sections, at the top, on every screen that needs a session.
 *
 * They used to be five underlined words at the bottom of the fleet alone: reachable from one
 * screen, below a list that grows with the fleet, and gone the moment a machine page was
 * opened. With accounts there are several places a person moves between, and a nav that
 * exists on one page is a nav that has to be walked back to.
 *
 * One row rather than a menu behind a button: a tab that can be seen is a tab that does not
 * have to be remembered. Each tab keeps the `h-11` touch target every other control here has.
 *
 * Four sections and the account, and no more. Orphans was a tab until 13/09: a ghost icon
 * and a word no customer uses, a fifth of the bar on every screen, for a question asked after
 * an interrupted job and almost never otherwise - and opening it questions every provider.
 * It now hangs under Machines, which is what it is about: the fleet links to it at its foot,
 * an interrupted job links to it where the doubt arises, and its address has not moved
 * (deploy.json and server.ts list it). Jobs reads "Activity" for the same reader, and keeps
 * `/jobs`.
 *
 * On a phone the row has to FIT, not scroll. Measured at 375 px before this: mark, icons and
 * six labels made a 640 px row in a 375 px bar, and Account - the tab someone looks for to
 * sign out - started at x 535, off-screen, with nothing saying the row went on. So below `sm` the sections
 * are words only, the mark goes (Machines is already the way home), and Account is an icon
 * pinned outside the scrolling part. A larger system font can still overflow it: then the
 * edge hiding a tab fades, and the current tab is scrolled into view.
 */
type Section = {
  to: string
  label: string
  icon: LucideIcon
  /** Which addresses light this tab: a machine's page belongs to Machines, a job's to Activity. */
  owns: (path: string) => boolean
}

const SECTIONS: Section[] = [
  {
    to: "/",
    label: "Machines",
    icon: ServerIcon,
    owns: (path) =>
      path === "/" ||
      path.startsWith("/machine/") ||
      path.startsWith("/new") ||
      path === "/orphans",
  },
  {
    to: "/jobs",
    label: "Activity",
    icon: ListChecksIcon,
    owns: (path) => path === "/jobs" || path.startsWith("/job/"),
  },
  {
    to: "/profiles",
    label: "Profiles",
    icon: LayersIcon,
    owns: (path) => path.startsWith("/profiles"),
  },
  // "Keys" and not the page's own title, "Keys & tokens": the row has to fit a 375 px bar
  // (see above), and the address stays /secrets - deploy.json and server.ts list it.
  {
    to: "/secrets",
    label: "Keys",
    icon: KeyRoundIcon,
    owns: (path) => path === "/secrets",
  },
]

const ACCOUNT: Section = {
  to: "/account",
  label: "Account",
  icon: CircleUserRoundIcon,
  owns: (path) => path === "/account",
}

export function TopNav() {
  const { session } = useSession()
  if (session === null || !session.authenticated) return null
  return <Bar />
}

/** Apart from TopNav so its hooks only ever run with the row mounted. */
function Bar() {
  const { pathname } = useLocation()
  const row = React.useRef<HTMLDivElement>(null)
  const hidden = useHiddenEdges(row, pathname)

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur">
      <nav
        aria-label="Sections"
        className="mx-auto flex w-full max-w-2xl items-center gap-1 px-2"
      >
        <div
          ref={row}
          className="flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden"
          style={fade(hidden)}
        >
          <Link
            to="/"
            aria-label="devbox"
            className="mr-1 hidden h-11 shrink-0 items-center px-2 sm:inline-flex"
          >
            <Mark className="size-5" />
          </Link>
          {SECTIONS.map((section) => (
            <Tab
              key={section.to}
              section={section}
              active={section.owns(pathname)}
            />
          ))}
        </div>
        {/* Outside the scrolling part, at the far edge, where a person looks for themselves:
            it never scrolls away. */}
        <Tab section={ACCOUNT} active={ACCOUNT.owns(pathname)} compact />
      </nav>
    </header>
  )
}

function Tab({
  section,
  active,
  compact = false,
}: {
  section: Section
  active: boolean
  /** An icon alone below `sm`, the label kept for screen readers. */
  compact?: boolean
}) {
  const Icon = section.icon
  return (
    <Link
      to={section.to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm whitespace-nowrap transition-colors sm:px-2.5",
        compact && "min-w-11",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground",
        // The underline sits ON the header's border, the way a selected tab reads as the
        // part of the bar that opens onto the page below.
        active &&
          "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground"
      )}
    >
      <Icon
        aria-hidden
        className={cn("size-4 shrink-0", !compact && "hidden sm:block")}
      />
      <span className={compact ? "sr-only sm:not-sr-only" : undefined}>
        {section.label}
      </span>
    </Link>
  )
}

/**
 * Which ends of the row hide a tab, and the current tab brought into view.
 *
 * No measure called from the effect itself: a ResizeObserver reports the first size on its
 * own as soon as it observes, and the children are observed too, because the row's own box
 * does not change when a web font arrives and widens every label inside it.
 */
function useHiddenEdges(
  row: React.RefObject<HTMLDivElement | null>,
  pathname: string
) {
  const [edges, setEdges] = React.useState({ start: false, end: false })

  React.useEffect(() => {
    const element = row.current
    if (element === null) return
    const measure = () => {
      const rest =
        element.scrollWidth - element.clientWidth - element.scrollLeft
      const start = element.scrollLeft > 1
      const end = rest > 1
      setEdges((current) =>
        current.start === start && current.end === end
          ? current
          : { start, end }
      )
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of Array.from(element.children)) observer.observe(child)
    element.addEventListener("scroll", measure, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener("scroll", measure)
    }
  }, [row])

  React.useEffect(() => {
    row.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [row, pathname])

  return edges
}

/** A 2 rem fade on each edge that hides something, and no mask at all when nothing does. */
function fade({
  start,
  end,
}: {
  start: boolean
  end: boolean
}): React.CSSProperties | undefined {
  if (!start && !end) return undefined
  const mask = `linear-gradient(to right, ${start ? "transparent, #000 2rem" : "#000"}, ${end ? "#000 calc(100% - 2rem), transparent" : "#000"})`
  return { maskImage: mask, WebkitMaskImage: mask }
}
