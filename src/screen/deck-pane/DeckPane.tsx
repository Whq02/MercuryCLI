import * as React from 'react'
import { useSyncExternalStore } from 'react'
import { contextWindowLabel } from '../../engine/context-window/contextFill.js'
import { formatSessionCost } from '../../models/usage/sessionCost.js'
import { useEngineModel } from '../model-picker/useEngineModel.js'
import { useDisplayedSessionModel, useFocusedServedModel } from '../model-picker/useDisplayedSessionModel.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useProviderUsageOnShow } from '../model-picker/useProviderUsageOnShow.js'
import { Text } from '../themedRenderer.js'

import { useVitals } from '../app-state/vitalsBus.js'
import { listCapabilityKills } from '../../permissions/rules/capabilityGate.js'
import type { MissionRowV1 } from '../../engine/connector/types.js'
import {
  agentStateSnapshot,
  daemonSnapshot,
  getLiveContextUsage,
  getLiveContextUsageVersion,
  sessionTraceSnapshot,
  subscribeLiveContextUsage,
  type SnapshotState,
} from '../cockpit-gauges/index.js'
import { conversationIdHere, getFocusedSessionConnector } from '../../engine/connector/focusedConnector.js'
import { formatCountdown } from '../cockpit-gauges/quota.js'
import { isLocalModelId } from '../../models/roads/local/localCatalogue.js'
import { localWindowRuleWords } from '../../models/roads/local/localWindow.js'
import { activeSourceUsage } from '../../models/roads/providerUsage.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../../models/roads/anthropic/anthropicLimits.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { useNowTick } from '../widgets/components.js'
import { GLYPH, truncateToWidth } from '../theme/glyphs.js'
import { useSessionAccent } from '../widgets/sessionAccent.js'
import { STATE_STYLE } from '../widgets/theme.js'
import { deckPaneView } from './deckPaneView.js'


const MAX_TASKS = 4

export function deckPaintsDock(cols: number): boolean {
  return cols < 100
}

export const DeckPane = React.memo(function DeckPane(): React.ReactNode {
  const tok = useMercuryTokens()
  const { accent: TERRA } = useSessionAccent()
  const cols = useTerminalSize().columns
  const compact = deckPaintsDock(cols)
  const servedModel = useFocusedServedModel()
  const processModel = useEngineModel()
  const rawModel = servedModel ?? processModel
  const model = useDisplayedSessionModel().compact
  const usageFacts = getFocusedSessionConnector().usage()
  const cost = usageFacts.totalCostUSD
  const unpricedTurns = usageFacts.unpricedTurns ?? 0
  const costFigure = unpricedTurns > 0 ? formatSessionCost(cost, unpricedTurns) : `$${cost.toFixed(2)}`
  const added = usageFacts.totalLinesAdded
  const removed = usageFacts.totalLinesRemoved

  const vitals = useVitals()
  const git = vitals.git
  const tasks: readonly MissionRowV1[] | null = vitals.version === 0 ? null : vitals.tasks
  const fleet = {
    state: vitals.fleet.state as SnapshotState,
    crew: vitals.fleet.crew ?? null,
    conflicts: vitals.fleet.conflicts,
    drifting: vitals.fleet.drifting,
  }
  const ownTrace = vitals.trace ? sessionTraceSnapshot(vitals.trace, conversationIdHere()) : null
  const trace =
    ownTrace && ownTrace.state === 'live'
      ? {
          state: 'live' as SnapshotState,
          total: ownTrace.data.total,
          highRisk: ownTrace.data.highRisk,
          killed: ownTrace.data.killed,
        }
      : { state: (ownTrace?.state ?? 'off') as SnapshotState, total: 0, highRisk: 0, killed: 0 }
  const daemon = daemonSnapshot()
  const daemonUpSec = daemon.state === 'live' ? Number(daemon.reason?.match(/up (\d+)s/)?.[1]) : NaN
  const killCount = Object.values(listCapabilityKills()).reduce((n, arr) => n + arr.length, 0)
  useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  useProviderUsageOnShow(true)
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
  const ctxWinLabel = contextWindowLabel(ctx.window, ctx.windowSource, ctx.windowPinned, isLocalModelId(rawModel))
  const ctxRule = localWindowRuleWords(rawModel, ctx.window)
  const agent = agentStateSnapshot()

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
    t => (t.blockedBy ?? []).some(id => openIds.has(id)),
  ).length
  const ledger = new Map<string, { done: number; total: number }>()
  for (const t of all) {
    const lk = t.ledger ?? 'session'
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
      <Text color={tok.textSecondary}>{fleet.crew ? ` ${fleet.crew}` : ''}</Text>
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
      {}
      {trace.killed > 0 ? <Text color={tok.failure}>{` ${GLYPH.fail}${trace.killed}`}</Text> : null}
      {}
      {killCount > 0 ? <Text color={tok.failure}>{` · ${GLYPH.fail}kill ${killCount}`}</Text> : null}
    </Text>
  )

  return deckPaneView({ tok, TERRA, cols, compact, rawModel, model, costFigure, added, removed, git, tasks, sourceUsage, stripFirst, stripSecond, now, resetIn, ctx, ctxUsedK, ctxWinLabel, ctxRule, all, completed, allDone, ordered, shown, blockedCount, ledgerGroups, opsRow })
})
