import { useRef } from 'react'
import { useClaim } from '../../hooks/effects.js'
import type { InputEvent, Key } from '../../ink/events/input-event.js'
import useInput from '../../ink/hooks/use-input.js'
import {
  isTopOverlayNow,
  useRegisterOverlay,
} from '../../context/overlayContext.js'
import { useModalScrollRef } from '../../context/modalContext.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { enterHeldByQueuedWords, reportConsentDeclineRow, trySeedComposer } from '../../utils/cockpit/composerSeed.js'
import {
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
} from '../../utils/stringUtils.js'
import {
  isInputOption,
  optionValueOf,
  type InputOption,
  type OptionWithDescription,
} from './option-map.js'
import type { SelectState } from './use-select-state.js'
import { usePopupPageOwner } from './popup-list.js'

export function letterOrdinalOf(option: {
  indexLabel?: string
}): string | undefined {
  const label = option.indexLabel
  if (label === undefined) return undefined
  const core = label.endsWith('.') ? label.slice(0, -1) : label
  return /^[A-Z]$/.test(core) ? core : undefined
}

export function isWheelReport(key: Key, event: InputEvent): boolean {
  return (key.wheelUp || key.wheelDown) && event.keypress.x !== undefined && event.keypress.y !== undefined
}

type UseSelectProps<T> = {
  isDisabled?: boolean
  disableSelection?: boolean | 'numeric'
  isMultiSelect?: boolean
  state: SelectState<T>
  onCancel?: () => void
  onUpFromFirstItem?: () => void
  onDownFromLastItem?: () => void
  scrollMovesFocus?: boolean
  onInputModeToggle?: (value: T) => void
  getInputValue?: (value: T) => string
  submitInputOption?: (option: InputOption<T>) => void
  isImageSelectionModeActive?: boolean
  tryEnterImageSelectionMode?: () => boolean
}

