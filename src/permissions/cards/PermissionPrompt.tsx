import React, { useMemo, useState } from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import { Select, type OptionWithDescription } from '../../screen/select/Select.js'
import { useKeybindings } from '../../screen/keys/useKeybinding.js'
import type { KeybindingAction } from '../../screen/keys/types.js'
import { useSetAppStateMaybe } from '../../screen/app-state/AppState.js'

export type PermissionPromptOption<T extends string> = {
  value: T
  label: React.ReactNode
  feedbackConfig?: {
    type: 'accept' | 'reject'
    placeholder?: string
  }
  keybinding?: KeybindingAction
}

type PermissionPromptProps<T extends string> = {
  options: PermissionPromptOption<T>[]
  onSelect: (value: T, feedback?: string) => void
  onCancel?: () => void
  question?: React.ReactNode
  isDisabled?: boolean
}

const DEFAULT_PLACEHOLDER: Record<'accept' | 'reject', string> = {
  accept: 'tell Mercury what to do next',
  reject: 'tell Mercury what to do differently',
}

export function PermissionPrompt<T extends string>({
  options,
  onSelect,
  onCancel,
  question = 'Do you want to proceed?',
  isDisabled = false,
}: PermissionPromptProps<T>): React.ReactNode {
  const [acceptFeedback, setAcceptFeedback] = useState('')
  const [rejectFeedback, setRejectFeedback] = useState('')
  const [acceptInputMode, setAcceptInputMode] = useState(false)
  const [rejectInputMode, setRejectInputMode] = useState(false)
  const [focusedValue, setFocusedValue] = useState<T | undefined>(options[0]?.value)
  const setAppState = useSetAppStateMaybe()

  const focusedOption = options.find(opt => opt.value === focusedValue) ?? options[0]
  const focusedFeedbackType = focusedOption?.feedbackConfig?.type
  const focusedInInputMode =
    (focusedFeedbackType === 'accept' && acceptInputMode) ||
    (focusedFeedbackType === 'reject' && rejectInputMode)

  function handleSelect(value: T): void {
    const option = options.find(opt => opt.value === value)
    if (!option) return
    if (!option.feedbackConfig) {
      onSelect(option.value)
      return
    }
    const raw = option.feedbackConfig.type === 'accept' ? acceptFeedback : rejectFeedback
    const trimmed = raw.trim()
    onSelect(option.value, trimmed !== '' ? trimmed : undefined)
  }

  function handleCancel(): void {
    setAppState?.(prev => ({
      ...prev,
      attribution: {
        ...prev.attribution,
        escapeCount: prev.attribution.escapeCount + 1,
      },
    }))
    onCancel?.()
  }

  function handleFocus(value: T): void {
    setFocusedValue(value)
    const nextOption = options.find(opt => opt.value === value)
    const nextType = nextOption?.feedbackConfig?.type
    if (nextType !== 'accept' && acceptInputMode && acceptFeedback.trim() === '') {
      setAcceptInputMode(false)
    }
    if (nextType !== 'reject' && rejectInputMode && rejectFeedback.trim() === '') {
      setRejectInputMode(false)
    }
  }

  function handleInputModeToggle(value: T): void {
    const option = options.find(opt => opt.value === value)
    if (!option?.feedbackConfig) return
    if (option.feedbackConfig.type === 'accept') {
      setAcceptInputMode(prev => !prev)
    } else {
      setRejectInputMode(prev => !prev)
    }
  }

  const keybindingHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {}
    for (const option of options) {
      if (option.keybinding) {
        handlers[option.keybinding] = () => {
          handleSelect(option.value)
        }
      }
    }
    return handlers
  }, [options, acceptFeedback, rejectFeedback, onSelect])

  useKeybindings(keybindingHandlers, {
    context: 'Confirmation',
    isActive: !isDisabled && !focusedInInputMode,
  })

  const selectOptions = useMemo<OptionWithDescription<T>[]>(
    () =>
      options.map(option => {
        const config = option.feedbackConfig
        if (!config) {
          return {
            label: option.label,
            value: option.value,
          }
        }
        const isActive = config.type === 'accept' ? acceptInputMode : rejectInputMode
        if (!isActive) {
          return {
            label: option.label,
            value: option.value,
          }
        }
        return {
          type: 'input',
          label: option.label,
          value: option.value,
          placeholder: config.placeholder ?? DEFAULT_PLACEHOLDER[config.type],
          initialValue: config.type === 'accept' ? acceptFeedback : rejectFeedback,
          onChange: config.type === 'accept' ? setAcceptFeedback : setRejectFeedback,
          allowEmptySubmitToCancel: true,
        }
      }),
    [options, acceptInputMode, rejectInputMode, acceptFeedback, rejectFeedback],
  )

  const canAmend = focusedOption?.feedbackConfig !== undefined && !focusedInInputMode

  return (
    <Box flexDirection="column">
      {typeof question === 'string' ? <Text bold>{question}</Text> : question}
      <Select
        options={selectOptions}
        isDisabled={isDisabled}
        inlineDescriptions
        scrollMovesFocus={false}
        onChange={handleSelect}
        onCancel={handleCancel}
        onFocus={handleFocus}
        onInputModeToggle={handleInputModeToggle}
      />
      <Box marginTop={1}>
        <Text color="subtle">
          {`↑↓ choose · ↵ confirm · esc cancel${canAmend ? ' · tab amend' : ''}`}
        </Text>
      </Box>
    </Box>
  )
}
