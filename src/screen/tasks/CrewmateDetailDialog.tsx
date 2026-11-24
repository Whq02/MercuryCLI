import React from 'react'
import { exitChordNoticeText } from '../composer/ExitChordNotice.js'
import { Box, Text, useInput } from '../themedRenderer.js'
import { useElapsedTime } from '../effects/useElapsedTime.js'
import { useKeybinding } from '../keys/useKeybinding.js'
import { useExitChord } from '../keys/useExitChord.js'
import type { CrewmateTaskState } from '../../engine/tasks/local-agent/crewmateTask.js'
import type { ToolActivity } from '../../engine/tasks/local-agent/crewmateTask.js'
import { getAllBaseTools } from '../../tools/kit/toolList.js'
import { getTheme } from '../theme/theme.js'
import { useTheme } from '../theme/ThemeProvider.js'
import { KeyboardShortcutHint } from '../theme/KeyboardShortcutHint.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { renderToolActivity } from './renderToolActivity.js'
import { crewmateLifecycleOf, getTaskStatusColor, getTaskStatusIcon } from './taskStatus.js'
import { GLYPH } from '../theme/glyphs.js'

const PROMPT_CAP = 300

function statusWord(status: string): string {
  if (status === 'killed') return 'Stopped'
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  return status
}

export function CrewmateDetailDialog({
  agent,
  onDone,
  onKillCrewmate,
  onBack,
  onForeground,
}: {
  agent: CrewmateTaskState
  onDone: () => void
  onKillCrewmate?: () => void
  onBack?: () => void
  onForeground?: () => void
}): React.ReactNode {
  const exitState = useExitChord()
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const tokens = useMercuryTokens()
  const tools = React.useMemo(() => getAllBaseTools(), [])

  const isRunning = agent.status === 'running' || agent.status === 'pending'
  const elapsed = useElapsedTime(agent.startTime, isRunning, undefined, undefined, agent.endTime)

  useKeybinding('confirm:yes', onDone, { context: 'Confirmation' })

  useInput((input, key) => {
    if (key.escape || input === ' ') {
      onDone()
      return
    }
    if (key.leftArrow && onBack) {
      onBack()
      return
    }
    if (input === 'x' && isRunning && onKillCrewmate) {
      onKillCrewmate()
      return
    }
    if ((input === 'f' || input === 'm') && onForeground) {
      onForeground()
    }
  })

  const lifecycle = !isRunning ? crewmateLifecycleOf(agent) : undefined
  const tokenCount =
    agent.progress?.tokenCount ?? agent.progress?.totalTokens ?? agent.lastReportedTokenCount
  const toolUseCount =
    agent.progress?.toolUseCount ??
    agent.progress?.totalToolUseCount ??
    agent.lastReportedToolCount
  const displayPrompt =
    agent.prompt && agent.prompt.length > PROMPT_CAP
      ? `${agent.prompt.slice(0, PROMPT_CAP)}…`
      : agent.prompt
  const recentActivities: ToolActivity[] = agent.progress?.recentActivities ?? []
  const newestFirst = [...recentActivities].reverse()

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box>
          <Text bold>{agent.agentType || 'crewmate'}</Text>
          <Text dimColor> · {agent.description || 'background task'}</Text>
        </Box>
        <Box>
          {!isRunning ? (
            <>
              <Text color={getTaskStatusColor(agent.status)}>
                {getTaskStatusIcon(agent.status)} {statusWord(agent.status)}
              </Text>
              <Text dimColor> · </Text>
            </>
          ) : null}
          <Text dimColor>{elapsed}</Text>
          {tokenCount !== undefined && tokenCount > 0 ? (
            <Text dimColor> · {tokenCount} tokens</Text>
          ) : null}
          {toolUseCount !== undefined && toolUseCount > 0 ? (
            <Text dimColor>
              {' '}
              · {toolUseCount} {toolUseCount === 1 ? 'tool use' : 'tool uses'}
            </Text>
          ) : null}
        </Box>
        {lifecycle ? (
          <Text dimColor>
            {lifecycle.state} {GLYPH.dot} {lifecycle.basis}
          </Text>
        ) : null}
      </Box>

      {displayPrompt ? <Text dimColor>{displayPrompt}</Text> : null}

      {isRunning && newestFirst.length > 0 ? (
        <Box flexDirection="column">
          <Text bold>Progress</Text>
          {newestFirst.map((activity, index) => (
            <Box key={index}>
              {index === 0 ? (
                <Text>▸ {renderToolActivity(activity, tools, theme)}</Text>
              ) : (
                <Text dimColor>  {renderToolActivity(activity, tools, theme)}</Text>
              )}
            </Box>
          ))}
        </Box>
      ) : null}

      {agent.status === 'failed' && agent.error ? (
        <Text color={tokens.failure}>{agent.error}</Text>
      ) : null}

      <Box>
        {exitState.pending ? (
          <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
        ) : (
          <Text dimColor>
            <KeyboardShortcutHint shortcut="f" action="foreground" />
            {' · '}
            <KeyboardShortcutHint shortcut="m" action="message" />
            {isRunning && onKillCrewmate ? (
              <>
                {' · '}
                <KeyboardShortcutHint shortcut="x" action="stop" />
              </>
            ) : null}
            {onBack ? (
              <>
                {' · '}
                <KeyboardShortcutHint shortcut="←" action="back" />
              </>
            ) : null}
            {' · '}
            <KeyboardShortcutHint shortcut="space" action="close" />
          </Text>
        )}
      </Box>
    </Box>
  )
}
