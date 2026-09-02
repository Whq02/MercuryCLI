// The single-select key grammar: the named `Select`-context bindings
// (next/previous/accept/cancel) plus the residual raw path (tab,
// input-option navigation, paging, space, digits, and the composer-seed
// fall-through). Digits, paging, space and tab deliberately stay on the raw
// path; up/down/enter/escape route through the rebindable layer.

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

/** The option's LETTER ordinal, when its display ordinal is a lettered one
 *  (indexLabel 'A.' → 'A'); undefined for numeric/absent ordinals. One
 *  derivation for the hotkey match — the paint side renders indexLabel
 *  verbatim, so key and glyph can never disagree. */
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
  /** `true` disables Enter, space and digits; `'numeric'` disables digits
   *  only, leaving Enter and scrolling live. */
  disableSelection?: boolean | 'numeric'
  /** Whether this hook is driving a multi-select (the space-toggle branch).
   *  Within this slice the single-select component always passes false, so
   *  the branch is unreachable from here — kept as the hook's accepted
   *  surface. */
  isMultiSelect?: boolean
  onCancel?: () => void
  onDownFromLastItem?: () => void
  onUpFromFirstItem?: () => void
  onInputModeToggle?: (value: T) => void
  /** Current text of an input option (the component owns the value map). */
  getInputValue?: (value: T) => string
  /** Submit an input option (digit selection with pre-filled text). */
  submitInputOption?: (option: OptionWithDescription<T>) => void
  /** Offer to enter image-selection mode; returns true when images exist. */
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
  // Registered as a modal overlay ONLY when a cancel callback was supplied;
  // the token gates escape handling to the top layer.
  const overlayToken = useRegisterOverlay('select', Boolean(onCancel))
  const tokenRef = useRef(overlayToken)
  tokenRef.current = overlayToken

  const optionCount = state.options.length
  const isOnLastOption = state.focusedIndex === optionCount && optionCount > 0
  const isOnFirstOption = state.focusedIndex === 1
  const isWindowAtTop = state.visibleFromIndex === 0

  // Navigation and accept are NOT registered while the focused option is an
  // input, so j/k/Enter reach the text field instead of being intercepted.
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
        // Act only while this select is the top overlay at the moment the
        // event is dispatched: one keypress closes exactly one layer.
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

      // 1. Tab toggles input mode for the focused value.
      if (key.tab && onInputModeToggle && state.focusedValue !== undefined) {
        onInputModeToggle(state.focusedValue)
        event.stopImmediatePropagation()
        return
      }

      // 2. While the focused option is an input, only the vertical movement
      // chords are intercepted; everything else — digits included — falls
      // through to the text field.
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

      // 3. Paging — deliberately does not consume the event (the remaining
      // steps are no-ops for these keys).
      if (key.pageDown) state.focusNextPage()
      if (key.pageUp) state.focusPreviousPage()

      // 4. Space and digits, unless selection is fully disabled.
      if (disableSelection !== true) {
        if (normalizeFullWidthSpace(input) === ' ') {
          if (isMultiSelect && focusedOption && !focusedOption.disabled) {
            // The multi-select toggle branch — unreachable within this slice
            // (the single-select component always passes isMultiSelect
            // false); commit the focused option as the toggle.
            state.selectFocusedOption()
            event.stopImmediatePropagation()
            return
          }
        }
        // The shared ordinal-activation body (digits and ordinal letters):
        // an input option with text submits, an empty one takes focus, a
        // text option fires the change callback ONLY — no focus move, no
        // update to the internally held selected value. A DISABLED target
        // consumes without acting (its ordinal is painted on this surface).
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
          // The decline law: a digit naming NO row here propagates untouched
          // (an interview card's footer paints its own ordinals below the
          // select — "6. Chat about this" — and owns them); digits are
          // structurally un-seedable, so nothing leaks into the composer.
          if (target !== undefined) {
            activateOrdinalTarget(target)
            return
          }
        }
        // Ordinal LETTERS: a list whose options carry lettered display
        // ordinals (indexLabel 'A.'–'E.' — the Apollo poll grammar) selects
        // on those letters too, case-insensitive — the advertised ordinal
        // is the hotkey. Scoped by construction to lists that PAINT letters:
        // an option without a letter ordinal never matches, so ordinary
        // selects (and the consent-card composer-seed fall-through below)
        // keep their behaviour byte-identical.
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

      // 5. Fall-through: offer the keystroke to the composer-seed seam
      // (armed consent cards seed the composer draft from a printable
      // non-digit keystroke; digits and focused fields returned earlier).
      trySeedComposer(input, key)
    },
    { isActive: !isDisabled },
  )
}
