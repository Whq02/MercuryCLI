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
import { isWheelReport, letterOrdinalOf } from './use-select-input.js'
import { usePopupPageOwner } from './popup-list.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type UseMultiSelectStateProps<T> = Unbuilt

type MultiSelectState<T> = Unbuilt

export function useMultiSelectState<T>(arg0: UseMultiSelectStateProps<T>): MultiSelectState<T> {
  return notBuilt('src/components/CustomSelect/use-multi-select-state.ts:53')
}
