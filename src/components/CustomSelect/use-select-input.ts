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
  type OptionWithDescription,
} from './option-map.js'
import type { SelectState } from './use-select-state.js'
import { usePopupPageOwner } from './popup-list.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

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

type UseSelectProps<T> = Unbuilt

export function useSelectInput<T>(arg0: UseSelectProps<T>): void {
  return notBuilt('src/components/CustomSelect/use-select-input.ts:54')
}
