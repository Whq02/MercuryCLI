
import { useRef } from 'react'
import useInput from '../../ink/hooks/use-input.js'
import {
  isTopOverlayNow,
  useRegisterOverlay,
} from '../../context/overlayContext.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { trySeedComposer } from '../../utils/cockpit/composerSeed.js'
import {
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
} from '../../utils/stringUtils.js'
import {
  isInputOption,
  optionValueOf,
  type OptionWithDescription,
} from './option-map.js'
import type { SelectState } from './use-select-state.js'

export function letterOrdinalOf(option: {
  indexLabel?: string
}): string | undefined {
  const label = option.indexLabel
  if (label === undefined) return undefined
  const core = label.endsWith('.') ? label.slice(0, -1) : label
  return /^[A-Z]$/.test(core) ? core : undefined
}

export type UseSelectProps<T> = {
  state: SelectState<T>
  isDisabled?: boolean
  disableSelection?: boolean | 'numeric'
  isMultiSelect?: boolean
  onCancel?: () => void
  onDownFromLastItem?: () => void
  onUpFromFirstItem?: () => void
  onInputModeToggle?: (value: T) => void
  getInputValue?: (value: T) => string
  submitInputOption?: (option: OptionWithDescription<T>) => void
  tryEnterImageSelectionMode?: () => boolean
  isImageSelectionModeActive?: boolean
}

export function useSelectInput<T>({
  state,
  isDisabled = false,
  disableSelection = false,
  isMultiSelect = false,
  onCancel,
  onDownFromLastItem,
  onUpFromFirstItem,
  onInputModeToggle,
  getInputValue,
  submitInputOption,
  tryEnterImageSelectionMode,
  isImageSelectionModeActive = false,
}: UseSelectProps<T>): void {
  const overlayToken = useRegisterOverlay('select', Boolean(onCancel))
  const tokenRef = useRef(overlayToken)
  tokenRef.current = overlayToken

  const optionCount = state.options.length
  const isOnLastOption = state.focusedIndex === optionCount && optionCount > 0
  const isOnFirstOption = state.focusedIndex === 1
  const isWindowAtTop = state.visibleFromIndex === 0

  useKeybindings(
    {
      'select:next': () => {
        if (onDownFromLastItem && isOnLastOption) {
          onDownFromLastItem()
          return
        }
        state.focusNextOption()
      },
      'select:previous': () => {
        if (onUpFromFirstItem && isWindowAtTop && isOnFirstOption) {
          onUpFromFirstItem()
          return
        }
        state.focusPreviousOption()
      },
      'select:accept': () => {
        if (disableSelection === true) return
        if (state.focusedValue === undefined) return
        const focused = state.options[state.focusedIndex - 1]
        if (focused?.disabled) return
        state.selectFocusedOption()
      },
    },
    { context: 'Select', isActive: !isDisabled && !state.isInInput },
  )

  useKeybindings(
    {
      'select:cancel': () => {
        const token = tokenRef.current
        if (token === null || !isTopOverlayNow(token)) return false
        onCancel?.()
      },
    },
    { context: 'Select', isActive: !isDisabled && Boolean(onCancel) },
  )

  useInput(
    (input, key, event) => {
      const focusedOption =
        state.focusedIndex > 0 ? state.options[state.focusedIndex - 1] : undefined

      if (key.tab && onInputModeToggle && state.focusedValue !== undefined) {
        onInputModeToggle(state.focusedValue)
        event.stopImmediatePropagation()
        return
      }

      if (state.isInInput) {
        if (isImageSelectionModeActive) return
        if (key.downArrow && tryEnterImageSelectionMode?.()) {
          event.stopImmediatePropagation()
          return
        }
        if (key.downArrow || (key.ctrl && input === 'n')) {
          if (onDownFromLastItem && isOnLastOption) onDownFromLastItem()
          else state.focusNextOption()
          event.stopImmediatePropagation()
          return
        }
        if (key.upArrow || (key.ctrl && input === 'p')) {
          if (onUpFromFirstItem && isWindowAtTop && isOnFirstOption) {
            onUpFromFirstItem()
          } else {
            state.focusPreviousOption()
          }
          event.stopImmediatePropagation()
          return
        }
        return
      }

      if (key.pageDown) state.focusNextPage()
      if (key.pageUp) state.focusPreviousPage()

      if (disableSelection !== true) {
        if (normalizeFullWidthSpace(input) === ' ') {
          if (isMultiSelect && focusedOption && !focusedOption.disabled) {
            state.selectFocusedOption()
            event.stopImmediatePropagation()
            return
          }
        }
        const activateOrdinalTarget = (
          target: OptionWithDescription<T>,
        ): void => {
          if (!target.disabled) {
            if (isInputOption(target)) {
              const text = getInputValue?.(optionValueOf(target)) ?? ''
              if (text.trim() !== '') {
                submitInputOption?.(target)
              } else if (target.allowEmptySubmitToCancel) {
                submitInputOption?.(target)
              } else {
                state.focusValue(optionValueOf(target))
              }
            } else {
              state.onChange?.(optionValueOf(target))
            }
          }
          event.stopImmediatePropagation()
        }
        const digits = normalizeFullWidthDigits(input)
        if (/^\d+$/.test(digits) && disableSelection !== 'numeric') {
          const target = state.options[parseInt(digits, 10) - 1]
          if (target !== undefined) {
            activateOrdinalTarget(target)
            return
          }
        }
        if (input.length === 1 && /[a-zA-Z]/.test(input)) {
          const pressed = input.toUpperCase()
          const at = state.options.findIndex(
            o => letterOrdinalOf(o) === pressed,
          )
          if (at >= 0) {
            activateOrdinalTarget(state.options[at]!)
            return
          }
        }
      }

      trySeedComposer(input, key)
    },
    { isActive: !isDisabled },
  )
}
