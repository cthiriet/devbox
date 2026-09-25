import type { Typed } from "@/components/secret-input"

/**
 * What a secret field holds, outside the component that draws it: a component file exporting
 * values breaks fast refresh (react-refresh/only-export-components), and three screens need
 * these two.
 */
export const EMPTY_TYPED: Typed = { value: "", file: null }

/**
 * What a save would send: nothing for a blank field, and a value on one line without the
 * spaces and the newline a paste drags along. A file, and anything typed on several lines - a
 * deploy key, a JSON key - go byte for byte: a key's line breaks are the key, and its trailing
 * newline is the file's business, not this page's.
 */
export function sendable(typed: Typed | undefined): string {
  if (typed === undefined) return ""
  const trimmed = typed.value.trim()
  if (trimmed === "") return ""
  return typed.file !== null || /[\r\n]/.test(trimmed) ? typed.value : trimmed
}
