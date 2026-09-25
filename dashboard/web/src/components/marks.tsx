import {
  Cpu,
  GitBranchIcon,
  HardDrive,
  KeyRoundIcon,
  MemoryStick,
  type LucideIcon,
} from "lucide-react"
import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { useSecretGuides } from "@/hooks/use-catalogue"
import { cloudName } from "@/lib/clouds"
import { cn } from "@/lib/utils"
import { eur, eurPerMonth } from "@/lib/format"
import type { Floors, JobState } from "@/lib/types"
import {
  CheckIcon as StateDoneIcon,
  LoaderCircleIcon as StateRunningIcon,
  TriangleAlertIcon as StateCutIcon,
  XIcon as StateFailedIcon,
} from "lucide-react"

/**
 * The providers' own marks, drawn here for the reason GithubMark is: a single path each,
 * no package, nothing fetched at runtime.
 *
 * The paths are simple-icons' (CC0-1.0), which is the collection's licence and not the
 * marks': those stay Hetzner's, Scaleway's and Google's, and are used here for the one
 * thing a trademark is always free to be used for - saying which company this row came
 * from. Unmodified, therefore, and never recoloured to something the owner does not use.
 *
 * `currentColor` on all three, so each inherits the tone its badge already carries. The
 * temptation is the official hex - #D50C2D, #4F0599, #4285F4 - and it fails the dark
 * theme: Scaleway's violet on a near-black background is very nearly invisible, and this
 * interface is opened at night as often as not. The hue survives through the tone; the
 * shape is what says which cloud.
 */
