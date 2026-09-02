import * as React from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import { useDisplayedSessionModel } from '../../../hooks/useDisplayedSessionModel.js'
import {
  getTotalCost,
  getTotalLinesAdded,
  getTotalLinesRemoved,
} from '../../../cost-tracker.js'
import { pokeTelemetry, useTelemetry } from '../../../state/telemetryBus.js'
import type { Task } from '../../../utils/tasks.js'
import type { AgentHealth } from '../../../utils/swarm/roomHealth.js'
import { DEFAULT_LEASE_TTL_MS, type Lease } from '../../../utils/swarm/leaseGlob.js'
import type { MercuryThemeTokens } from '../../../utils/mercuryTokens.js'
import { useMercuryTokens } from '../useMercuryTokens.js'
import {
  FreshnessLine,
  KeyValueGrid,
  ProgressBar,
  useNowTick,
  WarningBanner,
  type KVRow,
} from '../components.js'
import { GLYPH, HEALTH_GLYPH, STATUS_GLYPH } from '../glyphs.js'
import { STATE_STYLE } from '../theme.js'
import { useOpenEventGate } from '../useOpenEventGate.js'
import {
  NavigablePanes,
  type ColumnDef,
  type SectionDef,
} from '../NavigablePanes.js'

// ============================================================================
//  MonitorView — the HONEST fleet command-center on the NavigablePanes
//  framework (the /monitor surface). Reads ONLY data that exists live:
//
//    MISSIONS  tasks grouped by metadata.missionId (listTasks) — id · owner ·
//              state-glyph · done/total + ProgressBar · waits-on
//    AGENTS    computeAgentHealth — state-glyph · name · <type> · state ·
//              #tasks · lease-age
//    LEASES    listLeases snapshots — agentId · globs · age · expires
//
//  Any column whose live datum does NOT exist (model / tokens / cost / duration
//  per row) renders STATE_STYLE.unavailable '—' (FAINT) — NEVER a fabricated
//  number. Session-global model · $cost · diff are honest only in the HEADER
//  line, never a per-row cell. snapshot === null -> 'loading…'; not-in-a-team ->
//  an honest EmptyState (a swarm surface with no swarm is dormant, not broken).
//  No faked rows anywhere.
//
//  This is a NEW surface; it does not touch FleetMonitor (the /fleet view).
// ============================================================================

const BAR_WIDTH = 12

// A discriminated row so one ColumnDef set can render all three sections.
type Mission = { id: string; tasks: Task[]; done: number; total: number; owner: string; waits: string[] }
type MonRow =
  | { kind: 'mission'; mission: Mission }
  | { kind: 'agent'; agent: AgentHealth }
  | { kind: 'lease'; lease: Lease }

// --- honest helpers ---------------------------------------------------------

// STATE_STYLE.unavailable '—' — the honest "no live datum" cell (never a 0/fake).
function Unavailable(): React.ReactNode {
  return <Text color={STATE_STYLE.unavailable.color}>{STATE_STYLE.unavailable.glyph}</Text>
}

// ms → a compact human age ('3s' / '4m' / '2h' / '1d'). Negative/NaN → '—'.
function ageFromMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function leaseAgeMs(l: Lease, now: number): number | null {
  const t = Date.parse(l.ts)
  return Number.isFinite(t) ? now - t : null
}

// Expiry: ts + ttlMs (default 30min). Omitted ttl → 'never' (legacy indefinite).
function leaseExpires(l: Lease, now: number): string {
  if (typeof l.ttlMs !== 'number' || l.ttlMs <= 0) return 'never'
  const t = Date.parse(l.ts)
  if (!Number.isFinite(t)) return '—'
  const left = t + l.ttlMs - now
  if (left <= 0) return 'expired'
  return `in ${ageFromMs(left)}`
}

// --- mission grouping (honest, mirrors the /fleet derivation) ----------------

