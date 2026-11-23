import React from 'react'
import { exitChordNoticeText } from '../PromptInput/ExitChordNotice.js'
import { Box, Text, useInput } from '../../ink.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { useExitOnCtrlCD } from '../../hooks/useExitOnCtrlCD.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import type { ToolActivity } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getAllBaseTools } from '../../tools.js'
import { getTheme } from '../../utils/theme.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { renderToolActivity } from './renderToolActivity.js'
import { agentLifecycleOf, getTaskStatusColor, getTaskStatusIcon } from './taskStatusUtils.js'
import { GLYPH } from '../../utils/glyphs.js'

const PROMPT_CAP = 300

function statusWord(status: string): string {
  if (status === 'killed') return 'Stopped'
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  return status
}

export function AsyncAgentDetailDialog({
  agent,
  onDone,
  onKillAgent,
  onBack,
  onForeground,
}: {
  agent: LocalAgentTaskState
  onDone: () => void
  onKillAgent?: () => void
  onBack?: () => void
  onForeground?: () => void
}): React.ReactNode {
  const exitState = useExitOnCtrlCD(useKeybindings)
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
    if (input === 'x' && isRunning && onKillAgent) {
      onKillAgent()
      return
    }
    if ((input === 'f' || input === 'm') && onForeground) {
      onForeground()
    }
  })

  const lifecycle = !isRunning ? agentLifecycleOf(agent) : undefined
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
            {isRunning && onKillAgent ? (
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