const CLOUD_MARKS: Record<string, string> = {
  // A filled square with the H knocked out of it, which is the mark as Hetzner draws it.
  // It reads heavier than the other two at this size, and that is theirs to decide.
  hetzner:
    "M0 0v24h24V0H0zm4.602 4.025h2.244c.509 0 .716.215.716.717v5.64h8.883v-5.64c0-.509.215-.717.717-.717h2.229c.5 0 .71.23.724.717v14.516c0 .509-.215.717-.717.717h-2.23c-.51 0-.717-.215-.717-.717v-5.735H7.562v5.735c0 .516-.215.717-.716.717H4.602c-.51 0-.717-.208-.717-.717V4.742c0-.509.207-.717.717-.717z",
  scaleway:
    "M16.605 11.11v5.72a1.77 1.77 0 01-1.54 1.69h-4a1.43 1.43 0 01-1.31-1.22 1.09 1.09 0 010-.18 1.37 1.37 0 011.37-1.36h1.74a1 1 0 001-1v-3.62a1.4 1.4 0 011.18-1.39h.17a1.37 1.37 0 011.39 1.36zm-6.46 1.74V9.26a1 1 0 011-1h1.85a1.37 1.37 0 001.37-1.37 1 1 0 000-.17 1.45 1.45 0 00-1.41-1.2h-3.96a1.81 1.81 0 00-1.58 1.66v5.7a1.37 1.37 0 001.37 1.37h.21a1.4 1.4 0 001.15-1.4zm12-4.29V20a4.53 4.53 0 01-4.15 4h-7.58a8.57 8.57 0 01-8.56-8.57V4.54A4.54 4.54 0 016.395 0h7.18a8.56 8.56 0 018.56 8.56zm-2.74 0a5.83 5.83 0 00-5.82-5.82h-7.19a1.79 1.79 0 00-1.8 1.8v10.89a5.83 5.83 0 005.82 5.8h7.44a1.79 1.79 0 001.54-1.48z",
  // The three a tile on the settings page announces and nothing else orders on yet: same
  // source, same licence, and drawn in full rather than greyed into a silhouette, because a
  // reader recognises a provider by its shape and a blur is a riddle. What says they are not
  // ready is the word under them, not a mangled mark.
  // Three of these are NOT simple-icons' current files: AWS, Azure and Oracle were carried
  // until 12.0.0 and dropped afterwards, over the trademark policy those houses apply to icon
  // packs. These paths are that last CC0 release's, unchanged, and used for the one thing a
  // trademark is always free to be used for - saying which house a tile is about. Drawing
  // them as a generic cloud instead would have been the only alternative, and a provider
  // drawn as any provider says nothing.
  aws: "M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167zM21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607zM22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z",
  azure: "M22.379 23.343a1.62 1.62 0 0 0 1.536-2.14v.002L17.35 1.76A1.62 1.62 0 0 0 15.816.657H8.184A1.62 1.62 0 0 0 6.65 1.76L.086 21.204a1.62 1.62 0 0 0 1.536 2.139h4.741a1.62 1.62 0 0 0 1.535-1.103l.977-2.892 4.947 3.675c.28.208.618.32.966.32m-3.084-12.531 3.624 10.739a.54.54 0 0 1-.51.713v-.001h-.03a.54.54 0 0 1-.322-.106l-9.287-6.9h4.853m6.313 7.006c.116-.326.13-.694.007-1.058L9.79 1.76a1.722 1.722 0 0 0-.007-.02h6.034a.54.54 0 0 1 .512.366l6.562 19.445a.54.54 0 0 1-.338.684",
  oracle: "M16.412 4.412h-8.82a7.588 7.588 0 0 0-.008 15.176h8.828a7.588 7.588 0 0 0 0-15.176zm-.193 12.502H7.786a4.915 4.915 0 0 1 0-9.828h8.433a4.914 4.914 0 1 1 0 9.828z",
  vultr:
    "M8.36 2.172A1.194 1.194 0 007.348 1.6H1.2A1.2 1.2 0 000 2.8a1.211 1.211 0 00.182.64l11.6 18.4a1.206 1.206 0 002.035 0l3.075-4.874a1.229 1.229 0 00.182-.64 1.211 1.211 0 00-.182-.642zm10.349 8.68a1.206 1.206 0 002.035 0L21.8 9.178l2.017-3.2a1.211 1.211 0 00.183-.64 1.229 1.229 0 00-.183-.64l-1.6-2.526a1.206 1.206 0 00-1.016-.571h-6.148a1.2 1.2 0 00-1.201 1.2 1.143 1.143 0 00.188.64z",
  digitalocean:
    "M12.04 0C5.408-.02.005 5.37.005 11.992h4.638c0-4.923 4.882-8.731 10.064-6.855a6.95 6.95 0 014.147 4.148c1.889 5.177-1.924 10.055-6.84 10.064v-4.61H7.391v4.623h4.61V24c7.86 0 13.967-7.588 11.397-15.83-1.115-3.59-3.985-6.446-7.575-7.575A12.8 12.8 0 0012.039 0zM7.39 19.362H3.828v3.564H7.39zm-3.563 0v-2.978H.85v2.978z",
  ovh: "M19.881 10.095l2.563-4.45C23.434 7.389 24 9.404 24 11.555c0 2.88-1.017 5.523-2.71 7.594h-6.62l2.04-3.541h-2.696l3.176-5.513h2.691zm-2.32-5.243L9.333 19.14l.003.009H2.709C1.014 17.077 0 14.435 0 11.555c0-2.152.57-4.17 1.561-5.918L5.855 13.1 10.6 4.852h6.961z",
  gcp: "M12.19 2.38a9.344 9.344 0 0 0-9.234 6.893c.053-.02-.055.013 0 0-3.875 2.551-3.922 8.11-.247 10.941l.006-.007-.007.03a6.717 6.717 0 0 0 4.077 1.356h5.173l.03.03h5.192c6.687.053 9.376-8.605 3.835-12.35a9.365 9.365 0 0 0-2.821-4.552l-.043.043.006-.05A9.344 9.344 0 0 0 12.19 2.38zm-.358 4.146c1.244-.04 2.518.368 3.486 1.15a5.186 5.186 0 0 1 1.862 4.078v.518c3.53-.07 3.53 5.262 0 5.193h-5.193l-.008.009v-.04H6.785a2.59 2.59 0 0 1-1.067-.23h.001a2.597 2.597 0 1 1 3.437-3.437l3.013-3.012A6.747 6.747 0 0 0 8.11 8.24c.018-.01.04-.026.054-.023a5.186 5.186 0 0 1 3.67-1.69z",
}