function groupMissions(tasks: Task[]): Mission[] {
  const byMission = new Map<string, Task[]>()
  for (const t of tasks) {
    const missionId = typeof t.metadata?.missionId === 'string' ? t.metadata.missionId : undefined
    if (!missionId) continue
    const arr = byMission.get(missionId) ?? []
    arr.push(t)
    byMission.set(missionId, arr)
  }
  const missions: Mission[] = [...byMission.entries()].map(([id, ts]) => {
    const inGroup = new Set(ts.map(t => t.id))
    const owners = new Set(ts.map(t => t.owner).filter((o): o is string => !!o))
    const open = ts.filter(t => t.status !== 'completed')
    // "waits on" = open subtasks blocked by another in-group subtask.
    const waits = new Set<string>()
    for (const t of open) {
      for (const dep of t.blockedBy) {
        if (inGroup.has(dep)) waits.add(dep)
      }
    }
    return {
      id,
      tasks: dependencyOrder(ts),
      done: ts.filter(t => t.status === 'completed').length,
      total: ts.length,
      owner: owners.size === 0 ? 'unassigned' : owners.size === 1 ? [...owners][0]! : `${owners.size} owners`,
      waits: [...waits],
    }
  })
  missions.sort((a, b) => {
    const aDone = a.done >= a.total ? 1 : 0
    const bDone = b.done >= b.total ? 1 : 0
    if (aDone !== bDone) return aDone - bDone
    return a.id.localeCompare(b.id)
  })
  return missions
}

function dependencyOrder(tasks: Task[]): Task[] {
  const inGroup = new Set(tasks.map(t => t.id))
  const ordered: Task[] = []
  const placed = new Set<string>()
  const remaining = [...tasks].sort(
    (a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id),
  )
  let progress = true
  while (remaining.length > 0 && progress) {
    progress = false
    for (let i = 0; i < remaining.length; i++) {
      const t = remaining[i]!
      const deps = t.blockedBy.filter(id => inGroup.has(id))
      if (deps.every(id => placed.has(id))) {
        ordered.push(t)
        placed.add(t.id)
        remaining.splice(i, 1)
        progress = true
        break
      }
    }
  }
  for (const t of remaining) ordered.push(t)
  return ordered
}

function missionTone(done: number, total: number, k: MercuryThemeTokens): string {
  const frac = total > 0 ? done / total : 0
  return frac >= 1 ? k.textSecondary : frac > 0 ? k.success : k.warning
}

// --- columns (one set; cells switch on row.kind) -----------------------------
//  NAME col is elastic (no width → flexGrow). Tail cells carry honest per-kind
//  data OR '—' when a kind has no value there.

function buildColumns(now: number, k: MercuryThemeTokens): ColumnDef<MonRow>[] {
  // The mission-row identity glyph follows the LIVE session critter — the
  // tokens arrive from the component (useMercuryTokens subscribes), so the
  // marker re-tints under /critter and every ink role adapts.
  const missionColor = k.accent
  return [
    {
      key: 'glyph',
      header: '',
      width: 2,
      cell: r => {
        if (r.kind === 'mission')
          return <Text color={missionColor}>{GLYPH.mission}</Text>
        if (r.kind === 'agent') {
          const g = HEALTH_GLYPH[r.agent.state] ?? HEALTH_GLYPH.idle!
          return <Text color={g.color}>{g.glyph}</Text>
        }
        return <Text color={k.success}>{GLYPH.leaseHeld}</Text>
      },
    },
    {
      key: 'name',
      header: 'name', // elastic
      cell: r => {
        if (r.kind === 'mission')
          return (
            <Text color={k.textPrimary} wrap="truncate-end">
              {r.mission.id.replace(/^mission-/, '').slice(0, 28)}
            </Text>
          )
        if (r.kind === 'agent')
          return (
            <Text wrap="truncate-end">
              <Text color={k.textPrimary}>{r.agent.name}</Text>
              {r.agent.agentType ? <Text color={k.textMuted}> {`<${r.agent.agentType}>`}</Text> : null}
            </Text>
          )
        return (
          <Text wrap="truncate-end">
            <Text color={k.textPrimary}>{r.lease.agentId}</Text>
            <Text color={k.textMuted}> {r.lease.globs.join(', ') || '(none)'}</Text>
          </Text>
        )
      },
    },
    {
      key: 'owner',
      header: 'owner/state',
      width: 16,
      cell: r => {
        if (r.kind === 'mission')
          return (
            <Text color={k.textSecondary} wrap="truncate-end">
              {r.mission.owner}
            </Text>
          )
        if (r.kind === 'agent') {
          const c =
            r.agent.state === 'busy' ? k.success : r.agent.state === 'drifting' ? k.warning : k.textMuted
          return (
            <Text color={c} wrap="truncate-end">
              {r.agent.state}
            </Text>
          )
        }
        return <Unavailable />
      },
    },
    {
      key: 'progress',
      header: 'progress/#',
      width: 18,
      cell: r => {
        if (r.kind === 'mission')
          return (
            <Text>
              <Text color={r.mission.done >= r.mission.total ? k.textSecondary : k.success}>
                {r.mission.done}/{r.mission.total}{' '}
              </Text>
              <ProgressBar
                value={r.mission.done}
                max={r.mission.total}
                width={BAR_WIDTH}
                tone={missionTone(r.mission.done, r.mission.total, k)}
              />
            </Text>
          )
        if (r.kind === 'agent')
          return r.agent.currentTasks.length > 0 ? (
            <Text color={k.textSecondary} wrap="truncate-end">
              {r.agent.currentTasks.map(id => `#${id}`).join(', ')}
            </Text>
          ) : (
            <Unavailable />
          )
        return <Unavailable />
      },
    },
    {
      key: 'tail',
      header: 'waits/lease/expires',
      width: 20,
      cell: r => {
        if (r.kind === 'mission')
          return r.mission.waits.length > 0 ? (
            <Text color={k.warning} wrap="truncate-end">
              {r.mission.waits.map(id => `#${id}`).join(', ')}
            </Text>
          ) : (
            <Unavailable />
          )
        if (r.kind === 'agent') {
          const age = ageFromMs(r.agent.leaseAgeMs)
          return age ? <Text color={k.textMuted}>{age}</Text> : <Unavailable />
        }
        return (
          <Text color={k.textMuted} wrap="truncate-end">
            {leaseExpires(r.lease, now)}
          </Text>
        )
      },
    },
  ]
}

