import figures from 'figures'
import type React from 'react'
import { Box, Text } from '../themedRenderer.js'
import type { BranchManifest } from '../../sessions/branches/branchManifest.js'
import type { CheckpointFactsV1 } from '../../engine/connector/types.js'
import type { Message, PartialFoldDirection, UserMessage } from '../../engine/message-shapes/message.js'
import { Select } from '../select/index.js'
import type { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import TextInput from '../composer/text-input/TextInput.js'
import { previewOf } from './preview.js'
import { describeFiles, statsBetween, type CodeStats } from './stats.js'

const VISIBLE_ROWS = 7
export const CURRENT_PROMPT = Symbol('current-prompt')
export const UNDO_REWIND = Symbol('undo-rewind')

export type PickEntry = UserMessage | typeof CURRENT_PROMPT | typeof UNDO_REWIND

type ConfirmOption = { label: string; value: string; description: string }

type Tokens = ReturnType<typeof useMercuryTokens>
type Phase = 'pick' | 'confirm' | 'summarize'

export function pickView({
  selectable,
  checkpoints,
  index,
  entries,
  columns,
  historyOn,
  tokens,
  messages,
  hasSavedPoint,
  mutatingShellIds,
}: {
  selectable: UserMessage[]
  checkpoints: CheckpointFactsV1
  index: number
  entries: PickEntry[]
  columns: number
  historyOn: boolean
  tokens: Tokens
  messages: Message[]
  hasSavedPoint: (uuid: string) => boolean
  mutatingShellIds?: ReadonlySet<string> | null
}): React.ReactNode {
  const nothingToRewind = selectable.length === 0 && checkpoints.undo === undefined
  const half = Math.floor(VISIBLE_ROWS / 2)
  const start = Math.max(
    0,
    Math.min(index - half, entries.length - VISIBLE_ROWS),
  )
  const visible = entries.slice(start, start + VISIBLE_ROWS)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>{'─'.repeat(Math.max(8, Math.min(60, columns - 4)))}</Text>
      <Text bold>Rewind</Text>
      {nothingToRewind ? (
        <Text dimColor>There is nothing to rewind to yet.</Text>
      ) : (
        <Text dimColor>
          {historyOn
            ? 'Wind back to a saved point — the files, the conversation, or both.'
            : checkpoints.capture === 'off'
              ? 'File checkpoints are off for this session (Settings › File checkpointing) — the conversation can still be restored or forked.'
              : 'This session started before checkpoint capture (start a new session when ready); the conversation can still be restored or forked.'}
        </Text>
      )}
      {visible.map((entry, offset) => {
        const entryIndex = start + offset
        const focused = entryIndex === index
        if (entry === UNDO_REWIND) {
          return <Box key="undo" flexDirection="column">
            <Text color={focused ? tokens.accent : undefined}>{focused ? `${figures.pointer} ` : '  '}Undo the rewind</Text>
            <Text dimColor>    Restore the previous files; conversation unchanged.</Text>
          </Box>
        }
        if (entry === CURRENT_PROMPT) {
          return (
            <Box key="current">
              <Text color={focused ? tokens.accent : undefined}>
                {focused ? `${figures.pointer} ` : '  '}
                <Text italic dimColor>
                  (current prompt)
                </Text>
              </Text>
            </Box>
          )
        }
        const preview = previewOf(entry, columns - 24)
        const between = historyOn
          ? statsBetween(
              messages,
              entry.uuid,
              selectable[entryIndex + 1]?.uuid,
              mutatingShellIds,
            )
          : null
        const canRestore = historyOn && hasSavedPoint(entry.uuid)
        return (
          <Box key={entry.uuid} flexDirection="column">
            <Text color={focused ? tokens.accent : undefined}>
              {focused ? `${figures.pointer} ` : '  '}
              {preview.shell ? (
                <Text color={tokens.warning}>{preview.text}</Text>
              ) : (
                <Text>{preview.text}</Text>
              )}
            </Text>
            {historyOn && between !== null ? (
              <Text dimColor>
                {'    '}
                {!canRestore
                  ? 'no saved files at this point'
                  : between.files.length === 0
                    ? between.shellCommands > 0
                      ? between.shellCommands === 1
                        ? '1 shell command ran — changes it made are not put back'
                        : `${between.shellCommands} shell commands ran — changes they made are not put back`
                      : 'no code changes'
                    : between.shellCommands > 0
                      ? `${describeFiles(between.files)} +${between.insertions} -${between.deletions} · ${between.shellCommands === 1 ? '1 shell command ran (not put back)' : `${between.shellCommands} shell commands ran (not put back)`}`
                      : `${describeFiles(between.files)} +${between.insertions} -${between.deletions}`}
              </Text>
            ) : null}
          </Box>
        )
      })}
      <Text dimColor>↑↓ select · ↵ choose · esc close</Text>
    </Box>
  )
}

