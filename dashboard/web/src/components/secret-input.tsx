import * as React from "react"
import { FileKeyIcon, XIcon } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/**
 * What was typed or loaded, until the save that sends it. `file` names the file it came
 * from, and a loaded value is then never drawn at all - only that name.
 */
export type Typed = { value: string; file: string | null }

/**
 * Past this, what was picked is not a secret. A service account key is two kilobytes, a
 * token a few dozen bytes: sixty-four is a margin, not a measurement, and the server keeps
 * its own ceiling.
 */
const LARGEST = 64 * 1024

/**
 * What every secret field carries, and what it is there to stop.
 *
 * No `type=password`, and no `<form>` around these fields either. A password field in a form
 * that submits is what Chrome offers to SAVE - `autocomplete=off` does not stop the offer -
 * and the only login it knows on this origin is the dashboard's own: one tap on "update
 * password" and the dashboard's password is a Hetzner token. A text field is nobody's
 * password, so the offer never comes. The data- attributes are for the managers that walk the
 * page on their own (1Password, LastPass, Bitwarden): nothing to fill here, nothing to learn.
 */
const UNREMEMBERED = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": true,
} as const

/**
 * A masked field whose text can be copied out is a "show" button by other means. A password
 * field refuses copy and cut; these do the same, and a paste still goes in.
 */
const hold = (event: React.ClipboardEvent) => event.preventDefault()

/**
 * A value that goes in and never comes back out.
 *
 * Nothing here is ever filled from the server: the vault answers with a fingerprint, and the
 * field starts empty whatever it holds. What the reader types lives in the caller's state for
 * exactly as long as it takes to send it - the caller empties it the moment the save leaves.
 *
 * Masked, and with no toggle: this is opened on a train, and a token drawn in clear on a phone
 * is a token the next seat has read. The mask is CSS (`.secret-mask`, index.css) on a text
 * field or a text zone, never a password field - see UNREMEMBERED for the managers, and the
 * HTML standard for the rest: a password field strips line breaks from its value, so a deploy
 * key pasted into one was stored as a single line, fingerprinted, and looked valid. Anything
 * that may hold several lines - the GCP key, a profile secret - is a text zone.
 *
 * The GCP key says what it reads as instead: the service account and its project, which are
 * names and not secrets.
 *
 * A file is read here, in the page, and never uploaded as a file: its text becomes the value
 * and goes out through the same PUT as a paste. The input is emptied at once - a File left in
 * an `<input type=file>` is the whole secret, reachable by anything that walks the DOM for as
 * long as the tab lives.
 */