// --- per-kind detail (KeyValueGrid / subtask list of the row's REAL fields) ---

function renderDetail(r: MonRow, now: number, k: MercuryThemeTokens): React.ReactNode {
  if (r.kind === 'mission') {
    const m = r.mission
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={m.done >= m.total ? k.textSecondary : k.success}>
            {m.done}/{m.total}{' '}
          </Text>
          <ProgressBar value={m.done} max={m.total} width={BAR_WIDTH} tone={missionTone(m.done, m.total, k)} showPct />
        </Text>
        <Box marginTop={1} flexDirection="column">
          {m.tasks.map(t => {
            const s = STATUS_GLYPH[t.status]
            const waits = t.blockedBy.filter(id => m.tasks.some(x => x.id === id))
            return (
              <Text key={t.id} wrap="truncate-end">
                <Text color={s.color}>{s.glyph} </Text>
                <Text color={k.textSecondary}>{t.owner ?? 'unassigned'}</Text>
                <Text color={k.textMuted}> · </Text>
                <Text color={t.status === 'completed' ? k.textMuted : k.textPrimary}>{t.subject}</Text>
                {waits.length > 0 ? (
                  <Text color={k.warning}> waits {waits.map(id => `#${id}`).join(', ')}</Text>
                ) : null}
              </Text>
            )
          })}
        </Box>
      </Box>
    )
  }
  if (r.kind === 'agent') {
    const a = r.agent
    const age = ageFromMs(a.leaseAgeMs)
    const rows: KVRow[] = [
      { k: 'state', v: a.state, tone: a.state === 'busy' ? k.success : a.state === 'drifting' ? k.warning : k.textMuted },
      { k: 'type', v: a.agentType ?? '—', tone: a.agentType ? k.textPrimary : k.textMuted },
      { k: 'owns', v: a.currentTasks.length > 0 ? a.currentTasks.map(id => `#${id}`).join(', ') : '—', tone: a.currentTasks.length > 0 ? k.textSecondary : k.textMuted },
      { k: 'lease age', v: age ?? '—', tone: age ? k.textPrimary : k.textMuted },
      { k: 'why', v: a.why, tone: k.textMuted },
    ]
    return <KeyValueGrid rows={rows} keyWidth={11} />
  }
  // lease
  const l = r.lease
  const age = ageFromMs(leaseAgeMs(l, now))
  const rows: KVRow[] = [
    { k: 'agent', v: l.agentId, tone: k.textPrimary },
    { k: 'age', v: age ?? '—', tone: age ? k.textPrimary : k.textMuted },
    { k: 'ttl', v: typeof l.ttlMs === 'number' ? `${Math.round((l.ttlMs ?? DEFAULT_LEASE_TTL_MS) / 60000)}m` : 'none', tone: k.textMuted },
    { k: 'expires', v: leaseExpires(l, now), tone: k.textMuted },
  ]
  return (
    <Box flexDirection="column">
      <KeyValueGrid rows={rows} keyWidth={11} />
      <Box marginTop={1} flexDirection="column">
        <Text color={k.textMuted}>globs</Text>
        {l.globs.length > 0 ? (
          l.globs.map((g, i) => (
            <Text key={i} color={k.textSecondary} wrap="truncate-end">
              {' '}
              {g}
            </Text>
          ))
        ) : (
          <Text color={k.textMuted}> (none)</Text>
        )}
      </Box>
    </Box>
  )
}

