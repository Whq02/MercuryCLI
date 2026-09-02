
import { isEqual } from 'lodash-es'
import { useCallback, useRef, useState } from 'react'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import useInput from '../../ink/hooks/use-input.js'
import {
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
} from '../../utils/stringUtils.js'
import {
  isInputOption,
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
  focusValue?: T
  initialFocusLast?: boolean
  hideIndexes?: boolean
  hasSubmitButton?: boolean
  isDisabled?: boolean
  onDownFromLastItem?: () => void
  onUpFromFirstItem?: () => void
}

export type MultiSelectState<T> = SelectNavigation<T> & {
  selectedValues: T[]
  inputValues: Map<T, string>
  isSubmitFocused: boolean
  updateInputValue: (value: T, text: string) => void
  toggleValue: (value: T) => void
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
}: UseMultiSelectStateProps<T>): MultiSelectState<T> {
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
  const [isSubmitFocused, setSubmitFocused] = useState(false)

  const previousOptionsRef = useRef(options)
  if (
    previousOptionsRef.current !== options &&
    !isEqual(previousOptionsRef.current, options)
  ) {
    previousOptionsRef.current = options
    setSelectedValues(defaultValue ?? [])
  } else {
    previousOptionsRef.current = options
  }

  const selectedValuesRef = useRef(selectedValues)
  selectedValuesRef.current = selectedValues

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
      setInputValues(current => {
        const next = new Map(current)
        next.set(value, text)
        return next
      })
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

  useInput(
    (input, key, event) => {
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

      const isSpace = normalizeFullWidthSpace(input) === ' '
      if (key.return || isSpace) {
        if (key.return && key.ctrl && navigation.isInInput && onSubmit) {
          submit()
        } else if (key.return && isSubmitFocused && onSubmit) {
          submit()
        } else if (key.return && !hasSubmitButton && onSubmit) {
          submit()
        } else if (navigation.focusedValue !== undefined) {
          toggleValue(navigation.focusedValue)
        }
        event.stopImmediatePropagation()
        return
      }

      const digits = normalizeFullWidthDigits(input)
      if (/^\d+$/.test(digits)) {
        if (hideIndexes) return
        const target = options[parseInt(digits, 10) - 1]
        if (target) {
          toggleValue(optionValueOf(target))
          event.stopImmediatePropagation()
          return
        }
      }

      if (!hideIndexes && input.length === 1 && /[a-zA-Z]/.test(input)) {
        const pressed = input.toUpperCase()
        const lettered = options.find(o => letterOrdinalOf(o) === pressed)
        if (lettered) {
          toggleValue(optionValueOf(lettered))
          event.stopImmediatePropagation()
          return
        }
      }

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
    onCancel,
  }
}
