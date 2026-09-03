
import React, { useCallback, useEffect, useReducer, useRef } from 'react'
import OptionMap, {
  isInputOption,
  optionsEquivalent,
  type OptionMapItem,
  type OptionValue,
  type OptionWithDescription,
} from './option-map.js'

export function focusSeedAfterOptionsChange<T>(input: {
  focusedValue: OptionValue<T> | undefined
  options: readonly OptionWithDescription<T>[]
  focusValue: T | undefined
  initialFocusValue: T | undefined
}): OptionValue<T> | undefined {
  const { focusedValue, options, focusValue, initialFocusValue } = input
  if (focusedValue !== undefined && options.some(o => o.value === focusedValue)) {
    return focusedValue
  }
  return focusValue !== undefined ? focusValue : initialFocusValue
}

type NavigationState<T> = {
  optionMap: OptionMap<T>
  visibleOptionCount: number
  focusedValue: OptionValue<T> | undefined
  visibleFromIndex: number
  visibleToIndex: number
}

type CreateStateInput<T> = {
  options: readonly OptionWithDescription<T>[]
  visibleOptionCount?: number
  initialFocusValue?: OptionValue<T>
  currentViewport?: readonly [number, number]
}

function firstEnabled<T>(map: OptionMap<T>): OptionMapItem<T> | undefined {
  let item = map.first
  while (item && item.disabled) item = item.next
  return item
}

function lastEnabled<T>(map: OptionMap<T>): OptionMapItem<T> | undefined {
  let item = map.last
  while (item && item.disabled) item = item.previous
  return item
}

function createNavigationState<T>({
  options,
  visibleOptionCount,
  initialFocusValue,
  currentViewport,
}: CreateStateInput<T>): NavigationState<T> {
  const visible =
    typeof visibleOptionCount === 'number'
      ? Math.min(visibleOptionCount, options.length)
      : options.length
  const optionMap = new OptionMap(options)

  const explicit =
    initialFocusValue !== undefined ? optionMap.get(initialFocusValue) : undefined
  let focusedValue: OptionValue<T> | undefined
  if (explicit) {
    focusedValue = explicit.value
  } else {
    focusedValue = (firstEnabled(optionMap) ?? optionMap.first)?.value
  }

  let from = 0
  let to = visible
  if (explicit) {
    const index = explicit.index
    if (currentViewport) {
      const [currentFrom, currentTo] = currentViewport
      if (index >= currentFrom && index < currentTo) {
        from = currentFrom
        to = Math.min(currentTo, options.length)
      } else if (index < currentFrom) {
        from = index
        to = index + visible
      } else {
        to = index + 1
        from = to - visible
      }
    } else if (index >= visible) {
      to = index + 1
      from = to - visible
    }
    from = Math.max(0, Math.min(from, options.length - 1))
    to = Math.min(options.length, Math.max(to, visible))
  }

  return {
    optionMap,
    visibleOptionCount: visible,
    focusedValue,
    visibleFromIndex: from,
    visibleToIndex: to,
  }
}

type NavigationAction<T> =
  | { type: 'focus-next-option' }
  | { type: 'focus-previous-option' }
  | { type: 'focus-next-page' }
  | { type: 'focus-previous-page' }
  | { type: 'focus-value'; value: OptionValue<T> | undefined }
  | { type: 'reset'; state: NavigationState<T> }

