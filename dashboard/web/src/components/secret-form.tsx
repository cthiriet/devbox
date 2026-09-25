import * as React from "react"
import { TriangleAlertIcon } from "lucide-react"

import { GuideSteps, Rich } from "@/components/guide"
import { SecretInput, type Typed } from "@/components/secret-input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { shapeWarning, stepsOf } from "@/hooks/use-catalogue"
import { reason } from "@/lib/api"
import { EMPTY_TYPED, sendable } from "@/lib/typed"
import type { SecretGuide } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * One profile secret, typed and saved: where to get it, the field, and what its shape says.
 *
 * The same form on /secrets, in the dialog /new opens on a blocked profile, and wherever else
 * a secret is asked for - so the GitHub token is described once, and the field that takes it
 * behaves the same everywhere.
 *
 * ONE LINE for a secret the catalogue knows: a token is one line a password manager pastes,
 * and a three-line zone with a file picker under it asked a reader to wonder what else could
 * go there. A name the catalogue does not describe - a hand-written profile may read a deploy
 * key - keeps the zone and the picker.
 *
 * The warning under the field is the catalogue's, from the value's first characters, and it
 * never stops a save: see shapeWarning. The value leaves this component's state before the
 * request does, like everywhere else a secret is typed (screens/secrets.tsx says why), so a
 * refusal costs a paste.
 */
export function SecretForm({
  id,
  name,
  guide,
  replacing,
  disabled = false,
  showGuide = true,
  onSave,
  onCancel,
}: {
  id: string
  name: string
  guide: SecretGuide | undefined
  replacing: boolean
  disabled?: boolean
  showGuide?: boolean
  /** Throws to refuse: the message is shown, and the reader pastes again. */
  onSave: (value: string) => Promise<void>
  onCancel?: () => void
}) {
  const [typed, setTyped] = React.useState<Typed>(EMPTY_TYPED)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const value = sendable(typed)
  const known = guide !== undefined
  const warning = typed.file === null ? shapeWarning(guide, typed.value) : null

  const save = async () => {
    if (value === "" || saving || disabled) return
    const sending = value
    setTyped(EMPTY_TYPED)
    setSaving(true)
    setError(null)
    try {
      await onSave(sending)
    } catch (failure) {
      setError(reason(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      {showGuide && known ? <GuideSteps steps={stepsOf(guide)} /> : null}
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {known
            ? replacing
              ? `New ${guide.label}`
              : guide.label
            : replacing
              ? "New value"
              : "Value"}
        </Label>
        {/* No <form>, though return still saves: a form that submits is what makes a
            password manager offer to keep what was typed. See secret-input.tsx. */}
        <SecretInput
          id={id}
          multiline={!known}
          rows={3}
          loadable={!known}
          typed={typed}
          onChange={(next) => {
            setTyped(next)
            setError(null)
          }}
          onEnter={() => void save()}
          placeholder={
            known
              ? `Paste the ${guide.label}`
              : `Paste ${name}, or load it from a file`
          }
          disabled={disabled || saving}
        />
        {warning === null ? null : (
          <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-words">
              <Rich text={warning} />
            </span>
          </p>
        )}
      </div>
      {error === null ? null : (
        <p role="alert" className="text-sm break-words text-destructive">
          {error.replace(/\.$/, "")}. Nothing was kept: paste it again.
        </p>
      )}
      <div
        className={cn(
          "grid gap-2",
          onCancel === undefined ? "grid-cols-1" : "grid-cols-2"
        )}
      >
        {onCancel === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="h-11"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
        )}
        <Button
          type="button"
          size="lg"
          className="h-11"
          onClick={() => void save()}
          disabled={disabled || saving || value === ""}
        >
          {saving ? <Spinner /> : "Save"}
        </Button>
      </div>
    </div>
  )
}