/** One provider's mark, or nothing at all where devbox knows a cloud this file does not. */
export function CloudMark({
  cloud,
  className,
}: {
  cloud: string
  className?: string
}) {
  const path = CLOUD_MARKS[cloud]
  if (path === undefined) return null
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d={path} />
    </svg>
  )
}

/**
 * The three marks that come back everywhere: a cloud, a price, floors.
 *
 * A cloud keeps the same colour from one screen to the next, as in the Ink tables
 * (cli/src/ui/Table.tsx#cloudColor): hetzner red, scaleway magenta, gcp blue. This is not
 * decorative - it is what makes it possible to spot at a glance, in a list of offers sorted
 * by price and not by provider, that the first four rows all come from the same place.
 *
 * The provider's own mark sits in front of the name, and the NAME STAYS. A 12 px
 * monochrome glyph is a reminder for someone who already knows the three, not a label: on
 * a list of 1750 offers the word is what a reader who has met Scaleway once can still
 * read. Same posture as RepoLine, which draws GitHub's mark and spells the path anyway.
 *
 * The company's name, in the page's own type, since 13/09: it was the data's id in mono -
 * `gcp`, lowercase - which read as an abbreviation to decode rather than as Google Cloud.
 */
export function CloudBadge({
  cloud,
  className,
}: {
  cloud: string
  className?: string
}) {
  // Both themes are served: the dark background is the one opened at night, but the
  // provider switches to light and a pale red on white does not read.
  const tone =
    cloud === "hetzner"
      ? "bg-red-500/15 text-red-700 dark:text-red-300"
      : cloud === "scaleway"
        ? "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300"
        : cloud === "gcp"
          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
          : "bg-muted text-muted-foreground"
  return (
    <Badge variant="ghost" className={cn(tone, className)}>
      {/* No size class: the badge already forces `size-3` on any svg it holds, and the
          gap with it. One place decides how a mark sits in a badge. */}
      <CloudMark cloud={cloud} />
      {cloudName(cloud)}
    </Badge>
  )
}

/**
 * A price, by the hour or by the month.
 *
 * `value` is the hourly price in both cases - the month is derived here and nowhere else, so
 * the ×730 is written once for the whole interface and three screens cannot drift apart on
 * the same machine.
 *
 * The hour is always the same colour, and never the colour of anything else: it is the
 * number this tool exists for, and the fault it guards against is forgetting the third
 * machine. The month is deliberately quieter - grey, and left to whatever size it is given.
 * It is the figure that decides whether a machine is worth keeping until next week, which is
 * a slower question than the one the hour answers, and a second amber number beside the
 * first would only make the eye choose between them.
 */
export function Price({
  value,
  per = "hour",
  className,
}: {
  value: number | null
  per?: "hour" | "month"
  className?: string
}) {
  const month = per === "month"
  // The em dash is `eur`'s answer to an absent price; the month has to give the same one
  // rather than print `NaN` where a machine's price never came back.
  const amount =
    value === null || Number.isNaN(value)
      ? "-"
      : month
        ? eurPerMonth(value)
        : eur(value)
  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        month ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400",
        className
      )}
    >
      {amount}{" "}
      <span className={month ? undefined : "text-muted-foreground"}>
        {month ? "EUR/mo" : "EUR/h"}
      </span>
    </span>
  )
}

/**
 * What a machine is made of: cores, memory, disk - each behind its own icon.
 *
 * IT USED TO READ `4c 8G 80G`, and that is exactly as clear as it looks. Two of the three
 * numbers carried the same letter, so the only thing separating memory from disk was their
 * order, which a reader has to already know to make any use of. On the offers list the
 * confusion is not academic: `4c 8G 80G` and `4c 80G 8G` describe machines nobody would pay
 * the same for, and nothing on the row said which one was on screen.
 *
 * So the unit is drawn rather than spelled. The icon says WHICH quantity, the number says
 * how much, and `GB` stays on the two that share it - an icon is a hint, not a legend, and a
 * reader meeting this screen for the first time should not have to learn a vocabulary before
 * buying a machine.
 *
 * Out loud it is a sentence instead, and not through an `aria-label` on the wrapper: a
 * `aria-label` on a plain `span` carries no role for it to name, and screen readers are free
 * to ignore it - several do. So the drawn version is hidden outright and a `sr-only`
 * sentence sits beside it, which is the one form nothing has to interpret. Without it a
 * reader by ear got `4` `4GB` `80GB`, three fragments with no nouns, which is worse than the
 * line this replaced.
 */
