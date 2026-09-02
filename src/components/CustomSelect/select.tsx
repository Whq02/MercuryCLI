// The single-select component: three layouts (compact, expanded,
// compact-vertical), inline input options with attachment handling, and
// click-to-select in the expanded layout only. The key grammar lives in
// use-select-input; this file owns layout arithmetic, the input-value map,
// image-selection mode, and the submit/cancel decision for input options.

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
  /** `true` disables Enter, space and digits; `'numeric'` disables digits
   *  only (the key machinery beneath always spoke this union — a caller
   *  that owns its own digit grammar, e.g. the manager interview card's
   *  ruled select-never-advance digits, passes it while the painted
   *  indexes stay). Hiding indexes upgrades `false` to `'numeric'`. */
  disableSelection?: boolean | 'numeric'
  hideIndexes?: boolean
  visibleOptionCount?: number
  /** When an option's plain-string label contains this text, the first
   *  occurrence renders bold. */
  highlightText?: string
  options: OptionWithDescription<T>[]
  defaultValue?: T
  onCancel?: () => void
  onChange?: (value: T) => void
  onFocus?: (value: T) => void
  /** RENDER-STATE notification (PD-5): fires when the scrolled
   *  window moves, with the window's [from, to) option indexes — so a
   *  caller's own "…and N more below" can follow the scroll instead of
   *  freezing at mount. Pure paint data; nothing in the select reads it. */
  onVisibleWindowChange?: (visibleFromIndex: number, visibleToIndex: number) => void
  /** Seeds the opening focus and re-asserts focus whenever it changes. */
  defaultFocusValue?: T
  layout?: 'compact' | 'expanded' | 'compact-vertical'
  /** Render descriptions inline after the label instead of in their own
   *  column/line. */
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
  /** ↵ on an input row whose field is EMPTY (no attachment, no
   *  allowEmptySubmitToCancel): reported here instead of cancelling, so a
   *  caller can keep the field focused with a hint — an empty ↵ on a
   *  free-text row must never close the whole dialog under the operator. */
  onEmptyInputSubmit?: (value: T) => void
}

/** 1-based index prefix: positions 1–9 carry `N.`, positions 10 and above
 *  the empty string, padded to the reserved width so rows stay aligned. */
function indexPrefix(index1: number, reservedWidth: number): string {
  const raw = index1 <= 9 ? `${index1}.` : ''
  return raw.padEnd(reservedWidth)
}

/** The row's ordinal prefix: the option's own display ordinal (indexLabel —
 *  the Apollo letter grammar rides this) when declared, else the numeric
 *  index. One helper so the two prefix sites can never disagree. The
 *  declared-ordinal grammar guarantees ONE trailing space ("A. label") even
 *  where the reserved width is tighter (compact-vertical reserves
 *  digits+1, which leaves the numeric "1." flush — that legacy spacing is
 *  the numeric path's own and stays byte-identical). */
function rowPrefix(
  option: { indexLabel?: string },
  index1: number,
  reservedWidth: number,
): string {
  return option.indexLabel !== undefined
    ? option.indexLabel.padEnd(Math.max(reservedWidth, option.indexLabel.length + 1))
    : indexPrefix(index1, reservedWidth)
}

/** First occurrence of the highlight in a plain-string label renders bold. */
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

/** The two-column compact row declares the terminal cursor itself, parked
 *  at the row origin (the indicator cell) — gated on focus only. */
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
  onEmptyInputSubmit,
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

  // ── input-value bookkeeping ─────────────────────────────────────────────
  // Seeded from each input option's initial value (non-empty only). When an
  // option's initial value changes externally: adopt the new initial only
  // when the user has not edited away from the previous one.
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

  // ── image-selection mode ────────────────────────────────────────────────
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

  // Submitting an input option: non-blank trimmed text, existing image
  // attachments, or an allowed empty submit fire the change callback;
  // anything else reports the empty field to a caller that listens, else
  // cancels. `submitted` is the field's text at its own submit — a
  // coalesced keystroke lands text and ↵ in one event, ahead of the render
  // that would refresh the value map.
  const submitInputOption = (option: OptionWithDescription<T>, submitted?: string): void => {
    const text = submitted ?? inputValues.get(optionValueOf(option)) ?? ''
    if (
      text.trim() !== '' ||
      images.length > 0 ||
      (isInputOption(option) && option.allowEmptySubmitToCancel)
    ) {
      onChange?.(optionValueOf(option))
    } else if (onEmptyInputSubmit) {
      onEmptyInputSubmit(optionValueOf(option))
    } else {
      onCancel?.()
    }
  }

  // Hiding indexes also forces numeric selection off: a digit must never
  // activate a mapping the user cannot see — and the expanded layout paints
  // no ordinal either, so the fence and the paint read ONE predicate (PD-2:
  // the /resume tree's rows never showed a '3.' while a typed 3 resumed the
  // third session instead of starting a search).
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

  // ── layout arithmetic ───────────────────────────────────────────────────
  const optionCount = options.length
  const digitCount = String(optionCount).length
  // Reserved prefix widths per layout; input rows always digits + 2.
  const textRowReserved = hideIndexes
    ? 0
    : digitCount + (layout === 'compact-vertical' ? 1 : 2)
  const inputRowReserved = hideIndexes ? 0 : digitCount

  const visible = state.visibleOptions
  const hasAbove = state.visibleFromIndex > 0
  const hasBelow = state.visibleToIndex < optionCount
  // PD-5: report the window AS PAINTED — an effect keyed on the
  // window's own bounds, so a caller's tail count moves with the scroll.
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
    // The input row is a live door in the layouts whose text rows take a
    // click: a click puts the caret in its field, and with text (or an
    // attachment) already there it submits the row — the typed answer is
    // chosen by the same gesture that chooses any other row. An empty field
    // only takes the focus; it never submits nothing.
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
                state.focusValue(optionValueOf(option))
                const text = inputValues.get(optionValueOf(option)) ?? ''
                if (text.trim() !== '' || images.length > 0) submitInputOption(option)
              }
            : undefined
        }
      >
        <SelectInputOption
          option={option}
          isFocused={isFocused}
          isSelected={isSelected}
          value={inputValues.get(optionValueOf(option)) ?? ''}
          onChange={text => {
            setInputValue(optionValueOf(option), text)
            option.onChange?.(text)
          }}
          onSubmit={text => {
            submitInputOption(option, text)
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
      </Box>
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

  // ── the two-column compact-with-descriptions layout ─────────────────────
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
    // The column is measured over the WHOLE list, not
    // the visible window — a window-local measure re-derived the widest
    // label per scroll step and the description column slid sideways under
    // the operator on every press. The whole-list reduce is bounded by the
    // option count (picker lists, not transcripts) and gives the column ONE
    // width for the life of the list.
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

  // ── the shared-chrome layouts ───────────────────────────────────────────
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
                // The option's OWN box carries its
                // click identity — structural, wrap-proof (a row-arithmetic
                // map in a caller picked the wrong option the moment any
                // option wrapped). Click FOCUSES, never commits — the same
                // select-never-commit law the digit fence rides.
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

        // Compact: description trails on the same row — an indented,
        // heavily shrinkable wrap-trim column with inline descriptions off,
        // or inline after the label (space-prefixed, dimmed) when on.
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
