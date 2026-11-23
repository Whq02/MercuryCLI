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

type SelectMultiProps<T = string> = {
  isDisabled?: boolean
  visibleOptionCount?: number
  options: OptionWithDescription<T>[]
  defaultValue?: T[]
  onChange?: (values: T[]) => void
  onSubmit?: (values: T[]) => void
  onCancel?: () => void
  focusValue?: T
  onFocus?: (value: T) => void
  onSubmitFocus?: (focused: boolean) => void
  submitButtonText?: string
  hideIndexes?: boolean
  initialFocusLast?: boolean
  scrollMovesFocus?: boolean
  onUpFromFirstItem?: () => void
  onDownFromLastItem?: () => void
  onTabOut?: (direction: 'next' | 'prev') => void
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

function optionIndexPrefix(
  option: { indexLabel?: string },
  index1: number,
  reservedWidth: number,
): string {
  if (option.indexLabel !== undefined) {
    return option.indexLabel.padEnd(Math.max(reservedWidth, option.indexLabel.length + 1))
  }
  const raw = index1 <= 9 ? `${index1}.` : ''
  return raw.padEnd(reservedWidth)
}

export function SelectMulti<T = string>({
  isDisabled = false,
  visibleOptionCount = 5,
  options,
  defaultValue,
  onChange,
  onSubmit,
  onCancel,
  focusValue,
  onFocus,
  onSubmitFocus,
  submitButtonText,
  hideIndexes = false,
  initialFocusLast = false,
  scrollMovesFocus = true,
  onUpFromFirstItem,
  onDownFromLastItem,
  onTabOut,
  onOpenEditor,
  onImagePaste,
  pastedContents,
  onRemoveImage,
  onEmptyInputSubmit,
}: SelectMultiProps<T>): React.ReactNode {
  const hasSubmitButton = Boolean(submitButtonText && onSubmit)
  const state = useMultiSelectState({
    isDisabled,
    visibleOptionCount,
    options,
    defaultValue,
    onChange,
    onSubmit,
    onCancel,
    focusValue,
    onFocus,
    onSubmitFocus,
    hasSubmitButton,
    hideIndexes,
    initialFocusLast,
    scrollMovesFocus,
    onUpFromFirstItem,
    onDownFromLastItem,
    onTabOut,
    onEmptyInputSubmit,
  })

  const digitWidth = String(Math.max(1, options.length)).length
  const reservedIndexWidth = hideIndexes ? 0 : digitWidth
  const textRowReserved = hideIndexes ? 0 : digitWidth + 2
  const submitFocused = !isDisabled && state.isSubmitFocused

  return (
    <Box flexDirection="column">
      <PopupListViewport
        above={state.visibleFromIndex}
        below={Math.max(0, options.length - state.visibleToIndex)}
        rows={state.visibleOptions.length}
      >
        {state.visibleOptions.map((option: OptionWithDescription<T> & { index: number }) => {
          const val = optionValueOf(option)
          const optionIndex = option.index
          const isFocused = !isDisabled && !state.isSubmitFocused && state.focusedValue === option.value
          const isChecked = state.selectedValues.includes(val)
          const checkbox = (
            <Text color={isChecked ? 'success' : undefined} dimColor={option.disabled}>
              {isChecked ? figures.checkboxOn : figures.checkboxOff}{' '}
            </Text>
          )

          if (isInputOption(option)) {
            const inputOption: InputOption<T> = option
            const inputValue = state.inputValues.get(val) ?? inputOption.initialValue ?? ''
            return (
              <Box
                key={String(option.value)}
                flexDirection="column"
                onClick={
                  !isDisabled && !option.disabled
                    ? () => state.activateInputValue(val, 'click')
                    : undefined
                }
              >
                <SelectInputOption
                  option={inputOption}
                  isFocused={isFocused}
                  isSelected={false}
                  value={inputValue}
                  onChange={text => state.updateInputValue(val, text)}
                  onSubmit={() => state.activateInputValue(val, 'enter')}
                  index={optionIndex + 1}
                  reservedIndexWidth={reservedIndexWidth}
                  onOpenEditor={onOpenEditor}
                  onImagePaste={onImagePaste}
                  pastedContents={pastedContents}
                  onRemoveImage={onRemoveImage}
                >
                  {checkbox}
                </SelectInputOption>
              </Box>
            )
          }

          const prefix = hideIndexes ? '' : optionIndexPrefix(option, optionIndex + 1, textRowReserved)
          return (
            <Box
              key={String(option.value)}
              flexDirection="column"
              onClick={
                !isDisabled && !option.disabled
                  ? () => state.toggleValue(val)
                  : undefined
              }
            >
              <SelectOption
                isFocused={isFocused}
                isSelected={false}
                description={option.description}
              >
                <Box flexShrink={1} minWidth={0}>
                  {prefix !== '' ? <Text dimColor>{prefix}</Text> : null}
                  {checkbox}
                  <Text
                    color={isFocused && !option.disabled ? 'suggestion' : undefined}
                    dimColor={option.disabled}
                  >
                    {option.label}
                  </Text>
                </Box>
              </SelectOption>
            </Box>
          )
        })}
      </PopupListViewport>
      {hasSubmitButton ? (
        <Box
          marginTop={1}
          paddingLeft={2}
          onClick={!isDisabled ? () => state.submit() : undefined}
        >
          <Text
            bold
            color={submitFocused ? 'suggestion' : undefined}
            dimColor={isDisabled}
          >
            {submitFocused ? `${figures.pointer} ${submitButtonText}` : submitButtonText}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

export default SelectMulti