function Spec({
  icon: Icon,
  value,
  unit,
  dim,
}: {
  icon: typeof Cpu
  value: number
  unit?: string
  dim?: boolean
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        dim === true ? "text-muted-foreground" : undefined
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0 opacity-70" />
      <span className="font-mono tabular-nums">
        {value}
        {unit === undefined ? null : <span className="ml-0.5">{unit}</span>}
      </span>
    </span>
  )
}

/** The three of them in a row, as an offer states them. */
export function Specs({
  cpu,
  ramGb,
  diskGb,
  className,
}: {
  cpu: number
  ramGb: number
  diskGb: number
  className?: string
}) {
  return (
    <>
      <span className="sr-only">
        {cpu} cores, {ramGb} GB of memory, {diskGb} GB of disk
      </span>
      <span
        aria-hidden
        className={cn("inline-flex items-center gap-3", className)}
      >
        <Spec icon={Cpu} value={cpu} />
        <Spec icon={MemoryStick} value={ramGb} unit="GB" />
        <Spec icon={HardDrive} value={diskGb} unit="GB" />
      </span>
    </>
  )
}

/**
 * The same three, as floors, dimmed where the profile asked for nothing.
 *
 * The numbers are always the effective numbers - cli/src/floors.ts explains why a `?` was
 * worse than useless - and the dimming is all that is left of the distinction: on a profile
 * that sets only cores and memory, those come from the profile and the disk from devbox-core's template,
 * which is the whole difference between a floor that was chosen and one that is inherited.
 *
 * Same icons as `Specs`, deliberately: the floors and the offers they filter are the same
 * three quantities, and drawing them differently on two screens one step apart would make a
 * reader stop to check whether they are.
 */
export function FloorsLine({
  floors,
  className,
}: {
  floors: Floors
  className?: string
}) {
  return (
    <>
      <span className="sr-only">
        at least {floors.cpu.value} cores, {floors.ram.value} GB of memory,{" "}
        {floors.disk.value} GB of disk
      </span>
      <span
        aria-hidden
        className={cn("inline-flex items-center gap-3", className)}
      >
        <Spec icon={Cpu} value={floors.cpu.value} dim={!floors.cpu.declared} />
        <Spec
          icon={MemoryStick}
          value={floors.ram.value}
          unit="GB"
          dim={!floors.ram.declared}
        />
        <Spec
          icon={HardDrive}
          value={floors.disk.value}
          unit="GB"
          dim={!floors.disk.declared}
        />
      </span>
    </>
  )
}

/**
 * A job's state, in one word.
 *
 * `interrupted` is not a synonym of `failed`, and it is not coloured like it by accident: it
 * means the service restarted in the middle, and therefore that a machine may exist at the
 * provider without any state knowing about it. It is the only state that calls for going to
 * check elsewhere.
 */
export function JobStateLabel({ state }: { state: JobState }) {
  if (state === "running")
    return <span className="text-emerald-500">running</span>
  if (state === "succeeded")
    return <span className="text-muted-foreground">finished</span>
  if (state === "interrupted")
    return <span className="text-destructive">interrupted</span>
  return <span className="text-destructive">failed</span>
}

/**
 * GitHub's own mark, drawn here because lucide dropped its brand icons.
 *
 * Filled rather than stroked, which is how a logo is drawn and what makes it read as a
 * logo beside the stroked family around it. `currentColor`, so it inherits the muted grey
 * of the line it sits on instead of importing a second palette into a card.
 */
const GITHUB_PATH =
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"

