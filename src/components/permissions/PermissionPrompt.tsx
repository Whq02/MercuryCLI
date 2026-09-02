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
  /** A card that stands while focus lives elsewhere (the manager's plan
   *  card under a tabbed-away coordinator) hands its focus fact here: a
   *  disabled prompt owns no key — ↵/esc/digits on the board reach the
   *  board, never the card's Yes/No (MGR-2). */
  isDisabled?: boolean
  /** The footer's esc segment (default 'esc cancel'). A card whose esc does
   *  MORE than cancel says so — the contract offer's esc births the session
   *  plain, and 'esc cancel' over that act was a lie (C3, win-triage S10). */
  escapeHint?: string
}

const DEFAULT_PLACEHOLDERS: Record<FeedbackType, string> = {
  accept: 'tell Mercury what to do next',
  reject: 'tell Mercury what to do differently',
}

/**
 * The body every permission prompt composes: question line, option list,
 * and an inline feedback field where an option asks for one.
 *
 * This component owns:
 * - the bold ask (default "Do you want to proceed?") and the Tab hint
 * - expanding and collapsing the feedback input on Tab
 * - the analytics events around feedback use
 * - adapting the caller's options into the Select component's shape
 *
 * Fork consent-card grammar: the question reads as the card's ask (bold), and
 * the footer hint uses the kit's lowercase key grammar (`↑↓ choose · ↵ confirm
 * · esc cancel`) so every consent surface teaches the same keys the kit
 * panels do. Behavior (options, Select flow, analytics, keybindings) is
 * unchanged — plain hand-written React.
 *
 */
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

  // Find which option is focused and whether it has feedback config
  const focusedOption = options.find(opt => opt.value === focusedValue)
  const focusedFeedbackType = focusedOption?.feedbackConfig?.type

  // Show Tab hint when focused on a feedback-enabled option that's not already in input mode
  const showTabHint =
    (focusedFeedbackType === 'accept' && !acceptInputMode) ||
    (focusedFeedbackType === 'reject' && !rejectInputMode)

  // Transform options to Select-compatible format
  const selectOptions = useMemo((): OptionWithDescription<T>[] => {
    return options.map(opt => {
      const { value, label, feedbackConfig } = opt

      // No feedback config = simple option
      if (!feedbackConfig) {
        return { label, value }
      }

      const { type, placeholder } = feedbackConfig
      const isInputMode = type === 'accept' ? acceptInputMode : rejectInputMode
      const onChange = type === 'accept' ? setAcceptFeedback : setRejectFeedback
      const defaultPlaceholder = DEFAULT_PLACEHOLDERS[type]

      // In input mode the option renders as an inline input row.
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

      // Not in input mode - show simple option
      return { label, value }
    })
  }, [options, acceptInputMode, rejectInputMode])

  // Handle Tab key to toggle input mode
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

  // Handle selection
  const handleSelect = useCallback(
    (value: T) => {
      const option = options.find(opt => opt.value === value)
      if (!option) return

      // Get feedback if applicable
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

  // Register keybinding handlers for options that have a keybinding set
  const keybindingHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {}
    for (const opt of options) {
      if (opt.keybinding) {
        handlers[opt.keybinding] = () => handleSelect(opt.value)
      }
    }
    return handlers
  }, [options, handleSelect])

  // THE FIELD-OWNS-FOCUS GATE (PD-1's class): an option chord in the
  // Confirmation context is a bare letter (y/n) or a shifted one, and the
  // decoder makes a typed capital its shifted chord — so while a feedback
  // field owns focus no option chord may arm, or the words typed into the
  // field settle the card.
  const inputOwnsFocus =
    (focusedFeedbackType === 'accept' && acceptInputMode) ||
    (focusedFeedbackType === 'reject' && rejectInputMode)
  useKeybindings(keybindingHandlers, { context: 'Confirmation', isActive: !isDisabled && !inputOwnsFocus })

  // Handle cancel (Esc)
  const handleCancel = useCallback(() => {
    // Attribution: this esc joins the session's escape tally.
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
          // Moving focus away collapses an EMPTY feedback field; typed text holds it open.
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