export function summarizeView({
  tokens,
  feedback,
  setFeedback,
  setPhase,
  onPreRestore,
  onSummarize,
  chosen,
  close,
  columns,
  feedbackCursor,
  setFeedbackCursor,
}: {
  tokens: Tokens
  feedback: string
  setFeedback: React.Dispatch<React.SetStateAction<string>>
  setPhase: React.Dispatch<React.SetStateAction<Phase>>
  onPreRestore: () => void
  onSummarize: (
    message: UserMessage,
    feedback?: string,
    direction?: PartialFoldDirection,
  ) => void | Promise<void>
  chosen: UserMessage
  close: () => void
  columns: number
  feedbackCursor: number
  setFeedbackCursor: React.Dispatch<React.SetStateAction<number>>
}): React.ReactNode {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1} gap={1}>
      <Text bold>Summarise from this point</Text>
      <Text dimColor>
        Optional extra context for the summary (empty cancels):
      </Text>
      <TextInput
        value={feedback}
        onChange={setFeedback}
        onSubmit={value => {
          const trimmed = value.trim()
          if (trimmed === '') {
            setPhase('confirm')
            return
          }
          onPreRestore()
          void onSummarize(chosen, trimmed, 'from')
          close()
        }}
        columns={Math.max(30, columns - 8)}
        cursorOffset={feedbackCursor}
        onChangeCursorOffset={setFeedbackCursor}
      />
    </Box>
  )
}

export function confirmOptionsOf({
  canRestoreCode,
  conversationText,
  checkpoints,
  onViewOnly,
  onBranchCreated,
  onRerun,
}: {
  canRestoreCode: boolean
  conversationText: string
  checkpoints: CheckpointFactsV1
  onViewOnly: (() => void) | undefined
  onBranchCreated: ((manifest: BranchManifest) => void) | undefined
  onRerun: ((message: UserMessage) => Promise<{ ok: true } | { ok: false; reason: string }>) | undefined
}): ConfirmOption[] {
  const options: ConfirmOption[] = []
  if (canRestoreCode) {
    options.push({
      label: 'Restore code and conversation',
      value: 'both',
      description: `The files go back to their saved state at this point; ${conversationText.charAt(0).toLowerCase()}${conversationText.slice(1)}.`,
    })
    options.push({
      label: 'Restore conversation only',
      value: 'conversation',
      description: `${conversationText}; the files are unchanged.`,
    })
    options.push({
      label: 'Restore code only',
      value: 'code',
      description: 'The files go back to their saved state at this point; the conversation is unchanged.',
    })
    for (const file of checkpoints.files ?? []) {
      options.push({
        label: `Restore ${file}`,
        value: `file:${file}`,
        description: 'Restore this file only; other files and the conversation are unchanged.',
      })
    }
  } else {
    options.push({
      label: 'Restore conversation',
      value: 'conversation',
      description: `${conversationText}; no saved files at this point, so the files are unchanged.`,
    })
  }
  if (onViewOnly) {
    options.push({
      label: 'View history read-only (nothing is mutated)',
      value: 'view',
      description: 'Nothing changes — a read-only view of the history.',
    })
  }
  if (onBranchCreated) {
    options.push({
      label: 'Create a branch session from here (this one is untouched)',
      value: 'branch',
      description:
        'A new branch session is created from this point; the current conversation stays untouched.',
    })
  }
  if (onRerun) {
    options.push({
      label: 'Rerun from here on a new branch (this session is untouched)',
      value: 'rerun',
      description:
        'A new branch reruns this message; the current session is untouched.',
    })
  }
  options.push({
    label: 'Summarise from here…',
    value: 'summarize',
    description: 'Messages after this point will be summarised.',
  })
  options.push({
    label: 'Never mind',
    value: 'cancel',
    description: 'The conversation is unchanged.',
  })
  return options
}

