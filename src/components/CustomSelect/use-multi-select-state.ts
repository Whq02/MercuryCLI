// Multi-select state and its COMPLETE key grammar. Unlike the single
// select, everything is handled on the raw path here — including the bare
// j/k letters. The selection is an array reported in full through the
// change callback on every mutation; it resets to the default whenever the
// options array changes by callback-blind deep inequality (otherwise
// asynchronously loaded data leaves stale rows checked).
//
// An INPUT row (the free-text "Other" row) is never toggled: its membership
// in the selection mirrors its text — the first typed character adds it,
// clearing the field removes it — and ↵, a click and its ordinal all go
// through the row's own door (activateInputValue) instead.

import { useCallback, useRef, useState } from 'react'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import useInput from '../../ink/hooks/use-input.js'
import {
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
} from '../../utils/stringUtils.js'
import {
  isInputOption,
  optionsEquivalent,
  optionValueOf,
  type OptionWithDescription,
} from './option-map.js'
import {
  useSelectNavigation,
  type SelectNavigation,
} from './use-select-navigation.js'
import { letterOrdinalOf } from './use-select-input.js'

export type UseMultiSelectStateProps<T> = {
  visibleOptionCount?: number
  options: OptionWithDescription<T>[]
  defaultValue?: T[]
  onChange?: (values: T[]) => void
  onCancel: () => void
  onSubmit?: (values: T[]) => void
  onFocus?: (value: T) => void
  /** Controlled focus. */
  focusValue?: T
  /** Seed the initial focus on the LAST option. */
  initialFocusLast?: boolean
  /** Digits must never toggle an invisible mapping. */
  hideIndexes?: boolean
  /** Whether a submit button is rendered (button text + submit callback). */
  hasSubmitButton?: boolean
  isDisabled?: boolean
  onDownFromLastItem?: () => void
  onUpFromFirstItem?: () => void
  /** ↵ on an input row whose field is EMPTY: the row keeps focus and this
   *  reports it (a caller paints its hint) — an empty field never selects
   *  nothing. */
  onEmptyInputSubmit?: (value: T) => void
  /** When supplied, Tab / shift+Tab leave the list through this instead of
   *  walking its rows — a card whose tabs are its questions keeps the
   *  documented key from every row, the input row and the submit button
   *  included. */
  onTabOut?: (direction: 'next' | 'previous') => void
  /** Fires when the submit button takes or loses the focus (the row focus
   *  is unchanged underneath it, so onFocus cannot say). */
  onSubmitFocusChange?: (focused: boolean) => void
}

export type MultiSelectState<T> = SelectNavigation<T> & {
  selectedValues: T[]
  inputValues: Map<T, string>
  isSubmitFocused: boolean
  updateInputValue: (value: T, text: string) => void
  toggleValue: (value: T) => void
  /** The input row's own door — see the module note. `submitted` carries
   *  the field's text when the text field itself submitted (a coalesced
   *  keystroke lands text and ↵ in one event, ahead of any render). */
  activateInputValue: (value: T, via: 'enter' | 'pointer' | 'ordinal', submitted?: string) => void
  onCancel: () => void
}

