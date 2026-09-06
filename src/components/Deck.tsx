import * as React from 'react'
import { useEffect, useState } from 'react'
import {
  formatLaneSpend,
  formatSessionCost,
  getTotalCost,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalUnpricedTurns,
} from '../cost-tracker.js'
import { useMainLoopModel } from '../hooks/useMainLoopModel.js'
import { useDisplayedSessionModel } from '../hooks/useDisplayedSessionModel.js'
import { useProviderUsageOnShow } from '../hooks/useProviderUsageOnShow.js'
import { hasConsoleBillingAccess } from '../utils/billing.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { LAYOUT_BREAKPOINTS } from '../hooks/useLayoutTier.js'
import { useTelemetry } from '../state/telemetryBus.js'
import { getTaskListId, listTasks } from '../utils/tasks.js'
import {
  daemonSnapshot,
  fleetGauge,
  gitSnapshot,
  mcpGauge,
  permissionsSnapshot,
  substrateSnapshot,
  traceSnapshot,
  type FleetData,
  type GitData,
  type Snapshot,
  type TraceData,
} from '../utils/cockpit/index.js'
import { activeSourceUsage, freshestUsageView, usageCreditsWords } from '../services/providers/providerUsage.js'
import { NO_USAGE_READ_WORDS, usageSourceWords } from '../services/providers/usageFreshness.js'
import { mercuryDoctrineEnabled } from '../prompt/mercuryContract.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  CommandCenter,
  CommandRow,
  SectionHeader,
  StateBadge,
  UsageMeter,
} from './mercury-ui/components.js'
import { GLYPH, HEALTH_GLYPH, padTo, truncateToWidth, branchChip } from './mercury-ui/glyphs.js'
import { formatClock, formatCountdown } from '../utils/cockpit/quota.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'


function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  const t = useMercuryTokens()
  return (
    <Text>
      <Text color={t.textMuted}>{padTo(label, 11)}</Text>
      {children}
    </Text>
  )
}

