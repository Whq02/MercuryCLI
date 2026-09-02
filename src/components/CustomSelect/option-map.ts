// The indexed, doubly-linked option map behind the selection kernel: every
// entry carries its option's fields, its neighbours and its absolute index,
// and the map exposes its first and last entries. The linked structure is
// what lets the focus machine skip disabled runs in either direction
// without re-scanning arrays.

import type React from 'react'

/** The value side accepts any string beyond the pinned union — callers mix
 *  literal-typed and plain-string entries in one options array. */
export type OptionValue<T> = T | (string & {})

/** A plain text row (the default). */
export type TextOption<T> = {
  type?: 'text'
  label: React.ReactNode
  value: OptionValue<T>
  description?: string
  dimDescription?: boolean
  disabled?: boolean
  /** Display ordinal replacing the numeric index prefix (e.g. 'A.' for the
   *  Apollo interview polls). Display-only: digit-key selection and option
   *  identity are untouched. Ignored under hideIndexes. */
  indexLabel?: string
}

/** A row containing an inline editable text field. */
export type InputOption<T> = {
  type: 'input'
  label: React.ReactNode
  value: OptionValue<T>
  description?: string
  dimDescription?: boolean
  disabled?: boolean
  onChange?: (value: string) => void
  placeholder?: string
  initialValue?: string
  /** When true, submitting an empty field counts as a valid submission and
   *  an initial Enter submits immediately rather than entering edit mode;
   *  when false (the default), submitting empty cancels. */
  allowEmptySubmitToCancel?: boolean
  /** Force the label to render alongside the value regardless of the
   *  component-wide inline-description setting. */
  showLabelWithValue?: boolean
  /** Label/value separator (default ", "). */
  labelValueSeparator?: string
  /** Snap the caret to end of line when the option gains focus or the value
   *  changes from anything other than the user's own keystroke. */
  resetCursorOnUpdate?: boolean
  /** Display ordinal replacing the numeric index prefix (see TextOption). */
  indexLabel?: string
}

export type OptionWithDescription<T = string> = TextOption<T> | InputOption<T>

/** Read an option's value at its pinned type — the public option shape
 *  admits plain strings beyond T (see OptionValue), the machinery below
 *  runs on T. */
export function optionValueOf<T>(option: OptionWithDescription<T>): T {
  return option.value as T
}

export function isInputOption<T>(
  option: OptionWithDescription<T> | undefined,
): option is InputOption<T> {
  return option?.type === 'input'
}

export type OptionMapItem<T> = {
  label: React.ReactNode
  value: OptionValue<T>
  description?: string
  disabled?: boolean
  previous: OptionMapItem<T> | undefined
  next: OptionMapItem<T> | undefined
  index: number
  option: OptionWithDescription<T>
}

export default class OptionMap<T> extends Map<OptionValue<T>, OptionMapItem<T>> {
  readonly first: OptionMapItem<T> | undefined
  readonly last: OptionMapItem<T> | undefined

  constructor(options: readonly OptionWithDescription<T>[]) {
    const entries: Array<[OptionValue<T>, OptionMapItem<T>]> = []
    let previous: OptionMapItem<T> | undefined
    let index = 0
    for (const option of options) {
      const item: OptionMapItem<T> = {
        label: option.label,
        value: option.value,
        description: option.description,
        disabled: option.disabled,
        previous,
        next: undefined,
        index,
        option,
      }
      if (previous) previous.next = item
      entries.push([option.value, item])
      previous = item
      index += 1
    }
    super(entries)
    this.first = entries[0]?.[1]
    this.last = previous
  }
}
