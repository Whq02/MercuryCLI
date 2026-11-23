import figures from 'figures'
import { GLYPH } from '../theme/glyphs.js'
import React, { useContext, useRef, useState } from 'react'
import { usePublish } from '../effects/effects.js'
import { PopupFormContext, usePopupCompact } from '../overlays/popupFormContext.js'
import { Ansi, Box, Text } from '../themedRenderer.js'
import { useDeclaredCursor } from '../renderer/bindings/use-declared-cursor.js'
import { stringWidth } from '../renderer/stringWidth.js'
import type { PastedContent } from '../../platform/settings/config.js'
import type { ImageDimensions } from '../../platform/images/imageResizer.js'
import {
  isInputOption,
  optionValueOf,
  type InputOption,
  type OptionWithDescription,
} from './optionMap.js'
import { SelectInputOption } from './SelectInputOption.js'
import { useSelectInput } from './useSelectInput.js'
import { useSelectState } from './use-select-state.js'
import { PopupListViewport } from './popup-list.js'
import { selectViewOf } from './selectView.js'

export type { OptionWithDescription } from './optionMap.js'

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

function stateColorOf(
  isFocused: boolean,
  isSelected: boolean,
  disabled: boolean | undefined,
): string | undefined {
  if (disabled) return undefined
  if (isSelected) return 'success'
  if (isFocused) return 'suggestion'
  return undefined
}

function renderTwoColumnList<T>({
  options,
  visible,
  visibleFromIndex,
  visibleToIndex,
  hideIndexes,
  selectedValue,
  rowFlags,
}: {
  options: readonly OptionWithDescription<T>[]
  visible: readonly (OptionWithDescription<T> & { index: number })[]
  visibleFromIndex: number
  visibleToIndex: number
  hideIndexes: boolean
  selectedValue: T | undefined
  rowFlags: (option: OptionWithDescription<T> & { index: number }) => {
    isFocused: boolean
    isSelected: boolean
  }
}): React.ReactNode {
  const indexWidth = hideIndexes ? 0 : options.length.toString().length + 2
  let labelColumnWidth = 0
  for (const opt of options) {
    if (isInputOption(opt)) continue
    const labelWidth = typeof opt.label === 'string' ? stringWidth(opt.label) : 0
    const checkWidth = opt.value === selectedValue ? 2 : 0
    const rowWidth = 2 + indexWidth + labelWidth + checkWidth
    if (rowWidth > labelColumnWidth) labelColumnWidth = rowWidth
  }

  return (
    <PopupListViewport
      above={visibleFromIndex}
      below={options.length - visibleToIndex}
      rows={visible.length}
    >
      {visible.map(option => {
        const { isFocused, isSelected } = rowFlags(option)
        const disabled = Boolean(option.disabled)
        const stateColor = stateColorOf(isFocused, isSelected, option.disabled)
        const prefix = hideIndexes
          ? ''
          : rowPrefix(option, option.index + 1, indexWidth)
        const labelText = typeof option.label === 'string' ? option.label : ''
        const checkSuffix = isSelected ? ` ${GLYPH.check}` : ''
        const raw = `${prefix}${labelText}${checkSuffix}`
        const pad = Math.max(0, labelColumnWidth - 2 - stringWidth(raw))
        const labelCell = `${raw}${' '.repeat(pad)}`
        return (
          <TwoColumnRow
            key={String(option.value)}
            indicator={isFocused ? figures.pointer : ' '}
            labelCell={labelCell}
            isFocused={isFocused}
            description={option.description}
            dimDescription={option.dimDescription !== false}
            stateColor={stateColor}
            disabled={disabled}
          />
        )
      })}
    </PopupListViewport>
  )
}