export function GithubMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d={GITHUB_PATH} />
    </svg>
  )
}

/**
 * The mark of the thing a token is FOR, keyed by the secret's NAME.
 *
 * Same posture as CLOUD_MARKS above, and the same source: simple-icons' paths (CC0-1.0),
 * which is the collection's licence and not the marks' - those stay GitHub's, Anthropic's
 * and opencode's, unmodified and in `currentColor` so each takes the tone of the row it
 * sits on. Three lines that read `Added` in the same grey, one under the other, are told
 * apart by their shape before they are read.
 *
 * The software the value is SPENT BY, and not the company that hands it out: `openrouter`
 * is an OpenRouter key, and it carries opencode's mark because opencode is what asks for
 * it, what the profile of that name installs, and what the reader is coming here to set
 * up. `claude` carries Claude's mark for the same reason rather than Anthropic's A - the
 * row says "Claude Code token", and the value signs Claude Code in. It is the profiles'
 * three secrets, drawn as the three pieces of software they belong to.
 *
 * A profile written by hand may call its secret anything, and a name SECRET_GUIDES does not
 * describe keeps the plain key rather than being guessed at: `acme-vpn` is nobody's brand
 * here.
 */
const SECRET_MARKS: Record<string, string> = {
  github: GITHUB_PATH,
  claude:
    "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  // A frame with a block knocked out of it, which is the mark as opencode draws it.
  openrouter: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
}

/**
 * The software a profile installs, under the mark of the token it signs in with.
 *
 * The same paths as SECRET_MARKS, deliberately: on /profiles the agent and its token are two
 * rows of one tile - "Claude Code", and under it "Claude Code token, Added" - and drawing
 * them with two different glyphs made them look like two things to arrange rather than one
 * thing to set up. `opencode` carries the mark its key already carries, which is the same
 * answer read from the other end: the software is what the key is for.
 *
 * Only the three that read a token. Node, a browser, an interpreter have no mark here and
 * want none: they are a fold at the bottom of that form, not a decision.
 */
const SOFTWARE_MARKS: Record<string, string> = {
  claude: "claude",
  opencode: "openrouter",
  gh: "github",
}

/** One piece of software, marked as its token is, or nothing where it reads none. */
export function SoftwareMark({
  id,
  className,
}: {
  id: string
  className?: string
}) {
  const secret = SOFTWARE_MARKS[id]
  if (secret === undefined) return null
  return <SecretMark name={secret} className={className} />
}

/** One secret's software, or a plain key for a name no guide describes. */
export function SecretMark({
  name,
  className,
}: {
  name: string
  className?: string
}) {
  const path = SECRET_MARKS[name]
  if (path === undefined)
    return <KeyRoundIcon aria-hidden className={className} />
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d={path} />
    </svg>
  )
}

/**
 * A repository, as the eye reads it rather than as it is typed.
 *
 * `me/mine` and not `https://github.com/me/mine.git`: the scheme,
 * the host and the suffix are the same on every row, so they were four words of noise that
 * wrapped onto a second line on a phone. The mark says the host instead, in a glance - and
 * it is chosen from the URL rather than assumed, because a profile may name a GitLab and a
 * GitHub logo on it would be a small lie. The whole URL stays in `title`, for the once a
 * year somebody copies it.
 */
