import * as React from "react"

import { Button } from "@/components/ui/button"

/**
 * A field of the connection card: the value, and the button that copies it.
 *
 * An SSH client on a phone has neither a desktop nor synchronisation: ~/.ssh/config never
 * arrives there, and these values are retyped by hand into a form. Copying is therefore the
 * main gesture of this screen and not a convenience - hence one button per field rather
 * than one button for the whole card, and a value in `break-all` that shows the fingerprint
 * whole rather than truncating it prettily.
 *
 * The fallback comes from public/main.js and it is real: Safari refuses the clipboard
 * outside a user gesture it recognises, and handing back control without saying anything
 * would leave an IP address silently uncopied. The value is already on screen, so the
 * fallback is to ask for it to be selected - and `user-select` stays allowed on the value so
 * that it is possible.
 */
export function CopyField({
  label,
  value,
  copiable = true,
  note,
  below,
}: {
  label: string
  value: string
  /** "devbox" is not copied: it is the name of a key already in the keyring. */
  copiable?: boolean
  note?: string
  below?: string
}) {
  return (
    <div className="border-b border-border py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="shrink-0 text-sm text-muted-foreground">{label}</span>
        <span className="ml-auto font-mono text-sm break-all select-text">
          {value}
        </span>
        {copiable ? <CopyButton value={value} /> : null}
      </div>
      {note ? (
        <p className="mt-1 text-xs text-muted-foreground">{note}</p>
      ) : null}
      {below ? (
        <p className="mt-1 text-xs text-muted-foreground">{below}</p>
      ) : null}
    </div>
  )
}

export function CopyButton({
  value,
  label = "copy",
}: {
  value: string
  label?: string
}) {
  const [said, setSaid] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (said === null) return
    const timer = setTimeout(() => setSaid(null), 1500)
    return () => clearTimeout(timer)
  }, [said])

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-9 shrink-0 px-3"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setSaid("copied")
        } catch {
          setSaid("select it")
        }
      }}
    >
      {said ?? label}
    </Button>
  )
}
