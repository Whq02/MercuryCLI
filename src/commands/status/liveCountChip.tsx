
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

function deriveChip(counts: LiveCounts) {
  const { liveSessions, runningWorkflows, bridgeConnected } = counts
  const anyLive = liveSessions > 0
  const wfCount = bridgeConnected ? runningWorkflows : 0
  const anyWf = wfCount > 0
  const idle = !anyLive && !anyWf
  const color = idle ? FAINT : liveSessions >= 2 ? AMBER : TEAL
  return { liveSessions, wfCount, anyLive, anyWf, idle, color }
}

export function LiveCountChip({ counts }: { counts?: LiveCounts }): React.ReactNode {
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
