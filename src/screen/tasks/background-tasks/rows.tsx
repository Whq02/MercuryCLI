import React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import { useKeybindings } from '../../keys/useKeybinding.js'
import type { TaskState } from '../../../engine/tasks/taskState.js'
import { formatDuration, formatTokens } from '../../../platform/text/format.js'
import { KeyboardShortcutHint } from '../../theme/KeyboardShortcutHint.js'
import { KeyValueGrid, type KVRow } from '../../widgets/components.js'
import { WorkingGlyph } from '../../widgets/LiveGlyphs.js'
import { useMercuryTokens } from '../../widgets/useMercuryTokens.js'
import type { SampleRowV1, WorkRowV1 } from '../../../engine/connector/types.js'
import { sampleStateWord } from '../../../integrations/sample-contracts/contracts.js'
import { crewAgentFactsOf, crewCostLabel, crewModelLabel, CREW_ASK_WAIT_WORDS, crewPhaseWords, crewSpendLabel, crewStateLabel, crewStatusWords, crewTokensBreakdown, crewTokensLabel, crewToolUsesLabel } from '../../../engine/connector/crewFacts.js'
import { getFocusedSessionConnector } from '../../../engine/connector/focusedConnector.js'
import { GLYPH } from '../../theme/glyphs.js'

export const WINDOW = 10
export const MISSION_IN_PROGRESS_CAP = 4
export const MISSION_PENDING_CAP = 6

export type RowKind =
  | 'shell'
  | 'monitor'
  | 'agent'
  | 'sample'
  | 'lead'

export type BoardItem = {
  id: string
  kind: RowKind
  task?: TaskState
  work?: WorkRowV1
  sample?: SampleRowV1
}

export function SampleRowLine({ sample }: { sample: SampleRowV1 }): React.ReactNode {
  const tokens = useMercuryTokens()
  return (
    <Text wrap="truncate-end">
      <Text color={sample.state === 'approved' ? tokens.success : sample.state === 'changes-needed' ? tokens.warning : tokens.textMuted}>
        {sample.glyph}
      </Text>
      <Text> {sample.title}</Text>
      <Text color={tokens.textMuted}> · v{sample.version} · {sampleStateWord(sample.state)}</Text>
    </Text>
  )
}

export function boardRowElapsedMs(item: { task?: { startTime: number; endTime?: number }; work?: { startTime: number; endTime?: number } }, now: number): number | null {
  const started = item.task?.startTime ?? item.work?.startTime
  if (started === undefined || !Number.isFinite(started) || started === 0) return null
  const ended = item.task?.endTime ?? item.work?.endTime
  return Math.max(0, (ended !== undefined && Number.isFinite(ended) && ended > 0 ? ended : now) - started)
}

export function AgeCell({ item, now }: { item: BoardItem; now: number }): React.ReactNode {
  const elapsed = boardRowElapsedMs(item, now)
  if (elapsed === null) {
    return <Box width={9} flexShrink={0} />
  }
  return (
    <Box width={9} flexShrink={0} justifyContent="flex-end">
      <Text dimColor>{formatDuration(elapsed)}</Text>
    </Box>
  )
}

export function WorkRowLine({ work }: { work: WorkRowV1 }): React.ReactNode {
  const tokens = useMercuryTokens()
  const crew = crewAgentFactsOf(work, null)
  const crewTokens = crew === null ? null : crewTokensLabel(crew)
  const running = work.status === 'running'
  const pending = work.status === 'pending'
  const failed = work.status === 'failed' || work.status === 'killed'
  return (
    <Text wrap="truncate-end">
      {running ? (
        <WorkingGlyph color={tokens.success} active />
      ) : (
        <Text color={failed ? tokens.failure : pending ? tokens.warning : tokens.textMuted}>
          {failed ? GLYPH.fail : pending ? GLYPH.pending : GLYPH.done}
        </Text>
      )}
      <Text> {work.name}</Text>
      <Text color={tokens.textMuted}> · {crew !== null ? crewStatusWords(crew, Date.now()) : work.status}</Text>
      {crew !== null ? (
        <Text color={tokens.textMuted}>
          {' · '}{crewModelLabel(crew)}{crewTokens !== null ? ` · ${crewTokens}` : ''}
        </Text>
      ) : null}
      {(work.pendingAsks ?? 0) > 0 ? (
        <Text color={tokens.warning}> · {CREW_ASK_WAIT_WORDS}{(work.pendingAsks ?? 0) > 1 ? ` (${work.pendingAsks} asks)` : ''}</Text>
      ) : null}
    </Text>
  )
}