export function useSelectInput<T>({
  isDisabled = false,
  disableSelection = false,
  isMultiSelect = false,
  state,
  onCancel,
  onUpFromFirstItem,
  onDownFromLastItem,
  scrollMovesFocus = true,
  onInputModeToggle,
  getInputValue,
  submitInputOption,
  isImageSelectionModeActive = false,
  tryEnterImageSelectionMode,
}: UseSelectProps<T>): void {
  const modalScrollRef = useModalScrollRef()
  const cancelHandler = onCancel ?? state.onCancel
  const ownsPage = !isDisabled && scrollMovesFocus

  usePopupPageOwner(ownsPage)
  const overlayToken = useRegisterOverlay(
    'select',
    !isDisabled && cancelHandler !== undefined,
    { ownsPageKeys: ownsPage },
  )

  const options: readonly OptionWithDescription<T>[] = state.options

  const declineTokenRef = useRef({})
  const declineIdx = options.findIndex(
    opt => !isInputOption(opt) && (opt.value === 'no' || opt.value === 'reject'),
  )
  const declineRow = declineIdx >= 0 ? declineIdx + 1 : null
  useClaim(() => {
    if (isDisabled) return
    return reportConsentDeclineRow(declineTokenRef.current, declineRow)
  }, [isDisabled, declineRow])

  const focusedIdx =
    state.focusedValue !== undefined
      ? options.findIndex(o => o.value === state.focusedValue)
      : -1
  const focusedOption = focusedIdx >= 0 ? options[focusedIdx] : undefined

  const firstEnabledIdx = options.findIndex(o => !o.disabled)
  let lastEnabledIdx = -1
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i]!.disabled) {
      lastEnabledIdx = i
      break
    }
  }

  const moveNext = (): void => {
    if (
      onDownFromLastItem &&
      lastEnabledIdx >= 0 &&
      focusedIdx === lastEnabledIdx
    ) {
      onDownFromLastItem()
      return
    }
    state.focusNextOption()
  }

  const movePrevious = (): void => {
    if (
      onUpFromFirstItem &&
      firstEnabledIdx >= 0 &&
      focusedIdx === firstEnabledIdx &&
      state.visibleFromIndex === 0
    ) {
      onUpFromFirstItem()
      return
    }
    state.focusPreviousOption()
  }

  const wheelYieldRef = useRef(false)
  useInput(
    (_input: string, key: Key, event: InputEvent) => {
      wheelYieldRef.current = !scrollMovesFocus && isWheelReport(key, event)
    },
    { isActive: !isDisabled && !scrollMovesFocus },
  )

  useKeybindings(
    {
      'select:next': () => {
        if (!scrollMovesFocus && wheelYieldRef.current) {
          wheelYieldRef.current = false
          return false
        }
        moveNext()
      },
      'select:previous': () => {
        if (!scrollMovesFocus && wheelYieldRef.current) {
          wheelYieldRef.current = false
          return false
        }
        movePrevious()
      },
      'select:first': () => {
        state.focusFirstOption()
      },
      'select:last': () => {
        state.focusLastOption()
      },
      'select:accept': () => {
        if (disableSelection === true) return
        if (state.focusedValue === undefined) return
        if (focusedOption?.disabled) return
        if (enterHeldByQueuedWords()) return
        state.selectFocusedOption()
      },
    },
    {
      context: 'Select',
      isActive: !isDisabled && !state.isInInput,
    },
  )

  useKeybindings(
    {
      'select:cancel': () => {
        if (overlayToken === null || !isTopOverlayNow(overlayToken)) {
          return false
        }
        cancelHandler?.()
      },
    },
    {
      context: 'Select',
      isActive: !isDisabled && cancelHandler !== undefined,
    },
  )

  const activateOrdinalTarget = (target: OptionWithDescription<T>): void => {
    if (target.disabled) return
    const val = optionValueOf(target)
    if (isInputOption(target)) {
      const text = getInputValue?.(val) ?? ''
      if (
        submitInputOption &&
        (text.trim().length > 0 || target.allowEmptySubmitToCancel)
      ) {
        submitInputOption(target)
      } else {
        state.focusValue(val)
      }
      return
    }
    state.onChange?.(val)
  }

  useInput(
    (input: string, key: Key, event: InputEvent) => {
      if (
        !scrollMovesFocus &&
        (key.wheelUp || key.wheelDown || key.pageUp || key.pageDown)
      ) {
        return
      }

      if (key.pageDown || key.pageUp) {
        const modalBody = modalScrollRef?.current ?? null
        const atEdge = key.pageUp
          ? firstEnabledIdx >= 0 && focusedIdx === firstEnabledIdx
          : lastEnabledIdx >= 0 && focusedIdx === lastEnabledIdx
        if (
          modalBody &&
          atEdge &&
          modalBody.getFreshScrollHeight() > modalBody.getViewportHeight()
        ) {
          const step = Math.max(1, modalBody.getViewportHeight() - 1)
          modalBody.scrollBy(key.pageUp ? -step : step)
        } else if (key.pageUp) {
          state.focusPreviousPage()
        } else {
          state.focusNextPage()
        }
        event.stopImmediatePropagation()
        return
      }

      if (key.tab && onInputModeToggle && state.focusedValue !== undefined) {
        onInputModeToggle(state.focusedValue)
        event.stopImmediatePropagation()
        return
      }

      if (state.isInInput) {
        if (isImageSelectionModeActive) {
          return
        }
        if (key.downArrow) {
          if (tryEnterImageSelectionMode?.()) {
            event.stopImmediatePropagation()
            return
          }
          moveNext()
          event.stopImmediatePropagation()
          return
        }
        if (key.ctrl && input === 'n') {
          moveNext()
          event.stopImmediatePropagation()
          return
        }
        if (key.upArrow || (key.ctrl && input === 'p')) {
          movePrevious()
          event.stopImmediatePropagation()
          return
        }
        return
      }

      if (disableSelection === true) {
        return
      }

      if (
        isMultiSelect &&
        normalizeFullWidthSpace(input) === ' ' &&
        !key.ctrl &&
        !key.meta
      ) {
        if (state.focusedValue !== undefined && !focusedOption?.disabled) {
          state.selectFocusedOption()
        }
        event.stopImmediatePropagation()
        return
      }

      if (
        disableSelection !== 'numeric' &&
        !key.ctrl &&
        !key.meta &&
        !key.super
      ) {
        const normalized = normalizeFullWidthDigits(input)
        if (/^[0-9]+$/.test(normalized)) {
          const parsed = Number.parseInt(normalized, 10)
          if (parsed >= 1 && parsed <= options.length) {
            activateOrdinalTarget(options[parsed - 1]!)
            event.stopImmediatePropagation()
            return
          }
        }
      }

      if (/^[a-zA-Z]$/.test(input) && !key.ctrl && !key.meta && !key.super) {
        const upper = input.toUpperCase()
        const target = options.find(opt => letterOrdinalOf(opt) === upper)
        if (target !== undefined) {
          activateOrdinalTarget(target)
          event.stopImmediatePropagation()
          return
        }
      }

      if (trySeedComposer(input, key)) {
        event.stopImmediatePropagation()
      }
    },
    { isActive: !isDisabled },
  )
}
