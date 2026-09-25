import type { ReactNode } from "react"
import { ArrowUpRightIcon } from "lucide-react"

import type { GuideStep } from "@/lib/clouds"
import { cn } from "@/lib/utils"

/**
 * How to get a token, drawn the same way for a cloud and for a profile secret.
 *
 * A guide is the answer to the question this page left open until 13/09: where does the
 * value come from. There was not one link out of the interface, and a reader holding a phone
 * was asked for HCLOUD_TOKEN with nothing to say which company hands one out, or where.
 */

/**
 * Text with `commands` between backticks set in mono, and nothing else interpreted: no HTML,
 * no markdown. A catalogue string printed raw showed its backticks, which read as noise to
 * anyone who has never typed a command.
 */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code
            key={index}
            className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] break-all"
          >
            {part}
          </code>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  )
}

/**
 * A provider's page, in a new tab: the reader comes back here with a token to paste, and a
 * page that navigated away would have lost what else was typed. `noopener noreferrer`, so the
 * provider's page gets no handle on this one and no address from it.
 */
export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string
  children: ReactNode
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex min-h-11 items-center gap-1 font-medium underline underline-offset-4",
        className
      )}
    >
      {children}
      <ArrowUpRightIcon aria-hidden className="size-4 shrink-0" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  )
}

/** The steps, numbered, each with the link it needs right under it. */
export function GuideSteps({
  steps,
  className,
}: {
  steps: GuideStep[]
  className?: string
}) {
  if (steps.length === 0) return null
  return (
    <ol className={cn("space-y-2 text-sm", className)}>
      {steps.map((step, index) => (
        <li key={index} className="flex gap-2.5">
          {/* aria-hidden: the ordered list already announces "2 of 4". */}
          <span
            aria-hidden
            className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums"
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="leading-snug break-words">
              <Rich text={step.text} />
            </p>
            {step.link === undefined ? null : (
              <ExternalLink href={step.link.href} className="-mb-2 text-sm">
                {step.link.text}
              </ExternalLink>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}
