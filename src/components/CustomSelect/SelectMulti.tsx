// Multi-select rendering: checkbox rows (the inline checkbox carries the
// real state — the row-level "selected" chrome is deliberately NOT set, so
// input rows style like every other row) and the optional submit button.
// The children are passed to the row chrome unstyled, so the row's
// one-column gap falls between the indicator, the index, the checkbox and
// the label.

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

export type SelectMultiProps<T = string> = {
  isDisabled?: boolean
  hideIndexes?: boolean
  visibleOptionCount?: number
  options: OptionWithDescription<T>[]
  defaultValue?: T[]
  onCancel: () => void
  onChange?: (values: T[]) => void
  onFocus?: (value: T) => void
  focusValue?: T
  submitButtonText?: string
  onSubmit?: (values: T[]) => void
  onDownFromLastItem?: () => void
  onUpFromFirstItem?: () => void
  /** Open focus on the LAST option. */
  initialFocusLast?: boolean
  onOpenEditor?: (value: string, setValue: (value: string) => void) => void
  onImagePaste?: (
    base64Image: string,
    mediaType?: string,
    filename?: string,
    dimensions?: ImageDimensions,
  ) => void
  pastedContents?: Record<number, PastedContent>
  onRemoveImage?: (id: number) => void
  /** ↵ on an EMPTY input row reports here (the row keeps focus). */
  onEmptyInputSubmit?: (value: T) => void
  /** Tab / shift+Tab leave the list through this when supplied. */
  onTabOut?: (direction: 'next' | 'previous') => void
  /** The submit button taking or losing the focus. */
  onSubmitFocusChange?: (focused: boolean) => void
}

export function SelectMulti<T = string>({
  isDisabled = false,
  hideIndexes = false,
  visibleOptionCount = 5,
  options,
  defaultValue,
  onCancel,
  onChange,
  onFocus,
  focusValue,
  submitButtonText,
  onSubmit,
  onDownFromLastItem,
  onUpFromFirstItem,
  initialFocusLast = false,
  onOpenEditor,
  onImagePaste,
  pastedContents,
  onRemoveImage,
  onEmptyInputSubmit,
  onTabOut,
  onSubmitFocusChange,
}: SelectMultiProps<T>): React.ReactNode {
  // The submit button renders only when both button text and a submit
  // callback were supplied.
  const hasSubmitButton = Boolean(submitButtonText) && Boolean(onSubmit)
  const state = useMultiSelectState({
    visibleOptionCount,
    options,
    defaultValue,
    onChange,
    onCancel,
    onSubmit,
    onFocus,
    focusValue,
    initialFocusLast,
    hideIndexes,
    hasSubmitButton,
    isDisabled,
    onDownFromLastItem,
    onUpFromFirstItem,
    onEmptyInputSubmit,
    onTabOut,
    onSubmitFocusChange,
  })

  const optionCount = options.length
  const digitCount = String(optionCount).length
  const visible = state.visibleOptions
  const hasAbove = state.visibleFromIndex > 0
  const hasBelow = state.visibleToIndex < optionCount

  const checkbox = (checked: boolean): React.ReactNode =>
    checked ? (
      <Text color="success">{figures.checkboxOn}</Text>
    ) : (
      <Text>{figures.checkboxOff}</Text>
    )

  return (
    <Box flexDirection="column">
      {visible.map((option, position) => {
        // No row shows focus while the submit button holds it.
        const isFocused =
          !isDisabled &&
          !state.isSubmitFocused &&
          state.focusedValue === option.value
        const isChecked = state.selectedValues.includes(optionValueOf(option))
        const showUp = position === 0 && hasAbove && !isFocused
        const showDown =
          position === visible.length - 1 && hasBelow && !isFocused
        const prefix = hideIndexes
          ? undefined
          : option.indexLabel !== undefined
            ? // Declared-ordinal grammar: ONE guaranteed trailing space.
              option.indexLabel.padEnd(
                Math.max(digitCount + 1, option.indexLabel.length + 1),
              )
            : (option.index + 1 <= 9 ? `${option.index + 1}.` : '').padEnd(
                digitCount + 1,
              )

        if (isInputOption(option)) {
          // The input row is a full click target like every text row, and
          // its own door: a click puts the caret in its field and, with text
          // typed, keeps the row in the selection — never a toggle that
          // drops typed text out of the answer. The field's own submit (a
          // coalesced keystroke landing text and ↵ together) takes the same
          // door with the submitted text.
          return (
            <Box
              key={String(option.value)}
              onClick={
                isDisabled
                  ? undefined
                  : () => {
                      state.activateInputValue(optionValueOf(option), 'pointer')
                    }
              }
            >
              <SelectInputOption
                option={option as InputOption<T>}
                isFocused={isFocused}
                value={state.inputValues.get(optionValueOf(option)) ?? ''}
                onChange={text => {
                  state.updateInputValue(optionValueOf(option), text)
                }}
                onSubmit={text => {
                  state.activateInputValue(optionValueOf(option), 'enter', text)
                }}
                reservedIndexWidth={hideIndexes ? 0 : digitCount}
                index={option.index + 1}
                shouldShowDownArrow={showDown}
                shouldShowUpArrow={showUp}
                onOpenEditor={onOpenEditor}
                onImagePaste={onImagePaste}
                pastedContents={pastedContents}
                onRemoveImage={onRemoveImage}
              >
                {checkbox(isChecked)}
              </SelectInputOption>
            </Box>
          )
        }

        return (
          <Box
            key={String(option.value)}
            onClick={
              isDisabled
                ? undefined
                : () => {
                    state.toggleValue(optionValueOf(option))
                  }
            }
          >
            <SelectOption
              isFocused={isFocused}
              isSelected={false}
              shouldShowDownArrow={showDown}
              shouldShowUpArrow={showUp}
              description={option.description}
            >
              {prefix !== undefined ? <Text dimColor>{prefix}</Text> : null}
              {checkbox(isChecked)}
              <Text dimColor={option.disabled}>{option.label}</Text>
            </SelectOption>
          </Box>
        )
      })}
      {hasSubmitButton ? (
        <Box paddingLeft={2}>
          <Text
            bold
            color={state.isSubmitFocused ? 'suggestion' : undefined}
          >
            {state.isSubmitFocused ? `${figures.pointer} ` : ''}
            {submitButtonText}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

export default SelectMulti
