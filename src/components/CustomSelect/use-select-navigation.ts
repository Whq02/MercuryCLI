// The focus + viewport state machine shared by single- and multi-select:
// an indexed doubly-linked option map, a half-open visible window
// [from, to), disabled-skipping movement with wraparound, page movement,
// focus-by-value, and the options-reset path.
//
// Two deliberate inconsistencies are preserved:
// the state constructor treats an ABSENT visible count as "show everything"
// while the public hooks default the prop to 5; and the mount path prefers
// the controlled focus value only when it is truthy, while the reset path
// prefers it whenever it is defined.

import { isEqual } from 'lodash-es'
import React, { useCallback, useEffect, useReducer, useRef } from 'react'
import OptionMap, {
  isInputOption,
  type OptionMapItem,
  type OptionValue,
  type OptionWithDescription,
} from './option-map.js'

type NavigationState<T> = {
  optionMap: OptionMap<T>
  /** The clamped visible-option count (the whole list when the constructor
   *  received no number). */
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
  // The caller's number clamped to the option count; an ABSENT number means
  // every option is visible (reachable only by constructing state directly).
  const visible =
    typeof visibleOptionCount === 'number'
      ? Math.min(visibleOptionCount, options.length)
      : options.length
  const optionMap = new OptionMap(options)

  // An explicitly supplied initial focus value that exists in the map is
  // honoured verbatim — even when disabled (the caller's deliberate seed).
  const explicit =
    initialFocusValue !== undefined ? optionMap.get(initialFocusValue) : undefined
  let focusedValue: OptionValue<T> | undefined
  if (explicit) {
    focusedValue = explicit.value
  } else {
    focusedValue = (firstEnabled(optionMap) ?? optionMap.first)?.value
  }

  // The window starts at [0, visibleCount) and is adjusted ONLY when an
  // explicit initial focus value resolved in the map.
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
    // The final clamp is asymmetric: the start is clamped into
    // [0, size − 1], the end to at most the option count but at least the
    // visible count.
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
        // Forward chain exhausted: wrap to the first enabled item and reset
        // the window to the first page.
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
        // Extend by one row normally, by more when the disabled-skip jumped
        // several rows.
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
        // Backward chain exhausted: wrap to the last enabled item and move
        // the window to the tail.
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
      // Nearest enabled: forward first, then falling back toward the origin.
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
      // Bottom-anchored window containing the landing item.
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
      // Nearest enabled: backward first, then forward toward the origin.
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
      // Top-anchored window containing the landing item.
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
      // Scroll as little as possible so the item sits at the near edge.
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
  // Walk from the nearer end; the map is small (a dialog's option list).
  let item = map.first
  while (item && item.index !== index) item = item.next
  return item
}

export type UseSelectNavigationProps<T> = {
  /** Number of visible options (the public hooks default it to 5). */
  visibleOptionCount?: number
  options: OptionWithDescription<T>[]
  /** The initial focus seed used when no controlled focus value applies. */
  initialFocusValue?: T
  /** Controlled focus: dispatched as a focus-by-value whenever it changes,
   *  including on mount. */
  focusValue?: T
  /** Fires with the VALIDATED focused value whenever it changes, including
   *  once on mount. */
  onFocus?: (value: T) => void
}

export type SelectNavigation<T> = {
  /** The validated focused value: falls back to the first option when the
   *  internal focus does not name an existing option. */
  focusedValue: T | undefined
  /** 1-based index over the FULL list; 0 when nothing is focused. */
  focusedIndex: number
  visibleFromIndex: number
  visibleToIndex: number
  visibleOptions: Array<OptionWithDescription<T> & { index: number }>
  options: OptionWithDescription<T>[]
  /** Whether the focused option is an input row. */
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
        // Mount seeding prefers the controlled focus value only when TRUTHY
        // (preserved inconsistency — the reset path below prefers it
        // whenever it is defined).
        initialFocusValue: focusValue ? focusValue : initialFocusValue,
      }),
  )

  // Options replaced: identity inequality PLUS deep inequality — identity
  // alone would fire on every render, since callers build the array inline.
  const previousOptionsRef = useRef(options)
  if (
    previousOptionsRef.current !== options &&
    !isEqual(previousOptionsRef.current, options)
  ) {
    previousOptionsRef.current = options
    dispatch({
      type: 'reset',
      state: createNavigationState({
        options,
        visibleOptionCount,
        initialFocusValue:
          focusValue !== undefined
            ? focusValue
            : state.focusedValue !== undefined
              ? state.focusedValue
              : initialFocusValue,
        currentViewport: [state.visibleFromIndex, state.visibleToIndex],
      }),
    })
  } else {
    previousOptionsRef.current = options
  }

  // Validated focus: if the internal focus does not name an existing
  // option (options changed but the reset has not been processed yet), the
  // exposed value falls back to the first option's value — without this the
  // cursor vanishes for a render.
  const focusedItem =
    state.focusedValue !== undefined
      ? state.optionMap.get(state.focusedValue)
      : undefined
  const validatedFocusedValue = (
    focusedItem ? focusedItem.value : options[0]?.value
  ) as T | undefined

  // Focus notification through a ref, so a callback whose identity churns
  // each render does not re-fire it.
  const onFocusRef = useRef(onFocus)
  onFocusRef.current = onFocus
  const lastNotifiedRef = useRef<T | undefined>(undefined)
  // (validated values are option values read back at the pinned type)
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

  // Controlled focus: dispatch a focus-by-value whenever it changes,
  // including on mount (the dispatch no-ops when already focused).
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