export function SecretInput({
  id,
  multiline = false,
  rows = 4,
  json = false,
  loadable = false,
  typed,
  onChange,
  onEnter,
  placeholder,
  disabled,
  reveal = false,
}: {
  id: string
  /** A text zone rather than a line: the value may hold line breaks, and keeps them. */
  multiline?: boolean
  rows?: number
  /** The picker offers .json files, and what is typed is read back as a key would be. */
  json?: boolean
  /**
   * A file picker under the field. Not on a cloud token, which is one line a password
   * manager pastes - three pickers on the Scaleway card were three buttons nobody would
   * press. On the GCP key, which arrives as a download, and on a profile secret, which may be
   * anything a profile reads from /run/secrets, a deploy key's lines included.
   */
  loadable?: boolean
  typed: Typed
  onChange: (typed: Typed) => void
  /**
   * Return sends. Given by a card with ONE field; in a text zone, Shift+Return is then the
   * line break. Without it, return does what the field does: nothing on a line, a line break
   * in a zone.
   */
  onEnter?: () => void
  placeholder?: string
  disabled?: boolean
  /**
   * Drawn in clear, and copyable: for an identifier that is not a secret - a project's ID -
   * and above all for one the page filled in, which the reader has to be able to check.
   */
  reveal?: boolean
}) {
  const [refused, setRefused] = React.useState<string | null>(null)

  const type = (value: string) => {
    setRefused(null)
    onChange({ value, file: null })
  }

  const load = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const chosen = input.files?.[0]
    input.value = ""
    if (chosen === undefined) return
    if (chosen.size > LARGEST) {
      setRefused(
        `${chosen.name} is over ${LARGEST / 1024} KB: that is not a secret.`
      )
      return
    }
    let bytes: ArrayBuffer
    try {
      bytes = await chosen.arrayBuffer()
    } catch {
      setRefused(`${chosen.name} could not be read.`)
      return
    }
    const text = utf8(bytes)
    if (text === null) {
      setRefused(
        `${chosen.name} is not UTF-8 text. A secret travels as text from here, and this file would arrive altered: nothing was loaded.`
      )
      return
    }
    if (text.trim() === "") {
      setRefused(`${chosen.name} is empty: nothing was loaded.`)
      return
    }
    setRefused(null)
    onChange({ value: text, file: chosen.name })
  }

  const enter =
    onEnter === undefined
      ? undefined
      : (event: React.KeyboardEvent) => {
          // Shift+Return is a line break; a return that ends a composition (a keyboard that
          // builds characters, Safari flagging it by key code) belongs to the composition.
          if (event.key !== "Enter" || event.shiftKey) return
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          event.preventDefault()
          onEnter()
        }

  const reads = json && typed.value.trim() !== "" ? readKey(typed.value) : ""

  return (
    <div className="space-y-2">
      {typed.file !== null ? (
        <div className="flex h-12 items-center gap-2 rounded-lg border border-input pl-2.5 dark:bg-input/30">
          <FileKeyIcon aria-hidden className="size-4 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate font-mono text-sm">
            {typed.file}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="size-11"
            aria-label={`Drop ${typed.file}`}
            onClick={() => type("")}
            disabled={disabled}
          >
            <XIcon />
          </Button>
        </div>
      ) : multiline ? (
        <Textarea
          id={id}
          rows={rows}
          value={typed.value}
          onChange={(event) => type(event.target.value)}
          onKeyDown={enter}
          onCopy={hold}
          onCut={hold}
          placeholder={placeholder}
          disabled={disabled}
          enterKeyHint={onEnter === undefined ? undefined : "done"}
          {...UNREMEMBERED}
          className="secret-mask max-h-48 font-mono placeholder:font-sans"
        />
      ) : (
        <Input
          id={id}
          type="text"
          value={typed.value}
          onChange={(event) => type(event.target.value)}
          onKeyDown={enter}
          onCopy={reveal ? undefined : hold}
          onCut={reveal ? undefined : hold}
          placeholder={placeholder}
          disabled={disabled}
          enterKeyHint="done"
          {...UNREMEMBERED}
          className={cn(
            "h-12 font-mono text-base placeholder:font-sans",
            !reveal && "secret-mask"
          )}
        />
      )}

      {reads === "" ? null : (
        <p
          className={cn(
            "text-xs break-words",
            reads === null ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {reads ?? "Not JSON: the key Google hands out is a JSON file."}
        </p>
      )}

      {/* A label dressed as a button, around the input, and not a button calling .click()
          on a hidden one: the label is the platform's own way in, and iOS has refused
          programmatic clicks on file inputs in more than one version. */}
      {loadable ? (
        <label
          className={cn(
            buttonVariants({ variant: "outline", size: "lg" }),
            "h-11 cursor-pointer has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
            disabled && "pointer-events-none opacity-50"
          )}
        >
          <input
            type="file"
            accept={json ? ".json,application/json" : undefined}
            className="sr-only"
            onChange={load}
            disabled={disabled}
          />
          <FileKeyIcon data-icon="inline-start" />
          {json ? "Load the .json key" : "Load from a file"}
        </label>
      ) : null}

      {refused === null ? null : (
        <p className="text-sm break-words text-destructive">{refused}</p>
      )}
    </div>
  )
}

/**
 * The file's bytes as text, or null when they are not UTF-8.
 *
 * `File.text()` never refuses: it replaces every sequence it cannot decode with U+FFFD, and
 * the value sent is then a different secret with a fingerprint that looks like any other. The
 * decoder here refuses instead. A byte-order mark is kept, as the file has it: byte for byte is
 * the rule for a file, and a GCP key that starts with one is then read below as "Not JSON",
 * which says it rather than quietly mending it.
 */
function utf8(bytes: ArrayBuffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    )
  } catch {
    return null
  }
}

/**
 * What a pasted key says it is, without saying anything it holds.
 *
 * `client_email` is an identifier the console prints in clear; the rest of the document is the
 * private key, and none of it is repeated. The project is not said here: the Google Cloud panel
 * says it on its own line, the one that lets it change. The empty string means there is
 * nothing to say, null that it is not JSON at all.
 */
function readKey(text: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null
  const key = parsed as Record<string, unknown>
  return typeof key.client_email === "string"
    ? `Reads as ${key.client_email}.`
    : "JSON, but with no client_email: not a service account key?"
}
