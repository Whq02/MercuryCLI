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

// /fullscreen — the 3-rail Mercury command center. LEFT project/fleet · CENTER
// the MercuryFleetChat rail · RIGHT usage/trace/substrate telemetry. Every rail
// reads from the cockpit snapshots — real or honest-empty, never fabricated.
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
  // The usage rail's "5h" row is the five-hour RATE-LIMIT window every other
  // meter reads (quota.ts) — never the context-window fill under that label
  // (FN-018 rank 12: the rail printed the transcript's share of the model's
  // context window as "5h NN%", and coerced the window's unknown state to a
  // calm 0%). Unknown stays unknown; the component paints the em dash.
  const fiveHour = quotaWindows().fiveHour

  // Real fleet → teammates (honest empty when solo — never fabricated).
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

  // ↵ in the center MercuryFleetChat → a REAL DM to that teammate's inbox (the
  // same file-mailbox path SendMessage / the @name DM use), not a faked log line.
  // Only reachable when `team` is non-empty (the chat hides its compose box solo),
  // so teamName is set; honest no-op if a team raced away between render and send.
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
      // The center MercuryFleetChat owns fleet interaction — keep the LEFT rail to
      // project only (no duplicate fleet list) and drop the redundant 'transcript'
      // header above the chat's own one.
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
