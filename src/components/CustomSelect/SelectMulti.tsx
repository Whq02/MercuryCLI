import figures from 'figures'
import React from 'react'
import { Box, Text } from '../../ink.js'
import type { PastedContent } from '../../utils/config.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import {
  isInputOption,
  optionValueOf,
  type InputOption,
  type OptionWithDescription,
} from './option-map.js'
import { SelectInputOption } from './select-input-option.js'
import { SelectOption } from './select-option.js'
import { useMultiSelectState } from './use-multi-select-state.js'
import { PopupListViewport } from './popup-list.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type SelectMultiProps<T = string> = Unbuilt

export function SelectMulti<T = string>(arg0: SelectMultiProps<T>): React.ReactNode {
  return notBuilt('src/components/CustomSelect/SelectMulti.tsx:48')
}

export default SelectMulti
