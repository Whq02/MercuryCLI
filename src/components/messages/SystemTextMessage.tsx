// The system-row dispatcher: every system-message subtype. Seat receipts
// are ALWAYS rendered (an applied change to the session must be visible
// regardless of verbosity); everything else at info level is suppressed
// unless verbose.

import figures from 'figures'
import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import Link from '../../ink/components/Link.js'
import type {
  SystemMessage,
  SystemStopHookSummaryMessage,
} from '../../types/message.js'
import { TURN_COMPLETION_VERBS } from '../../constants/turnCompletionVerbs.js'
import { getGlobalConfig } from '../../utils/config.js'
import { formatDuration, formatNumber } from '../../utils/format.js'
import { openPath } from '../../utils/browser.js'
import { renderModelName } from '../../utils/model/model.js'
import { crossProviderNote } from '../../utils/model/modelTransition.js'
import { plural } from '../../utils/stringUtils.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppStateStore } from '../../state/AppState.js'
import { isManageableTask } from '../tasks/taskStatusUtils.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { MessageResponse } from '../MessageResponse.js'
import { ResumeRecapCard } from './ResumeRecapCard.js'
import { SystemAPIErrorMessage } from './SystemAPIErrorMessage.js'
import { useSelectedMessageBg } from '../messageActions.js'

function TurnDurationRow({
  message,
}: {
  message: Extract<SystemMessage, { subtype: 'turn_duration' }>
}): React.ReactNode {
  // The verb and the background-task snapshot are captured once at mount
  // (the store is read imperatively, never subscribed) so the row never
  // churns.
  const store = useAppStateStore()
  const [verb] = useState(
    () =>
      TURN_COMPLETION_VERBS[
        Math.floor(Math.random() * TURN_COMPLETION_VERBS.length)
      ] ?? 'Worked',
  )
  const [backgroundCount] = useState(() => {
    try {
      const tasks = Object.values(store.getState().tasks ?? {})
      return tasks.filter(task => isManageableTask(task)).length
    } catch {
      return 0
    }
  })

  const showDuration = getGlobalConfig().showTurnDuration ?? true
  const hasBudget = message.budgetLimit !== undefined
  if (!showDuration && !hasBudget) return null

  const parts: React.ReactNode[] = []
  if (showDuration) {
    parts.push(
      <Text key="duration">
        {verb} for {formatDuration(message.durationMs)}
      </Text>,
    )
  }
  if (hasBudget && message.budgetLimit !== undefined) {
    const used = message.budgetTokens ?? 0
    const pct = Math.round((used / message.budgetLimit) * 100)
    const belowMinimum = used <= message.budgetLimit
    parts.push(
      <Text key="budget">
        {showDuration ? ' · ' : ''}
        {belowMinimum && pct < 100
          ? `${formatNumber(used)} used (min ✓)`
          : `${formatNumber(used)} / ${formatNumber(message.budgetLimit)} (${pct}%)`}
        {message.budgetNudges ? ` · ${message.budgetNudges} ${plural(message.budgetNudges, 'nudge')}` : ''}
      </Text>,
    )
  }
  return (
    <Text dimColor>
      <Text dimColor>{'╰ '}</Text>
      {parts}
      {backgroundCount > 0 ? (
        <Text dimColor>
          {' '}
          · {backgroundCount} background {plural(backgroundCount, 'task')} still
          running
        </Text>
      ) : null}
    </Text>
  )
}

function StopHookSummary({
  message,
  verbose,
  isTranscriptMode,
}: {
  message: SystemStopHookSummaryMessage
  verbose: boolean
  isTranscriptMode: boolean
}): React.ReactNode {
  const hasErrors = message.hookErrors.length > 0
  if (!hasErrors && !message.preventedContinuation && !message.hookLabel) {
    if (message.hookCount === 0) return null
  }
  if (message.hookLabel) {
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text dimColor>
            Ran {message.hookCount} {message.hookLabel}{' '}
            {plural(message.hookCount, 'hook')}
          </Text>
        </MessageResponse>
        {isTranscriptMode
          ? message.hookInfos.map((info, index) => (
              <Box key={index} paddingLeft={2}>
                <Text dimColor>{info.promptText ?? info.command ?? ''}</Text>
              </Box>
            ))
          : null}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>● </Text>
        <Text dimColor>
          Ran {message.hookCount} stop-hook {plural(message.hookCount, 'hook')}
        </Text>
        {!verbose && message.hasOutput ? (
          <>
            {' '}
            <CtrlOToExpand />
          </>
        ) : null}
      </Text>
      {verbose
        ? message.hookInfos.map((info, index) => (
            <Box key={index} paddingLeft={2}>
              <Text dimColor>{info.command ?? info.promptText ?? ''}</Text>
            </Box>
          ))
        : null}
      {message.preventedContinuation && message.stopReason ? (
        <Text color="warning">{message.stopReason}</Text>
      ) : null}
      {message.hookErrors.map((error, index) => (
        <Text key={index} color="error">
          {error}
        </Text>
      ))}
    </Box>
  )
}

