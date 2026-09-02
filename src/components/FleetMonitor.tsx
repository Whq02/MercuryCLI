import * as React from 'react'
import { useEffect, useState } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../ink.js'
import type { Task } from '../utils/tasks.js'
import {
  fleetGauge,
  type FleetData,
  type Snapshot,
} from '../utils/cockpit/index.js'
import { AMBER, FAINT, IVORY, SECOND, TEAL } from './mercuryPalette.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import {
  AgentRow,
  CockpitEmbeddedContext,
  CommandCenter,
  EmptyState,
  KeyValueGrid,
  ProgressBar,
  SectionHeader,
  WarningBanner,
} from './mercury-ui/components.js'
import { GLYPH, STATUS_GLYPH } from './mercury-ui/glyphs.js'
import { useLayoutTier } from '../hooks/useLayoutTier.js'
import { decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useStableSelection } from './mercury-ui/useStableSelection.js'

// ============================================================================
//  FleetMonitor — the Mercury swarm raid-frame (the /fleet view). Reads
//  the coordination substrate via fleetGauge: MISSIONS (tasks grouped by
//  missionId, dependency-ordered with a roll-up bar), AGENTS (roster health),
//  LEASES + tree-conflicts. Not in a team → an honest `off` EmptyState (a swarm
//  surface with no swarm is dormant, not broken; the live co-presence owners
//  are /multiplayer · /tickets — no planned-tier cards here).
//
//  Live re-probe (mirrors DaemonSupervisorView): the snapshot is keyed on a
//  loadId, so `r` re-runs fleetGauge() into state; ↑↓ move a clamped cursor
//  over the agent roster; a 150ms enter-buffer keeps the launching keystroke
//  off row 0; CommandCenter mounts captureInput={false} so our useInput owns
//  esc/←. READ-ONLY: this view never mutates the team — `r` just re-reads.
// ============================================================================

const BAR_WIDTH = 14
const MAX_MISSIONS = 6
const MAX_SUBTASKS = 8
const MAX_LOOSE = 6
const MAX_AGENTS = 10
const MAX_LEASES = 8

type Mission = { id: string; tasks: Task[]; done: number; total: number }

function groupMissions(tasks: Task[]): { missions: Mission[]; loose: Task[] } {
  const byMission = new Map<string, Task[]>()
  const loose: Task[] = []
  for (const t of tasks) {
    const missionId = typeof t.metadata?.missionId === 'string' ? t.metadata.missionId : undefined
    if (missionId) {
      const arr = byMission.get(missionId) ?? []
      arr.push(t)
      byMission.set(missionId, arr)
    } else if (t.status !== 'completed') {
      loose.push(t)
    }
  }
  const missions: Mission[] = [...byMission.entries()].map(([id, ts]) => ({
    id,
    tasks: dependencyOrder(ts),
    done: ts.filter(t => t.status === 'completed').length,
    total: ts.length,
  }))
  missions.sort((a, b) => {
    const aDone = a.done >= a.total ? 1 : 0
    const bDone = b.done >= b.total ? 1 : 0
    if (aDone !== bDone) return aDone - bDone
    return a.id.localeCompare(b.id)
  })
  return { missions, loose }
}

function dependencyOrder(tasks: Task[]): Task[] {
  const inGroup = new Set(tasks.map(t => t.id))
  const ordered: Task[] = []
  const placed = new Set<string>()
  const remaining = [...tasks].sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id))
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

// Mission roll-up bar: complete → SECOND, in-progress → TEAL, unstarted → AMBER.
function missionTone(done: number, total: number): string {
  const frac = total > 0 ? done / total : 0
  return frac >= 1 ? SECOND : frac > 0 ? TEAL : AMBER
}

