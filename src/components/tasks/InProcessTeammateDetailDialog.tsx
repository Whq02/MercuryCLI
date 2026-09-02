// Detail card for an in-process teammate: coloured @name + derived
// activity, the width-truncated prompt, and the spawn-captured operating
// profile line (canonical role · model · instruction digest — the
// captured-at-spawn snapshot, never the live toggles).
// f/m/x require a running teammate; the completion marker is a word only.

import React from 'react'
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import { Box, Text, useInput } from '../../ink.js'
import { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { ToolActivity } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getAllBaseTools } from '../../tools.js'
import { getTheme } from '../../utils/theme.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { renderToolActivity } from './renderToolActivity.js'
import { describeTeammateActivity, teammateRole } from './taskStatusUtils.js'

/** Prompt display cap, by display width. */
const PROMPT_WIDTH_CAP = 300

function completionColor(status: string): 'success' | 'warning' | 'error' {
  if (status === 'completed') return 'success'
  if (status === 'killed') return 'warning'
  return 'error'
}

function completionWord(status: string): string {
  if (status === 'killed') return 'stopped'
  return status
}

/** The spawn-captured operating profile: role, model and instruction
 *  profile — omitted entirely when none of its parts exist. */
function profileLineOf(teammate: InProcessTeammateTaskState): string | null {
  const parts: string[] = []
  if (teammate.identity.agentType !== undefined) {
    parts.push(`role ${teammate.identity.agentType}`)
  }
  if (teammate.model !== undefined) {
    parts.push(`model ${teammate.model}`)
  }
  const instruction = teammate.instructionAtSpawn
  if (instruction !== undefined) {
    const profile =
      typeof instruction.profile === 'string' ? instruction.profile : 'default'
    parts.push(
      `instructions ${profile} · ${instruction.digest.slice(0, 8)} (captured at spawn)`,
    )
  }
  return parts.length === 0 ? null : parts.join(' · ')
}

export function InProcessTeammateDetailDialog({
  teammate,
  onDone,
  onKill,
  onBack,
  onForeground,
}: {
  teammate: InProcessTeammateTaskState
  onDone: () => void
  onKill?: () => void
  onBack?: () => void
  onForeground?: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const running = teammate.status === 'running'
  const elapsed = useElapsedTime(
    teammate.startTime,
    running,
    1000,
    teammate.totalPausedMs,
    teammate.endTime,
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
      return
    }
    if ((e.key === "f" || e.key === "m") && running && onForeground) {
      e.stopImmediatePropagation()
      onForeground()
    }
  }
  useInput((_input, _key, event) => {
    handleKeyDown(new KeyboardEvent(event.keypress))
  })
  useKeybinding('confirm:yes', () => onDone(), { context: 'Confirmation' })

  const progress = teammate.progress as
    | {
        toolUseCount?: number
        tokenCount?: number
        totalTokens?: number
        totalToolUseCount?: number
        recentActivities?: ToolActivity[]
      }
    | undefined
  const result = teammate.result as
    | { totalTokens?: number; totalToolUseCount?: number }
    | undefined
  const tokenCount =
    result?.totalTokens ?? progress?.totalTokens ?? progress?.tokenCount ?? 0
  const toolUseCount =
    result?.totalToolUseCount ??
    progress?.totalToolUseCount ??
    progress?.toolUseCount ??
    0
  const recent = progress?.recentActivities ?? []
  const profileLine = profileLineOf(teammate)

  return (
    <Box flexDirection="column" tabIndex={-1}>
      <Text bold>
        <Text color={teammateRole(teammate.identity.color)}>
          @{teammate.identity.agentName}
        </Text>
        <Text dimColor> ({describeTeammateActivity(teammate)})</Text>
      </Text>
      <Text dimColor>
        {!running ? (
          <Text color={completionColor(teammate.status)}>
            {completionWord(teammate.status)}
            {' · '}
          </Text>
        ) : null}
        {elapsed}
        {tokenCount > 0 ? ` · ${tokenCount} tokens` : ''}
        {toolUseCount > 0
          ? ` · ${toolUseCount} tool ${toolUseCount === 1 ? 'use' : 'uses'}`
          : ''}
      </Text>
      {profileLine !== null ? (
        <Text dimColor wrap="truncate-end">
          {profileLine}
        </Text>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {truncateToWidth(teammate.prompt, PROMPT_WIDTH_CAP)}
        </Text>
      </Box>
      {running && recent.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Progress</Text>
          {[...recent].reverse().map((activity, index) => (
            <Text key={index} dimColor={index !== 0} wrap="truncate-end">
              {index === 0 ? '▸ ' : '  '}
              {renderToolActivity(activity, getAllBaseTools(), theme)}
            </Text>
          ))}
        </Box>
      ) : null}
      {teammate.status === 'failed' && teammate.error !== undefined ? (
        <Box marginTop={1}>
          <Text color={tokens.failure}>{teammate.error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        {exitState.pending ? (
          <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
        ) : (
          <Text dimColor>
            {running ? (
              <>
                <KeyboardShortcutHint shortcut="f" action="foreground" />
                {' · '}
                <KeyboardShortcutHint shortcut="m" action="message" />
                {onKill ? (
                  <>
                    {' · '}
                    <KeyboardShortcutHint shortcut="x" action="stop" />
                  </>
                ) : null}
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