export function SystemTextMessage({
  message,
  addMargin = false,
  verbose = false,
  isTranscriptMode = false,
}: {
  message: SystemMessage
  addMargin?: boolean
  verbose?: boolean
  isTranscriptMode?: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const tokens = useMercuryTokens()
  // The selected-message background belongs on the box that owns the top
  // margin, so the margin row is not painted.
  const selectedBg = useSelectedMessageBg()

  switch (message.subtype) {
    case 'turn_duration':
      return <TurnDurationRow message={message} />

    case 'memory_saved': {
      const count = message.writtenPaths.length
      return (
        <Box
          flexDirection="column"
          marginTop={addMargin ? 1 : 0}
          backgroundColor={selectedBg}
        >
          <Text>
            <Text color="remember">● </Text>
            <Text dimColor>
              {message.verb ?? 'Saved'} {count} {plural(count, 'memory')}
            </Text>
          </Text>
          {message.writtenPaths.map(path => {
            const basename = path.split(/[\\/]/).pop() ?? path
            return (
              <InteractiveRow
                key={path}
                id={`memory-saved:${message.uuid}:${path}`}
                directActivate
                selectionBand={false}
                onActivate={() => {
                  void openPath(path)
                }}
              >
                <Text dimColor>
                  {'  '}
                  <Link url={`file://${path}`} fallback={basename}>
                    {basename}
                  </Link>
                </Text>
              </InteractiveRow>
            )
          })}
        </Box>
      )
    }

    case 'model_transition': {
      const previous = message.previous ?? 'default'
      const applied = message.applied ?? 'default'
      if (message.resolution === 'cancelled-pending') {
        return (
          <Text dimColor>
            Queued model switch cancelled — staying on {previous}.
          </Text>
        )
      }
      if (message.resolution === 'applied' && message.boundary === 'turn-boundary') {
        // The pings rule: a queued switch settling at the
        // turn boundary paints exactly this one grey sentence — with the
        // cross-provider marker through the ONE note owner when the
        // receipt says so (FN-016 R17: this is the branch the producer
        // actually takes; the notes array below never rendered for it).
        return (
          <Text dimColor>
            model switched to{' '}
            {message.applied === null ? 'default' : renderModelName(message.applied)} for
            this session
            {message.crossProvider ? crossProviderNote(message.applied) : ''}
          </Text>
        )
      }
      const unchanged = message.previous === null && message.applied === null
      const notes: string[] = []
      if (message.boundary === 'turn-boundary') notes.push('at turn boundary')
      if (message.boundary === 'autopilot-tool') notes.push('by autopilot')
      if (message.crossProvider) notes.push('cross-provider')
      return (
        <Text dimColor>
          {unchanged
            ? `Model unchanged (${previous} → ${applied})`
            : `Model: ${previous} → ${applied}`}
          {notes.length > 0 ? ` (${notes.join(', ')})` : ''}
        </Text>
      )
    }

    case 'away_summary': {
      if (message.recapMetadata) {
        return (
          <ResumeRecapCard metadata={message.recapMetadata} addMargin={addMargin} />
        )
      }
      return (
        <Text dimColor>
          {'※ '}
          {message.content}
        </Text>
      )
    }

    case 'agents_killed':
      return (
        <Text>
          <Text color="error">● </Text>
          <Text dimColor>All background agents stopped.</Text>
        </Text>
      )

    case 'thinking':
      return null

    case 'bridge_status':
      return (
        <Box flexDirection="column">
          <Text dimColor>
            Remote control is active — /remote-control ·{' '}
            <Link url={message.url} fallback={message.url}>
              {message.url}
            </Link>
          </Text>
          {message.upgradeNudge ? (
            <MessageResponse height={1}>
              <Text dimColor>{message.upgradeNudge}</Text>
            </MessageResponse>
          ) : null}
        </Box>
      )

    case 'scheduled_task_fire':
      return (
        <Text dimColor>
          {'* '}
          {message.content}
        </Text>
      )

    case 'permission_retry':
      return (
        <Text>
          <Text dimColor>{'* '}Allowed </Text>
          <Text bold>{message.commands.join(', ')}</Text>
        </Text>
      )

    case 'seat_receipt':
      return (
        <Text color={message.level === 'warning' ? 'warning' : undefined}>
          {message.content}
        </Text>
      )

    case 'roster_transition':
      // The landed spawn-switch toggle: one grey sentence, the way a
      // queued model switch settles.
      return <Text dimColor>{message.content}</Text>

    case 'api_error':
      return <SystemAPIErrorMessage message={message} verbose={verbose} />

    case 'stop_hook_summary':
      return (
        <StopHookSummary
          message={message}
          verbose={verbose}
          isTranscriptMode={isTranscriptMode}
        />
      )

    default: {
      const level = (message as { level?: string }).level ?? 'info'
      if (level === 'info' && !verbose) return null
      const content = (message as { content?: unknown }).content
      if (typeof content !== 'string') return null
      const glyph =
        level === 'warning' || level === 'warn'
          ? GLYPH.warn
          : level === 'info'
            ? GLYPH.idle
            : GLYPH.done
      return (
        <Box
          marginTop={addMargin ? 1 : 0}
          width={Math.max(20, columns - 4)}
          backgroundColor={selectedBg}
        >
          <Text
            color={
              level === 'warning' || level === 'warn'
                ? tokens.warning
                : level === 'error'
                  ? tokens.failureText
                  : undefined
            }
            dimColor={level === 'info'}
            wrap="wrap"
          >
            {glyph} {content.trim()}
          </Text>
        </Box>
      )
    }
  }
}

export default SystemTextMessage
