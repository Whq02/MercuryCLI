// ============================================================================
//  SHELVED: unmounted; /live unregistered (../live/live.tsx not imported by commands.ts).
//  liveCountChip — the token-burn awareness
//  indicator. Two honest counts, always legible:
//    • N working  — agents actively spending tokens now (live concurrent sessions)
//    • N wf       — swarm fan-outs with ≥1 still-running agent
//  rendered as a compact status-line chip ("3 working · 2 wf") with an idle →
//  active → hot colour gradient (FAINT idle, TEAL active, AMBER when ≥2 concurrent
//  — a fleet quietly burning is conspicuous). The full /live panel surfaces the
//  same counts as two navigable deck-card rows (Live view / Workflow monitor).
//
//  Refresh discipline clones the source: a split poll — sessions brisk
//  (SESSION_POLL_MS), workflows slow (WORKFLOW_POLL_MS) — through the
//  framework-agnostic liveCountBridge. No SSE in Mercury (the source's 'session'
//  pulse), so the brisk session poll IS the live cadence. HONEST: the workflow
//  count is gated on the swarm bridge (in-a-team) and zeroes when it's stale, so
//  the chip never spins a ghost-LIVE "N wf" for an orphaned run.
//
//  Reads ONLY through liveCountBridge (no ad-hoc scraping); fails safe to zeros.
//  Colours/glyphs are tokens — zero new hex, geometric glyphs only, no emoji.
// ============================================================================

import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { AMBER, FAINT, IVORY, SECOND, TEAL } from '../../components/mercuryPalette.js'
import { CommandCenter, SectionHeader } from '../../components/mercury-ui/components.js'
import { GLYPH, padTo } from '../../components/mercury-ui/glyphs.js'
import {
  EMPTY_COUNTS,
  readLiveSessions,
  readRunningWorkflows,
  SESSION_POLL_MS,
  WORKFLOW_POLL_MS,
  type LiveCounts,
} from '../../utils/liveCountBridge.js'

// --- The hook: split-poll the two axes, fail safe, no churn ------------------
//  Mirrors useLiveCounts in the source: two independent intervals (brisk
//  sessions, slow workflows), a setState that no-ops when nothing changed (so a
//  steady fleet doesn't re-render the frame every 2s), torn down on unmount.
export function useLiveCounts(): LiveCounts {
  const [counts, setCounts] = useState<LiveCounts>(EMPTY_COUNTS)

  useEffect(() => {
    let active = true

    const loadSessions = () => {
      readLiveSessions().then(
        ({ liveSessions, sessionCount }) => {
          if (!active) return
          setCounts(c =>
            c.liveSessions === liveSessions && c.sessionCount === sessionCount
              ? c
              : { ...c, liveSessions, sessionCount },
          )
        },
        () => {},
      )
    }
    const loadWorkflows = () => {
      readRunningWorkflows().then(
        ({ runningWorkflows, bridgeConnected }) => {
          if (!active) return
          setCounts(c =>
            c.runningWorkflows === runningWorkflows && c.bridgeConnected === bridgeConnected
              ? c
              : { ...c, runningWorkflows, bridgeConnected },
          )
        },
        () => {},
      )
    }

    loadSessions()
    loadWorkflows()
    const st = setInterval(loadSessions, SESSION_POLL_MS)
    const wt = setInterval(loadWorkflows, WORKFLOW_POLL_MS)
    return () => {
      active = false
      clearInterval(st)
      clearInterval(wt)
    }
  }, [])

  return counts
}

// --- Shared derivation (chip + panel read the SAME honest gate) --------------
function deriveChip(counts: LiveCounts) {
  const { liveSessions, runningWorkflows, bridgeConnected } = counts
  const anyLive = liveSessions > 0
  // A swarm fan-out's 'running' is only LIVE while the bridge is fresh — a stale
  // bridge ⇒ 0, so the always-visible chrome never spins a ghost-LIVE wf count.
  const wfCount = bridgeConnected ? runningWorkflows : 0
  const anyWf = wfCount > 0
  const idle = !anyLive && !anyWf
  // Two+ concurrent live turns = a fleet quietly burning — warn-tint it (AMBER).
  const color = idle ? FAINT : liveSessions >= 2 ? AMBER : TEAL
  return { liveSessions, wfCount, anyLive, anyWf, idle, color }
}

