
import figures from 'figures'
import React, { useEffect, useRef, useState } from 'react'
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
import { SelectOption } from './select-option.js'
import { useSelectInput } from './use-select-input.js'
import { useSelectState } from './use-select-state.js'

export type { OptionWithDescription } from './option-map.js'

export type SelectProps<T = string> = {
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
  onInputModeToggle,
  onOpenEditor,
  onImagePaste,
  pastedContents,
  onRemoveImage,
}: SelectProps<T>): React.ReactNode {
  const state = useSelectState({
    visibleOptionCount,
    options,
    defaultValue,
    onChange,
    onCancel,
    onFocus,
    focusValue: defaultFocusValue,
  })

  const [inputValues, setInputValues] = useState<Map<T, string>>(() => {
    const seeded = new Map<T, string>()
    for (const option of options) {
      if (isInputOption(option) && option.initialValue) {
        seeded.set(optionValueOf(option), option.initialValue)
      }
    }
    return seeded
  })
  const previousInitialsRef = useRef<Map<T, string | undefined>>(
    new Map(
      options
        .filter(isInputOption)
        .map(option => [optionValueOf(option), option.initialValue]),
    ),
  )
  let initialAdoptions: Map<T, string> | null = null
  for (const option of options) {
    if (!isInputOption(option)) continue
    const value = optionValueOf(option)
    const previousInitial = previousInitialsRef.current.get(value)
    if (option.initialValue !== previousInitial) {
      previousInitialsRef.current.set(value, option.initialValue)
      const current = inputValues.get(value) ?? ''
      if (current === (previousInitial ?? '')) {
        ;(initialAdoptions ??= new Map()).set(value, option.initialValue ?? '')
      }
    }
  }
  if (initialAdoptions !== null) {
    const merged = new Map(inputValues)
    for (const [value, text] of initialAdoptions) merged.set(value, text)
    setInputValues(merged)
  }

  const setInputValue = (value: T, text: string): void => {
    setInputValues(current => {
      const next = new Map(current)
      next.set(value, text)
      return next
    })
  }

  const images: PastedContent[] = Object.values(pastedContents ?? {}).filter(
    content => content.type === 'image',
  )
  const [isImageSelectionMode, setImageSelectionMode] = useState(false)
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const tryEnterImageSelectionMode = (): boolean => {
    if (images.length === 0) return false
    setImageSelectionMode(true)
    setSelectedImageIndex(images.length - 1)
    return true
  }

  const submitInputOption = (option: OptionWithDescription<T>): void => {
    const text = inputValues.get(optionValueOf(option)) ?? ''
    if (
      text.trim() !== '' ||
      images.length > 0 ||
      (isInputOption(option) && option.allowEmptySubmitToCancel)
    ) {
      onChange?.(optionValueOf(option))
    } else {
      onCancel?.()
    }
  }

  const ordinalsHidden = layout === 'expanded' || hideIndexes
  const effectiveDisableSelection: boolean | 'numeric' =
    disableSelection === false && ordinalsHidden ? 'numeric' : disableSelection

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
    submitInputOption,
    tryEnterImageSelectionMode,
    isImageSelectionModeActive: isImageSelectionMode,
  })

  const optionCount = options.length
  const digitCount = String(optionCount).length
  const textRowReserved = hideIndexes
    ? 0
    : digitCount + (layout === 'compact-vertical' ? 1 : 2)
  const inputRowReserved = hideIndexes ? 0 : digitCount

  const visible = state.visibleOptions
  const hasAbove = state.visibleFromIndex > 0
  const hasBelow = state.visibleToIndex < optionCount
  const { visibleFromIndex, visibleToIndex } = state
  useEffect(() => {
    onVisibleWindowChange?.(visibleFromIndex, visibleToIndex)
  }, [onVisibleWindowChange, visibleFromIndex, visibleToIndex])

  const rowFlags = (
    option: OptionWithDescription<T> & { index: number },
    position: number,
  ) => {
    const isFocused = !isDisabled && state.focusedValue === option.value
    const isSelected = state.value === option.value
    const showUp = position === 0 && hasAbove && !isFocused
    const showDown = position === visible.length - 1 && hasBelow && !isFocused
    return { isFocused, isSelected, showUp, showDown }
  }

  const inputRow = (
    option: InputOption<T> & { index: number },
    position: number,
  ): React.ReactNode => {
    const { isFocused, isSelected, showUp, showDown } = rowFlags(
      option,
      position,
    )
    return (
      <SelectInputOption
        key={String(option.value)}
        option={option}
        isFocused={isFocused}
        isSelected={isSelected}
        value={inputValues.get(optionValueOf(option)) ?? ''}
        onChange={text => {
          setInputValue(optionValueOf(option), text)
          option.onChange?.(text)
        }}
        onSubmit={() => {
          submitInputOption(option)
        }}
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
        onExitImageSelection={() => {
          setImageSelectionMode(false)
        }}
      />
    )
  }

  const stateColorOf = (
    isFocused: boolean,
    isSelected: boolean,
    disabled: boolean | undefined,
  ): string | undefined => {
    if (disabled) return undefined
    if (isSelected) return 'success'
    if (isFocused) return 'suggestion'
    return undefined
  }

  const anyInputInView = visible.some(option => isInputOption(option))
  const anyDescriptionInView = visible.some(
    option => option.description !== undefined && option.description !== '',
  )
  if (
    layout === 'compact' &&
    !inlineDescriptions &&
    !anyInputInView &&
    anyDescriptionInView
  ) {
    const indexWidth = hideIndexes ? 0 : digitCount + 2
    const labelColumnWidth = options.reduce((max, option) => {
      if (isInputOption(option)) return max
      const labelWidth =
        typeof option.label === 'string' ? stringWidth(option.label) : 0
      const checkmarkWidth = state.value === option.value ? 2 : 0
      return Math.max(max, 2 + indexWidth + labelWidth + checkmarkWidth)
    }, 0)
    return (
      <Box flexDirection="column">
        {visible.map((option, position) => {
          const { isFocused, isSelected, showUp, showDown } = rowFlags(
            option,
            position,
          )
          const indicator = isFocused
            ? figures.pointer
            : showDown
              ? figures.arrowDown
              : showUp
                ? figures.arrowUp
                : ' '
          const prefix = hideIndexes
            ? ''
            : rowPrefix(option, option.index + 1, indexWidth)
          const label = typeof option.label === 'string' ? option.label : ''
          const tick = isSelected ? ` ${figures.tick}` : ''
          const bare = `${prefix}${label}${tick}`
          const pad = Math.max(
            0,
            labelColumnWidth - 2 - stringWidth(bare),
          )
          return (
            <TwoColumnRow
              key={String(option.value)}
              indicator={indicator}
              labelCell={bare + ' '.repeat(pad)}
              isFocused={isFocused}
              description={option.description}
              dimDescription={option.dimDescription !== false}
              stateColor={stateColorOf(isFocused, isSelected, option.disabled)}
              disabled={Boolean(option.disabled)}
            />
          )
        })}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {visible.map((option, position) => {
        if (isInputOption(option)) {
          return inputRow(option as InputOption<T> & { index: number }, position)
        }
        const { isFocused, isSelected, showUp, showDown } = rowFlags(
          option,
          position,
        )
        const stateColor = stateColorOf(isFocused, isSelected, option.disabled)
        const prefix = ordinalsHidden ? '' : rowPrefix(option, option.index + 1, textRowReserved)
        const clickable =
          layout === 'expanded' && disableSelection !== true && !option.disabled
        const description =
          option.description !== undefined && option.description !== ''
            ? option.description
            : undefined
        const dimDescription = option.dimDescription !== false

        const labelNode = (
          <Box flexShrink={0}>
            <Text color={stateColor} dimColor={option.disabled}>
              {prefix}
              {renderLabel(option.label, highlightText)}
            </Text>
          </Box>
        )

        if (layout === 'expanded') {
          return (
            <Box
              key={String(option.value)}
              flexDirection="column"
              onClick={
                clickable
                  ? () => {
                      state.focusValue(optionValueOf(option))
                      state.selectValue(optionValueOf(option))
                    }
                  : undefined
              }
            >
              <SelectOption
                isFocused={isFocused}
                isSelected={isSelected}
                shouldShowDownArrow={showDown}
                shouldShowUpArrow={showUp}
                description={description}
              >
                {labelNode}
              </SelectOption>
              <Box height={1} />
            </Box>
          )
        }

        if (layout === 'compact-vertical') {
          const indent = hideIndexes ? 4 : textRowReserved + 4
          return (
            <Box
              key={String(option.value)}
              flexDirection="column"
              onClick={
                !isDisabled && !option.disabled && disableSelection !== true
                  ? () => state.focusValue(optionValueOf(option))
                  : undefined
              }
            >
              <SelectOption
                isFocused={isFocused}
                isSelected={isSelected}
                shouldShowDownArrow={showDown}
                shouldShowUpArrow={showUp}
              >
                {labelNode}
              </SelectOption>
              {description !== undefined ? (
                <Box paddingLeft={indent}>
                  <Text color={stateColor} dimColor={dimDescription}>
                    <Ansi>{description}</Ansi>
                  </Text>
                </Box>
              ) : null}
            </Box>
          )
        }

        return (
          <SelectOption
            key={String(option.value)}
            isFocused={isFocused}
            isSelected={isSelected}
            shouldShowDownArrow={showDown}
            shouldShowUpArrow={showUp}
          >
            {labelNode}
            {description !== undefined && !inlineDescriptions ? (
              <Box marginLeft={2} flexShrink={1}>
                <Text color={stateColor} dimColor={dimDescription} wrap="wrap-trim">
                  <Ansi>{description}</Ansi>
                </Text>
              </Box>
            ) : null}
            {description !== undefined && inlineDescriptions ? (
              <Text color={stateColor} dimColor>
                {' '}
                <Ansi>{description}</Ansi>
              </Text>
            ) : null}
          </SelectOption>
        )
      })}
    </Box>
  )
}

export default Select
