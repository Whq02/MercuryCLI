import { useCallback, useReducer, useRef } from 'react'
import { usePublish } from '../effects/effects.js'
import OptionMap, {
  isInputOption,
  optionsEquivalent,
  optionValueOf,
  type OptionMapItem,
  type OptionValue,
  type OptionWithDescription,
} from './optionMap.js'

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

export type NavigationState<T> = {
  optionMap: OptionMap<T>
  visibleOptionCount: number
  focusedValue: OptionValue<T> | undefined
  visibleFromIndex: number
  visibleToIndex: number
}

export type CreateStateInput<T> = {
  options: readonly OptionWithDescription<T>[]
  visibleOptionCount?: number
  initialFocusValue?: OptionValue<T>
  previousViewport?: readonly [number, number]
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

export function createNavigationState<T>({
  visibleOptionCount,
  options,
  initialFocusValue,
  previousViewport,
}: CreateStateInput<T>): NavigationState<T> {
  const optionMap = new OptionMap(options)
  const count =
    typeof visibleOptionCount === 'number'
      ? Math.min(visibleOptionCount, options.length)
      : options.length
  const explicitItem =
    initialFocusValue !== undefined ? optionMap.get(initialFocusValue) : undefined
  const initialItem = explicitItem ?? firstEnabled(optionMap) ?? optionMap.first
  const focusedValue = initialItem?.value

  let visibleFromIndex = 0
  let visibleToIndex = count

  if (explicitItem !== undefined) {
    if (previousViewport !== undefined) {
      visibleFromIndex = Math.max(
        0,
        Math.min(previousViewport[0], options.length - count),
      )
      visibleToIndex = visibleFromIndex + count
      if (explicitItem.index < visibleFromIndex) {
        visibleFromIndex = explicitItem.index
        visibleToIndex = visibleFromIndex + count
      }
    }
    if (explicitItem.index >= visibleToIndex) {
      visibleToIndex = explicitItem.index + 1
      visibleFromIndex = visibleToIndex - count
    }
  }

  visibleFromIndex = Math.max(0, Math.min(visibleFromIndex, options.length))
  visibleToIndex = Math.max(
    visibleFromIndex,
    Math.min(visibleToIndex, options.length),
  )

  return {
    optionMap,
    visibleOptionCount: count,
    focusedValue,
    visibleFromIndex,
    visibleToIndex,
  }
}

export type NavigationAction<T> =
  | { type: 'focus-next-option' }
  | { type: 'focus-previous-option' }
  | { type: 'focus-next-page' }
  | { type: 'focus-previous-page' }
  | { type: 'focus-first-option' }
  | { type: 'focus-last-option' }
  | { type: 'focus-value'; value: OptionValue<T> | undefined }
  | { type: 'reset'; state: NavigationState<T> }

export function reduceNavigation<T>(
  state: NavigationState<T>,
  action: NavigationAction<T>,
): NavigationState<T> {
  const { optionMap, visibleOptionCount, focusedValue } = state
  const size = optionMap.size

  switch (action.type) {
    case 'focus-first-option': {
      const landing = firstEnabled(optionMap)
      if (!landing || landing.value === focusedValue) return state
      const to = Math.min(size, Math.max(visibleOptionCount, landing.index + 1))
      return {
        ...state,
        focusedValue: landing.value,
        visibleFromIndex: Math.max(0, to - visibleOptionCount),
        visibleToIndex: to,
      }
    }

    case 'focus-last-option': {
      const landing = lastEnabled(optionMap)
      if (!landing || landing.value === focusedValue) return state
      const from = Math.max(0, Math.min(landing.index, size - visibleOptionCount))
      return {
        ...state,
        focusedValue: landing.value,
        visibleFromIndex: from,
        visibleToIndex: Math.min(size, from + visibleOptionCount),
      }
    }

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

type UseSelectNavigationProps<T> = {
  visibleOptionCount?: number
  options: OptionWithDescription<T>[]
  initialFocusValue?: T
  focusValue?: T
  onFocus?: (value: T) => void
}

export type SelectNavigation<T> = {
  options: OptionWithDescription<T>[]
  visibleOptions: Array<OptionWithDescription<T> & { index: number }>
  visibleFromIndex: number
  visibleToIndex: number
  focusedValue: T | undefined
  focusedIndex: number
  isInInput: boolean
  focusNextOption: () => void
  focusPreviousOption: () => void
  focusNextPage: () => void
  focusPreviousPage: () => void
  focusFirstOption: () => void
  focusLastOption: () => void
  focusValue: (value: OptionValue<T> | undefined) => void
}

export function useSelectNavigation<T>({
  visibleOptionCount = 5,
  options,
  initialFocusValue,
  focusValue,
  onFocus,
}: UseSelectNavigationProps<T>): SelectNavigation<T> {
  const [state, dispatch] = useReducer(
    reduceNavigation<T>,
    {
      visibleOptionCount,
      options,
      initialFocusValue: focusValue || initialFocusValue,
    },
    createNavigationState,
  )

  const prevOptionsRef = useRef(options)
  const prevFocusValueRef = useRef(focusValue)

  const effectiveVisibleCount = Math.min(visibleOptionCount, options.length)
  if (
    state.visibleOptionCount !== effectiveVisibleCount ||
    !optionsEquivalent(prevOptionsRef.current, options)
  ) {
    prevOptionsRef.current = options
    const nextFocus = focusSeedAfterOptionsChange({
      focusedValue: state.focusedValue,
      options,
      focusValue,
      initialFocusValue,
    })
    dispatch({
      type: 'reset',
      state: createNavigationState({
        visibleOptionCount,
        options,
        initialFocusValue: nextFocus,
        previousViewport: [state.visibleFromIndex, state.visibleToIndex],
      }),
    })
  }

  if (prevFocusValueRef.current !== focusValue) {
    prevFocusValueRef.current = focusValue
    dispatch({ type: 'focus-value', value: focusValue })
  }

  const focusedItem =
    state.focusedValue !== undefined
      ? state.optionMap.get(state.focusedValue)
      : undefined
  const validatedFocusedValue: T | undefined =
    focusedItem !== undefined
      ? optionValueOf(focusedItem.option)
      : options[0] !== undefined
        ? optionValueOf(options[0])
        : undefined
  const focusedIndex = focusedItem !== undefined ? focusedItem.index + 1 : 0
  const isInInput = isInputOption(focusedItem?.option)

  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  usePublish(() => {
    if (validatedFocusedValue !== undefined) {
      onFocusRef.current?.(validatedFocusedValue)
    }
  }, [validatedFocusedValue])

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
  const focusFirstOption = useCallback(() => {
    dispatch({ type: 'focus-first-option' })
  }, [])
  const focusLastOption = useCallback(() => {
    dispatch({ type: 'focus-last-option' })
  }, [])
  const focusValueAction = useCallback((value: OptionValue<T> | undefined) => {
    dispatch({ type: 'focus-value', value })
  }, [])

  const visibleOptions: Array<OptionWithDescription<T> & { index: number }> =
    options
      .slice(state.visibleFromIndex, state.visibleToIndex)
      .map((option, i) => ({ ...option, index: state.visibleFromIndex + i }))

  return {
    options,
    visibleOptions,
    visibleFromIndex: state.visibleFromIndex,
    visibleToIndex: state.visibleToIndex,
    focusedValue: validatedFocusedValue,
    focusedIndex,
    isInInput,
    focusNextOption,
    focusPreviousOption,
    focusNextPage,
    focusPreviousPage,
    focusFirstOption,
    focusLastOption,
    focusValue: focusValueAction,
  }
}