function reduceNavigation<T>(
  state: NavigationState<T>,
  action: NavigationAction<T>,
): NavigationState<T> {
  const { optionMap, visibleOptionCount, focusedValue } = state
  const size = optionMap.size

  switch (action.type) {
    case 'focus-next-option': {
      const current =
        focusedValue !== undefined ? optionMap.get(focusedValue) : undefined
      if (!current) return state
      let next = current.next
      while (next && next.disabled) next = next.next
      if (!next) {
        const landing = firstEnabled(optionMap)
        if (!landing || landing.value === focusedValue) return state
        return {
          ...state,
          focusedValue: landing.value,
          visibleFromIndex: 0,
          visibleToIndex: visibleOptionCount,
        }
      }
      if (next.value === focusedValue) return state
      if (next.index >= state.visibleToIndex) {
        const to = Math.min(
          size,
          Math.max(next.index + 1, state.visibleToIndex + 1),
        )
        return {
          ...state,
          focusedValue: next.value,
          visibleFromIndex: to - visibleOptionCount,
          visibleToIndex: to,
        }
      }
      return { ...state, focusedValue: next.value }
    }

    case 'focus-previous-option': {
      const current =
        focusedValue !== undefined ? optionMap.get(focusedValue) : undefined
      if (!current) return state
      let previous = current.previous
      while (previous && previous.disabled) previous = previous.previous
      if (!previous) {
        const landing = lastEnabled(optionMap)
        if (!landing || landing.value === focusedValue) return state
        return {
          ...state,
          focusedValue: landing.value,
          visibleFromIndex: Math.max(0, size - visibleOptionCount),
          visibleToIndex: size,
        }
      }
      if (previous.value === focusedValue) return state
      if (previous.index <= state.visibleFromIndex) {
        const from = Math.max(
          0,
          Math.min(previous.index, state.visibleFromIndex - 1),
        )
        return {
          ...state,
          focusedValue: previous.value,
          visibleFromIndex: from,
          visibleToIndex: from + visibleOptionCount,
        }
      }
      return { ...state, focusedValue: previous.value }
    }

    case 'focus-next-page': {
      const current =
        focusedValue !== undefined ? optionMap.get(focusedValue) : undefined
      if (!current) return state
      const target = Math.min(current.index + visibleOptionCount, size - 1)
      let landing: OptionMapItem<T> | undefined
      for (let i = target; i < size; i++) {
        const item = itemAt(optionMap, i)
        if (item && !item.disabled) {
          landing = item
          break
        }
      }
      if (!landing) {
        for (let i = target; i > current.index; i--) {
          const item = itemAt(optionMap, i)
          if (item && !item.disabled) {
            landing = item
            break
          }
        }
      }
      if (!landing) return state
      const to = Math.min(size, Math.max(landing.index + 1, visibleOptionCount))
      return {
        ...state,
        focusedValue: landing.value,
        visibleFromIndex: Math.max(0, to - visibleOptionCount),
        visibleToIndex: to,
      }
    }

    case 'focus-previous-page': {
      const current =
        focusedValue !== undefined ? optionMap.get(focusedValue) : undefined
      if (!current) return state
      const target = Math.max(current.index - visibleOptionCount, 0)
      let landing: OptionMapItem<T> | undefined
      for (let i = target; i >= 0; i--) {
        const item = itemAt(optionMap, i)
        if (item && !item.disabled) {
          landing = item
          break
        }
      }
      if (!landing) {
        for (let i = target; i < current.index; i++) {
          const item = itemAt(optionMap, i)
          if (item && !item.disabled) {
            landing = item
            break
          }
        }
      }
      if (!landing) return state
      const from = Math.max(0, Math.min(landing.index, size - visibleOptionCount))
      return {
        ...state,
        focusedValue: landing.value,
        visibleFromIndex: from,
        visibleToIndex: Math.min(size, from + visibleOptionCount),
      }
    }

    case 'focus-value': {
      if (action.value === undefined) return state
      const item = optionMap.get(action.value)
      if (!item || item.value === focusedValue) return state
      if (
        item.index >= state.visibleFromIndex &&
        item.index < state.visibleToIndex
      ) {
        return { ...state, focusedValue: item.value }
      }
      let from: number
      let to: number
      if (item.index < state.visibleFromIndex) {
        from = item.index
        to = Math.min(size, from + visibleOptionCount)
      } else {
        to = item.index + 1
        from = Math.max(0, to - visibleOptionCount)
      }
      return {
        ...state,
        focusedValue: item.value,
        visibleFromIndex: from,
        visibleToIndex: to,
      }
    }

    case 'reset':
      return action.state

    default:
      return state
  }
}

function itemAt<T>(
  map: OptionMap<T>,
  index: number,
): OptionMapItem<T> | undefined {
  if (index < 0 || index >= map.size) return undefined
  let item = map.first
  while (item && item.index !== index) item = item.next
  return item
}

