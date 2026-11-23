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
  ordinalsHidden,
  textRowReserved,
  rowFlags,
}: {
  options: readonly OptionWithDescription<T>[]
  visible: readonly (OptionWithDescription<T> & { index: number })[]
  visibleFromIndex: number
  visibleToIndex: number
  ordinalsHidden: boolean
  textRowReserved: number
  rowFlags: (option: OptionWithDescription<T> & { index: number }) => {
    isFocused: boolean
    isSelected: boolean
  }
}): React.ReactNode {
  let labelColumnWidth = 0
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!
    if (isInputOption(opt)) continue
    const prefix = ordinalsHidden ? '' : rowPrefix(opt, i + 1, textRowReserved)
    const labelWidth = typeof opt.label === 'string' ? stringWidth(opt.label) : 0
    const rowWidth = 2 + stringWidth(prefix) + labelWidth + 2
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
        const activeFocus = isFocused && !disabled
        const stateColor = stateColorOf(isFocused, isSelected, option.disabled)
        const prefix = ordinalsHidden
          ? ''
          : rowPrefix(option, option.index + 1, textRowReserved)
        const labelText = typeof option.label === 'string' ? option.label : ''
        const checkSuffix = isSelected && !disabled ? ` ${GLYPH.check}` : ''
        const raw = `${prefix}${labelText}${checkSuffix}`
        const pad = Math.max(0, labelColumnWidth - 2 - stringWidth(raw))
        const labelCell = `${raw}${' '.repeat(pad)}`
        return (
          <TwoColumnRow
            key={String(option.value)}
            indicator={activeFocus ? figures.pointer : ' '}
            labelCell={labelCell}
            isFocused={activeFocus}
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

  usePublish(() => {
    const prev = prevInitialValuesRef.current!
    const updates: Array<[T, string]> = []
    const nextPrev = new Map<T, string | undefined>()
    for (const option of options) {
      if (!isInputOption(option)) continue
      const val = optionValueOf(option)
      nextPrev.set(val, option.initialValue)
      const hadPrev = prev.has(val)
      const former = prev.get(val)
      if (!hadPrev ? Boolean(option.initialValue) : former !== option.initialValue) {
        updates.push([val, option.initialValue ?? ''])
      }
    }
    prevInitialValuesRef.current = nextPrev
    if (updates.length === 0) return
    setInputValues(currentMap => {
      let nextMap: Map<T, string> | null = null
      for (const [val, nextInit] of updates) {
        const former = prev.get(val) ?? ''
        const current = currentMap.get(val) ?? ''
        if (current === former || current === '') {
          if (!nextMap) nextMap = new Map(currentMap)
          if (nextInit) {
            nextMap.set(val, nextInit)
          } else {
            nextMap.delete(val)
          }
        }
      }
      return nextMap ?? currentMap
    })
  }, [options])

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

  const submitInputOption = (value: T, providedText?: string): void => {
    const option = options.find(o => o.value === value)
    if (!isInputOption(option)) return
    const text = providedText ?? inputValues.get(value) ?? ''
    if (text.trim().length > 0 || hasImages || option.allowEmptySubmitToCancel) {
      state.selectValue(value)
      return
    }
    if (onEmptyInputSubmit) {
      onEmptyInputSubmit(value)
    } else {
      onCancel?.()
    }
  }

  const effectiveDisableSelection: boolean | 'numeric' =
    disableSelection === true
      ? true
      : layout === 'expanded' || hideIndexes
        ? 'numeric'
        : disableSelection

  useSelectInput({
    isDisabled,
    disableSelection: effectiveDisableSelection,
    isMultiSelect: false,
    state,
    onCancel,
    onUpFromFirstItem,
    onDownFromLastItem,
    scrollMovesFocus,
    onInputModeToggle,
    getInputValue: value => inputValues.get(value) ?? '',
    submitInputOption: option => submitInputOption(optionValueOf(option)),
    isImageSelectionModeActive: isImageSelectionMode,
    tryEnterImageSelectionMode: handleEnterImageSelection,
  })

  const ordinalsHidden = hideIndexes || layout === 'expanded'
  const digits = options.length.toString().length
  const textRowReserved = ordinalsHidden
    ? 0
    : digits + (layout === 'compact-vertical' ? 1 : 2)
  const inputRowReserved = ordinalsHidden ? 0 : digits

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
      ordinalsHidden,
      textRowReserved,
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
    const node = (
      <SelectInputOption
        key={clickable ? undefined : String(option.value)}
        option={option}
        isFocused={isFocused}
        isSelected={isSelected}
        shouldShowUpArrow={showUp}
        shouldShowDownArrow={showDown}
        value={currentValue}
        onChange={(newValue: string) => handleInputChange(option, newValue)}
        onSubmit={(submitted: string) => submitInputOption(val, submitted)}
        onExit={onCancel}
        layout={layout}
        index={option.index + 1}
        reservedIndexWidth={inputRowReserved}
        hideIndexes={ordinalsHidden}
        inlineDescription={inlineDescriptions}
        onOpenEditor={onOpenEditor}
        onImagePaste={onImagePaste}
        pastedContents={pastedContents}
        onRemoveImage={onRemoveImage}
        isImageSelectionMode={isFocused && isImageSelectionMode}
        selectedImageIndex={selectedImageIndex}
        onSelectedImageIndexChange={setSelectedImageIndex}
        onExitImageSelection={handleExitImageSelection}
      />
    )
    if (!clickable) return node
    return (
      <Box
        key={String(option.value)}
        onClick={() => {
          state.focusValue(val)
          const text = inputValues.get(val) ?? ''
          if (text.trim().length > 0 || hasImages) {
            state.selectValue(val)
          }
        }}
      >
        {node}
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
    disableSelection: effectiveDisableSelection,
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