export function FleetMonitor({ onClose }: { onClose: () => void }): React.ReactNode {
  // When hosted in the cockpit tower, the tower owns esc (close) + ←/→ (tab
  // switch); FleetMonitor must NOT also consume esc/← for onClose, or pressing
  // ← on the Fleet tab closes the whole cockpit instead of switching tabs (both
  // useInputs fire and onClose wins). Standalone (/fleet), keep esc/← = close.
  const embedded = React.useContext(CockpitEmbeddedContext)
  const [snap, setSnap] = useState<Snapshot<{ data: FleetData }> | null>(null)
  const [loadId, setLoadId] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  // ↵ inline-detail toggle (trust-cockpit W4): the detail follows the ▸ cursor.
  const [expanded, setExpanded] = useState(false)
  // Live session accent (re-tints per critter) — NOT the static TERRA, so /fleet's
  // identity marks follow the active critter like the rest of the chrome.
  const accent = useSessionAccent().accent
  // Agents | Leases sit side-by-side at the card width (>=120), stacked
  // full-width below. One col higher than Deck's 110 because these rows carry a
  // longer agent name + state + glob list, so they need more room before pairing.
  const { columns } = useTerminalSize()
  const { fleetSideBySide: sideBySide } = useLayoutTier()

  // 150ms buffer so the keystroke that launches /fleet doesn't immediately fire
  // `r` — as a open-event seq gate (event identity, not wall-clock), not the old setTimeout→setState flag
  // whose parked commit swallowed the first keypress nondeterministically
  // esc/←
  // and ↑↓ respond instantly; only `r` waits.
  const pastOpenEvent = useOpenEventGate()

  // Read the snapshot; a `loadId` bump re-reads (the `r` re-probe). Never throws.
  useEffect(() => {
    let alive = true
    fleetGauge().then(s => alive && setSnap(s))
    return () => {
      alive = false
    }
  }, [loadId])

  // The agent roster is the primary navigable list; clamp the selection to it
  // (it may be empty → harmless). ↑↓ move · r re-probe · esc/← close.
  // FULL length, not min(len, MAX_AGENTS): the cursor ranges over EVERY agent
  // and the visible MAX_AGENTS window slides with it (the cap-then-clamp-to-cap
  // bug class, flare pass — rows past the cap were unreachable).
  const roster = snap?.state === 'live' ? snap.data.health : []
  const rosterLen = roster.length
  // Identity-stable cursor: an `r` re-probe reordering the
  // roster keeps the SAME agent selected, never a stale position.
  const rosterSel = useStableSelection(roster, a => a.name)
  const clampedSel = rosterSel.index
  useInput(
    (input, key) => {
      // Semantic decode (navSemantics): vertical roster; standalone /fleet
      // advertises the ←-close synonym; embedded, the tower owns esc/←.
      const action = decodeNavKey(input, key, { orientation: 'vertical', leftCloses: true })
      if (!embedded && action === 'cancel') {
        onClose()
        return
      }
      if (action === 'movePrevious') {
        rosterSel.select(clampedSel - 1)
        setNote(null)
        return
      }
      if (action === 'moveNext') {
        rosterSel.select(clampedSel + 1)
        setNote(null)
        return
      }
      if (!pastOpenEvent()) return
      if (key.return && rosterLen > 0) {
        // ↵ toggles an INLINE detail under the selected roster row (the
        // /doctor expand grammar) — a full-view detail would need its own
        // esc-back, colliding with the tower's esc-close when embedded.
        setExpanded(e => !e)
        return
      }
      if (input === 'r') {
        setNote('re-reading the coordination substrate (read-only)')
        setLoadId(n => n + 1)
        return
      }
    },
    { isActive: true },
  )

  // Not loaded yet.
  if (snap === null) {
    return (
      <CommandCenter view="fleet" onClose={onClose} captureInput={false} footer="r refresh">
        <Box marginTop={1}>
          <Text color={FAINT}>loading…</Text>
        </Box>
      </CommandCenter>
    )
  }

  // Not in a team — dormant, honest.
  if (snap.state !== 'live') {
    return (
      <CommandCenter view="fleet" onClose={onClose} captureInput={false} footer="r refresh">
        <Box marginTop={1}>
          <EmptyState
            title={snap.reason ?? 'not in a team'}
            hint="/fleet is the command-center for a swarm. Start or join a team first."
          />
        </Box>
      </CommandCenter>
    )
  }

  const { teamName, tasks, health, leases, conflicts } = snap.data
  const { missions, loose } = groupMissions(tasks)
  const shownMissions = missions.slice(0, MAX_MISSIONS)
  const shownLoose = loose.slice(0, MAX_LOOSE)
  // Selection-centered window (suggestions-list idiom): every agent reachable.
  const rosterWinStart = Math.max(
    0,
    Math.min(clampedSel - Math.floor(MAX_AGENTS / 2), health.length - MAX_AGENTS),
  )
  const shownHealth = health.slice(rosterWinStart, rosterWinStart + MAX_AGENTS)
  const shownLeases = leases.slice(0, MAX_LEASES)
  const ownerLabel = (t: Task): string => t.owner ?? 'unassigned'

  const liveFooter = rosterLen > 0 ? '↑↓ move · ↵ detail · r refresh' : 'r refresh'
  return (
    <CommandCenter view="fleet" subtitle={teamName ?? undefined} onClose={onClose} captureInput={false} footer={liveFooter}>
      {/* MISSIONS */}
      <SectionHeader count={missions.length}>Missions</SectionHeader>
      {missions.length === 0 ? (
        <Text color={FAINT}>no missions — no tasks grouped under a missionId</Text>
      ) : (
        shownMissions.map(m => {
          const shortId = m.id.replace(/^mission-/, '').slice(0, 18)
          const subtasks = m.tasks.slice(0, MAX_SUBTASKS)
          return (
            <Box key={m.id} flexDirection="column" marginTop={1}>
              <Text>
                <Text color={accent}>{GLYPH.mission} </Text>
                <Text color={IVORY}>{shortId}</Text>
                <Text color={FAINT}> · </Text>
                <Text color={m.done >= m.total ? SECOND : TEAL}>
                  {m.done}/{m.total}
                </Text>
                <Text color={FAINT}> </Text>
                <ProgressBar value={m.done} max={m.total} width={BAR_WIDTH} tone={missionTone(m.done, m.total)} />
              </Text>
              {subtasks.map(t => {
                const s = STATUS_GLYPH[t.status]
                const waits = t.blockedBy.filter(id => m.tasks.some(x => x.id === id))
                return (
                  <Text key={t.id}>
                    <Text color={FAINT}> </Text>
                    <Text color={s.color}>{s.glyph} </Text>
                    <Text color={SECOND}>{ownerLabel(t)}</Text>
                    <Text color={FAINT}> · </Text>
                    <Text color={t.status === 'completed' ? FAINT : IVORY}>{t.subject}</Text>
                    {waits.length > 0 ? (
                      <Text color={AMBER}> waits on {waits.map(id => `#${id}`).join(', ')}</Text>
                    ) : null}
                  </Text>
                )
              })}
              {m.tasks.length > subtasks.length ? (
                <Text color={FAINT}> +{m.tasks.length - subtasks.length} more subtasks</Text>
              ) : null}
            </Box>
          )
        })
      )}
      {missions.length > shownMissions.length ? (
        <Text color={FAINT}>+{missions.length - shownMissions.length} more missions</Text>
      ) : null}

      {/* LOOSE TASKS */}
      {loose.length > 0 ? (
        <>
          <SectionHeader count={loose.length}>Loose tasks</SectionHeader>
          {shownLoose.map(t => {
            const s = STATUS_GLYPH[t.status]
            return (
              <Text key={t.id}>
                <Text color={s.color}>{s.glyph} </Text>
                <Text color={SECOND}>{ownerLabel(t)}</Text>
                <Text color={FAINT}> · </Text>
                <Text color={IVORY}>{t.subject}</Text>
              </Text>
            )
          })}
          {loose.length > shownLoose.length ? (
            <Text color={FAINT}>+{loose.length - shownLoose.length} more</Text>
          ) : null}
        </>
      ) : null}

      {/* AGENTS | LEASES — side-by-side at the card width (>=120), stacked
          full-width below. Each column carries its own header + body. */}
      {(() => {
        const agentsCol = (
          <>
            <SectionHeader count={health.length} marginTop={sideBySide ? 0 : 1}>Agents</SectionHeader>
            {health.length === 0 ? (
              <Text color={FAINT}>no roster</Text>
            ) : (
              <>
                {rosterWinStart > 0 ? (
                  <Text color={FAINT}>↑ +{rosterWinStart} above</Text>
                ) : null}
                {shownHealth.map((a, i) => (
                  <Box key={a.name} flexDirection="column">
                    <Box flexDirection="row">
                      <Text color={rosterWinStart + i === clampedSel ? accent : FAINT}>{rosterWinStart + i === clampedSel ? '▸ ' : '  '}</Text>
                      <AgentRow
                        name={a.name}
                        agentType={a.agentType}
                        state={a.state as 'busy' | 'idle' | 'drifting' | 'blocked'}
                        tasks={a.currentTasks}
                        // cap the name to the column budget (50% col when
                        // side-by-side, else full width) so a long name can't overflow.
                        maxWidth={sideBySide ? 28 : Math.max(20, columns - 40)}
                      />
                    </Box>
                    {/* ↵ inline detail — the row's REAL fields (why + lease age +
                        open tasks), the /doctor expand grammar; follows the cursor. */}
                    {expanded && rosterWinStart + i === clampedSel ? (
                      <Box paddingLeft={4}>
                        <KeyValueGrid
                          keyWidth={8}
                          rows={[
                            { k: 'state', v: a.state, tone: a.state === 'drifting' ? AMBER : a.state === 'busy' ? TEAL : SECOND },
                            { k: 'why', v: a.why || '—', tone: a.why ? IVORY : FAINT },
                            {
                              k: 'lease',
                              v: a.leaseAgeMs !== null ? `${Math.round(a.leaseAgeMs / 1000)}s old` : 'none held',
                              tone: a.leaseAgeMs !== null ? IVORY : FAINT,
                            },
                            {
                              k: 'tasks',
                              v: a.currentTasks.length > 0 ? a.currentTasks.map(id => `#${id}`).join(' ') : 'none open',
                              tone: a.currentTasks.length > 0 ? IVORY : FAINT,
                            },
                          ]}
                        />
                      </Box>
                    ) : null}
                  </Box>
                ))}
                {rosterWinStart + shownHealth.length < health.length ? (
                  <Text color={FAINT}>+{health.length - rosterWinStart - shownHealth.length} more</Text>
                ) : null}
              </>
            )}
          </>
        )
        const leasesCol = (
          <>
            <SectionHeader count={leases.length} marginTop={sideBySide ? 0 : 1}>Leases</SectionHeader>
            {leases.length === 0 ? (
              <Text color={FAINT}>none held — all paths open</Text>
            ) : (
              <>
                {shownLeases.map((l, i) => (
                  <Text key={`${l.agentId}-${i}`}>
                    <Text color={TEAL}>{GLYPH.leaseHeld} </Text>
                    <Text color={IVORY}>{l.agentId}</Text>
                    <Text color={FAINT}> · </Text>
                    <Text color={SECOND}>{l.globs.join(', ') || '(none)'}</Text>
                  </Text>
                ))}
                {leases.length > shownLeases.length ? (
                  <Text color={FAINT}>+{leases.length - shownLeases.length} more</Text>
                ) : null}
              </>
            )}
          </>
        )
        return sideBySide ? (
          <Box marginTop={1} flexDirection="row">
            <Box flexDirection="column" width="50%" paddingRight={2}>{agentsCol}</Box>
            <Box flexDirection="column" width="50%">{leasesCol}</Box>
          </Box>
        ) : (
          <>
            {agentsCol}
            {leasesCol}
          </>
        )
      })()}
      {conflicts.length > 0 ? (
        <Box marginTop={1}>
          <WarningBanner
            tone="danger"
            title={`Tree conflicts (${conflicts.length})`}
            detail={conflicts.map(c => `${c.agents.join(` ${GLYPH.conflict} `)} · ${c.detail}`).join('  ·  ')}
          />
        </Box>
      ) : null}
      {note ? (
        <Box marginTop={1}>
          <Text color={TEAL}>{GLYPH.dot} {note}</Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}