export function RepoLine({
  repo,
  icon = true,
  className,
}: {
  repo: string | null
  /** Off where a label already says "Repository": the mark would say it twice. */
  icon?: boolean
  className?: string
}) {
  // Nothing at all. A line saying there is no repository describes a thing that is not
  // there, on a card scanned rather than read: the absence of the line is the same
  // statement, in the space it was taking. What a profile clones is on the cards that
  // clone something.
  if (repo === null) return null

  let host = ""
  let path = repo
  try {
    const url = new URL(repo)
    host = url.hostname
    path = url.pathname.replace(/^\//, "").replace(/\.git$/, "")
  } catch {
    // An scp-style remote (git@host:owner/name.git), or anything else this does not parse:
    // shown whole rather than mangled by a guess.
  }

  return (
    <p
      title={repo}
      className={cn(
        "flex items-center gap-1.5 text-sm text-muted-foreground",
        className
      )}
    >
      {icon ? (
        host === "github.com" ? (
          <GithubMark className="size-3.5 shrink-0" />
        ) : (
          <GitBranchIcon className="size-3.5 shrink-0" />
        )
      ) : null}
      <span className="font-mono break-all">
        {host === "" || host === "github.com" ? path : `${host}/${path}`}
      </span>
    </p>
  )
}

/**
 * The secrets a profile declares, one chip each, and the missing ones in red.
 *
 * They were a sentence - "expected secrets: claude, github" - which reads as prose and
 * scans as nothing: on a screen whose whole job is comparing two profiles at a glance, a
 * name is a thing and deserves an edge. Red is not decoration either: a red chip is a
 * profile this service cannot seed, and the card says underneath what to do about it.
 *
 * Each chip reads as the catalogue names the secret - "GitHub token" - and a name it does not
 * describe is shown as it is, in the same type. They were all identifiers in mono until 13/09,
 * which a customer took for words of configuration, and the undescribed ones kept the mono until
 * 15/09: a hand-written profile's `vpn` then read as code beside the "GitHub token" next to it.
 */
export function SecretChips({
  secrets,
  missing,
  icon = true,
  className,
}: {
  secrets: string[]
  missing?: string[]
  /** Off where a label already says "Secrets". */
  icon?: boolean
  className?: string
}) {
  const guides = useSecretGuides()
  const absent = missing ?? []
  return (
    <p className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {icon ? (
        <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      {secrets.length === 0 ? (
        <span className="text-sm text-muted-foreground">no token needed</span>
      ) : (
        secrets.map((secret) => {
          const label = guides.get(secret)?.label
          return (
            <Badge
              key={secret}
              variant={absent.includes(secret) ? "destructive" : "outline"}
            >
              {label ?? secret}
            </Badge>
          )
        })
      )}
    </p>
  )
}

/**
 * One fact, with the mark that says which fact it is.
 *
 * A machine's row carries seven of them - cloud, region, shape, profile, name, address,
 * age - and until 27/08 they were seven grey words in a row, in one weight, with no
 * labels: `scaleway fr-par-1 DEV1-L claude devbox-k2m7v 203.0.113.21 up 4 h 16`. Every
 * one of them is a different kind of thing and the line said so nowhere, so reading it
 * meant knowing the order by heart.
 *
 * A mark per fact costs 14 px and removes the guessing. `mono` for the ones a machine
 * produced and a person types back - the name and the address - as everywhere else here.
 */
export function Meta({
  icon: Icon,
  mono,
  children,
}: {
  icon: LucideIcon
  mono?: boolean
  children: ReactNode
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 opacity-70" />
      <span className={mono ? "font-mono break-all" : undefined}>
        {children}
      </span>
    </span>
  )
}

/**
 * A job's state as a mark, for a row with no room for a word: a spinner, a tick, a cross.
 *
 * `interrupted` keeps a mark of its own rather than the cross, for JobStateLabel's reason: it
 * is the one state that sends the reader to check elsewhere. The word stays, for a reader by
 * ear.
 */
export function JobStateIcon({
  state,
  className,
}: {
  state: JobState
  className?: string
}) {
  return (
    <span className={cn("inline-flex shrink-0", className)}>
      {state === "running" ? (
        <StateRunningIcon
          aria-hidden
          className="size-4 animate-spin text-muted-foreground"
        />
      ) : state === "succeeded" ? (
        <StateDoneIcon
          aria-hidden
          className="size-4 text-emerald-600 dark:text-emerald-400"
        />
      ) : state === "interrupted" ? (
        <StateCutIcon aria-hidden className="size-4 text-destructive" />
      ) : (
        <StateFailedIcon aria-hidden className="size-4 text-destructive" />
      )}
      <span className="sr-only">
        {state === "running"
          ? "Running"
          : state === "succeeded"
            ? "Done"
            : state === "interrupted"
              ? "Interrupted"
              : "Failed"}
      </span>
    </span>
  )
}
