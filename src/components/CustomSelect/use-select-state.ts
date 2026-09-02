
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
  focusValue?: T
}

export type SelectState<T> = SelectNavigation<T> & {
  value: T | undefined
  selectFocusedOption: () => void
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
