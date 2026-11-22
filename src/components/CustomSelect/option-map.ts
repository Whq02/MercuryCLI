import { isEqualWith } from 'lodash-es'
import type React from 'react'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type OptionValue<T> = T | (string & {})

type TextOption<T> = {
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

export function optionsEquivalent<T>(
  a: readonly OptionWithDescription<T>[],
  b: readonly OptionWithDescription<T>[],
): boolean {
  return isEqualWith(a, b, (x: unknown, y: unknown) =>
    typeof x === 'function' && typeof y === 'function' ? true : undefined,
  )
}

export type OptionMapItem<T> = Unbuilt

export default class OptionMap<T> extends Map<OptionValue<T>, OptionMapItem<T>> {
  readonly first: OptionMapItem<T> | undefined
  readonly last: OptionMapItem<T> | undefined

  constructor(options: readonly OptionWithDescription<T>[]) {
    notBuilt('src/components/CustomSelect/option-map.ts:70')
    super(notBuilt('src/components/CustomSelect/option-map.ts:70'))
  }
}