export function Select<T = string>({
  isDisabled = false,
  disableSelection = false,
  hideIndexes = false,
  visibleOptionCount = 5,
  highlightText,
  options,
  defaultValue,
  onCancel,
  onChange,
  onFocus,
  onVisibleWindowChange,
  defaultFocusValue,
  layout = 'compact',
  inlineDescriptions = false,
  onUpFromFirstItem,
  onDownFromLastItem,
  scrollMovesFocus = true,
  onInputModeToggle,
  onOpenEditor,
  onImagePaste,
  pastedContents,
  onRemoveImage,
  onEmptyInputSubmit,
}: SelectProps<T>): React.ReactNode {
  const fit = useContext(PopupFormContext)
  const { compact: singleLine } = usePopupCompact()

  const state = useSelectState({
    visibleOptionCount,
    options,
    defaultValue,
    onChange,
    onCancel,
    onFocus,
    focusValue: defaultFocusValue,
  })

  usePublish(() => {
    onVisibleWindowChange?.(state.visibleFromIndex, state.visibleToIndex)
  }, [onVisibleWindowChange, state.visibleFromIndex, state.visibleToIndex])

  const [inputValues, setInputValues] = useState<Map<T, string>>(() => {
    const initial = new Map<T, string>()
    for (const option of options) {
      if (isInputOption(option) && option.initialValue) {
        initial.set(optionValueOf(option), option.initialValue)
      }
    }
    return initial
  })

  const prevInitialValuesRef = useRef<Map<T, string | undefined> | null>(null)
  if (prevInitialValuesRef.current === null) {
    const seed = new Map<T, string | undefined>()
    for (const option of options) {
      if (isInputOption(option)) {
        seed.set(optionValueOf(option), option.initialValue)
      }
    }
    prevInitialValuesRef.current = seed
  }

  const prevInitialValues = prevInitialValuesRef.current
  let nextInputValues: Map<T, string> | null = null
  for (const option of options) {
    if (!isInputOption(option)) continue
    const val = optionValueOf(option)
    const former = prevInitialValues.get(val)
    if (option.initialValue !== former) {
      prevInitialValues.set(val, option.initialValue)
      const current = inputValues.get(val) ?? ''
      if (current === (former ?? '')) {
        if (nextInputValues === null) {
          nextInputValues = new Map(inputValues)
        }
        nextInputValues.set(val, option.initialValue ?? '')
      }
    }
  }
  if (nextInputValues !== null) {
    setInputValues(nextInputValues)
  }

  const imageAttachments = pastedContents
    ? Object.values(pastedContents).filter(item => item.type === 'image')
    : []
  const hasImages = imageAttachments.length > 0

  const [isImageSelectionMode, setIsImageSelectionMode] = useState(false)
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)

  const handleEnterImageSelection = (): boolean => {
    if (!hasImages) return false
    setIsImageSelectionMode(true)
    setSelectedImageIndex(imageAttachments.length - 1)
    return true
  }

  const handleExitImageSelection = (): void => {
    setIsImageSelectionMode(false)
  }

  const handleInputChange = (option: InputOption<T>, newValue: string): void => {
    const val = optionValueOf(option)
    setInputValues(prev => {
      const next = new Map(prev)
      next.set(val, newValue)
      return next
    })
    option.onChange?.(newValue)
  }

  const submitInputOption = (
    option: InputOption<T>,
    submittedText?: string,
  ): void => {
    const val = optionValueOf(option)
    const text = submittedText ?? inputValues.get(val) ?? ''
    if (text.trim().length > 0 || hasImages || option.allowEmptySubmitToCancel) {
      onChange?.(val)
      return
    }
    if (onEmptyInputSubmit) {
      onEmptyInputSubmit(val)
    } else {
      onCancel?.()
    }
  }

  const ordinalsHidden = layout === 'expanded' || hideIndexes
  const effectiveDisableSelection: boolean | 'numeric' =
    disableSelection === false && ordinalsHidden ? 'numeric' : disableSelection
  const digits = options.length.toString().length
  const textRowReserved = hideIndexes
    ? 0
    : digits + (layout === 'compact-vertical' ? 1 : 2)
  const inputRowReserved = hideIndexes ? 0 : digits

  useSelectInput({
    state,
    isDisabled,
    disableSelection: effectiveDisableSelection,
    isMultiSelect: false,
    onCancel,
    onDownFromLastItem,
    onUpFromFirstItem,
    onInputModeToggle,
    getInputValue: value => inputValues.get(value) ?? '',
    submitInputOption: option => submitInputOption(option),
    tryEnterImageSelectionMode: handleEnterImageSelection,
    isImageSelectionModeActive: isImageSelectionMode,
    scrollMovesFocus,
  })

  const rowFlags = (option: OptionWithDescription<T> & { index: number }) => ({
    isFocused: !isDisabled && state.focusedValue === option.value,
    isSelected: state.value === option.value,
    showUp: false,
    showDown: false,
  })

  const visible: Array<OptionWithDescription<T> & { index: number }> =
    state.visibleOptions
  const useTwoColumn =
    layout === 'compact' &&
    !inlineDescriptions &&
    !visible.some(isInputOption) &&
    visible.some(o => o.description !== undefined && o.description !== '')

  if (useTwoColumn) {
    return renderTwoColumnList({
      options,
      visible,
      visibleFromIndex: state.visibleFromIndex,
      visibleToIndex: state.visibleToIndex,
      hideIndexes,
      selectedValue: state.value,
      rowFlags,
    })
  }

  const inputRow = (
    option: InputOption<T> & { index: number },
  ): React.ReactNode => {
    const val = optionValueOf(option)
    const { isFocused, isSelected, showUp, showDown } = rowFlags(option)
    const currentValue = inputValues.get(val) ?? ''
    const clickable =
      layout !== 'compact' &&
      !isDisabled &&
      !option.disabled &&
      disableSelection !== true
    return (
      <Box
        key={String(option.value)}
        flexDirection="column"
        onClick={
          clickable
            ? () => {
                state.focusValue(val)
                const text = inputValues.get(val) ?? ''
                if (text.trim().length > 0 || hasImages) {
                  submitInputOption(option)
                }
              }
            : undefined
        }
      >
        <SelectInputOption
          option={option}
          isFocused={isFocused}
          isSelected={isSelected}
          value={currentValue}
          onChange={(newValue: string) => handleInputChange(option, newValue)}
          onSubmit={(submitted: string) => submitInputOption(option, submitted)}
          reservedIndexWidth={inputRowReserved}
          index={option.index + 1}
          showLabelWithValue={inlineDescriptions}
          layout={layout}
          shouldShowDownArrow={showDown}
          shouldShowUpArrow={showUp}
          onOpenEditor={onOpenEditor}
          onImagePaste={onImagePaste}
          pastedContents={pastedContents}
          onRemoveImage={onRemoveImage}
          isImageSelectionMode={isImageSelectionMode}
          selectedImageIndex={selectedImageIndex}
          onSelectImage={setSelectedImageIndex}
          onExitImageSelection={handleExitImageSelection}
        />
      </Box>
    )
  }

  return selectViewOf({
    state,
    optionCount: options.length,
    visible,
    inputRow,
    rowFlags,
    stateColorOf,
    ordinalsHidden,
    textRowReserved,
    layout,
    disableSelection,
    isDisabled,
    fit,
    singleLine,
    highlightText,
    hideIndexes,
    inlineDescriptions,
    rowPrefix,
    renderLabel,
  })
}

export default Select