export function RosterWorkDetail({
  work,
  now,
  onBack,
}: {
  work: WorkRowV1
  now: number
  onBack: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()
  useKeybindings(
    {
      'confirm:no': () => {
        onBack()
      },
    },
    { context: 'Confirmation', isActive: true },
  )
  const crew = crewAgentFactsOf(work, null)
  const rows: KVRow[] = [
    { k: 'state', v: crew !== null ? crewStateLabel(crew) : work.status, tone: work.status === 'running' ? tokens.success : tokens.textPrimary },
    { k: 'started', v: `${formatDuration(Math.max(0, now - work.startTime))} ago`, tone: tokens.textMuted },
  ]
  if (work.endTime !== undefined) rows.push({ k: 'ran', v: formatDuration(Math.max(0, work.endTime - work.startTime)), tone: tokens.textMuted })
  if (crew !== null) {
    rows.push({ k: 'model', v: crewModelLabel(crew), tone: tokens.textPrimary })
    const toolUses = crewToolUsesLabel(crew)
    if (toolUses !== null) rows.push({ k: 'tools', v: toolUses, tone: tokens.textPrimary })
    if (crew.activity !== null) rows.push({ k: 'doing', v: crew.activity, tone: tokens.textSecondary })
    if (crew.stopReason !== null) rows.push({ k: 'why', v: crew.stopReason, tone: tokens.warning })
    const phase = crewPhaseWords(crew, now)
    if (phase !== null) rows.push({ k: 'phase', v: phase, tone: tokens.textSecondary })
    if (crew.agentType !== null) rows.push({ k: 'agent', v: crew.agentType, tone: tokens.textPrimary })
    if (crew.crew !== null) rows.push({ k: 'crew', v: crew.crew, tone: tokens.textPrimary })
    const crewTokens = crewTokensLabel(crew)
    if (crewTokens !== null) rows.push({ k: 'tokens', v: `${GLYPH.tokens} ${crewTokens}`, tone: tokens.textPrimary })
    const crewSpend = crewSpendLabel(crew)
    if (crewSpend !== null) {
      const breakdown = crewTokensBreakdown(crew)
      rows.push({ k: 'spent', v: `${GLYPH.tokens} ${crewSpend}${breakdown !== null ? ` (${breakdown})` : ''}`, tone: tokens.textPrimary })
    }
    const spend = crewCostLabel(crew)
    if (spend !== null && getFocusedSessionConnector().identity().consoleBilling) {
      rows.push({ k: 'spend', v: spend, tone: tokens.textPrimary })
    }
  } else {
    if (work.model !== undefined) rows.push({ k: 'model', v: work.model, tone: tokens.textPrimary })
    if ((work.totalTokens ?? 0) > 0) rows.push({ k: 'tokens', v: `${GLYPH.tokens} ${formatTokens(work.totalTokens ?? 0)} spent`, tone: tokens.textPrimary })
  }
  return (
    <Box flexDirection="column">
      {work.description !== undefined ? (
        <Text color={tokens.textMuted} wrap="truncate-end">
          {work.description}
        </Text>
      ) : null}
      {work.error !== undefined ? (
        <Text color={tokens.failure} wrap="wrap">
          {work.error}
        </Text>
      ) : null}
      <KeyValueGrid rows={rows} keyWidth={8} />
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          <KeyboardShortcutHint shortcut="Esc" action="back" />
        </Text>
      </Box>
    </Box>
  )
}