export function confirmView({
  tokens,
  preview,
  age,
  options,
  canRestoreCode,
  focusedConfirm,
  setFocusedConfirm,
  setPhase,
  openedPreselected,
  close,
  onViewOnly,
  runBranch,
  runRerun,
  runRestore,
  storeStats,
  elsewhere,
  shellCommandsAfter,
}: {
  tokens: Tokens
  preview: ReturnType<typeof previewOf>
  age: string
  options: ConfirmOption[]
  canRestoreCode: boolean
  focusedConfirm: string
  setFocusedConfirm: React.Dispatch<React.SetStateAction<string>>
  setPhase: React.Dispatch<React.SetStateAction<Phase>>
  openedPreselected: React.MutableRefObject<boolean>
  close: () => void
  onViewOnly: (() => void) | undefined
  runBranch: () => Promise<void>
  runRerun: () => Promise<void>
  runRestore: (what: 'both' | 'conversation' | 'code', files?: { filePath?: string; undo?: boolean; userMessageId?: string }) => Promise<void>
  storeStats: CodeStats | undefined
  elsewhere: string | null
  shellCommandsAfter: number
}): React.ReactNode {
  const codeLine = (value: string): string | null => {
    if (value === 'summarize') return null
    if (value.startsWith('file:')) return null
    if (value === 'both' || value === 'code') {
      if (storeStats === undefined) return 'Asking the session what a restore would touch…'
      if (storeStats.filesChanged.length === 0) {
        return shellCommandsAfter > 0
          ? 'No Edit or Write changes to restore; shell commands ran after this point and what they changed is not put back.'
          : 'The files already match this point.'
      }
      return `Restores ${describeFiles(storeStats.filesChanged)} +${storeStats.insertions} -${storeStats.deletions}.`
    }
    return 'The files are unchanged.'
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1} gap={1}>
      <Text>
        <Text bold>{preview.text}</Text> <Text dimColor>({age})</Text>
      </Text>
      <Select
        options={options.map(option => ({
          label: option.label,
          value: option.value,
        }))}
        defaultFocusValue={canRestoreCode ? 'both' : 'conversation'}
        inlineDescriptions={false}
        onFocus={value => setFocusedConfirm(value)}
        onChange={value => {
          if (value === 'cancel') {
            if (openedPreselected.current) close()
            else setPhase('pick')
            return
          }
          if (value === 'view') {
            onViewOnly?.()
            close()
            return
          }
          if (value === 'branch') {
            void runBranch()
            return
          }
          if (value === 'rerun') {
            void runRerun()
            return
          }
          if (value === 'summarize') {
            setPhase('summarize')
            return
          }
          if (value.startsWith('file:')) {
            void runRestore('code', { filePath: value.slice(5) })
            return
          }
          void runRestore(value as 'both' | 'conversation' | 'code')
        }}
        onCancel={() => {
          if (openedPreselected.current) close()
          else setPhase('pick')
        }}
      />
      <Box flexDirection="column">
        <Text dimColor>
          {(options.find(option => option.value === focusedConfirm) ??
            options[0])!.description}
        </Text>
        {codeLine(focusedConfirm) !== null ? (
          <Text dimColor>{codeLine(focusedConfirm)}</Text>
        ) : null}
        {shellCommandsAfter > 0 && storeStats !== undefined && storeStats.filesChanged.length > 0 && (focusedConfirm === 'both' || focusedConfirm === 'code') ? (
          <Text dimColor>Shell commands also ran after this point — what they changed is not put back.</Text>
        ) : null}
        {elsewhere !== null && (focusedConfirm === 'both' || focusedConfirm === 'code') ? (
          <Text dimColor>{elsewhere}</Text>
        ) : null}
      </Box>
      {canRestoreCode ? (
        <Text dimColor>
          A file edited by hand since the session last touched it is refused by name — nothing is restored until you resolve it.
        </Text>
      ) : null}
    </Box>
  )
}
