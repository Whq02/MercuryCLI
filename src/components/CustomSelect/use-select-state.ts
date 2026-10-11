import { useCallback, useState } from 'react'
import type { OptionWithDescription } from './option-map.js'
import { useSelectNavigation, type SelectNavigation } from './use-select-navigation.js'

type UseSelectStateProps<T> = {
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

function useCommittedValue<T>(defaultValue: T | undefined, onChange: ((value: T) => void) | undefined) {
  const [value, setValue] = useState<T | undefined>(defaultValue)
  const commit = useCallback(
    (next: T | undefined): void => {
      if (next === undefined) return
      setValue(next)
      onChange?.(next)
    },
    [onChange],
  )
  return { value, commit }
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
  const navigation = useSelectNavigation({ visibleOptionCount, options, focusValue, onFocus })
  const { value, commit } = useCommittedValue(defaultValue, onChange)
  const { focusedValue } = navigation
  const selectFocusedOption = useCallback(() => commit(focusedValue), [commit, focusedValue])
  return { ...navigation, value, selectFocusedOption, selectValue: commit, onChange, onCancel }
}
