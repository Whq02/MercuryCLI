import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { contextWindowLabel } from '../utils/contextFill.js'
import {
  formatSessionCost,
  getTotalCost,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalUnpricedTurns,
} from '../cost-tracker.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { useDisplayedSessionModel } from '../hooks/useDisplayedSessionModel.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { useAppStateMaybeOutsideOfProvider } from '../state/AppState.js'
import { useTelemetry } from '../state/telemetryBus.js'
import { LAYOUT_BREAKPOINTS } from '../hooks/useLayoutTier.js'
import { getGitState, type GitRepoState } from '../utils/git.js'
import { hasConsoleBillingAccess } from '../utils/billing.js'
import { renderModelChip, renderModelName } from '../utils/model/model.js'
import { listCapabilityKills } from '../utils/permissions/capabilityGate.js'
import { getTaskListId, listTasks, type Task } from '../utils/tasks.js'
import {
  getDisplayedEffortLabel,
  modelSupportsEffort,
  type EffortValue,
} from '../utils/effort.js'
import {
  agentStateSnapshot,
  daemonSnapshot,
  daemonRosterSnapshot,
  type RosterSnapshot,
  getLiveContextUsage,
  getLiveContextUsageVersion,
  getLivePresence,
  getPresenceVersion,
  subscribeLiveContextUsage,
  subscribePresence,
  traceSnapshot,
  type SnapshotState,
} from '../utils/cockpit/index.js'
import { formatCountdown } from '../utils/cockpit/quota.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../services/claudeAiLimits.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { CompanionSpeechLine, DeckCompanion, DeckCompanionChip } from './mercury-ui/DeckCompanion.js'
import { EffortChip } from './mercury-ui/EffortChip.js'
import { TrimChip } from './mercury-ui/TrimChip.js'
import { MiniCritter } from './mercury-ui/MiniCritter.js'
import { Crab } from './mercury-ui/assets.js'
import { useCompanionEnabled } from './mercury-ui/useCompanion.js'
import { ProgressBar, UsageMeter, useNowTick } from './mercury-ui/components.js'
import { AttentionPulse, WorkingGlyph } from './mercury-ui/LiveGlyphs.js'
import { GLYPH, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { STATE_STYLE } from './mercury-ui/theme.js'


const MAX_TASKS = 4

export const DeckPane = React.memo(function DeckPane(): React.ReactNode {
  const tok = useMercuryTokens()
  const { accent: TERRA, accentDeep: CLAW } = useSessionAccent()
  const cols = useTerminalSize().columns
  const compact = cols < 100
  const companionOn = useCompanionEnabled()
  const rawModel = useMainLoopModel()
  const model = useDisplayedSessionModel().compact
  const cost = getTotalCost()
  const unpricedTurns = getTotalUnpricedTurns()
  const costFigure = unpricedTurns > 0 ? formatSessionCost(cost, unpricedTurns) : `$${cost.toFixed(2)}`
  const added = getTotalLinesAdded()
  const removed = getTotalLinesRemoved()

  const vitals = useTelemetry()
  const git = vitals.git
  const tasks: Task[] | null = vitals.version === 0 ? null : vitals.tasks
  const fleet = {
    state: vitals.fleet.state as SnapshotState,
    team: vitals.fleet.team ?? null,
    conflicts: vitals.fleet.conflicts,
    drifting: vitals.fleet.drifting,
  }
  const trace =
    vitals.trace && vitals.trace.state === 'live'
      ? {
          state: 'live' as SnapshotState,
          total: vitals.trace.data.total,
          highRisk: vitals.trace.data.highRisk,
          killed: vitals.trace.data.killed,
        }
      : { state: (vitals.trace?.state ?? 'off') as SnapshotState, total: 0, highRisk: 0, killed: 0 }
  const daemon = daemonSnapshot()
  const daemonUpSec = daemon.state === 'live' ? Number(daemon.reason?.match(/up (\d+)s/)?.[1]) : NaN
  const effortValue = useAppStateMaybeOutsideOfProvider(
    (s: { effortValue?: EffortValue } | undefined) => s?.effortValue,
  ) as EffortValue | undefined
  const effortLevel = modelSupportsEffort(rawModel)
    ? getDisplayedEffortLabel(rawModel, effortValue)
    : null
  const killCount = Object.values(listCapabilityKills()).reduce((n, arr) => n + arr.length, 0)
  useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  const sourceUsage = activeSourceUsage()
  const stripFirst = sourceUsage.windows[0]
  const stripSecond =
    sourceUsage.binding !== undefined && stripFirst !== undefined && sourceUsage.binding.window.key !== stripFirst.key
      ? sourceUsage.binding.window
      : sourceUsage.windows[1]
  const now = useNowTick(30_000)
  const resetIn = (w: { resetsAtMs: number | null }): string | undefined =>
    w.resetsAtMs != null ? formatCountdown(w.resetsAtMs - now) : undefined
  useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const ctx = getLiveContextUsage()
  const ctxUsedK =
    ctx.usedTokens != null
      ? Math.round(ctx.usedTokens / 1000)
      : ctx.usedPct != null
        ? Math.round((ctx.window * ctx.usedPct) / 100 / 1000)
        : 0
  const ctxWinLabel = contextWindowLabel(ctx.window, ctx.windowSource)
  const agent = agentStateSnapshot()
  useSyncExternalStore(subscribePresence, getPresenceVersion, getPresenceVersion)
  const seats = getLivePresence()

  const all = tasks ?? []
  const open = all.filter(t => t.status !== 'completed')
  const completed = all.filter(t => t.status === 'completed')
  const inProg = open.filter(t => t.status === 'in_progress')
  const allDone = all.length > 0 && open.length === 0
  const ordered = [
    ...inProg,
    ...completed,
    ...open.filter(t => t.status !== 'in_progress'),
  ]
  const shown = ordered.slice(0, MAX_TASKS)
  const openIds = new Set(open.map(t => t.id))
  const blockedCount = open.filter(
    t => t.blockedBy.length > 0 && t.blockedBy.some(id => openIds.has(id)),
  ).length
  const ledger = new Map<string, { done: number; total: number }>()
  for (const t of all) {
    const meta = t.metadata as { ledger?: unknown; missionId?: unknown } | undefined
    const lk =
      (typeof meta?.ledger === 'string' && meta.ledger.trim()) ||
      (typeof meta?.missionId === 'string' && meta.missionId.trim()) ||
      'session'
    const g = ledger.get(lk) ?? { done: 0, total: 0 }
    g.total++
    if (t.status === 'completed') g.done++
    ledger.set(lk, g)
  }
  const ledgerGroups = [...ledger.entries()]

  const opsRow = (
    <Text wrap="truncate-end">
      {agent.state === 'live' && agent.data.needsAttention ? (
        <Text color={tok.failure} bold>
          {agent.data.verdict?.state === 'failed' ? `${GLYPH.fail} agent failed` : `${GLYPH.warn} agent needs you`}
          {agent.data.verdict?.needs || agent.data.verdict?.detail
            ? ` · ${truncateToWidth(agent.data.verdict.needs || agent.data.verdict.detail, 48)}`
            : ''}
          {' · '}
        </Text>
      ) : null}
      {}
      <Text color={tok.textMuted}>daemon </Text>
      <Text color={STATE_STYLE[daemon.state].color}>{STATE_STYLE[daemon.state].glyph}</Text>
      {Number.isFinite(daemonUpSec) && daemonUpSec > 0 ? (
        <Text color={tok.textSecondary}>{` up ${daemonUpSec < 60 ? `${daemonUpSec}s` : formatCountdown(daemonUpSec * 1000)}`}</Text>
      ) : null}
      <Text color={tok.textMuted}> · fleet </Text>
      <Text color={STATE_STYLE[fleet.state].color}>{STATE_STYLE[fleet.state].glyph}</Text>
      <Text color={tok.textSecondary}>{fleet.team ? ` ${fleet.team}` : ''}</Text>
      {fleet.conflicts > 0 ? <Text color={tok.failure}>{` ${GLYPH.conflict}${fleet.conflicts}`}</Text> : null}
      {fleet.drifting > 0 ? <Text color={tok.warning}>{` ${GLYPH.drifting}${fleet.drifting}`}</Text> : null}
      <Text color={tok.textMuted}> · trace </Text>
      {trace.state === 'live' ? (
        <Text color={tok.textPrimary}>{trace.total}</Text>
      ) : trace.state === 'unavailable' ? (
        <Text color={tok.textMuted}>0</Text>
      ) : (
        <Text color={STATE_STYLE[trace.state].color}>{STATE_STYLE[trace.state].glyph}</Text>
      )}
      {
}
      {trace.state === 'live' ? <Text color={tok.textMuted}>{' · repo'}</Text> : null}
      {trace.killed > 0 ? <Text color={tok.failure}>{` ${GLYPH.fail}${trace.killed}`}</Text> : null}
      {}
      {killCount > 0 ? <Text color={tok.failure}>{` · ${GLYPH.fail}kill ${killCount}`}</Text> : null}
    </Text>
  )

  return (
    <Box
      flexShrink={0}
      flexDirection="column"
      borderStyle="round"
      borderColor={tok.borderStrong}
      paddingX={1}
      width="100%"
    >
      {
}
      {compact ? (
        (() => {
          const denseRow = (
            <Text wrap="truncate-end">
              {
}
              <Crab />
              <Text color={tok.textMuted}> · </Text>
              <Text color={tok.textSecondary}>{model}</Text>
              <EffortChip model={rawModel} />
              <TrimChip />
              {companionOn ? (
                <>
                  <Text color={tok.textMuted}> · </Text>
                  <DeckCompanionChip />
                </>
              ) : null}
              {git !== null ? (
                <>
                  <Text color={tok.textMuted}>{' · ' + GLYPH.branch}</Text>
                  <Text color={tok.textPrimary}>{truncateToWidth(git.branchName, 14)}</Text>
                  {git.isClean ? null : <Text color={tok.warning}>*</Text>}
                </>
              ) : null}
              {
}
              {ctx.window > 0 && ctx.usedPct != null ? (
                <>
                  <Text color={tok.textMuted}> · ctx </Text>
                  <Text color={tok.textSecondary}>{`${ctx.fillSource === 'estimate' ? '≈' : ''}${Math.round(ctx.usedPct)}%`}</Text>
                  <Text color={tok.textMuted}>{` · ${ctxUsedK}k/${ctxWinLabel}`}</Text>
                </>
              ) : null}
            </Text>
          )
          if (!companionOn) return denseRow
          return (
            <Box flexDirection="row">
              <Box flexShrink={0} marginRight={1}>
                <MiniCritter cols={cols} bare />
              </Box>
              <Box flexDirection="column" flexGrow={1}>
                {denseRow}
                {opsRow}
                <CompanionSpeechLine />
              </Box>
            </Box>
          )
        })()
      ) : (
        <Text wrap="truncate-end">
          <Crab />
          <Text color={tok.textMuted}> · </Text>
          <Text color={tok.textSecondary}>{model}</Text>
          <EffortChip model={rawModel} />
          <TrimChip />
          <Text color={tok.textMuted}> · {hasConsoleBillingAccess() ? `${costFigure} · ` : ''}</Text>
          <Text color={tok.success}>+{added}</Text>
          <Text color={tok.textMuted}>/</Text>
          <Text color={tok.warning}>-{removed}</Text>
        </Text>
      )}

      {
}
      {!compact && companionOn ? <DeckCompanion /> : null}

      {
}
      {seats.length > 0 ? (
        <Box flexDirection="column">
          {seats.map((s, i) => (
            <Text key={s.seat} wrap="truncate-end">
              <Text color={tok.textMuted}>{i === 0 ? 'seats  ' : '       '}</Text>
              <Text color={tok.success}>{s.seat}</Text>
              {s.verb ? (
                <>
                  <Text color={tok.textMuted}> · </Text>
                  <Text color={tok.textPrimary}>{s.verb}</Text>
                </>
              ) : null}
              {s.branch ? (
                <>
                  <Text color={tok.textMuted}>{' · ' + GLYPH.branch}</Text>
                  <Text color={tok.textPrimary}>{truncateToWidth(s.branch, 20)}</Text>
                </>
              ) : null}
              {s.lastLine ? (
                <>
                  <Text color={tok.textMuted}> · </Text>
                  <Text color={tok.textMuted}>{truncateToWidth(s.lastLine, 40)}</Text>
                </>
              ) : null}
            </Text>
          ))}
        </Box>
      ) : null}

      {
}
      {!compact ? (
      <Text wrap="truncate-end">
        {git === null ? (
          <Text color={tok.textMuted}>git: not a repository</Text>
        ) : (
          <>
            <Text color={tok.textMuted}>{GLYPH.branch}</Text>
            <Text color={tok.textPrimary}>{truncateToWidth(git.branchName, 24)}</Text>
            <Text color={tok.textMuted}> · </Text>
            {git.isClean ? (
              <Text color={tok.success}>clean</Text>
            ) : (
              <Text color={tok.warning}>uncommitted</Text>
            )}
            {
}
            {git.unpushedCount > 0 ? (
              <Text color={tok.textSecondary}>{` · ↑${git.unpushedCount}`}</Text>
            ) : !git.isHeadOnRemote ? (
              <Text color={tok.textSecondary}> · ↑</Text>
            ) : null}
            {git.worktreeCount > 1 ? <Text color={tok.textSecondary}>{` · ⌂${git.worktreeCount}`}</Text> : null}
          </>
        )}
        {sourceUsage.windows.length > 0 ? <Text color={tok.textMuted}>{'   ·   '}</Text> : null}
        {stripFirst !== undefined ? (
          <UsageMeter compact window={stripFirst.label} state={stripFirst.state} value={stripFirst.usedPct ?? undefined} resetIn={resetIn({ resetsAtMs: stripFirst.resetsAtMs ?? null })} />
        ) : null}
        {stripSecond !== undefined && cols >= LAYOUT_BREAKPOINTS.cockpitMin ? (
          <>
            <Text color={tok.textMuted}> {GLYPH.dot} </Text>
            <UsageMeter compact window={stripSecond.label} state={stripSecond.state} value={stripSecond.usedPct ?? undefined} resetIn={resetIn({ resetsAtMs: stripSecond.resetsAtMs ?? null })} />
          </>
        ) : null}
        {((): React.ReactNode => {
          if (sourceUsage.limited === undefined) return null
          return (
            <Text>
              <Text color={tok.textMuted}> {GLYPH.dot} </Text>
              <Text color={tok.warning}>{`limit · resets ${formatCountdown(sourceUsage.limited.resetsAtMs - now)}`}</Text>
            </Text>
          )
        })()}
      </Text>
      ) : null}

      {
}
      {!compact ? (
      <Text wrap="truncate-end">
        <Text color={tok.textMuted}>{`tasks (${completed.length}/${all.length}) `}</Text>
        {tasks === null ? (
          <Text color={tok.textMuted}>…</Text>
        ) : all.length === 0 ? (
          <Text color={tok.textMuted}>none</Text>
        ) : allDone ? (
          <Text color={tok.success}>{`${GLYPH.done} ${all.length}/${all.length} complete`}</Text>
        ) : (
          shown.map((t, i) => {
            const isActive = t.status === 'in_progress'
            const isDone = t.status === 'completed'
            const label = truncateToWidth(
              isActive ? t.activeForm || t.subject : t.subject,
              32,
            )
            const glyph = isDone ? GLYPH.done : '○'
            const glyphCol = isActive ? TERRA : isDone ? tok.success : tok.textMuted
            const labelCol = isActive ? tok.textPrimary : isDone ? tok.textMuted : tok.textSecondary
            return (
              <Text key={i}>
                {i > 0 ? <Text color={tok.textMuted}> · </Text> : null}
                {isActive ? (
                  <WorkingGlyph color={glyphCol} />
                ) : (
                  <Text color={glyphCol}>{glyph}</Text>
                )}
                <Text bold={isActive} color={glyphCol}>
                  {' '}
                </Text>
                <Text bold={isActive} color={labelCol}>
                  {label}
                </Text>
              </Text>
            )
          })
        )}
        {!allDone && ordered.length > shown.length ? (
          <Text color={tok.textMuted}>{` +${ordered.length - shown.length}`}</Text>
        ) : null}
        {blockedCount > 0 ? (
          <Text color={tok.warning}>{` · ${GLYPH.conflict}${blockedCount} blocked`}</Text>
        ) : null}
      </Text>
      ) : null}

      {
}
      {!compact && ledgerGroups.length > 1 ? (
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>ledger  </Text>
          {ledgerGroups.map(([label, g], i) => {
            const groupDone = g.done === g.total
            return (
              <Text key={label}>
                {i > 0 ? <Text color={tok.textMuted}> · </Text> : null}
                <Text bold={!groupDone} color={groupDone ? tok.success : TERRA}>
                  {groupDone ? GLYPH.done : GLYPH.inProgress}{' '}
                </Text>
                <Text color={groupDone ? tok.textMuted : tok.textPrimary}>{truncateToWidth(label, 18)}</Text>
                <Text color={tok.textMuted}>{` ${g.done}/${g.total}`}</Text>
              </Text>
            )
          })}
        </Text>
      ) : null}

      {
}
      {!compact && ctx.window > 0 ? (
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>{'ctx '}</Text>
          {ctx.usedPct != null ? (
            <Text>
              <ProgressBar value={ctx.usedPct} max={100} width={5} showPct />
              <Text color={tok.textMuted}>{` · ${ctx.fillSource === 'estimate' ? '≈' : ''}${ctxUsedK}k/${ctxWinLabel}`}</Text>
            </Text>
          ) : (
            <Text>
              <ProgressBar value={0} max={100} width={5} tone={tok.textMuted} />
              <Text color={tok.textMuted}>{` · ${ctxWinLabel} window`}</Text>
            </Text>
          )}
          {}
        </Text>
      ) : null}

      {
}
      {compact && companionOn ? null : opsRow}

    </Box>
  )
})
