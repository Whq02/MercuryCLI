import { useCallback, useRef, useState } from 'react'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import type { InputEvent, Key } from '../../ink/events/input-event.js'
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
import { isWheelReport, letterOrdinalOf } from './use-select-input.js'
import { usePopupPageOwner } from './popup-list.js'

type UseMultiSelectStateProps<T> = {
  isDisabled?: boolean
  visibleOptionCount?: number
  options: OptionWithDescription<T>[]
  defaultValue?: T[]
  onChange?: (values: T[]) => void
  onSubmit?: (values: T[]) => void
  onCancel?: () => void
  focusValue?: T
  onFocus?: (value: T) => void
  onSubmitFocus?: (focused: boolean) => void
  hasSubmitButton?: boolean
  hideIndexes?: boolean
  initialFocusLast?: boolean
  scrollMovesFocus?: boolean
  onUpFromFirstItem?: () => void
  onDownFromLastItem?: () => void
  onTabOut?: (direction: 'next' | 'prev') => void
  onEmptyInputSubmit?: (value: T) => void
}

type MultiSelectState<T> = SelectNavigation<T> & {
  selectedValues: T[]
  isSubmitFocused: boolean
  inputValues: Map<T, string>
  toggleValue: (value: T) => void
  updateInputValue: (value: T, text: string) => void
  activateInputValue: (value: T, via?: 'enter' | 'click') => void
  submit: () => void
}

function seedInputValues<T>(options: readonly OptionWithDescription<T>[]): Map<T, string> {
  const map = new Map<T, string>()
  for (const option of options) {
    if (isInputOption(option) && option.initialValue !== undefined) {
      map.set(optionValueOf(option), option.initialValue)
    }
  }
  return map
}

function firstEnabledIndexOf<T>(options: readonly OptionWithDescription<T>[]): number {
  return options.findIndex(option => !option.disabled)
}

function lastEnabledIndexOf<T>(options: readonly OptionWithDescription<T>[]): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i]!.disabled) return i
  }
  return -1
}

type MultiKeyContext<T> = {
  options: OptionWithDescription<T>[]
  navigation: SelectNavigation<T>
  selectedValues: T[]
  isSubmitFocused: boolean
  hasSubmitButton: boolean
  hideIndexes: boolean
  scrollMovesFocus: boolean
  onSubmit?: (values: T[]) => void
  onCancel?: () => void
  onUpFromFirstItem?: () => void
  onDownFromLastItem?: () => void
  onTabOut?: (direction: 'next' | 'prev') => void
  setSubmitFocus: (next: boolean) => void
  toggleValue: (value: T) => void
  activateInputValue: (value: T, via?: 'enter' | 'click') => void
}

