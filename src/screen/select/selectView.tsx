import React from 'react'
import { Ansi, Box, Text } from '../themedRenderer.js'
import {
  isInputOption,
  optionValueOf,
  type InputOption,
  type OptionWithDescription,
} from './optionMap.js'
import { SelectOption } from './select-option.js'
import type { SelectState } from './use-select-state.js'
import { PopupListViewport } from './popup-list.js'

export function selectViewOf<T>({
  state,
  optionCount,
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
}: {
  state: SelectState<T>
  optionCount: number
  visible: Array<OptionWithDescription<T> & { index: number }>
  inputRow: (option: InputOption<T> & { index: number }, position: number) => React.ReactNode
  rowFlags: (
    option: OptionWithDescription<T> & { index: number },
    position: number,
  ) => { isFocused: boolean; isSelected: boolean; showUp: boolean; showDown: boolean }
  stateColorOf: (isFocused: boolean, isSelected: boolean, disabled: boolean | undefined) => string | undefined
  ordinalsHidden: boolean
  textRowReserved: number
  layout: 'compact' | 'expanded' | 'compact-vertical'
  disableSelection: boolean | 'numeric'
  isDisabled: boolean
  fit: boolean
  singleLine: boolean
  highlightText: string | undefined
  hideIndexes: boolean
  inlineDescriptions: boolean
  rowPrefix: (option: { indexLabel?: string }, index1: number, reservedWidth: number) => string
  renderLabel: (label: React.ReactNode, highlightText: string | undefined) => React.ReactNode
}): React.ReactNode {
  return (
    <PopupListViewport above={state.visibleFromIndex} below={optionCount - state.visibleToIndex} rows={visible.length}>
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
          layout === 'expanded' && disableSelection !== true && !option.disabled && !isDisabled
        const description =
          option.description !== undefined && option.description !== ''
            ? option.description
            : undefined
        const dimDescription = option.dimDescription !== false

        const yields = fit || layout !== 'compact' || description === undefined
        const labelNode = (
          <Box flexShrink={yields ? 1 : 0} minWidth={yields ? 0 : undefined} {...(singleLine ? { height: 1, overflow: 'hidden' as const } : {})}>
            <Text color={stateColor} dimColor={option.disabled} {...(singleLine ? { wrap: 'truncate-end' as const } : {})}>
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
              {description !== undefined && !singleLine ? (
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
    </PopupListViewport>
  )
}
