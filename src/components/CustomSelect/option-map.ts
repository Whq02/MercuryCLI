
import type React from 'react'

export type OptionValue<T> = T | (string & {})

export type TextOption<T> = {
  type?: 'text'
  label: React.ReactNode
  value: OptionValue<T>
  description?: string
  dimDescription?: boolean
  disabled?: boolean
  indexLabel?: string
}

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
  allowEmptySubmitToCancel?: boolean
  showLabelWithValue?: boolean
  labelValueSeparator?: string
  resetCursorOnUpdate?: boolean
  indexLabel?: string
}

export type OptionWithDescription<T = string> = TextOption<T> | InputOption<T>

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
