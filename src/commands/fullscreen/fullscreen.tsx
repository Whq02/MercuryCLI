import { pathTailLabel } from '../../utils/pathLabel.js'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { MercuryFleetChat, type Teammate } from '../../components/MercuryFleetChat.js'
import { MercuryFullscreen } from '../../components/MercuryFullscreen.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import { TEAL } from '../../components/mercuryPalette.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { getAgentName, getTeammateColor } from '../../utils/teammate.js'
import {
  fleetGauge,
  gitSnapshot,
  substrateSnapshot,
  traceSnapshot,
  type FleetData,
  type GitData,
  type Snapshot,
  type TraceData,
} from '../../utils/cockpit/index.js'
import { quotaWindows } from '../../utils/cockpit/quota.js'

const HEALTH_GLYPH: Record<string, string> = { busy: '●', idle: '·', drifting: '◓' }

function FullscreenLive({
  onClose,
}: {
  onClose: () => void
}): React.ReactNode {
  const [git, setGit] = useState<Snapshot<{ data: GitData }> | null>(null)
  const [fleet, setFleet] = useState<Snapshot<{ data: FleetData }> | null>(null)
  const [trace, setTrace] = useState<Snapshot<{ data: TraceData }> | null>(null)
  useEffect(() => {
    let alive = true
    gitSnapshot().then(s => alive && setGit(s))
    fleetGauge().then(s => alive && setFleet(s))
    traceSnapshot().then(s => alive && setTrace(s))
    return () => {
      alive = false
    }
  }, [])

  const substrate = substrateSnapshot()
  const fiveHour = quotaWindows().fiveHour

  const health = fleet?.state === 'live' ? fleet.data.health : []
  const team: Teammate[] = health.map(h => ({
    name: h.name,
    role: h.agentType ?? 'agent',
    state: h.state === 'drifting' ? 'drift' : h.state,
    glyph: HEALTH_GLYPH[h.state] ?? '·',
  }))

  const repo = pathTailLabel(getCwd())
  const branch = git?.data.git?.branchName ?? 'main'
  const teamName = fleet?.state === 'live' ? fleet.data.teamName : null

  function handleSend(target: string, text: string): void {
    if (!teamName) return
    void writeToMailbox(
      target,
      {
        from: getAgentName() ?? 'user',
        text,
        timestamp: new Date().toISOString(),
        color: getTeammateColor(),
      },
      teamName,
    )
  }

  return (
    <MercuryFullscreen
      repo={repo}
      branch={branch}
      agents={[]}
      centerLabel={null}
      tasks={[]}
      usagePct={fiveHour.usedPct === null ? null : Math.round(fiveHour.usedPct)}
      traceCount={trace?.state === 'live' ? trace.data.total : 0}
      traceHigh={trace?.state === 'live' ? trace.data.highRisk : 0}
      traceKilled={trace?.state === 'live' ? trace.data.killed : 0}
      substrateOn={substrate.data.active}
      substrateTotal={substrate.data.total}
    >
      <MercuryFleetChat team={team} onSend={handleSend} onClose={onClose} />
    </MercuryFullscreen>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context) => (
  <FullscreenLive
    onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }}
  />
)
