import * as React from "react"
import { ChevronRightIcon, PackageIcon } from "lucide-react"

import { FloorsLine, SecretMark } from "@/components/marks"
import type { Catalogue, Profile } from "@/lib/types"

/**
 * One profile at rest, the same on Profiles and on the order screen: its mark, its name, one
 * grey line, and whatever the page has to say about it beside the name.
 *
 * Shared because the two pages list the same profiles and a reader goes from one to the other:
 * a row that reads `claude` in large mono on one and with an icon, floors and a summary on the
 * other looks like two different things. What differs is the state, and each page passes its
 * own: a missing token on Profiles, what stands between the profile and a machine on /new.
 */
export function ProfileLine({
  profile,
  catalogue,
  badge,
}: {
  profile: Profile
  catalogue: Catalogue | null
  badge?: React.ReactNode
}) {
  const mark = MARKS.find((name) => profile.secrets.includes(name))
  return (
    <>
      <span className="flex shrink-0 text-muted-foreground">
        {mark === undefined ? (
          <PackageIcon aria-hidden className="size-[18px]" />
        ) : (
          <SecretMark name={mark} className="size-[18px]" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 truncate font-mono text-sm font-medium">
            {profile.name}
          </span>
          {badge}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {/* The floors first, and in the icons Specs uses on every offer: they are the
              three numbers that decide what a machine ordered with this profile costs. */}
          <FloorsLine floors={profile.floors} className="shrink-0 gap-2" />
          <span className="shrink-0 opacity-50">·</span>
          <Summary profile={profile} catalogue={catalogue} />
        </span>
      </span>
      <ChevronRightIcon
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
      />
    </>
  )
}

/**
 * The mark of what a profile is for, read off the keys it declares.
 *
 * In this order, and never from the software a composed spec names: the keys are the one
 * thing both kinds of profile carry, so one rule draws both lists rather than two rules
 * drifting apart. A profile that declares none takes the package, which is what it is: a
 * machine and nothing on it.
 *
 * It is a HINT and it is allowed to be wrong: a hand-written profile may call its secret
 * `claude` and install something else (which is why a value's prefix only ever warns, and the
 * page refuses to guess anywhere it would be read as a fact). The name beside it is what
 * identifies the profile; this only makes the list scannable.
 */
const MARKS = ["claude", "openrouter", "github"]

/**
 * `Claude Code, GitHub CLI · me/app · scripts/setup.sh`: what it installs, what it clones and
 * what it runs last, in one grey line.
 *
 * A profile written by hand has no spec to read - it is a file, and the form that would
 * describe it does not exist - so its line is what the file itself declares: the keys it asks
 * for, by the catalogue's names, and the repository when it names one. The software is NOT
 * inferred from a key: `claude` is the name of a secret, and a hand-written profile is free to
 * use it for something else. Guessing would read as a fact on a row nobody taps.
 */
function Summary({
  profile,
  catalogue,
}: {
  profile: Profile
  catalogue: Catalogue | null
}) {
  const ids = profile.authored?.software ?? []
  const setup = profile.authored?.setup ?? null
  // In the catalogue's order, which is the order they install in; ids until it has answered.
  const labels =
    catalogue === null
      ? ids
      : catalogue.software
          .filter((one) => ids.includes(one.id))
          .map((one) => one.label)
  const parts = [
    ...(labels.length === 0 ? [] : [labels.join(", ")]),
    ...(profile.repo === null ? [] : [shortRepo(profile.repo)]),
    ...(setup === null ? [] : [setup]),
  ]
  if (parts.length === 0) {
    const keys = profile.secrets.map(
      (name) =>
        catalogue?.secrets.find((guide) => guide.name === name)?.label ?? name
    )
    parts.push(keys.length === 0 ? "No token needed" : keys.join(", "))
  }
  return <span className="truncate">{parts.join(" · ")}</span>
}

/** `me/app` for github.com, `host/owner/name` elsewhere, the address whole when it is not one. */
function shortRepo(repo: string): string {
  try {
    const url = new URL(repo)
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "")
    return url.hostname === "github.com" ? path : `${url.hostname}/${path}`
  } catch {
    return repo
  }
}
