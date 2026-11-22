import figures from 'figures'
import { GLYPH } from '../../utils/glyphs.js'
import React, { useContext, useRef, useState } from 'react'
import { usePublish } from '../../hooks/effects.js'
import { PopupFormContext, usePopupCompact } from '../../context/popupFormContext.js'
import { Ansi, Box, Text } from '../../ink.js'
import { useDeclaredCursor } from '../../ink/hooks/use-declared-cursor.js'
import { stringWidth } from '../../ink/stringWidth.js'
import type { PastedContent } from '../../utils/config.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import {
  isInputOption,
  optionValueOf,
  type InputOption,
  type OptionWithDescription,
} from './option-map.js'
import { SelectInputOption } from './select-input-option.js'
import { useSelectInput } from './use-select-input.js'
import { useSelectState } from './use-select-state.js'
import { PopupListViewport } from './popup-list.js'
import { selectViewOf } from './selectView.js'
import { notBuilt } from '../../pi/holes.js'

export type { OptionWithDescription } from './option-map.js'

type SelectProps<T = string> = {
  isDisabled?: boolean
  disableSelection?: boolean | 'numeric'
  hideIndexes?: boolean
  visibleOptionCount?: number
  highlightText?: string
  options: OptionWithDescription<T>[]
  defaultValue?: T
  onCancel?: () => void
  onChange?: (value: T) => void
  onFocus?: (value: T) => void
  onVisibleWindowChange?: (visibleFromIndex: number, visibleToIndex: number) => void
  defaultFocusValue?: T
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  inlineDescriptions?: boolean
  onUpFromFirstItem?: () => void
  onDownFromLastItem?: () => void
  scrollMovesFocus?: boolean
  onInputModeToggle?: (value: T) => void
  onOpenEditor?: (value: string, setValue: (value: string) => void) => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
  ) => void
  pastedContents?: Record<number, PastedContent>
  onRemoveImage?: (id: number) => void
  onEmptyInputSubmit?: (value: T) => void
}

function indexPrefix(index1: number, reservedWidth: number): string {
  const raw = index1 <= 9 ? `${index1}.` : ''
  return raw.padEnd(reservedWidth)
}

function rowPrefix(
  option: { indexLabel?: string },
  index1: number,
  reservedWidth: number,
): string {
  return option.indexLabel !== undefined
    ? option.indexLabel.padEnd(Math.max(reservedWidth, option.indexLabel.length + 1))
    : indexPrefix(index1, reservedWidth)
}

function renderLabel(
  label: React.ReactNode,
  highlightText: string | undefined,
): React.ReactNode {
  if (
    highlightText === undefined ||
    highlightText === '' ||
    typeof label !== 'string' ||
    !label.includes(highlightText)
  ) {
    return label
  }
  const at = label.indexOf(highlightText)
  return (
    <>
      {label.slice(0, at)}
      <Text bold>{label.slice(at, at + highlightText.length)}</Text>
      {label.slice(at + highlightText.length)}
    </>
  )
}

function TwoColumnRow({
  indicator,
  labelCell,
  isFocused,
  description,
  dimDescription,
  stateColor,
  disabled,
}: {
  indicator: string
  labelCell: string
  isFocused: boolean
  description: string | undefined
  dimDescription: boolean
  stateColor: string | undefined
  disabled: boolean
}): React.ReactNode {
  const cursorRef = useDeclaredCursor({ line: 0, column: 0, active: isFocused })
  return (
    <Box ref={cursorRef} width="100%">
      <Box flexShrink={0}>
        <Text color={stateColor} dimColor={disabled}>
          {indicator} {labelCell}
        </Text>
      </Box>
      <Box marginLeft={2} flexShrink={1}>
        <Text color={stateColor} dimColor={dimDescription} wrap="wrap">
          {description !== undefined && description !== '' ? (
            <Ansi>{description}</Ansi>
          ) : (
            ' '
          )}
        </Text>
      </Box>
    </Box>
  )
}

export function Select<T = string>(arg0: SelectProps<T>): React.ReactNode {
  return notBuilt('src/components/CustomSelect/select.tsx:132')
}

export default Select