export function useMultiSelectState<T>({
  visibleOptionCount = 5,
  options,
  defaultValue,
  onChange,
  onCancel,
  onSubmit,
  onFocus,
  focusValue,
  initialFocusLast = false,
  hideIndexes = false,
  hasSubmitButton = false,
  isDisabled = false,
  onDownFromLastItem,
  onUpFromFirstItem,
  onEmptyInputSubmit,
  onTabOut,
  onSubmitFocusChange,
}: UseMultiSelectStateProps<T>): MultiSelectState<T> {
  // Always an overlay, unconditionally, under this semantic id.
  useRegisterOverlay('multi-select')

  const lastOption = options[options.length - 1]
  const navigation = useSelectNavigation({
    visibleOptionCount,
    options,
    initialFocusValue:
      initialFocusLast && lastOption ? optionValueOf(lastOption) : undefined,
    focusValue,
    onFocus,
  })

  const [selectedValues, setSelectedValues] = useState<T[]>(
    () => defaultValue ?? [],
  )
  const [inputValues, setInputValues] = useState<Map<T, string>>(() => {
    const seeded = new Map<T, string>()
    for (const option of options) {
      if (isInputOption(option) && option.initialValue) {
        seeded.set(optionValueOf(option), option.initialValue)
      }
    }
    return seeded
  })
  const [isSubmitFocused, setSubmitFocusedState] = useState(false)
  // The submit-button focus, with its change reported to the caller; the
  // ref mirrors it so a same-value set reports nothing.
  const submitFocusedRef = useRef(isSubmitFocused)
  submitFocusedRef.current = isSubmitFocused
  const onSubmitFocusChangeRef = useRef(onSubmitFocusChange)
  onSubmitFocusChangeRef.current = onSubmitFocusChange
  const setSubmitFocused = useCallback((next: boolean): void => {
    if (submitFocusedRef.current === next) return
    submitFocusedRef.current = next
    setSubmitFocusedState(next)
    onSubmitFocusChangeRef.current?.(next)
  }, [])

  // Reset the selection to the default whenever the options change by
  // callback-blind deep inequality.
  const previousOptionsRef = useRef(options)
  if (
    previousOptionsRef.current !== options &&
    !optionsEquivalent(previousOptionsRef.current, options)
  ) {
    previousOptionsRef.current = options
    setSelectedValues(defaultValue ?? [])
  } else {
    previousOptionsRef.current = options
  }

  // Mirror of the selection for the input handler and callbacks, so a
  // mutation computes from the latest committed value without impure state
  // updaters.
  const selectedValuesRef = useRef(selectedValues)
  selectedValuesRef.current = selectedValues
  // The same mirror for the input texts: a keystroke and the ↵ that follows
  // it can share one input event, ahead of any render.
  const inputValuesRef = useRef(inputValues)
  inputValuesRef.current = inputValues

  const toggleValue = useCallback(
    (value: T): void => {
      const current = selectedValuesRef.current
      const next = current.includes(value)
        ? current.filter(v => v !== value)
        : [...current, value]
      selectedValuesRef.current = next
      setSelectedValues(next)
      onChange?.(next)
    },
    [onChange],
  )

  const updateInputValue = useCallback(
    (value: T, text: string): void => {
      const texts = new Map(inputValuesRef.current)
      texts.set(value, text)
      inputValuesRef.current = texts
      setInputValues(texts)
      const option = options.find(o => o.value === value)
      if (isInputOption(option)) option.onChange?.(text)
      const current = selectedValuesRef.current
      const has = current.includes(value)
      let next = current
      if (text !== '' && !has) next = [...current, value]
      else if (text === '' && has) next = current.filter(v => v !== value)
      selectedValuesRef.current = next
      setSelectedValues(next)
      onChange?.(next)
    },
    [options, onChange],
  )

  const optionCount = options.length
  const isOnLastOption =
    navigation.focusedIndex === optionCount && optionCount > 0
  const isOnFirstOption = navigation.focusedIndex === 1

  const submit = (): void => {
    onSubmit?.(selectedValues)
  }

  // The input row's own door. With text: the row is in the selection (added
  // now when it is not — its text is its membership), it takes the focus,
  // and ↵ moves on to the submit button when one is painted. Empty: the row
  // takes the focus so the operator can type, and ↵ reports the empty field
  // instead of selecting nothing.
  const { focusValue: focusByValue } = navigation
  const activateInputValue = useCallback(
    (value: T, via: 'enter' | 'pointer' | 'ordinal', submitted?: string): void => {
      const text = (submitted ?? inputValuesRef.current.get(value) ?? '').trim()
      if (text === '') {
        focusByValue(value)
        if (via === 'enter') onEmptyInputSubmit?.(value)
        return
      }
      if (!selectedValuesRef.current.includes(value)) toggleValue(value)
      if (via === 'enter' && hasSubmitButton) setSubmitFocused(true)
      else focusByValue(value)
    },
    [focusByValue, toggleValue, hasSubmitButton, onEmptyInputSubmit, setSubmitFocused],
  )

  useInput(
    (input, key, event) => {
      // While the focused option is an input, only these chords are allowed
      // through; everything else is ignored at this layer and falls to the
      // text field.
      if (navigation.isInInput && !isSubmitFocused) {
        const allowed =
          key.upArrow ||
          key.downArrow ||
          key.escape ||
          key.tab ||
          key.return ||
          (key.ctrl && (input === 'n' || input === 'p'))
        if (!allowed) return
      }

      // Tab / shift+Tab — handed out of the list when the caller owns them.
      if (key.tab && onTabOut) {
        onTabOut(key.shift ? 'previous' : 'next')
        event.stopImmediatePropagation()
        return
      }
      if (key.tab && key.shift) {
        if (isSubmitFocused) {
          setSubmitFocused(false)
          const last = options[optionCount - 1]
          if (last) navigation.focusValue(optionValueOf(last))
        } else {
          navigation.focusPreviousOption()
        }
        event.stopImmediatePropagation()
        return
      }
      if (key.tab) {
        if (!isSubmitFocused) {
          if (hasSubmitButton && isOnLastOption) setSubmitFocused(true)
          else navigation.focusNextOption()
        }
        event.stopImmediatePropagation()
        return
      }

      // Down / ctrl+n / bare j (no ctrl, no shift).
      if (
        key.downArrow ||
        (key.ctrl && input === 'n') ||
        (input === 'j' && !key.ctrl && !key.shift)
      ) {
        if (isSubmitFocused) {
          onDownFromLastItem?.()
        } else if (isOnLastOption && hasSubmitButton) {
          setSubmitFocused(true)
        } else if (isOnLastOption && onDownFromLastItem) {
          onDownFromLastItem()
        } else {
          navigation.focusNextOption()
        }
        event.stopImmediatePropagation()
        return
      }

      // Up / ctrl+p / bare k.
      if (
        key.upArrow ||
        (key.ctrl && input === 'p') ||
        (input === 'k' && !key.ctrl && !key.shift)
      ) {
        if (isSubmitFocused) {
          setSubmitFocused(false)
        } else if (isOnFirstOption && onUpFromFirstItem) {
          onUpFromFirstItem()
        } else {
          navigation.focusPreviousOption()
        }
        event.stopImmediatePropagation()
        return
      }

      // Page keys: page-down is inert while the submit button is focused
      // (it is the last element); page-up returns focus to the last option.
      if (key.pageDown) {
        if (!isSubmitFocused) navigation.focusNextPage()
        event.stopImmediatePropagation()
        return
      }
      if (key.pageUp) {
        if (isSubmitFocused) setSubmitFocused(false)
        else navigation.focusPreviousPage()
        event.stopImmediatePropagation()
        return
      }

      // Enter or space. Every submit path requires the submit callback; a
      // failed submit condition falls through to the toggle — except on the
      // focused input row, whose ↵ is its own door (never a toggle).
      const isSpace = normalizeFullWidthSpace(input) === ' '
      if (key.return || isSpace) {
        if (key.return && key.ctrl && navigation.isInInput && onSubmit) {
          submit()
        } else if (key.return && isSubmitFocused && onSubmit) {
          submit()
        } else if (key.return && !hasSubmitButton && onSubmit) {
          submit()
        } else if (key.return && navigation.isInInput && navigation.focusedValue !== undefined) {
          activateInputValue(navigation.focusedValue, 'enter')
        } else if (navigation.focusedValue !== undefined) {
          toggleValue(navigation.focusedValue)
        }
        event.stopImmediatePropagation()
        return
      }

      // An ordinal (digit or letter) naming an input row goes through its
      // door; naming a text row toggles it.
      const activateOrdinalTarget = (target: OptionWithDescription<T>): void => {
        if (isInputOption(target)) activateInputValue(optionValueOf(target), 'ordinal')
        else toggleValue(optionValueOf(target))
        event.stopImmediatePropagation()
      }

      // Digits toggle the 1-based option — suppressed entirely when indexes
      // are hidden. The decline law: a digit naming NO row propagates
      // untouched (an interview card's footer paints its own ordinals below
      // this list and owns them); digits are structurally un-seedable.
      const digits = normalizeFullWidthDigits(input)
      if (/^\d+$/.test(digits)) {
        if (hideIndexes) return
        const target = options[parseInt(digits, 10) - 1]
        if (target) {
          activateOrdinalTarget(target)
          return
        }
      }

      // Ordinal LETTERS toggle their lettered option (indexLabel 'A.'–'E.'
      // — the Apollo poll grammar), case-insensitive: the advertised
      // ordinal is the hotkey, exactly as on the single select. Suppressed
      // with the ordinals themselves under hideIndexes.
      if (!hideIndexes && input.length === 1 && /[a-zA-Z]/.test(input)) {
        const pressed = input.toUpperCase()
        const lettered = options.find(o => letterOrdinalOf(o) === pressed)
        if (lettered) {
          activateOrdinalTarget(lettered)
          return
        }
      }

      // Escape cancels — checked last, after the digit branch.
      if (key.escape) {
        onCancel()
        event.stopImmediatePropagation()
      }
    },
    { isActive: !isDisabled },
  )

  return {
    ...navigation,
    selectedValues,
    inputValues,
    isSubmitFocused,
    updateInputValue,
    toggleValue,
    activateInputValue,
    onCancel,
  }
}
