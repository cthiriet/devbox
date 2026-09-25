import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DialogOverlay, DialogPortal } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/**
 * What a tap opens: a sheet from the bottom on a phone, a dialog on a wider screen.
 *
 * The dialog's own parts - portal, backdrop, focus trap, Escape, the scroll lock - around a
 * popup of its own, because the shared DialogContent is a small centred box: a guide, a key
 * file and a refusal do not fit in one on a phone, and a sheet keeps the thumb where the
 * buttons are. It scrolls inside itself, under a header that stays, so Close is never
 * scrolled out of reach. Confirmations are drawn inside it, not over it: see Confirm in screens/secrets.tsx.
 *
 * Opened by the address and not by a trigger, so Base UI cannot tell a tap from a click, and
 * focus goes to the first tabbable element: the header's Close, which is first on purpose - a
 * field focused on arrival would throw a keyboard over the guide before it is read.
 */
export function Sheet({
  open,
  onClose,
  children,
}: {
  open: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogPortal>
        {/* The backdrop lasts as long as the sheet, and both HOLD their last frame. The shared
            backdrop fades in 100 ms and the sheet in 200: with no fill mode, the backdrop's
            fade ended first and snapped back to full blur for the 100 ms the sheet still had
            before Base UI unmounted them both - the flash on every close. */}
        <DialogOverlay className="duration-200 data-closed:fill-mode-forwards" />
        <DialogPrimitive.Popup
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 max-h-[90svh] overflow-y-auto overscroll-contain rounded-t-2xl bg-popover px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10 outline-none",
            "duration-200 data-closed:fill-mode-forwards data-closed:animate-out data-closed:slide-out-to-bottom data-open:animate-in data-open:slide-in-from-bottom",
            "sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[calc(100svh-4rem)] sm:w-[calc(100%-2rem)] sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:pb-5 sm:data-closed:fade-out-0 sm:data-closed:slide-out-to-bottom-2 sm:data-open:fade-in-0 sm:data-open:slide-in-from-bottom-2"
          )}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </DialogPrimitive.Root>
  )
}

export function PanelHeader({
  icon,
  title,
  mono = false,
  description,
}: {
  icon: React.ReactNode
  title: React.ReactNode
  mono?: boolean
  description?: React.ReactNode
}) {
  return (
    <>
      <div className="sticky top-0 z-10 -mx-4 flex items-center gap-2.5 bg-popover px-4 pt-2 pb-1 sm:pt-3">
        {icon}
        <DialogPrimitive.Title
          className={cn(
            "min-w-0 flex-1 text-lg leading-snug font-semibold break-words",
            mono && "font-mono text-base break-all"
          )}
        >
          {title}
        </DialogPrimitive.Title>
        <DialogPrimitive.Close
          render={
            <Button
              variant="ghost"
              size="icon-lg"
              className="-mr-2 size-11 shrink-0"
            />
          }
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </div>
      {description === undefined ? null : (
        <DialogPrimitive.Description className="mb-4 text-sm text-muted-foreground">
          {description}
        </DialogPrimitive.Description>
      )}
    </>
  )
}


/**
 * A fold with a 44 px summary. `group/fold`, named, so a chevron turns with ITS fold and not
 * with another one around it.
 */
export function Fold({
  title,
  defaultOpen = false,
  className,
  children,
}: {
  title: string
  defaultOpen?: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <details
      className={cn("group/fold", className)}
      open={defaultOpen || undefined}
    >
      <summary className="flex h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 transition-transform group-open/fold:rotate-180"
        />
      </summary>
      <div className="pb-1">{children}</div>
    </details>
  )
}

/**
 * Rows at rest, in one card: what a screen shows of the things a tap opens.
 *
 * The shape of the Keys page's token list, lifted so every screen draws its secondary things
 * the same way - an icon, a label, one short grey value, a chevron - and says nothing else
 * until tapped. `h-12`, above the 44 px every control here keeps.
 */
export function Rows({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <ul
      className={cn(
        "divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10",
        className
      )}
    >
      {children}
    </ul>
  )
}

export function Row({
  icon,
  label,
  value,
  tone = "muted",
  onOpen,
}: {
  icon?: React.ReactNode
  label: React.ReactNode
  /** One or two words, right-aligned: a state, a count, an address. */
  value?: React.ReactNode
  /** Only for a value that is a problem or a success; everything else stays grey. */
  tone?: "muted" | "ok" | "danger"
  onOpen: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex h-12 w-full items-center gap-3 px-3 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted"
      >
        {icon === undefined ? null : (
          <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">
            {icon}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {label}
        </span>
        {value === undefined ? null : (
          <span
            className={cn(
              "max-w-[50%] shrink-0 truncate text-xs",
              tone === "muted" && "text-muted-foreground",
              tone === "ok" && "text-emerald-600 dark:text-emerald-400",
              tone === "danger" && "text-destructive"
            )}
          >
            {value}
          </span>
        )}
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      </button>
    </li>
  )
}
