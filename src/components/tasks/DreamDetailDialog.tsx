// Detail card for the memory-consolidation task: elapsed + sessions
// under review (+ files touched when non-zero), a status word, and the last
// six non-empty turns with a count of the earlier hidden ones. No
// foreground/message keys — there is nothing to foreground.

import React from 'react'
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import { Box, Text, useInput } from '../../ink.js'
import { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import type { DreamTaskState } from '../../tasks/DreamTask/DreamTask.js'
import { plural } from '../../utils/stringUtils.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

/** The visible turn window: the last six non-empty turns. */
const TURN_WINDOW = 6

export function DreamDetailDialog({
  task,
  onDone,
  onBack,
  onKill,
}: {
  task: DreamTaskState
  onDone: () => void
  onBack?: () => void
  onKill?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const running = task.status === 'running' || task.status === 'pending'
  const elapsed = useElapsedTime(
    task.startTime,
    running,
    1000,
    task.totalPausedMs,
    task.endTime,
  )
  const exitState = useExitOnCtrlCD(useKeybindings)

  const handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === ' ') {
      e.stopImmediatePropagation()
      onDone()
      return
    }
    if (e.key === 'left' && onBack) {
      e.stopImmediatePropagation()
      onBack()
      return
    }
    if (e.key === 'x' && running && onKill) {
      e.stopImmediatePropagation()
      onKill()
    }
  }
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })
  useKeybinding('confirm:yes', () => onDone(), { context: 'Confirmation' })

  const turns = task.turns.filter(turn => turn.text.trim() !== '')
  const shown = turns.slice(-TURN_WINDOW)
  const hidden = turns.length - shown.length
  const statusColor = running
    ? undefined
    : task.status === 'completed'
      ? tokens.success
      : tokens.failure

  return (
    <Box flexDirection="column" tabIndex={-1}>
      <Text bold>{task.description}</Text>
      <Text dimColor>
        {elapsed}
        {' · '}
        {task.sessionsReviewing} {plural(task.sessionsReviewing, 'session')}
        {task.filesTouched.length > 0
          ? ` · ${task.filesTouched.length} ${plural(task.filesTouched.length, 'file')} touched`
          : ''}
      </Text>
      <Box marginTop={1}>
        <Text color={statusColor}>{running ? 'running' : task.status}</Text>
      </Box>
      {shown.length === 0 ? (
        <Text dimColor>{running ? 'starting' : 'no text output'}</Text>
      ) : (
        <Box flexDirection="column">
          {hidden > 0 ? (
            <Text dimColor>
              {hidden} earlier {plural(hidden, 'turn')} hidden
            </Text>
          ) : null}
          {shown.map((turn, index) => (
            <Text key={index} wrap="truncate-end">
              {turn.text}
              {turn.toolUseCount > 0 ? (
                <Text dimColor>
                  {' '}
                  ({turn.toolUseCount} {plural(turn.toolUseCount, 'tool use')})
                </Text>
              ) : null}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        {exitState.pending ? (
          <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
        ) : (
          <Text dimColor>
            {running && onKill ? (
              <>
                <KeyboardShortcutHint shortcut="x" action="stop" />
                {' · '}
              </>
            ) : null}
            {onBack ? (
              <>
                <KeyboardShortcutHint shortcut="←" action="back" />
                {' · '}
              </>
            ) : null}
            <KeyboardShortcutHint shortcut="space" action="close" />
          </Text>
        )}
      </Box>
    </Box>
  )
}