function handleMultiSelectKey<T>(
  input: string,
  key: Key,
  event: InputEvent,
  ctx: MultiKeyContext<T>,
): void {
  const {
    options,
    navigation,
    selectedValues,
    isSubmitFocused,
    hasSubmitButton,
    hideIndexes,
    scrollMovesFocus,
    onSubmit,
    onCancel,
    onUpFromFirstItem,
    onDownFromLastItem,
    onTabOut,
    setSubmitFocus,
    toggleValue,
    activateInputValue,
  } = ctx

  if (!scrollMovesFocus && (isWheelReport(key, event) || key.pageUp || key.pageDown)) {
    return
  }

  const inInput = navigation.isInInput && !isSubmitFocused
  if (inInput) {
    const isAllowedInInput =
      key.upArrow ||
      key.downArrow ||
      key.pageUp ||
      key.pageDown ||
      key.escape ||
      key.tab ||
      key.return ||
      (key.ctrl && (input === 'n' || input === 'p')) ||
      (scrollMovesFocus && (key.wheelUp || key.wheelDown))
    if (!isAllowedInInput) return
  }

  if (key.escape) {
    event.stopImmediatePropagation()
    onCancel?.()
    return
  }

  const firstIdx = firstEnabledIndexOf(options)
  const lastIdx = lastEnabledIndexOf(options)
  const currentIdx = options.findIndex(option => option.value === navigation.focusedValue)

  if (key.tab) {
    event.stopImmediatePropagation()
    if (onTabOut) {
      onTabOut(key.shift ? 'prev' : 'next')
      return
    }
    if (hasSubmitButton) {
      if (key.shift) {
        if (isSubmitFocused) {
          setSubmitFocus(false)
          navigation.focusLastOption()
        } else if (currentIdx === firstIdx) {
          setSubmitFocus(true)
        } else {
          navigation.focusPreviousOption()
        }
      } else if (isSubmitFocused) {
        setSubmitFocus(false)
        navigation.focusFirstOption()
      } else if (currentIdx === lastIdx) {
        setSubmitFocus(true)
      } else {
        navigation.focusNextOption()
      }
    } else if (key.shift) {
      navigation.focusPreviousOption()
    } else {
      navigation.focusNextOption()
    }
    return
  }

  if (!inInput && !hideIndexes && !key.ctrl && !key.meta) {
    const normalizedDigit = normalizeFullWidthDigits(input)
    if (/^[1-9]$/.test(normalizedDigit)) {
      const targetIdx = Number(normalizedDigit) - 1
      if (targetIdx >= 0 && targetIdx < options.length) {
        event.stopImmediatePropagation()
        const target = options[targetIdx]!
        if (!target.disabled) {
          const val = optionValueOf(target)
          setSubmitFocus(false)
          navigation.focusValue(val)
          if (isInputOption(target)) {
            activateInputValue(val, 'click')
          } else {
            toggleValue(val)
          }
        }
        return
      }
    }
    if (/^[a-zA-Z]$/.test(input)) {
      const upper = input.toUpperCase()
      const target = options.find(option => letterOrdinalOf(option) === upper)
      if (target) {
        event.stopImmediatePropagation()
        if (!target.disabled) {
          const val = optionValueOf(target)
          setSubmitFocus(false)
          navigation.focusValue(val)
          if (isInputOption(target)) {
            activateInputValue(val, 'click')
          } else {
            toggleValue(val)
          }
        }
        return
      }
    }
  }

  const isDown =
    key.downArrow ||
    (key.ctrl && input === 'n') ||
    (!inInput && input === 'j') ||
    (scrollMovesFocus && key.wheelDown)
  if (isDown) {
    event.stopImmediatePropagation()
    if (isSubmitFocused) {
      if (onDownFromLastItem) {
        onDownFromLastItem()
      } else {
        setSubmitFocus(false)
        navigation.focusFirstOption()
      }
    } else if (currentIdx === lastIdx && lastIdx >= 0) {
      if (hasSubmitButton) {
        setSubmitFocus(true)
      } else if (onDownFromLastItem) {
        onDownFromLastItem()
      } else {
        navigation.focusNextOption()
      }
    } else {
      navigation.focusNextOption()
    }
    return
  }

  const isUp =
    key.upArrow ||
    (key.ctrl && input === 'p') ||
    (!inInput && input === 'k') ||
    (scrollMovesFocus && key.wheelUp)
  if (isUp) {
    event.stopImmediatePropagation()
    if (isSubmitFocused) {
      setSubmitFocus(false)
      navigation.focusLastOption()
    } else if (currentIdx === firstIdx && firstIdx >= 0 && navigation.visibleFromIndex === 0) {
      if (onUpFromFirstItem) {
        onUpFromFirstItem()
      } else if (hasSubmitButton) {
        setSubmitFocus(true)
      } else {
        navigation.focusPreviousOption()
      }
    } else {
      navigation.focusPreviousOption()
    }
    return
  }

  if (key.pageDown) {
    event.stopImmediatePropagation()
    if (isSubmitFocused) setSubmitFocus(false)
    navigation.focusNextPage()
    return
  }

  if (key.pageUp) {
    event.stopImmediatePropagation()
    if (isSubmitFocused) setSubmitFocus(false)
    navigation.focusPreviousPage()
    return
  }

  if (key.return) {
    event.stopImmediatePropagation()
    if (inInput) {
      if (key.ctrl) {
        onSubmit?.(selectedValues)
      } else if (navigation.focusedValue !== undefined) {
        activateInputValue(navigation.focusedValue, 'enter')
      }
    } else if (isSubmitFocused) {
      onSubmit?.(selectedValues)
    } else if (!hasSubmitButton) {
      if (onSubmit) {
        onSubmit(selectedValues)
      } else if (navigation.focusedValue !== undefined) {
        toggleValue(navigation.focusedValue)
      }
    } else if (navigation.focusedValue !== undefined) {
      toggleValue(navigation.focusedValue)
    }
    return
  }

  if (!inInput && normalizeFullWidthSpace(input) === ' ') {
    event.stopImmediatePropagation()
    if (isSubmitFocused) {
      onSubmit?.(selectedValues)
    } else if (navigation.focusedValue !== undefined) {
      toggleValue(navigation.focusedValue)
    }
  }
}

