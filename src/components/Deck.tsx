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
import { GLYPH, HEALTH_GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { formatClock, formatCountdown } from '../utils/cockpit/quota.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'

// ============================================================================
//  Deck — the Mercury command-center snapshot (the /deck view). A
//  state-honest summary matching the full-deck card 1:1: session · usage · git ·
//  objective · two-column fleet|trace · a single "Substrate & governance" chip
//  row · a "next" row. Reads everything through utils/cockpit snapshots (no
//  ad-hoc scraping); every surface with no backend renders its honest state
//  (off/unavailable), never a fake live value. Identity-accent headers follow
//  the session critter (getSessionAccent); the status spine stays fixed.
// ============================================================================

// A label + value row with a padded t.textMuted label column so the deck reads as a
// grid. The value is arbitrary JSX (mixed colours / badges).
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
  const cost = getTotalCost()
  // The turns the ledger could not price ride beside the figure (the
  // usage-neutrality law) — the two-decimal spelling stands when there are
  // none, so the deck's captures keep their shape.
  const unpricedTurns = getTotalUnpricedTurns()
  const costFigure = unpricedTurns > 0 ? formatSessionCost(cost, unpricedTurns) : `$${cost.toFixed(2)}`
  const added = getTotalLinesAdded()
  const removed = getTotalLinesRemoved()

  // Sync snapshots — cheap gate/config reads, recomputed per render (every
  // open, and every bus-version re-render now that the deck subscribes).
  const substrate = substrateSnapshot()
  const perms = permissionsSnapshot()
  const mcp = mcpGauge()
  const daemon = daemonSnapshot()
  const { accent } = useSessionAccent()
  // Responsive Fleet|Trace: two columns only when there's room for full names +
  // a gap (the full-deck card renders at 120); below that, stacked full-width so
  // neither column truncates. Mirrors SubstratePanel's >=110 breakpoint.
  const { columns } = useTerminalSize()
  const twoCol = columns >= LAYOUT_BREAKPOINTS.deckTwoColMin

  // Async snapshots — git/fleet/trace touch fs/process, loaded in one effect.
  // Keyed on the telemetry-bus version so the deck RE-FETCHES on every bus
  // refresh (event-driven turn/task movement + the 15s heartbeat) instead of
  // silently aging after a one-shot mount load (trust-cockpit W2a). The deck
  // keeps its OWN snapshot shapes — the bus git summary (getGitState) differs
  // from gitSnapshot's, so the version is the trigger, not the data source.
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
      {/* SESSION */}
      <SectionHeader>Session</SectionHeader>
      <Row label="model">
        <Text color={t.textSecondary}>{model}</Text>
        {/* $ only for console-billing sessions — a subscription session showing
            "$0.00" is fabricated data (HB-0209 fixed the frame; this is the
            deck's copy of the same guard — uniqueness-program D5). */}
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

      {/* USAGE — its own header, matching full-deck. ONE derivation
          (providerUsage.activeSourceUsage — the owner the settings tab and the
          telemetry rail read too): meters in the ACTIVE source's own shape
          (Anthropic 5h/7d · OpenAI observed bands · api-key = spend truth),
          honest logged-out absence with the attach route, never a fake bar.
          resets recompute on this open. */}
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
          // Quiet honest absence + the attach route (law 1) — the owner's
          // per-family why-not, so a compat/local lane never steers to
          // /logins (its connect home is env/a server, not a login).
          nodes.push(
            <Text key="none" color={t.textMuted}>
              {padTo('', 11)}{usage.whyNot ?? 'not connected'}
            </Text>,
          )
        } else if (usage.shape === 'none' && usage.absence) {
          // A connected source that meters nothing says so (local servers).
          nodes.push(
            <Text key="absence" color={t.textMuted}>
              {padTo('', 11)}{usage.absence}
            </Text>,
          )
        } else if (usage.shape === 'api-spend') {
          // An active API key: billing truth — session spend, never a
          // fabricated subscription bar.
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
          // The key's credit balance as the provider states it, with its
          // feed and age — or the honest "not reported by the provider" —
          // from the ONE owner (the same words the tab and the doctor carry).
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
          // The shared windows, then the per-model weekly pools the family
          // reports (folded into the same block, their own labels), then
          // ONE read line — the feed and age of the freshest figure — so a
          // stale record never paints as live.
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
        if (usage.limited !== undefined) {
          nodes.push(
            <Text key="limited" color={t.warning}>
              {padTo('', 11)}limit reached · resets {formatCountdown(usage.limited.resetsAtMs - now)}
            </Text>,
          )
        }
        // The quiet source line: whose truth the meters tell + its real tier —
        // both words from the owner, never hard-coded.
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

      {/* GIT */}
      <SectionHeader>Git</SectionHeader>
      <Row label="git">
        {git === null ? (
          <Text color={t.textMuted}>loading…</Text>
        ) : git.data.git === null ? (
          <Text color={t.textMuted}>{git.reason}</Text>
        ) : (
          <>
            <Text color={t.textMuted}>{GLYPH.branch}</Text>
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

      {/* OBJECTIVE */}
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

      {/* FLEET | TRACE — two columns at the card width (>=110), stacked
          full-width below (mirrors SubstratePanel). Each column body is built
          once and placed into either layout. */}
      {(() => {
        const fleetCol = (
          <>
            <Text>
              {/* t.textPrimary like SectionHeader */}
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

      {/* SUBSTRATE & GOVERNANCE — one honest chip row (full-deck). Each chip is a
          self-contained <Text> in a flex-wrap row: one line at 120 (matches the
          card's 3-col gaps), wraps at chip boundaries (never mid-chip) at 80. */}
      <SectionHeader>Substrate &amp; governance</SectionHeader>
      {(() => {
        const substrateOn = substrate.data.substrateOn
        // Three trace states, three words (FC-096): 'unavailable' is ARMED
        // with nothing recorded yet — collapsing it into 'off' contradicted
        // /substrate ("Invocation trace live") and /health ("trace
        // recording") on the same boot. The chip now says recording for an
        // armed-but-empty trace and keeps on/off for the real two.
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
            {/* wrapper profile chip — moved here from the deck STRIP (
                declutter): the full /deck snapshot is the single owner of the
                set-and-forget profile flags now. */}
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

      {/* NEXT */}
      <Box marginTop={1} flexDirection="column">
        <CommandRow command="/fleet" hint="agents · missions · leases" />
        <CommandRow command="/trace" hint="telemetry" />
        <CommandRow command="/substrate" hint="gates" />
      </Box>
    </CommandCenter>
  )
}