// --- The status-line chip (MercuryFrame inline use) ---------------------------
//  A single-line <Text> fragment, no border — drop it into the frame's row beside
//  a `Sep`. Renders a quiet "idle" when nothing is live; the active hue when an
//  agent is working; AMBER past two concurrent. The wf segment carries a spinner
//  glyph + count, present only when the bridge is fresh AND a fan-out runs.
export function LiveCountChip({ counts }: { counts?: LiveCounts }): React.ReactNode {
  // Accept counts from a parent (so the frame can own ONE poll loop) or self-poll.
  const ownCounts = useLiveCounts()
  const { liveSessions, wfCount, anyWf, idle, color } = deriveChip(counts ?? ownCounts)

  if (idle) {
    return (
      <Text>
        <Text color={FAINT}>{GLYPH.idle} idle</Text>
      </Text>
    )
  }
  return (
    <Text>
      <Text color={color}>{GLYPH.busy} </Text>
      <Text bold color={color}>{liveSessions}</Text>
      <Text color={color}> working</Text>
      {anyWf ? (
        <Text>
          <Text color={FAINT}> {GLYPH.dot} </Text>
          <Text color={TEAL}>{GLYPH.inProgress} </Text>
          <Text bold color={TEAL}>{wfCount}</Text>
          <Text color={TEAL}> wf</Text>
        </Text>
      ) : null}
    </Text>
  )
}

// --- A deck-card row: a navigable jump target as a labelled count row ---------
//  Mirrors the source's two clickable segments (Live view / Workflow monitor). In
//  the TUI a "click" is a deck card; each row names its jump-off command so the
//  segment stays navigable even without a pointer.
function CardRow({
  glyph,
  glyphColor,
  label,
  count,
  unit,
  jump,
  detail,
}: {
  glyph: string
  glyphColor: string
  label: string
  count: number
  unit: string
  jump: string
  detail: string
}): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={glyphColor}>{glyph} </Text>
        <Text color={FAINT}>{padTo(label, 9)}</Text>
        <Text bold color={count > 0 ? glyphColor : FAINT}>{count}</Text>
        <Text color={FAINT}> {count === 1 ? unit : unit + 's'}</Text>
      </Text>
      <Text>
        <Text color={FAINT}>{padTo('', 2)}</Text>
        <Text color={SECOND}>{detail}</Text>
      </Text>
      <Text>
        <Text color={FAINT}>{padTo('', 2)}</Text>
        <Text color={FAINT}>{GLYPH.prompt} </Text>
        <Text color={IVORY}>{jump}</Text>
      </Text>
    </Box>
  )
}

// --- The full panel (the /live command surface) ------------------------------
//  Two deck cards: the Live view (working agents) + the Workflow monitor (running
//  fan-outs), each with its honest count, a one-line state, and its navigable
//  jump-off command. The CommandCenter shell owns esc→close.
export function LiveCountView({ onClose }: { onClose: () => void }): React.ReactNode {
  const counts = useLiveCounts()
  const { liveSessions, wfCount, idle, color } = deriveChip(counts)

  const sessionDetail =
    liveSessions === 0
      ? 'no agents working right now — nothing is spending tokens'
      : liveSessions >= 2
        ? 'multiple agents working — a fleet is burning tokens'
        : 'an agent is working (a turn is in flight)'

  const wfDetail = !counts.bridgeConnected
    ? 'swarm bridge idle — not in a team (no fan-out possible)'
    : wfCount === 0
      ? 'in a team — no fan-out is running'
      : 'swarm fan-out running'

  return (
    <CommandCenter view="live" subtitle={idle ? 'idle' : `${liveSessions} working · ${wfCount} wf`} onClose={onClose}>
      <SectionHeader>Live now</SectionHeader>
      <Box marginTop={1}>
        <LiveCountChip counts={counts} />
      </Box>

      <SectionHeader>Live view</SectionHeader>
      <CardRow
        glyph={GLYPH.busy}
        glyphColor={color}
        label="working"
        count={liveSessions}
        unit="agent"
        detail={sessionDetail}
        jump="/deck — session + fleet at a glance"
      />

      <SectionHeader>Workflow monitor</SectionHeader>
      <CardRow
        glyph={GLYPH.inProgress}
        glyphColor={wfCount > 0 ? TEAL : FAINT}
        label="running"
        count={wfCount}
        unit="workflow"
        detail={wfDetail}
        jump="/fleet — swarm tasks, agent health & leases"
      />
    </CommandCenter>
  )
}
