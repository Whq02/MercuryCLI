import React, { type ReactNode, useCallback, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import type { KeybindingAction } from '../../keybindings/types.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useSetAppState } from '../../state/AppState.js'
import { type OptionWithDescription, Select } from '../CustomSelect/select.js'

export type FeedbackType = 'accept' | 'reject'

export type PermissionPromptOption<T extends string> = {
  value: T
  label: ReactNode
  feedbackConfig?: {
    type: FeedbackType
    placeholder?: string
  }
  keybinding?: KeybindingAction
}

export type PermissionPromptProps<T extends string> = {
  options: PermissionPromptOption<T>[]
  onSelect: (value: T, feedback?: string) => void
  onCancel?: () => void
  question?: string | ReactNode
  isDisabled?: boolean
  escapeHint?: string
}

const DEFAULT_PLACEHOLDERS: Record<FeedbackType, string> = {
  accept: 'tell Mercury what to do next',
  reject: 'tell Mercury what to do differently',
}

export function PermissionPrompt<T extends string>({
  options,
  onSelect,
  onCancel,
  question = 'Do you want to proceed?',
  isDisabled = false,
  escapeHint = 'esc cancel',
}: PermissionPromptProps<T>): React.ReactNode {  const setAppState = useSetAppState()
  const [acceptFeedback, setAcceptFeedback] = useState('')
  const [rejectFeedback, setRejectFeedback] = useState('')
  const [acceptInputMode, setAcceptInputMode] = useState(false)
  const [rejectInputMode, setRejectInputMode] = useState(false)
  const [focusedValue, setFocusedValue] = useState<T | null>(null)

  const focusedOption = options.find(opt => opt.value === focusedValue)
  const focusedFeedbackType = focusedOption?.feedbackConfig?.type

  const showTabHint =
    (focusedFeedbackType === 'accept' && !acceptInputMode) ||
    (focusedFeedbackType === 'reject' && !rejectInputMode)

  const selectOptions = useMemo((): OptionWithDescription<T>[] => {
    return options.map(opt => {
      const { value, label, feedbackConfig } = opt

      if (!feedbackConfig) {
        return { label, value }
      }

      const { type, placeholder } = feedbackConfig
      const isInputMode = type === 'accept' ? acceptInputMode : rejectInputMode
      const onChange = type === 'accept' ? setAcceptFeedback : setRejectFeedback
      const defaultPlaceholder = DEFAULT_PLACEHOLDERS[type]

      if (isInputMode) {
        return {
          type: 'input' as const,
          label,
          value,
          placeholder: placeholder ?? defaultPlaceholder,
          onChange,
          allowEmptySubmitToCancel: true,
        }
      }

      return { label, value }
    })
  }, [options, acceptInputMode, rejectInputMode])

  const handleInputModeToggle = useCallback(
    (value: T) => {
      const option = options.find(opt => opt.value === value)
      if (!option?.feedbackConfig) return

      const { type } = option.feedbackConfig
      if (type === 'accept') {
        if (acceptInputMode) {
          setAcceptInputMode(false)
        } else {
          setAcceptInputMode(true)
        }
      } else if (type === 'reject') {
        if (rejectInputMode) {
          setRejectInputMode(false)
        } else {
          setRejectInputMode(true)
        }
      }
    },
    [options, acceptInputMode, rejectInputMode],
  )

  const handleSelect = useCallback(
    (value: T) => {
      const option = options.find(opt => opt.value === value)
      if (!option) return

      let feedback: string | undefined
      if (option.feedbackConfig) {
        const rawFeedback =
          option.feedbackConfig.type === 'accept'
            ? acceptFeedback
            : rejectFeedback
        const trimmedFeedback = rawFeedback.trim()

        if (trimmedFeedback) {
          feedback = trimmedFeedback
        }

      }

      onSelect(value, feedback)
    },
    [
      options,
      acceptFeedback,
      rejectFeedback,
      onSelect,
    ],
  )

  const keybindingHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {}
    for (const opt of options) {
      if (opt.keybinding) {
        handlers[opt.keybinding] = () => handleSelect(opt.value)
      }
    }
    return handlers
  }, [options, handleSelect])

  const inputOwnsFocus =
    (focusedFeedbackType === 'accept' && acceptInputMode) ||
    (focusedFeedbackType === 'reject' && rejectInputMode)
  useKeybindings(keybindingHandlers, { context: 'Confirmation', isActive: !isDisabled && !inputOwnsFocus })

  const handleCancel = useCallback(() => {
    setAppState(prev => ({
      ...prev,
      attribution: {
        ...prev.attribution,
        escapeCount: prev.attribution.escapeCount + 1,
      },
    }))
    onCancel?.()
  }, [onCancel, setAppState])

  return (
    <Box flexDirection="column">
      {typeof question === 'string' ? (
        <Text bold={true}>{question}</Text>
      ) : (
        question
      )}
      <Select
        options={selectOptions}
        inlineDescriptions
        isDisabled={isDisabled}
        onChange={handleSelect}
        onCancel={handleCancel}
        onFocus={value => {
          const newOption = options.find(opt => opt.value === value)
          if (
            newOption?.feedbackConfig?.type !== 'accept' &&
            acceptInputMode &&
            !acceptFeedback.trim()
          ) {
            setAcceptInputMode(false)
          }
          if (
            newOption?.feedbackConfig?.type !== 'reject' &&
            rejectInputMode &&
            !rejectFeedback.trim()
          ) {
            setRejectInputMode(false)
          }
          setFocusedValue(value)
        }}
        onInputModeToggle={handleInputModeToggle}
      />
      <Box marginTop={1}>
        <Text color="subtle">
            {`↑↓ choose · ↵ confirm · ${escapeHint}`}
            {showTabHint ? ' · tab amend' : ''}
          </Text>
      </Box>
    </Box>
  )
}