export type UseSelectNavigationProps<T> = {
  visibleOptionCount?: number
  options: OptionWithDescription<T>[]
  initialFocusValue?: T
  focusValue?: T
  onFocus?: (value: T) => void
}

export type SelectNavigation<T> = {
  focusedValue: T | undefined
  focusedIndex: number
  visibleFromIndex: number
  visibleToIndex: number
  visibleOptions: Array<OptionWithDescription<T> & { index: number }>
  options: OptionWithDescription<T>[]
  isInInput: boolean
  focusNextOption: () => void
  focusPreviousOption: () => void
  focusNextPage: () => void
  focusPreviousPage: () => void
  focusValue: (value: T | undefined) => void
}

export function useSelectNavigation<T>({
  visibleOptionCount = 5,
  options,
  initialFocusValue,
  focusValue,
  onFocus,
}: UseSelectNavigationProps<T>): SelectNavigation<T> {
  const [state, dispatch] = useReducer(
    reduceNavigation as React.Reducer<NavigationState<T>, NavigationAction<T>>,
    undefined,
    () =>
      createNavigationState({
        options,
        visibleOptionCount,
        initialFocusValue: focusValue ? focusValue : initialFocusValue,
      }),
  )

  const previousOptionsRef = useRef(options)
  if (
    previousOptionsRef.current !== options &&
    !optionsEquivalent(previousOptionsRef.current, options)
  ) {
    previousOptionsRef.current = options
    dispatch({
      type: 'reset',
      state: createNavigationState({
        options,
        visibleOptionCount,
        initialFocusValue: focusSeedAfterOptionsChange({
          focusedValue: state.focusedValue,
          options,
          focusValue,
          initialFocusValue,
        }),
        currentViewport: [state.visibleFromIndex, state.visibleToIndex],
      }),
    })
  } else {
    previousOptionsRef.current = options
  }

  const focusedItem =
    state.focusedValue !== undefined
      ? state.optionMap.get(state.focusedValue)
      : undefined
  const validatedFocusedValue = (
    focusedItem ? focusedItem.value : options[0]?.value
  ) as T | undefined

  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const lastNotifiedRef = useRef<T | undefined>(undefined)
  const hasNotifiedRef = useRef(false)
  useEffect(() => {
    if (validatedFocusedValue === undefined) return
    if (hasNotifiedRef.current && lastNotifiedRef.current === validatedFocusedValue) {
      return
    }
    hasNotifiedRef.current = true
    lastNotifiedRef.current = validatedFocusedValue
    onFocusRef.current?.(validatedFocusedValue)
  }, [validatedFocusedValue])

  useEffect(() => {
    dispatch({ type: 'focus-value', value: focusValue })
  }, [focusValue])

  const focusNextOption = useCallback(() => {
    dispatch({ type: 'focus-next-option' })
  }, [])
  const focusPreviousOption = useCallback(() => {
    dispatch({ type: 'focus-previous-option' })
  }, [])
  const focusNextPage = useCallback(() => {
    dispatch({ type: 'focus-next-page' })
  }, [])
  const focusPreviousPage = useCallback(() => {
    dispatch({ type: 'focus-previous-page' })
  }, [])
  const focusByValue = useCallback((value: T | undefined) => {
    dispatch({ type: 'focus-value', value })
  }, [])

  const visibleOptions: Array<OptionWithDescription<T> & { index: number }> = []
  for (let i = state.visibleFromIndex; i < state.visibleToIndex; i++) {
    const option = options[i]
    if (option !== undefined) visibleOptions.push({ ...option, index: i })
  }

  return {
    focusedValue: validatedFocusedValue,
    focusedIndex: focusedItem ? focusedItem.index + 1 : 0,
    visibleFromIndex: state.visibleFromIndex,
    visibleToIndex: state.visibleToIndex,
    visibleOptions,
    options,
    isInInput: isInputOption(focusedItem?.option),
    focusNextOption,
    focusPreviousOption,
    focusNextPage,
    focusPreviousPage,
    focusValue: focusByValue,
  }
}
