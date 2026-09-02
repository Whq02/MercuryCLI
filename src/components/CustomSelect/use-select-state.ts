// The single-select state layer: navigation plus a selected value seeded
// from a default. It exposes both "select the currently focused option" and
// "select this exact value" — the second exists because focus updates
// asynchronously, and a mouse click must select the row that was clicked,
// not whatever focus happens to hold.
//
// This layer passes NO initial focus value down to navigation: the
// component's own defaultFocusValue reaches navigation as the CONTROLLED
// focus value instead, which both seeds the opening focus and re-asserts
// focus whenever the caller changes it.

import { useCallback, useState } from 'react'
import type { OptionWithDescription } from './option-map.js'
import {
  useSelectNavigation,
  type SelectNavigation,
} from './use-select-navigation.js'

export type UseSelectStateProps<T> = {
  visibleOptionCount?: number
  options: OptionWithDescription<T>[]
  defaultValue?: T
  onChange?: (value: T) => void
  onCancel?: () => void
  onFocus?: (value: T) => void
  /** Controlled focus (the component's defaultFocusValue rides here). */
  focusValue?: T
}

export type SelectState<T> = SelectNavigation<T> & {
  /** The currently selected value. */
  value: T | undefined
  /** Commit the focused option as the selection and fire the change
   *  callback with it. */
  selectFocusedOption: () => void
  /** Commit this exact value (the click path). */
  selectValue: (value: T) => void
  onChange?: (value: T) => void
  onCancel?: () => void
}

export function useSelectState<T>({
  visibleOptionCount = 5,
  options,
  defaultValue,
  onChange,
  onCancel,
  onFocus,
  focusValue,
}: UseSelectStateProps<T>): SelectState<T> {
  const navigation = useSelectNavigation({
    visibleOptionCount,
    options,
    focusValue,
    onFocus,
  })
  const [value, setValue] = useState<T | undefined>(defaultValue)

  const { focusedValue } = navigation
  const selectFocusedOption = useCallback(() => {
    if (focusedValue === undefined) return
    setValue(focusedValue)
    onChange?.(focusedValue)
  }, [focusedValue, onChange])

  const selectValue = useCallback(
    (next: T) => {
      setValue(next)
      onChange?.(next)
    },
    [onChange],
  )

  return {
    ...navigation,
    value,
    selectFocusedOption,
    selectValue,
    onChange,
    onCancel,
  }
}
