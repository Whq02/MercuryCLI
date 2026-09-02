// One teammate row in the spinner tree: tree glyphs, status
// precedence (shutdown → approval → idle → active), progressively
// responsive layout against a fixed 8-cell prefix, and the optional
// conversation preview under continuation glyphs.

import figures from 'figures'
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import { sampleSpinnerVerb } from '../../constants/spinnerVerbs.js'
import { formatDuration } from '../../utils/format.js'
import { formatNumber } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { displayWidth, truncateToWidth } from '../mercury-ui/glyphs.js'
import { useNowTick } from '../mercury-ui/components.js'
import { teammateRole } from '../tasks/taskStatusUtils.js'

const PREFIX_CELLS = 8
const ACTIVITY_FLOOR = 25
const EXTRAS_SLACK = 5
const NAME_HIDE_COLUMNS = 60
const PREVIEW_LINES = 3
const PREVIEW_LINE_WIDTH = 80

type TeammateProgress = {
  toolUseCount?: number
  totalToolUseCount?: number
  tokenCount?: number
  totalTokens?: number
  recentActivitySummary?: string
  lastActivity?: { description?: string }
}

function activityTextOf(
  teammate: InProcessTeammateTaskState,
  mountVerb: string,
): string {
  const progress = teammate.progress as TeammateProgress | undefined
  return (
    progress?.recentActivitySummary ??
    progress?.lastActivity?.description ??
    teammate.spinnerVerb ??
    mountVerb
  )
}

/** Up to 3 recent conversation lines, collected newest-first but rendered
 *  oldest-first, each truncated to 80 columns. */
function previewLinesOf(teammate: InProcessTeammateTaskState): string[] {
  const messages = (teammate.messages ?? []) as Array<{
    type?: string
    message?: { content?: unknown }
  }>
  const collected: string[] = []
  for (let i = messages.length - 1; i >= 0 && collected.length < PREVIEW_LINES; i--) {
    const message = messages[i]!
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const content = message.message?.content
    if (typeof content === 'string') {
      const lines = content.split('\n').filter(line => line.trim() !== '')
      for (let k = lines.length - 1; k >= 0 && collected.length < PREVIEW_LINES; k--) {
        collected.push(truncateToWidth(lines[k]!, PREVIEW_LINE_WIDTH))
      }
      continue
    }
    if (!Array.isArray(content)) continue
    for (let b = content.length - 1; b >= 0 && collected.length < PREVIEW_LINES; b--) {
      const block = content[b] as {
        type?: string
        text?: string
        input?: Record<string, unknown>
      }
      if (block.type === 'tool_use') {
        const input = block.input ?? {}
        const field = ['description', 'prompt', 'command', 'query', 'pattern']
          .map(key => input[key])
          .find(value => typeof value === 'string' && value !== '') as
          | string
          | undefined
        collected.push(
          truncateToWidth(
            field ? field.split('\n')[0]! : 'using tool',
            PREVIEW_LINE_WIDTH,
          ),
        )
      } else if (block.type === 'text' && typeof block.text === 'string') {
        const lines = block.text.split('\n').filter(line => line.trim() !== '')
        for (let k = lines.length - 1; k >= 0 && collected.length < PREVIEW_LINES; k--) {
          collected.push(truncateToWidth(lines[k]!, PREVIEW_LINE_WIDTH))
        }
      }
    }
  }
  return collected.reverse()
}