// --- header line (session-global honest facts; HEADER only, never a row cell) -

function HeaderLine(): React.ReactNode {
  const k = useMercuryTokens()
  // The ONE display resolver (a queued switch projects into the chip).
  const model = useDisplayedSessionModel().compact
  const cost = getTotalCost()
  const added = getTotalLinesAdded()
  const removed = getTotalLinesRemoved()
  return (
    <Text>
      <Text color={k.textMuted}>model </Text>
      <Text color={k.textPrimary}>{model}</Text>
      <Text color={k.textMuted}> · ${cost.toFixed(2)}</Text>
      <Text color={k.textMuted}> · diff </Text>
      <Text color={k.success}>+{added}</Text>
      <Text color={k.textMuted}>/</Text>
      <Text color={k.failure}>-{removed}</Text>
    </Text>
  )
}

//

export function MonitorView({ onClose }: { onClose: () => void }): React.ReactNode {
  const k = useMercuryTokens()
  // Live fleet via the shared telemetry bus (trust-cockpit W2a): the old
  // one-shot fleetGauge() mount effect froze the board at open, and the
  // render-time Date.now() capture froze the age/expiry columns with it.
  // fleetFull carries the FULL snapshot (roster/leases/conflicts); null only
  // while the FIRST bus refresh is in flight — the loading state below.
  // useNowTick keeps ages/expiries ticking between refreshes.
  const { fleetFull: snap, refreshedAt } = useTelemetry()
  const now = useNowTick()

  // Board-level `r` → force a bus refresh. A buffered SIBLING useInput (the
  // DaemonSupervisorView idiom): NavigablePanes owns the nav keys only; this
  // owns exactly one action key, mount-buffered so the keystroke that
  // launched /monitor can't fire it.
  const pastOpenEvent = useOpenEventGate()
  useInput(input => {
    if (input === 'r' && pastOpenEvent()) pokeTelemetry()
  })

  // loading — honest, before the first bus refresh resolves.
  if (snap === null) {
    return (
      <NavigablePanes<MonRow>
        view="monitor"
        headerLine={<HeaderLine />}
        sections={[]}
        columns={[]}
        rowKey={() => ''}
        renderDetail={() => null}
        onClose={onClose}
        footerHints="r refresh"
        loading
      />
    )
  }

  // not in a team — honest dormant card, NOT a crash, NO faked rows.
  if (snap.state !== 'live') {
    return (
      <NavigablePanes<MonRow>
        view="monitor"
        headerLine={<HeaderLine />}
        sections={[]}
        columns={[]}
        rowKey={() => ''}
        renderDetail={() => null}
        onClose={onClose}
        footerHints="r refresh"
        emptyState={{
          title: snap.reason ?? 'not in a team',
          hint: '/monitor is a swarm command-center. Start or join a team first.',
        }}
      />
    )
  }

  const { teamName, tasks, health, leases, conflicts } = snap.data
  const missions = groupMissions(tasks)

  const sections: SectionDef<MonRow>[] = [
    {
      id: 'missions',
      label: 'Missions',
      count: missions.length,
      rows: missions.map(m => ({ kind: 'mission', mission: m } as const)),
      emptyHint: 'no missions — no tasks grouped under a missionId',
    },
    {
      id: 'agents',
      label: 'Agents',
      count: health.length,
      rows: health.map(a => ({ kind: 'agent', agent: a } as const)),
      emptyHint: 'no roster — no agents reporting',
    },
    {
      id: 'leases',
      label: 'Leases',
      count: leases.length,
      rows: leases.map(l => ({ kind: 'lease', lease: l } as const)),
      emptyHint: 'none held — all paths open',
    },
  ]

  const columns = buildColumns(now, k)

  // Standing glance card: the
  // un-drilled companion for the selected row — identity, state, and the one
  // next-action-relevant fact per kind. The drilled detail keeps the full
  // task list / glob list; nothing here is fabricated (missing ⇒ omitted).
  const sideInfo = (r: MonRow): React.ReactNode => {
    if (r.kind === 'mission') {
      const m = r.mission
      const nextTask = m.tasks.find(t => t.status !== 'completed')
      return (
        <Box flexDirection="column">
          <Text bold color={k.accent} wrap="truncate-end">
            {m.id.replace(/^mission-/, '')}
          </Text>
          <Text color={k.textMuted}>mission · {m.owner}</Text>
          <Box marginTop={1}>
            <Text>
              <Text color={m.done >= m.total ? k.textSecondary : k.success}>
                {m.done}/{m.total}{' '}
              </Text>
              <ProgressBar value={m.done} max={m.total} width={BAR_WIDTH} tone={missionTone(m.done, m.total, k)} />
            </Text>
          </Box>
          {m.waits.length > 0 ? (
            <Text color={k.warning} wrap="truncate-end">
              waits {m.waits.map(id => `#${id}`).join(', ')}
            </Text>
          ) : null}
          {nextTask ? (
            <Box marginTop={1}>
              <Text color={k.textPrimary} wrap="truncate-end">
                next: {nextTask.subject}
              </Text>
            </Box>
          ) : null}
        </Box>
      )
    }
    if (r.kind === 'agent') {
      const a = r.agent
      const age = ageFromMs(a.leaseAgeMs)
      return (
        <Box flexDirection="column">
          <Text bold color={k.accent} wrap="truncate-end">
            {a.name}
          </Text>
          <Text color={k.textMuted}>agent{a.agentType ? ` · ${a.agentType}` : ''}</Text>
          <Box marginTop={1}>
            <KeyValueGrid
              keyWidth={9}
              rows={[
                {
                  k: 'state',
                  v: a.state,
                  tone: a.state === 'busy' ? k.success : a.state === 'drifting' ? k.warning : k.textMuted,
                },
                {
                  k: 'owns',
                  v: a.currentTasks.length > 0 ? a.currentTasks.map(id => `#${id}`).join(', ') : '—',
                  tone: a.currentTasks.length > 0 ? k.textSecondary : k.textMuted,
                },
                ...(age ? [{ k: 'lease age', v: age, tone: k.textPrimary } satisfies KVRow] : []),
              ]}
            />
          </Box>
          <Box marginTop={1}>
            <Text color={k.textMuted} wrap="wrap">
              {a.why}
            </Text>
          </Box>
        </Box>
      )
    }
    const l = r.lease
    const age = ageFromMs(leaseAgeMs(l, now))
    return (
      <Box flexDirection="column">
        <Text bold color={k.accent} wrap="truncate-end">
          {l.agentId}
        </Text>
        <Text color={k.textMuted}>lease · {l.globs.length || 'no'} glob{l.globs.length === 1 ? '' : 's'}</Text>
        <Box marginTop={1}>
          <KeyValueGrid
            keyWidth={9}
            rows={[
              ...(age ? [{ k: 'age', v: age, tone: k.textPrimary } satisfies KVRow] : []),
              { k: 'expires', v: leaseExpires(l, now), tone: k.textMuted },
              ...(l.globs[0]
                ? [{ k: 'first', v: l.globs[0], tone: k.textSecondary } satisfies KVRow]
                : []),
            ]}
          />
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <NavigablePanes<MonRow>
        view="monitor"
        subtitle={teamName ?? undefined}
        headerLine={
          <Box flexDirection="column">
            <Box>
              <HeaderLine />
              <Text color={k.textMuted}> · </Text>
              <FreshnessLine at={refreshedAt} now={now} />
            </Box>
            {conflicts.length > 0 ? (
              <Box marginTop={1}>
                <WarningBanner
                  tone="danger"
                  title={`Tree conflicts (${conflicts.length})`}
                  detail={conflicts
                    .map(c => `${c.agents.join(` ${GLYPH.conflict} `)} · ${c.detail}`)
                    .join('  ·  ')}
                />
              </Box>
            ) : null}
          </Box>
        }
        sections={sections}
        columns={columns}
        rowKey={r =>
          r.kind === 'mission'
            ? `m:${r.mission.id}`
            : r.kind === 'agent'
              ? `a:${r.agent.name}`
              : `l:${r.lease.agentId}:${r.lease.globs.join(',')}`
        }
        renderDetail={r => renderDetail(r, now, k)}
        sideInfo={sideInfo}
        detailTitle={r =>
          r.kind === 'mission'
            ? `mission — ${r.mission.id}`
            : r.kind === 'agent'
              ? `agent — ${r.agent.name}`
              : `lease — ${r.lease.agentId}`
        }
        onClose={onClose}
        footerHints="r refresh"
      />
    </Box>
  )
}
