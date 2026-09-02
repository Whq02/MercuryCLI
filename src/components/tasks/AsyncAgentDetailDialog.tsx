// Detail card for a local background agent: title from agent type +
// description, the shared subtitle (completion marker · elapsed · tokens ·
// tool uses), the prompt (or its embedded plan through the plan renderer),
// a Progress block while running, and the f/m foreground pair offered in
// every listed state — a completed agent inside its linger window is
// precisely the row the reply flow needs.

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
import { UserPlanMessage } from '../messages/UserPlanMessage.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { renderToolActivity } from './renderToolActivity.js'
import { agentLifecycleOf, getTaskStatusColor, getTaskStatusIcon } from './taskStatusUtils.js'
import { GLYPH } from '../mercury-ui/glyphs.js'

/** Prompt display cap: 297 characters plus an ellipsis. */
const PROMPT_CAP = 300

/** The plan-file attachment marker — a prompt embedding a plan renders the
 *  plan through the plan message component instead of raw text. */
const PLAN_MARKER = 'Plan contents:\n\n'
const PLAN_TAIL = '\n\nIf this plan is relevant'

function embeddedPlanOf(prompt: string): string | null {
  const at = prompt.indexOf(PLAN_MARKER)
  if (at < 0) return null
  let plan = prompt.slice(at + PLAN_MARKER.length)
  const tail = plan.indexOf(PLAN_TAIL)
  if (tail >= 0) plan = plan.slice(0, tail)
  return plan.trim() === '' ? null : plan
}

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
  const tokens = useMercuryTokens()
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const running = agent.status === 'running' || agent.status === 'pending'
  const lifecycle = agentLifecycleOf(agent)
  const elapsed = useElapsedTime(
    agent.startTime,
    running,
    1000,
    agent.totalPausedMs,
    agent.endTime,
  )
  const exitState = useExitOnCtrlCD(useKeybindings)

  useInput((input, key, event) => {
    if (input === ' ') {
      event.stopImmediatePropagation()
      onDone()
      return
    }
    if (key.leftArrow && onBack) {
      event.stopImmediatePropagation()
      onBack()
      return
    }
    if (input === 'x' && running && onKillAgent) {
      event.stopImmediatePropagation()
      onKillAgent()
      return
    }
    if ((input === 'f' || input === 'm') && onForeground) {
      event.stopImmediatePropagation()
      onForeground()
    }
  })
  useKeybinding('confirm:yes', () => onDone(), { context: 'Confirmation' })

  const progress = agent.progress as
    | {
        toolUseCount?: number
        tokenCount?: number
        totalTokens?: number
        totalToolUseCount?: number
        recentActivities?: ToolActivity[]
      }
    | undefined
  const result = agent.result as
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
  const plan = embeddedPlanOf(agent.prompt)
  const promptShown =
    agent.prompt.length > PROMPT_CAP
      ? `${agent.prompt.slice(0, PROMPT_CAP - 3)}…`
      : agent.prompt

  return (
    <Box flexDirection="column" tabIndex={-1}>
      <Text bold>
        {agent.agentType !== '' ? agent.agentType : 'agent'}
        <Text dimColor>
          {' · '}
          {agent.description !== '' ? agent.description : 'background task'}
        </Text>
      </Text>
      <Text dimColor>
        {!running ? (
          <Text color={getTaskStatusColor(agent.status)}>
            {getTaskStatusIcon(agent.status)} {statusWord(agent.status)}
            {' · '}
          </Text>
        ) : null}
        {elapsed}
        {tokenCount > 0 ? ` · ${tokenCount} tokens` : ''}
        {toolUseCount > 0
          ? ` · ${toolUseCount} tool ${toolUseCount === 1 ? 'use' : 'uses'}`
          : ''}
      </Text>
      {lifecycle !== undefined && lifecycle.state !== 'running' ? (
        // The lifecycle vocabulary (spec 03-C2): what this terminal row IS
        // now and whether a SendMessage revives it — the one derivation,
        // its basis printed verbatim.
        <Text dimColor>
          {lifecycle.state} {GLYPH.dot} {lifecycle.basis}
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {plan !== null ? (
          <UserPlanMessage planContent={plan} />
        ) : (
          <Text dimColor wrap="truncate-end">
            {promptShown}
          </Text>
        )}
      </Box>
      {running && recent.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Progress</Text>
          {[...recent].reverse().map((activity, index) => (
            <Text
              key={index}
              dimColor={index !== 0}
              wrap="truncate-end"
            >
              {index === 0 ? '▸ ' : '  '}
              {renderToolActivity(activity, getAllBaseTools(), theme)}
            </Text>
          ))}
        </Box>
      ) : null}
      {agent.status === 'failed' && agent.error !== undefined ? (
        <Box marginTop={1}>
          <Text color={tokens.failure}>{agent.error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        {exitState.pending ? (
          <Text dimColor>{exitChordNoticeText(exitState.keyName)}</Text>
        ) : (
          <Text dimColor>
            <KeyboardShortcutHint shortcut="f" action="foreground" />
            {' · '}
            <KeyboardShortcutHint shortcut="m" action="message" />
            {running && onKillAgent ? (
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
