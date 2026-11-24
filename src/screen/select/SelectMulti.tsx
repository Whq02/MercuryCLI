import figures from 'figures'
import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import type { PastedContent } from '../../platform/settings/config.js'
import type { ImageDimensions } from '../../platform/images/imageResizer.js'
import {
  isInputOption,
  optionValueOf,
  type InputOption,
  type OptionWithDescription,
} from './optionMap.js'
import { SelectInputOption } from './SelectInputOption.js'
import { SelectOption } from './select-option.js'
import { useMultiSelectState } from './useMultiSelectState.js'
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
  onSubmitFocusChange?: (focused: boolean) => void
  submitButtonText?: string
  hideIndexes?: boolean
  initialFocusLast?: boolean
  scrollMovesFocus?: boolean
  onUpFromFirstItem?: () => void
  onDownFromLastItem?: () => void
  onTabOut?: (direction: 'next' | 'previous') => void
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
  onSubmitFocusChange,
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
    onSubmitFocusChange,
    hasSubmitButton,
    hideIndexes,
    initialFocusLast,
    scrollMovesFocus,
    onUpFromFirstItem,
    onDownFromLastItem,
    onTabOut,
    onEmptyInputSubmit,
  })

  const digitWidth = String(options.length).length

  return (
    <Box flexDirection="column">
      <PopupListViewport
        above={state.visibleFromIndex}
        below={options.length - state.visibleToIndex}
        rows={state.visibleOptions.length}
      >
        {state.visibleOptions.map((option: OptionWithDescription<T> & { index: number }) => {
          const val = optionValueOf(option)
          const isFocused = !isDisabled && !state.isSubmitFocused && state.focusedValue === option.value
          const checkbox = state.selectedValues.includes(val) ? (
            <Text color="success">{figures.checkboxOn}</Text>
          ) : (
            <Text>{figures.checkboxOff}</Text>
          )

          if (isInputOption(option)) {
            const inputOption: InputOption<T> = option
            return (
              <Box
                key={String(option.value)}
                onClick={() => {
                  if (!isDisabled) state.activateInputValue(val, 'pointer')
                }}
              >
                <SelectInputOption
                  option={inputOption}
                  isFocused={isFocused}
                  value={state.inputValues.get(val) ?? ''}
                  onChange={text => state.updateInputValue(val, text)}
                  onSubmit={text => state.activateInputValue(val, 'enter', text)}
                  reservedIndexWidth={hideIndexes ? 0 : Math.max(digitWidth, inputOption.indexLabel?.length ?? 0)}
                  index={option.index + 1}
                  shouldShowDownArrow={false}
                  shouldShowUpArrow={false}
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

          const prefix = hideIndexes ? '' : optionIndexPrefix(option, option.index + 1, digitWidth + 1)
          return (
            <Box
              key={String(option.value)}
              onClick={() => {
                if (!isDisabled) state.toggleValue(val)
              }}
            >
              <SelectOption
                isFocused={isFocused}
                isSelected={false}
                shouldShowDownArrow={false}
                shouldShowUpArrow={false}
                description={option.description}
              >
                {prefix !== '' ? <Text dimColor>{prefix}</Text> : null}
                {checkbox}
                <Text dimColor={option.disabled}>{option.label}</Text>
              </SelectOption>
            </Box>
          )
        })}
      </PopupListViewport>
      {hasSubmitButton ? (
        <Box paddingLeft={2}>
          <Text bold color={state.isSubmitFocused ? 'suggestion' : undefined}>
            {state.isSubmitFocused ? `${figures.pointer} ` : ''}
            {submitButtonText}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
}

export default SelectMulti
