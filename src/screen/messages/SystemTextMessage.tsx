import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import React, { useState } from 'react'
import { Box, Text } from '../themedRenderer.js'
import Link from '../renderer/elements/Link.js'
import type {
  SystemMessage,
  SystemMessageLevel,
} from '../../engine/message-shapes/message.js'
import { TURN_COMPLETION_VERBS } from '../spinner/turnCompletionVerbs.js'
import { getGlobalConfig } from '../../platform/settings/config.js'
import { formatDuration, formatNumber } from '../../platform/text/format.js'
import { openPath } from '../../platform/host-os/browser.js'
import { renderModelName } from '../../models/catalogue/engineModel.js'
import { crossProviderNote } from '../../models/catalogue/modelTransition.js'
import { plural } from '../../platform/text/strings.js'
import { advisorBlockOf } from '../../engine/message-shapes/noticeRows.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useAppStateStore } from '../app-state/AppState.js'
import { isManageableTask } from '../tasks/taskStatus.js'
import { GLYPH } from '../theme/glyphs.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { InteractiveRow } from '../widgets/InteractiveRow.js'
import { CtrlOToExpand } from './CtrlOToExpand.js'
import { MessageResponse } from '../../tools/kit/MessageResponse.js'
import { isTransportRetryNotice } from './nullRenderingAttachments.js'
import { ResumeRecapCard } from './ResumeRecapCard.js'
import { SystemAPIErrorMessage } from './SystemAPIErrorMessage.js'
import { UserNoticeMessage } from './UserNoticeMessage.js'
import { useSelectedMessageBg } from './messageActions.js'
import { passedOver } from '../../platform/errors/passedOver.js'

function TurnDurationRow({
  message,
}: {
  message: Extract<SystemMessage, { subtype: 'turn_duration' }>
}): React.ReactNode {
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
    } catch (error) {
      passedOver(error)
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


function MemorySavedRow({
  message,
  addMargin,
  bg,
}: {
  message: Extract<SystemMessage, { subtype: 'memory_saved' }>
  addMargin: boolean
  bg: string | undefined
}): React.ReactNode {
  const [openError, setOpenError] = useState<string | null>(null)
  const verb = message.verb ?? 'Saved'
  const count = message.writtenPaths.length
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0} backgroundColor={bg}>
      <Text>
        <Text color="remember">● </Text>
        <Text dimColor>
          {verb} {count} {plural(count, 'memory', 'memories')}
        </Text>
      </Text>
      {message.writtenPaths.map(filePath => {
        const label = basename(filePath)
        return (
          <InteractiveRow
            key={filePath}
            id={`memory-saved:${message.uuid}:${filePath}`}
            directActivate
            selectionBand={false}
            onActivate={() => {
              setOpenError(null)
              void openPath(filePath, err => {
                setOpenError(`${filePath} could not be opened (${err}) — open it yourself`)
              })
            }}
          >
            <Text dimColor>
              {'  '}
              <Link url={pathToFileURL(filePath).href} fallback={label}>
                {label}
              </Link>
            </Text>
          </InteractiveRow>
        )
      })}
      {openError ? <Text color="warning">{openError}</Text> : null}
    </Box>
  )
}

function renderFallbackSystemRow({
  row,
  addMargin,
  verbose,
  columns,
  bg,
  warningColor,
  errorColor,
}: {
  row: { content: string; level: SystemMessageLevel }
  addMargin: boolean
  verbose: boolean
  columns: number
  bg: string | undefined
  warningColor: string
  errorColor: string
}): React.ReactNode {
  const { level, content } = row
  if (level === 'info' && !verbose) return null
  const glyph =
    level === 'warning' || level === 'warn'
      ? GLYPH.warn
      : level === 'info'
        ? GLYPH.idle
        : GLYPH.done
  const color =
    level === 'warning' || level === 'warn'
      ? warningColor
      : level === 'error'
        ? errorColor
        : undefined
  return (
    <Box
      width={Math.max(20, columns - 4)}
      marginTop={addMargin ? 1 : 0}
      backgroundColor={bg}
    >
      <Text color={color} dimColor={level === 'info'} wrap="wrap">
        {glyph} {content.trim()}
      </Text>
    </Box>
  )
}

