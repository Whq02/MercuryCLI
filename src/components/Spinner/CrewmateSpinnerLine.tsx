
import figures from 'figures'
import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { InProcessCrewmateTaskState } from '../../tasks/InProcessCrewmateTask/types.js'
import { sampleSpinnerVerb } from '../../constants/spinnerVerbs.js'
import { formatDuration } from '../../utils/format.js'
import { formatNumber } from '../../utils/format.js'
import { plural } from '../../utils/stringUtils.js'
import { displayWidth, truncateToWidth } from '../mercury-ui/glyphs.js'
import { useNowTick } from '../mercury-ui/components.js'
import { crewmateRole } from '../tasks/taskStatusUtils.js'

const PREFIX_CELLS = 8
const ACTIVITY_FLOOR = 25
const EXTRAS_SLACK = 5
const NAME_HIDE_COLUMNS = 60
const PREVIEW_LINES = 3
const PREVIEW_LINE_WIDTH = 80

type CrewmateProgress = {
  toolUseCount?: number
  totalToolUseCount?: number
  tokenCount?: number
  totalTokens?: number
  recentActivitySummary?: string
  lastActivity?: { description?: string }
}

function activityTextOf(
  crewmate: InProcessCrewmateTaskState,
  mountVerb: string,
): string {
  const progress = crewmate.progress as CrewmateProgress | undefined
  return (
    progress?.recentActivitySummary ??
    progress?.lastActivity?.description ??
    crewmate.spinnerVerb ??
    mountVerb
  )
}

function previewLinesOf(crewmate: InProcessCrewmateTaskState): string[] {
  const messages = (crewmate.messages ?? []) as Array<{
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

export function CrewmateSpinnerLine({
  crewmate,
  isLast,
  isSelected = false,
  isForegrounded = false,
  allIdle = false,
  showPreview = false,
}: {
  crewmate: InProcessCrewmateTaskState
  isLast: boolean
  isSelected?: boolean
  isForegrounded?: boolean
  allIdle?: boolean
  showPreview?: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const now = useNowTick()
  const previewEnabled = useAppState(
    (state: AppState) => state.showCrewmateMessagePreview === true,
  )
  const mountVerbRef = useRef<string | null>(null)
  if (mountVerbRef.current === null) {
    mountVerbRef.current = crewmate.spinnerVerb ?? sampleSpinnerVerb()
  }
  const pastVerbRef = useRef<string | null>(null)
  if (pastVerbRef.current === null) {
    pastVerbRef.current = crewmate.pastTenseVerb ?? 'worked'
  }

  const idleSinceRef = useRef<number | null>(null)
  const [frozenIdleMs, setFrozenIdleMs] = useState<number | null>(null)
  useEffect(() => {
    if (crewmate.isIdle) {
      if (idleSinceRef.current === null) idleSinceRef.current = Date.now()
    } else {
      idleSinceRef.current = null
    }
  }, [crewmate.isIdle])
  useEffect(() => {
    if (allIdle && crewmate.isIdle) {
      setFrozenIdleMs(previous =>
        previous !== null ? previous : Date.now() - crewmate.startTime,
      )
    } else {
      setFrozenIdleMs(null)
    }
  }, [allIdle, crewmate.isIdle, crewmate.startTime])

  const highlighted = isSelected || isForegrounded
  const treeGlyph = highlighted
    ? isLast && !isSelected
      ? '╚'
      : '╠'
    : isLast
      ? '└'
      : '├'

  let statusText: string | null = null
  if (crewmate.shutdownRequested) {
    statusText = '[stopping]'
  } else if (crewmate.isIdle) {
    if (allIdle) {
      const duration = frozenIdleMs ?? Date.now() - crewmate.startTime
      statusText = `${pastVerbRef.current} for ${formatDuration(duration, { mostSignificantOnly: true })}`
    } else {
      const idleMs = idleSinceRef.current !== null ? now - idleSinceRef.current : 0
      statusText = `waiting ${formatDuration(Math.max(0, idleMs), { mostSignificantOnly: true })}`
    }
  } else if (highlighted) {
    statusText = null
  } else {
    const activity = activityTextOf(crewmate, mountVerbRef.current)
    statusText = activity.endsWith('…') ? activity : `${activity}…`
  }

  const name = `@${crewmate.identity.agentName}`
  const nameWidth = displayWidth(name) + 2
  const available = columns - PREFIX_CELLS
  const showName = columns >= NAME_HIDE_COLUMNS && available - nameWidth >= ACTIVITY_FLOOR

  const progress = crewmate.progress as CrewmateProgress | undefined
  const toolCount = progress?.totalToolUseCount ?? progress?.toolUseCount ?? 0
  const tokenCount = progress?.totalTokens ?? progress?.tokenCount ?? 0
  const statsText =
    toolCount > 0 || tokenCount > 0
      ? `${toolCount} ${plural(toolCount, 'tool use')} · ${formatNumber(tokenCount)} tokens`
      : ''
  const viewHint = isSelected && !isForegrounded ? '↵ view' : ''
  const selectHint = isSelected ? '↑↓ select' : ''

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
    showPreview && previewEnabled ? previewLinesOf(crewmate) : []

  return (
    <Box flexDirection="column" paddingLeft={3}>
      <Box>
        <Text bold={isSelected}>{isSelected ? `${figures.pointer} ` : '  '}</Text>
        <Text dimColor={!isSelected}>{treeGlyph} </Text>
        <Text color={crewmateRole(crewmate.identity.color)} bold={isForegrounded}>
          {showName ? `${name}  ` : ''}
        </Text>
        {statusText !== null ? (
          <Text
            dimColor
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