export function useMultiSelectState<T>({
  isDisabled = false,
  visibleOptionCount = 5,
  options,
  defaultValue,
  onChange,
  onSubmit,
  onCancel,
  focusValue,
  onFocus,
  onSubmitFocus,
  hasSubmitButton = false,
  hideIndexes = false,
  initialFocusLast = false,
  scrollMovesFocus = true,
  onUpFromFirstItem,
  onDownFromLastItem,
  onTabOut,
  onEmptyInputSubmit,
}: UseMultiSelectStateProps<T>): MultiSelectState<T> {
  usePopupPageOwner(!isDisabled && scrollMovesFocus)
  useRegisterOverlay('select-multi', !isDisabled && Boolean(onCancel), {
    ownsPageKeys: scrollMovesFocus,
  })

  const lastEnabledIdx = lastEnabledIndexOf(options)
  const lastFallback = lastEnabledIdx >= 0 ? options[lastEnabledIdx] : options[options.length - 1]
  const initialFocusValue =
    initialFocusLast && lastFallback !== undefined ? optionValueOf(lastFallback) : undefined

  const navigation = useSelectNavigation({
    visibleOptionCount,
    options,
    initialFocusValue,
    focusValue,
    onFocus,
  })

  const [selectedValues, setSelectedValues] = useState<T[]>(() => defaultValue ?? [])
  const [inputValues, setInputValues] = useState<Map<T, string>>(() => seedInputValues(options))
  const [isSubmitFocused, setIsSubmitFocusedState] = useState(false)

  const selectedValuesRef = useRef(selectedValues)
  selectedValuesRef.current = selectedValues
  const inputValuesRef = useRef(inputValues)
  inputValuesRef.current = inputValues
  const prevOptionsRef = useRef(options)

  if (!optionsEquivalent(prevOptionsRef.current, options)) {
    prevOptionsRef.current = options
    const nextSelected = defaultValue ?? []
    const nextInputs = seedInputValues(options)
    selectedValuesRef.current = nextSelected
    inputValuesRef.current = nextInputs
    setSelectedValues(nextSelected)
    setInputValues(nextInputs)
    if (isSubmitFocused) {
      setIsSubmitFocusedState(false)
      onSubmitFocus?.(false)
    }
  }

  const setSubmitFocus = useCallback(
    (next: boolean): void => {
      setIsSubmitFocusedState(current => {
        if (current !== next) {
          onSubmitFocus?.(next)
        }
        return next
      })
    },
    [onSubmitFocus],
  )

  const toggleValue = useCallback(
    (value: T): void => {
      if (isDisabled) return
      const target = options.find(option => option.value === value)
      if (!target || target.disabled) return
      const current = selectedValuesRef.current
      const next = current.includes(value)
        ? current.filter(item => item !== value)
        : [...current, value]
      selectedValuesRef.current = next
      setSelectedValues(next)
      onChange?.(next)
    },
    [isDisabled, options, onChange],
  )

  const updateInputValue = useCallback(
    (value: T, text: string): void => {
      const target = options.find(option => option.value === value)
      const nextInputs = new Map(inputValuesRef.current)
      nextInputs.set(value, text)
      inputValuesRef.current = nextInputs
      setInputValues(nextInputs)

      if (isInputOption(target)) {
        target.onChange?.(text)
      }

      const current = selectedValuesRef.current
      const hasValue = current.includes(value)
      let next = current
      if (text !== '' && !hasValue) {
        next = [...current, value]
      } else if (text === '' && hasValue) {
        next = current.filter(item => item !== value)
      }
      if (next !== current) {
        selectedValuesRef.current = next
        setSelectedValues(next)
      }
      onChange?.(next)
    },
    [options, onChange],
  )

  const activateInputValue = useCallback(
    (value: T, via: 'enter' | 'click' = 'enter'): void => {
      if (isDisabled) return
      const target = options.find(option => option.value === value)
      if (!target || target.disabled) return
      const text =
        inputValuesRef.current.get(value) ??
        (isInputOption(target) ? target.initialValue ?? '' : '')
      if (text.trim() === '') {
        setSubmitFocus(false)
        navigation.focusValue(value)
        if (via === 'enter') {
          onEmptyInputSubmit?.(value)
        }
        return
      }
      const current = selectedValuesRef.current
      if (!current.includes(value)) {
        const next = [...current, value]
        selectedValuesRef.current = next
        setSelectedValues(next)
        onChange?.(next)
      }
      if (via === 'enter' && hasSubmitButton) {
        setSubmitFocus(true)
      } else {
        setSubmitFocus(false)
        navigation.focusValue(value)
      }
    },
    [isDisabled, options, hasSubmitButton, navigation, onChange, onEmptyInputSubmit, setSubmitFocus],
  )

  const submit = useCallback((): void => {
    if (isDisabled) return
    onSubmit?.(selectedValuesRef.current)
  }, [isDisabled, onSubmit])

  useInput(
    (input, key, event) =>
      handleMultiSelectKey(input, key, event, {
        options,
        navigation,
        selectedValues: selectedValuesRef.current,
        isSubmitFocused,
        hasSubmitButton,
        hideIndexes,
        scrollMovesFocus,
        onSubmit,
        onCancel,
        onUpFromFirstItem,
        onDownFromLastItem,
        onTabOut,
        setSubmitFocus,
        toggleValue,
        activateInputValue,
      }),
    { isActive: !isDisabled },
  )

  return {
    ...navigation,
    selectedValues,
    isSubmitFocused,
    inputValues,
    toggleValue,
    updateInputValue,
    activateInputValue,
    submit,
  }
}