export function SystemTextMessage({
  message,
  addMargin = false,
  verbose = false,
}: {
  message: SystemMessage
  addMargin?: boolean
  verbose?: boolean
  isTranscriptMode?: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const tokens = useMercuryTokens()
  const bg = useSelectedMessageBg()

  switch (message.subtype) {
    case 'turn_duration':
      return <TurnDurationRow message={message} />

    case 'memory_saved':
      return <MemorySavedRow message={message} addMargin={addMargin} bg={bg} />

    case 'model_transition': {
      if (message.resolution === 'cancelled-pending') {
        return (
          <Text dimColor>
            Queued model switch cancelled — staying on {message.previous ?? 'default'}.
          </Text>
        )
      }
      if (message.resolution === 'applied' && message.boundary === 'turn-boundary') {
        const appliedLabel =
          message.applied === null ? 'default' : renderModelName(message.applied)
        const cross = message.crossProvider ? crossProviderNote(message.applied) : ''
        return (
          <Text dimColor>
            model switched to {appliedLabel} for
            this session{cross}
          </Text>
        )
      }
      const prev = message.previous ?? 'default'
      const applied = message.applied ?? 'default'
      const head =
        message.previous === null && message.applied === null
          ? `Model unchanged (${prev} → ${applied})`
          : `Model: ${prev} → ${applied}`
      const notes: string[] = []
      if (message.boundary === 'turn-boundary') notes.push('at turn boundary')
      if (message.crossProvider) notes.push('cross-provider')
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : ''
      return (
        <Text dimColor>
          {head}
          {suffix}
        </Text>
      )
    }

    case 'away_summary':
      if (message.recapMetadata) {
        return (
          <ResumeRecapCard metadata={message.recapMetadata} addMargin={addMargin} />
        )
      }
      return <Text dimColor>※ {message.content}</Text>

    case 'agents_killed':
      return (
        <Text>
          <Text color="error">● </Text>
          <Text dimColor>All background crewmates stopped.</Text>
        </Text>
      )

    case 'thinking':
    case 'thinking_note':
    case 'thinking_dead':
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
      return <Text dimColor>* {message.content}</Text>

    case 'seat_receipt':
      return (
        <Text color={message.level === 'warning' ? 'warning' : undefined}>
          {message.content}
        </Text>
      )

    case 'roster_transition':
      return <Text dimColor>{message.content}</Text>

    case 'advisor_quiet':
      return (
        <UserNoticeMessage
          addMargin={addMargin}
          blocks={[advisorBlockOf(message.origin, message.content)]}
        />
      )

    case 'stream_cut':
      return (
        <Box flexDirection="column">
          <Text color="subtle">
            Continued after <Text bold>{message.count}</Text>{' '}
            {plural(message.count, 'stream cut')} · context sent again
            {!verbose ? (
              <>
                {' '}
                <CtrlOToExpand />
              </>
            ) : null}
          </Text>
          {verbose && message.content ? <Text dimColor>{message.content}</Text> : null}
        </Box>
      )

    case 'busy_recovery': {
      const seconds = Math.max(1, Math.round(message.elapsedMs / 1000))
      return (
        <Box flexDirection="column">
          <Text color="subtle">
            {message.provider} was busy · answered after{' '}
            <Text bold>{message.retries}</Text>{' '}
            {plural(message.retries, 'retry', 'retries')} ({seconds} s)
            {!verbose ? (
              <>
                {' '}
                <CtrlOToExpand />
              </>
            ) : null}
          </Text>
          {verbose && message.content ? <Text dimColor>{message.content}</Text> : null}
        </Box>
      )
    }

    case 'api_error':
      if (isTransportRetryNotice(message)) return null
      return <SystemAPIErrorMessage message={message} verbose={verbose} />

    case 'api_metrics':
    case 'close_usage':
      return null

    default:
      return renderFallbackSystemRow({
        row: message,
        addMargin,
        verbose,
        columns,
        bg,
        warningColor: tokens.warning,
        errorColor: tokens.failureText,
      })
  }
}

export default SystemTextMessage
