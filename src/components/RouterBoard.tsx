import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../ink.js'
import { routerRunStore, type RouterRunState } from '../substrate/routerRunStore.js'
import { buildRouterModelSnapshot } from '../utils/router/modelRegistry.js'
import { readRouterPostureFile, resolveRouterPosture } from '../utils/router/postures.js'
import { ACTIVE_NODE_STATES, explainWidth } from '../utils/router/scheduler.js'
import { FANOUT_MAX_WIDTH } from '../utils/router/routeCompiler.js'
import type { RouteNode, TaskRoutePlan } from '../utils/router/contracts.js'
import { FreshnessLine, KeyValueGrid, useNowTick, type KVRow } from './mercury-ui/components.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  NavigablePanes,
  type ColumnDef,
  type SectionDef,
} from './mercury-ui/NavigablePanes.js'

// ============================================================================
//  RouterBoard — the /router operator surface.
// ----------------------------------------------------------------------------
//  One NavigablePanes board over the durable route store: ACTIVE plans
//  (running/synthesizing) + RECENT settled ones; the sideInfo card is the
//  "why this route?" glance — profile chip, model path, decisive reason codes,
//  adjustments, per-node states, useful-width explanation; drill-in is the
//  full decision record + event tail. The header carries the live posture +
//  pin + provider availability (future providers render their honest
//  unavailable codes — never "configured", never "coming soon").
//  Read-only projection (the View law): every fact on screen is a store row.
// ============================================================================

type PlanRow = { plan: TaskRoutePlan }

const PROFILE_CHIP: Record<string, string> = {
  'sonnet-direct': 'SONNET DIRECT',
  'sonnet-opus-review': 'OPUS REVIEW',
  'opus-direct': 'OPUS DIRECT',
  'parallel-sonnet': 'PARALLEL',
  'dependency-graph': 'DEP GRAPH',
}

function modelPath(plan: TaskRoutePlan): string {
  const exec = [...new Set(plan.decision.selectedModels.map(m => m.modelClass.toUpperCase()))].join('+')
  const review = plan.synthesis.required ? ` → ${plan.synthesis.owner.toUpperCase()} ACCEPT` : ' → ACCEPT'
  return `${plan.mode.toUpperCase()} PLAN → ${exec || '—'} EXECUTE${review}`
}

function nodeGlyphs(nodes: readonly RouteNode[]): { text: string; activeCount: number } {
  const order: Record<string, string> = {
    accepted: '●',
    reported: '◉',
    working: '◐',
    delivered: '◐',
    dispatched: '◌',
    held: '◌',
    ready: '○',
    blocked: '·',
    failed: '✕',
    cancelled: '–',
    superseded: '–',
  }
  return {
    text: nodes.map(n => order[n.state] ?? '?').join(''),
    activeCount: nodes.filter(n => ACTIVE_NODE_STATES.has(n.state)).length,
  }
}

