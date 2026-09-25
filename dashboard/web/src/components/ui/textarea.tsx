import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The registry's textarea, in input.tsx's own classes so the two read as one family.
 *
 * Without `field-sizing-content`, which the registry ships and this drops: the text zones in
 * this app hold secrets - a service account key is twenty-eight lines of JSON, a deploy key
 * about as many - and a box that grew to fit them would push the Save button a screen away on
 * a phone.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