export function TeammateSpinnerLine({
  teammate,
  isLast,
  isSelected = false,
  isForegrounded = false,
  allIdle = false,
  showPreview = false,
}: {
  teammate: InProcessTeammateTaskState
  isLast: boolean
  isSelected?: boolean
  isForegrounded?: boolean
  allIdle?: boolean
  showPreview?: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const now = useNowTick()
  const previewEnabled = useAppState(
    (state: AppState) => state.showTeammateMessagePreview === true,
  )
  // Per-row verb chosen once at mount.
  const mountVerbRef = useRef<string | null>(null)
  if (mountVerbRef.current === null) {
    mountVerbRef.current = teammate.spinnerVerb ?? sampleSpinnerVerb()
  }
  const pastVerbRef = useRef<string | null>(null)
  if (pastVerbRef.current === null) {
    pastVerbRef.current = teammate.pastTenseVerb ?? 'worked'
  }

  // Idle timing: captured on the transition into idle, cleared on leaving.
  const idleSinceRef = useRef<number | null>(null)
  const [frozenIdleMs, setFrozenIdleMs] = useState<number | null>(null)
  useEffect(() => {
    if (teammate.isIdle) {
      if (idleSinceRef.current === null) idleSinceRef.current = Date.now()
    } else {
      idleSinceRef.current = null
    }
  }, [teammate.isIdle])
  useEffect(() => {
    if (allIdle && teammate.isIdle) {
      // Freeze once at the teammate's own work duration.
      setFrozenIdleMs(previous =>
        previous !== null ? previous : Date.now() - teammate.startTime,
      )
    } else {
      setFrozenIdleMs(null)
    }
  }, [allIdle, teammate.isIdle, teammate.startTime])

  const highlighted = isSelected || isForegrounded
  const treeGlyph = highlighted
    ? isLast && !isSelected
      ? '╚'
      : '╠'
    : isLast
      ? '└'
      : '├'

  // Status text by precedence.
  let statusText: string | null = null
  let statusColor: string | undefined
  if (teammate.shutdownRequested) {
    statusText = '[stopping]'
  } else if (teammate.awaitingPlanApproval) {
    statusText = '[awaiting approval]'
    statusColor = 'warning'
  } else if (teammate.isIdle) {
    if (allIdle) {
      const duration = frozenIdleMs ?? Date.now() - teammate.startTime
      statusText = `${pastVerbRef.current} for ${formatDuration(duration, { mostSignificantOnly: true })}`
    } else {
      const idleMs = idleSinceRef.current !== null ? now - idleSinceRef.current : 0
      statusText = `waiting ${formatDuration(Math.max(0, idleMs), { mostSignificantOnly: true })}`
    }
  } else if (highlighted) {
    statusText = null
  } else {
    const activity = activityTextOf(teammate, mountVerbRef.current)
    statusText = activity.endsWith('…') ? activity : `${activity}…`
  }

  // Responsive layout against the fixed prefix.
  const name = `@${teammate.identity.agentName}`
  const nameWidth = displayWidth(name) + 2
  const available = columns - PREFIX_CELLS
  const showName = columns >= NAME_HIDE_COLUMNS && available - nameWidth >= ACTIVITY_FLOOR

  const progress = teammate.progress as TeammateProgress | undefined
  const toolCount = progress?.totalToolUseCount ?? progress?.toolUseCount ?? 0
  const tokenCount = progress?.totalTokens ?? progress?.tokenCount ?? 0
  const statsText =
    toolCount > 0 || tokenCount > 0
      ? `${toolCount} ${plural(toolCount, 'tool use')} · ${formatNumber(tokenCount)} tokens`
      : ''
  const viewHint = isSelected && !isForegrounded ? '↵ view' : ''
  const selectHint = isSelected ? '↑↓ select' : ''

  // Extras shed in order: view hint, select hint, stats.
  let remaining = available - (showName ? nameWidth : 0)
  const extras: string[] = []
  for (const extra of [viewHint, selectHint, statsText]) {
    if (extra === '') continue
    const cost = displayWidth(extra) + 3
    const admitted = extras.reduce((sum, e) => sum + displayWidth(e) + 3, 0)
    if (remaining - admitted - cost >= ACTIVITY_FLOOR + EXTRAS_SLACK) {
      extras.push(extra)
    }
  }
  const extrasWidth = extras.reduce((sum, e) => sum + displayWidth(e) + 3, 0)
  const activityWidth = Math.max(
    ACTIVITY_FLOOR,
    remaining - extrasWidth - 1,
  )

  const preview =
    showPreview && previewEnabled ? previewLinesOf(teammate) : []

  return (
    <Box flexDirection="column" paddingLeft={3}>
      <Box>
        <Text bold={isSelected}>{isSelected ? `${figures.pointer} ` : '  '}</Text>
        <Text dimColor={!isSelected}>{treeGlyph} </Text>
        <Text color={teammateRole(teammate.identity.color)} bold={isForegrounded}>
          {showName ? `${name}  ` : ''}
        </Text>
        {statusText !== null ? (
          <Text
            color={statusColor}
            dimColor={statusColor === undefined}
            wrap="truncate-end"
          >
            {truncateToWidth(statusText, activityWidth)}
          </Text>
        ) : null}
        {extras.map((extra, index) => (
          <Text key={index} dimColor>
            {'  '}
            {extra}
          </Text>
        ))}
      </Box>
      {preview.map((line, index) => (
        <Box key={index} paddingLeft={2}>
          <Text dimColor>
            {index === preview.length - 1 && isLast ? '  ' : '│ '}
            {line}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