const age = (ms: number, now: number): string => {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

export function RouterBoard({ onClose }: { onClose: () => void }): React.ReactNode {
  const tokens = useMercuryTokens()
  const [state, setState] = useState<RouterRunState | null>(null)
  const now = useNowTick()
  useEffect(() => {
    const store = routerRunStore()
    let alive = true
    void store.read().then(s => {
      if (alive) setState(s)
    })
    const unsub = store.subscribe(s => {
      if (alive) setState(s)
    })
    return () => {
      alive = false
      unsub()
    }
  }, [])

  const posture = resolveRouterPosture()
  const pin = readRouterPostureFile().pin
  const snapshot = buildRouterModelSnapshot()
  const plans = state?.plans ?? []
  const active = plans.filter(p => p.state === 'running' || p.state === 'synthesizing' || p.state === 'revising')
  const settled = plans.filter(p => !active.includes(p)).slice(-10)

  const stateTone = (s: string): string =>
    s === 'accepted'
      ? tokens.success
      : s === 'failed' || s === 'cancelled'
        ? tokens.failure
        : s === 'synthesizing'
          ? tokens.warning
          : tokens.textPrimary

  const sections: SectionDef<PlanRow>[] = [
    {
      id: 'active',
      label: 'active routes',
      rows: active.map(plan => ({ plan })).reverse(),
      emptyHint: 'no route in flight — a planner dispatch mints one',
    },
    {
      id: 'recent',
      label: 'recent',
      rows: settled.map(plan => ({ plan })).reverse(),
      emptyHint: 'no settled routes yet',
    },
  ]

  const columns: ColumnDef<PlanRow>[] = [
    {
      key: 'profile',
      header: 'profile',
      width: 14,
      cell: r => <Text color={tokens.accent}>{PROFILE_CHIP[r.plan.profile] ?? r.plan.profile}</Text>,
    },
    {
      key: 'title',
      header: 'mission',
      cell: r => <Text color={tokens.textPrimary} wrap="truncate-end">{r.plan.title}</Text>,
    },
    {
      key: 'nodes',
      header: 'nodes',
      width: 8,
      cell: r => <Text color={tokens.textSecondary}>{nodeGlyphs(r.plan.nodes).text}</Text>,
    },
    {
      key: 'state',
      header: 'state',
      width: 13,
      cell: r => <Text color={stateTone(r.plan.state)}>{r.plan.state}</Text>,
    },
    {
      key: 'age',
      header: 'age',
      width: 5,
      align: 'right',
      cell: r => <Text color={tokens.textMuted}>{age(r.plan.updatedAt, now)}</Text>,
    },
  ]

  const sideInfo = (r: PlanRow): React.ReactNode => {
    const p = r.plan
    const d = p.decision
    const maxWidth = p.mode === 'fanout' ? FANOUT_MAX_WIDTH : 1
    const kv: KVRow[] = [
      { k: 'path', v: modelPath(p), tone: tokens.textPrimary },
      { k: 'why', v: d.decisiveReasons.join(' · ') || '—', tone: tokens.textSecondary },
      ...(d.adjustments.length > 0
        ? [{ k: 'adjusted', v: d.adjustments.join(' · '), tone: tokens.warning } satisfies KVRow]
        : []),
      { k: 'width', v: explainWidth(p, maxWidth, d.adjustments.includes('width-capped-shared-lane')), tone: tokens.textSecondary },
      ...(d.source !== 'structured-intent'
        ? [{ k: 'source', v: d.source, tone: tokens.warning } satisfies KVRow]
        : []),
    ]
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color={tokens.accent} wrap="truncate-end">
            {PROFILE_CHIP[p.profile] ?? p.profile}
          </Text>
          <Text color={tokens.textMuted}> · {p.mode} · rev {p.revision}</Text>
        </Box>
        <KeyValueGrid rows={kv} keyWidth={9} />
      </Box>
    )
  }

  const renderDetail = (r: PlanRow): React.ReactNode => {
    const p = r.plan
    const d = p.decision
    const rows: KVRow[] = [
      { k: 'objective', v: p.objective, tone: tokens.textPrimary },
      { k: 'decision', v: `${d.policyVersion} · ${d.source} · posture ${d.posture}`, tone: tokens.textMuted },
      { k: 'reasons', v: d.displayReasons.join(' · ') || '—', tone: tokens.textPrimary },
      ...(d.adjustments.length > 0 ? [{ k: 'adjusted', v: d.adjustments.join(' · '), tone: tokens.warning } satisfies KVRow] : []),
      ...(d.workerAffinity
        ? [{ k: 'affinity', v: d.workerAffinity.keptCurrentModel ? `kept current (${d.workerAffinity.reason})` : d.workerAffinity.reason, tone: tokens.textSecondary } satisfies KVRow]
        : []),
      ...(d.priorContribution
        ? [{ k: 'history', v: `${d.priorContribution.sampleCount} samples · first-pass ${Math.round(d.priorContribution.acceptedFirstPassRate * 100)}% · weight ≤${d.priorContribution.weight}`, tone: tokens.textMuted } satisfies KVRow]
        : []),
    ]
    for (const n of p.nodes) {
      rows.push({
        k: n.id,
        v: `${n.state}${n.attempt > 1 ? ` (attempt ${n.attempt})` : ''} · ${n.assignedWorker ?? '—'} · ${n.assignedModel ? `${n.assignedModel.model}@${n.assignedModel.effort}` : '—'} · ${n.title}`,
        tone: stateTone(n.state),
      })
      if (n.completion) {
        rows.push({ k: '', v: `↳ ${n.completion.summary}${n.completion.unresolved.length ? ` · unresolved: ${n.completion.unresolved.join('; ')}` : ''}`, tone: tokens.textMuted })
      }
    }
    const events = (state?.events ?? []).filter(e => e.planId === p.id).slice(-6)
    for (const e of events) {
      rows.push({ k: age(e.ts, now), v: `${e.nodeId ?? 'plan'} ${e.from}→${e.to}${e.reason ? ` (${e.reason})` : ''}`, tone: e.to.startsWith('refused') ? tokens.warning : tokens.textMuted })
    }
    return <KeyValueGrid rows={rows} keyWidth={10} />
  }

  const providers = snapshot.providers
    .map(p => (p.available ? `${p.id} LIVE` : `${p.id} ${p.reason ?? 'unavailable'}`))
    .join(' · ')

  const headerLine = (
    <Box>
      <Text color={tokens.textSecondary}>posture {posture}</Text>
      {pin !== 'auto' ? <Text color={tokens.warning}> · pin {pin}</Text> : null}
      <Text color={tokens.textMuted}> · {providers} · </Text>
      <FreshnessLine at={state?.updatedAt ?? 0} now={now} source="route store" />
    </Box>
  )

  return (
    <NavigablePanes<PlanRow>
      view="router"
      subtitle={`${active.length} active`}
      headerLine={headerLine}
      sections={sections}
      columns={columns}
      rowKey={r => r.plan.id}
      sideInfo={sideInfo}
      detailTitle={r => `${PROFILE_CHIP[r.plan.profile] ?? r.plan.profile} — ${r.plan.title}`}
      renderDetail={renderDetail}
      onClose={onClose}
      loading={state === null}
      footerHints="/router adaptive|quality|balanced|fast|fixed · /router pin opus|sonnet|auto · /router explain · /router engines · /router key"
    />
  )
}