export function Deck({ onClose }: { onClose: () => void }): React.ReactNode {
  const t = useMercuryTokens()
  const model = useDisplayedSessionModel().label
  useProviderUsageOnShow(true)
  const cost = getTotalCost()
  const unpricedTurns = getTotalUnpricedTurns()
  const costFigure = unpricedTurns > 0 ? formatSessionCost(cost, unpricedTurns) : `$${cost.toFixed(2)}`
  const added = getTotalLinesAdded()
  const removed = getTotalLinesRemoved()

  const substrate = substrateSnapshot()
  const perms = permissionsSnapshot()
  const mcp = mcpGauge()
  const daemon = daemonSnapshot()
  const { accent } = useSessionAccent()
  const { columns } = useTerminalSize()
  const twoCol = columns >= LAYOUT_BREAKPOINTS.deckTwoColMin

  const { version } = useTelemetry()
  const [git, setGit] = useState<Snapshot<{ data: GitData }> | null>(null)
  const [fleet, setFleet] = useState<Snapshot<{ data: FleetData }> | null>(null)
  const [trace, setTrace] = useState<Snapshot<{ data: TraceData }> | null>(null)
  const [objective, setObjective] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    gitSnapshot().then(s => alive && setGit(s))
    fleetGauge().then(s => alive && setFleet(s))
    traceSnapshot().then(s => alive && setTrace(s))
    listTasks(getTaskListId())
      .then(ts => {
        if (!alive) return
        const ip = ts.find(t => t.status === 'in_progress')
        setObjective(ip ? ip.activeForm || ip.subject : null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [version])

  return (
    <CommandCenter view="deck" onClose={onClose}>
      {}
      <SectionHeader>Session</SectionHeader>
      <Row label="model">
        <Text color={t.textSecondary}>{model}</Text>
        {
}
        {hasConsoleBillingAccess() ? (
          <>
            <Text color={t.textMuted}> · </Text>
            <Text color={t.textPrimary}>{costFigure}</Text>
          </>
        ) : null}
        <Text color={t.textMuted}> · diff </Text>
        <Text color={t.success}>+{added}</Text>
        <Text color={t.textMuted}>/</Text>
        <Text color={t.textSecondary}>-{removed}</Text>
      </Row>

      {
}
      <SectionHeader>Usage</SectionHeader>
      {(() => {
        const now = Date.now()
        const usage = activeSourceUsage()
        const tail = (resetsAtMs?: number): string | undefined => {
          if (resetsAtMs == null) return undefined
          return `${formatClock(resetsAtMs)} · in ${formatCountdown(resetsAtMs - now)}`
        }
        const nodes: React.ReactNode[] = []
        if (usage.sourceKind === 'none') {
          nodes.push(
            <Text key="none" color={t.textMuted}>
              {padTo('', 11)}{usage.whyNot ?? 'not connected'}
            </Text>,
          )
        } else if (usage.shape === 'none' && usage.absence) {
          nodes.push(
            <Text key="absence" color={t.textMuted}>
              {padTo('', 11)}{usage.absence}
            </Text>,
          )
        } else if (usage.shape === 'api-spend') {
          nodes.push(
            <Text key="spend">
              <Text color={t.textMuted}>{padTo('spend', 11)}</Text>
              <Text color={t.textPrimary}>
                {usage.spend.models > 0
                  ? `${usage.spend.pricing !== undefined ? formatLaneSpend(usage.spend) : `$${usage.spend.costUSD.toFixed(2)}`} session`
                  : 'none yet'}
              </Text>
            </Text>,
          )
          const creditsWords = usageCreditsWords(usage.credits, now)
          if (creditsWords !== undefined) {
            nodes.push(
              <Text key="credits">
                <Text color={t.textMuted}>{padTo('credits', 11)}</Text>
                <Text color={usage.credits?.state === 'reported' ? t.textPrimary : t.textMuted}>{creditsWords}</Text>
              </Text>,
            )
          }
        } else if (usage.windows.length === 0) {
          nodes.push(
            <Text key="warming" color={t.textMuted}>
              {padTo('', 11)}{NO_USAGE_READ_WORDS} · fills after first reply
            </Text>,
          )
        } else {
          const meters = [...usage.windows, ...usage.pools]
          const labelWidth = Math.max(3, ...meters.map(w => w.label.length))
          for (const w of meters) {
            nodes.push(
              <UsageMeter
                key={`w:${w.key}`}
                window={w.label}
                state={w.state}
                value={w.usedPct ?? undefined}
                resetIn={tail(w.resetsAtMs)}
                hint={w.state !== 'live' ? 'not reported yet' : undefined}
                labelWidth={labelWidth}
              />,
            )
          }
          const freshest = freshestUsageView(meters)
          const readWords = freshest !== undefined ? usageSourceWords(freshest, now) : undefined
          if (readWords !== undefined) {
            nodes.push(
              <Text key="read">
                <Text color={t.textMuted}>{padTo('read', 11)}</Text>
                <Text color={t.textMuted}>{readWords}</Text>
              </Text>,
            )
          }
        }
        if (usage.readerNote !== undefined) {
          nodes.push(
            <Text key="reader">
              <Text color={t.textMuted}>{padTo('', 11)}</Text>
              <Text color={t.warning}>{usage.readerNote}</Text>
            </Text>,
          )
        }
        if (usage.limited !== undefined) {
          nodes.push(
            <Text key="limited" color={t.warning}>
              {padTo('', 11)}limit reached · resets {formatCountdown(usage.limited.resetsAtMs - now)}
            </Text>,
          )
        }
        if (usage.sourceKind !== 'none') {
          nodes.push(
            <Text key="source" color={t.textMuted}>
              {padTo('', 11)}source · {usage.label}
              {usage.tier ? ` · ${usage.tier}` : ''}
            </Text>,
          )
        }
        return <>{nodes}</>
      })()}

      {}
      <SectionHeader>Git</SectionHeader>
      <Row label="git">
        {git === null ? (
          <Text color={t.textMuted}>loading…</Text>
        ) : git.data.git === null ? (
          <Text color={t.textMuted}>{git.reason}</Text>
        ) : (
          <>
            <Text color={t.textMuted}>{branchChip('')}</Text>
            <Text color={t.textPrimary}>{git.data.git.branchName}</Text>
            <Text color={t.textMuted}> · </Text>
            {git.data.git.isClean ? (
              <Text color={t.success}>clean</Text>
            ) : (
              <Text color={t.warning}>uncommitted</Text>
            )}
            {!git.data.git.isHeadOnRemote ? <Text color={t.textMuted}> · ahead</Text> : null}
          </>
        )}
      </Row>

      {}
      <SectionHeader>Objective</SectionHeader>
      <Row label="">
        {objective ? (
          <>
            <Text color={t.success}>{GLYPH.inProgress} </Text>
            <Text color={t.textPrimary}>{truncateToWidth(objective, 72)}</Text>
          </>
        ) : (
          <Text color={t.textMuted}>{GLYPH.pending} no active task</Text>
        )}
      </Row>

      {
}
      {(() => {
        const fleetCol = (
          <>
            <Text>
              {}
              <Text bold color={t.textPrimary}>Fleet</Text>
              {fleet?.state === 'live' ? <Text color={t.textMuted}> ({fleet.data.health.length})</Text> : null}
            </Text>
            {fleet === null ? (
              <Text color={t.textMuted}>loading…</Text>
            ) : fleet.state !== 'live' ? (
              <StateBadge state={fleet.state} label={fleet.reason ?? 'off'} mono />
            ) : (
              <>
                {fleet.data.health.slice(0, 3).map(a => {
                  const g = HEALTH_GLYPH[a.state] ?? HEALTH_GLYPH.idle!
                  return (
                    <Text key={a.name}>
                      <Text color={g.color}>{g.glyph} </Text>
                      <Text color={t.textPrimary}>{truncateToWidth(a.name, 14)}</Text>
                      <Text color={t.textMuted}> {a.state}</Text>
                    </Text>
                  )
                })}
                {fleet.data.conflicts.length > 0 ? (
                  <StateBadge state="failed" label={`${fleet.data.conflicts.length} conflicts`} />
                ) : null}
              </>
            )}
          </>
        )
        const traceCol = (
          <>
            <Text>
              <Text bold color={t.textPrimary}>Trace</Text>
              {trace?.state === 'live' ? (
                <Text color={t.textMuted}>
                  {' · '}
                  <Text color={t.textPrimary}>{trace.data.total}</Text> · <Text color={t.textMuted}>{trace.data.highRisk} high-risk class</Text> · <Text color={trace.data.killed > 0 ? t.failure : t.textMuted}>{trace.data.killed} killed</Text> · <Text color={t.textMuted}>{trace.data.errors} errored</Text> · repo
                </Text>
              ) : null}
            </Text>
            {trace === null ? (
              <Text color={t.textMuted}>loading…</Text>
            ) : trace.state !== 'live' ? (
              <StateBadge state={trace.state} label={trace.reason ?? 'off'} mono />
            ) : (
              trace.data.records.slice(-3).map((r, i) => (
                <Text key={i}>
                  <Text color={r.risk === 'high' ? t.failure : r.risk === 'medium' ? t.warning : t.success}>
                    {GLYPH.dot}{' '}
                  </Text>
                  <Text color={t.textPrimary}>{truncateToWidth(String(r.tool), 18)}</Text>
                  <Text color={t.textMuted}> {String(r.risk ?? '')}</Text>
                </Text>
              ))
            )}
          </>
        )
        return twoCol ? (
          <Box marginTop={1} flexDirection="row">
            <Box flexDirection="column" width="50%" paddingRight={2}>{fleetCol}</Box>
            <Box flexDirection="column" width="50%">{traceCol}</Box>
          </Box>
        ) : (
          <>
            <Box marginTop={1} flexDirection="column">{fleetCol}</Box>
            <Box marginTop={1} flexDirection="column">{traceCol}</Box>
          </>
        )
      })()}

      {
}
      <SectionHeader>Substrate &amp; governance</SectionHeader>
      {(() => {
        const substrateOn = substrate.data.substrateOn
        const traceState = trace?.state
        const traceOn = traceState === 'live'
        const traceWord = traceState === 'live' ? 'on' : traceState === 'unavailable' ? 'recording (no events yet)' : 'off'
        const daemonOn = daemon.state === 'live'
        const leases = fleet?.state === 'live' ? fleet.data.leases.length : 0
        const firstKill = perms.data.kills[0] ?? 'none'
        return (
          <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
            <Text>
              <Text color={substrateOn ? t.success : t.textMuted}>{substrateOn ? GLYPH.done : GLYPH.pending}</Text>
              <Text color={t.textMuted}> substrate </Text>
              <Text color={substrateOn ? t.success : t.textMuted}>{substrateOn ? 'on' : 'off'}</Text>
            </Text>
            {
}
            <Text>
              <Text color={mercuryDoctrineEnabled() ? t.success : t.textMuted}>{mercuryDoctrineEnabled() ? GLYPH.done : GLYPH.pending}</Text>
              <Text color={t.textMuted}> doctrine </Text>
              <Text color={mercuryDoctrineEnabled() ? t.success : t.textMuted}>{mercuryDoctrineEnabled() ? 'on' : 'off'}</Text>
            </Text>
            <Text>
              <Text color={traceOn || traceState === 'unavailable' ? t.success : t.textMuted}>
                {traceOn || traceState === 'unavailable' ? GLYPH.done : GLYPH.pending}
              </Text>
              <Text color={t.textMuted}> trace </Text>
              <Text color={traceOn || traceState === 'unavailable' ? t.success : t.textMuted}>{traceWord}</Text>
            </Text>
            <Text>
              <Text color={t.textMuted}>mcp </Text>
              <Text color={mcp.data.mcpPolicyActive ? t.success : t.textSecondary}>{mcp.data.maxRisk}</Text>
              <Text color={t.textMuted}>/trust</Text>
            </Text>
            <Text>
              <Text color={daemonOn ? t.success : t.textMuted}>{daemonOn ? GLYPH.done : GLYPH.pending}</Text>
              <Text color={t.textMuted}> daemon </Text>
              <Text color={daemonOn ? t.success : t.textMuted}>{daemonOn ? 'on' : 'off'}</Text>
            </Text>
            <Text>
              <Text color={leases > 0 ? t.success : t.textMuted}>{GLYPH.leaseHeld}</Text>
              <Text color={t.textMuted}> leases </Text>
              <Text color={leases > 0 ? t.success : t.textMuted}>{leases}</Text>
            </Text>
            <Text>
              <Text color={firstKill === 'none' ? t.textMuted : t.failure}>{GLYPH.conflict}</Text>
              <Text color={t.textMuted}> kill </Text>
              <Text color={firstKill === 'none' ? t.textMuted : t.failure}>{firstKill}</Text>
            </Text>
          </Box>
        )
      })()}

      {}
      <Box marginTop={1} flexDirection="column">
        <CommandRow command="/fleet" hint="agents · missions · leases" />
        <CommandRow command="/trace" hint="telemetry" />
        <CommandRow command="/substrate" hint="gates" />
      </Box>
    </CommandCenter>
  )
}
