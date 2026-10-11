import { useCallback, useState } from 'react'
import { useSelectNavigation, type SelectNavigation } from './use-select-navigation.js'

type NavigationArgs<T> = Omit<Parameters<typeof useSelectNavigation<T>>[0], 'initialFocusValue'>

type Announce<T> = { onChange?: (value: T) => void; onCancel?: () => void }

type UseSelectStateProps<T> = NavigationArgs<T> & Announce<T> & { defaultValue?: T }

export type SelectState<T> = SelectNavigation<T> & Announce<T> & { value: T | undefined; selectFocusedOption: () => void; selectValue: (value: T) => void }

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

export function useSelectState<T>({ defaultValue, onChange, onCancel, visibleOptionCount = 5, ...navigationArgs }: UseSelectStateProps<T>): SelectState<T> {
  const navigation = useSelectNavigation({ visibleOptionCount, ...navigationArgs })
  const { value, commit } = useCommittedValue(defaultValue, onChange)
  const { focusedValue } = navigation
  const selectFocusedOption = useCallback(() => commit(focusedValue), [commit, focusedValue])
  return { ...navigation, value, selectFocusedOption, selectValue: commit, onChange, onCancel }
}
