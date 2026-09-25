import * as React from "react"

import { api } from "@/lib/api"
import type { GuideStep } from "@/lib/clouds"
import type { Catalogue, SecretGuide } from "@/lib/types"

/**
 * The catalogue, asked once per page load and shared by every screen that names a secret.
 *
 * It is code on the server - a constant - so there is nothing to revalidate, and a badge, a
 * card and a dialog each asking for it would be three requests for the same bytes. A failure
 * is not kept: the next screen to mount asks again, and until then a secret is shown by its
 * name, which is what the page did before there was anything else to show.
 */
let held: Catalogue | null = null
let pending: Promise<Catalogue> | null = null

function load(): Promise<Catalogue> {
  if (pending === null) {
    pending = api.software().then(
      (catalogue) => {
        held = catalogue
        return catalogue
      },
      (error: unknown) => {
        pending = null
        throw error
      }
    )
  }
  return pending
}

export function useCatalogue(): Catalogue | null {
  const [catalogue, setCatalogue] = React.useState<Catalogue | null>(held)
  React.useEffect(() => {
    if (catalogue !== null) return
    let alive = true
    load().then(
      (answer) => {
        if (alive) setCatalogue(answer)
      },
      () => {
        // Names stand in for labels: see above.
      }
    )
    return () => {
      alive = false
    }
  }, [catalogue])
  return catalogue
}

/** The secrets by name, or an empty map until the catalogue has answered. */
export function useSecretGuides(): ReadonlyMap<string, SecretGuide> {
  const catalogue = useCatalogue()
  return React.useMemo(
    () =>
      new Map((catalogue?.secrets ?? []).map((guide) => [guide.name, guide])),
    [catalogue]
  )
}

/** `a GitHub token`, `an OpenRouter API key`, or `a secret named x` for a name with no guide. */
export function aSecret(name: string, guide: SecretGuide | undefined): string {
  if (guide === undefined) return `a secret named ${name}`
  return `${/^[aeiou]/i.test(guide.label) ? "an" : "a"} ${guide.label}`
}

/**
 * What to warn about a value from its shape, or null. Never a refusal: the server stores what
 * it is given, since a hand-written profile may name anything `claude`.
 */
export function shapeWarning(
  guide: SecretGuide | undefined,
  value: string
): string | null {
  const trimmed = value.trim()
  if (guide === undefined || trimmed === "") return null
  const mistake = guide.mistakes.find((one) => trimmed.startsWith(one.prefix))
  if (mistake !== undefined) return mistake.says
  if (guide.prefixes.length === 0) return null
  if (guide.prefixes.some((prefix) => trimmed.startsWith(prefix))) return null
  const starts = guide.prefixes.map((prefix) => `\`${prefix}\``)
  return `This does not look like ${aSecret(guide.name, guide)}, which starts with ${starts.join(" or ")}. It can be saved all the same.`
}

/** A profile secret's guide as steps: its one link goes under the first, where it is needed. */
export function stepsOf(guide: SecretGuide): GuideStep[] {
  return guide.steps.map((text, index) =>
    index === 0 && guide.link !== null ? { text, link: guide.link } : { text }
  )
}
