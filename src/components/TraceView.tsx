import * as React from 'react'
import { Box, Text, useInput } from '../ink.js'
import { pokeTelemetry, useTelemetry } from '../state/telemetryBus.js'
import { aggregateByTool, aggregateVelocity } from '../utils/cockpit/index.js'
import { SECOND, AMBER, CRIMSON, FAINT, IVORY, TEAL } from './mercuryPalette.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import {
  ActivityFeed,
  CommandCenter,
  EmptyState,
  FreshnessLine,
  SectionHeader,
  Sparkline,
  useNowTick,
} from './mercury-ui/components.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  getPulseRing,
  pulsePercentile,
  type PulseTurnSummary,
} from '../utils/pulse/index.js'
import {
  frictionSnapshot,
  type FrictionTransition,
} from '../utils/observability/frictionStopwatch.js'
import { FRAME_TRACE_RING_CAP, readFrameTrace, type FrameTraceRow } from '../ink/root/frame-trace.js'
import { resolveTerminalProfile } from '../ink/session/terminalProfile.js'

// ============================================================================
//  TraceView — the Mercury invocation-trace viewer (the /trace view).
//  Reads the per-invocation observability spine off the shared telemetry bus
//  (useTelemetry().trace — the same traceSnapshot parse the data bridge uses,
//  refreshed on turn/task movement + the 15s heartbeat, `r` forces one), then
//  renders a compact ActivityFeed table: time · tool · risk · surface · dur ·
//  ok, under a FreshnessLine that says how old the snapshot is. Missing/
//  disabled trace → an honest EmptyState (off/unavailable), never a crash.
// ============================================================================

const MAX_ROWS = 20
const MAX_TOOLS = 8

function clock(ts: unknown): string {
  if (typeof ts !== 'string') return '--:--:--'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtIdle(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

export function TraceView({ onClose }: { onClose: () => void }): React.ReactNode {
  // Live trace via the shared telemetry bus (trust-cockpit W2a): the old
  // one-shot traceSnapshot() mount effect froze this view at open in
  // live-looking chrome. `trace` carries the FULL snapshot the view needs
  // (the bus stores traceSnapshot()'s resolve wholesale); null only while the
  // first bus refresh is in flight. useNowTick keeps the freshness stamp and
  // the Session Pulse window moving between refreshes.
  const { trace: snap, refreshedAt } = useTelemetry()
  const now = useNowTick()
  // `r` is an ACTION key — mount-buffered so the keystroke that launched
  // /trace can't fire it (useOpenEventGate doctrine). esc stays where it lives
  // (CommandCenter standalone, the cockpit tower when embedded); this sibling
  // useInput owns exactly one key and never competes for close/nav.
  const pastOpenEvent = useOpenEventGate()
  useInput(input => {
    if (input === 'r' && pastOpenEvent()) pokeTelemetry()
  })

  if (snap === null) {
    return (
      <CommandCenter view="trace" onClose={onClose}>
        <Box marginTop={1}>
          <Text color={FAINT}>loading…</Text>
        </Box>
      </CommandCenter>
    )
  }

  if (snap.state !== 'live') {
    return (
      <CommandCenter view="trace" onClose={onClose}>
        <Box marginTop={1}>
          <EmptyState
            title="No invocation trace yet"
            hint={snap.reason}
          />
        </Box>
        {/* The frame ring is render-side truth — it exists (and matters)
            before the first tool call ever fires; the friction stopwatch
            likewise has its boot row from the first prompt. */}
        <FrictionSection />
        <FrameSection />
      </CommandCenter>
    )
  }

  const { records, total, highRisk, killed, errors, compaction } = snap.data
  const rows = records.slice(-MAX_ROWS).map(r => ({
    time: clock(r.ts),
    tool: r.tool,
    risk: r.risk as 'low' | 'medium' | 'high' | undefined,
    surface: typeof r.surface === 'string' ? r.surface : '?',
    duration: fmtDuration(r.durationMs),
    ok: r.ok,
    killed: r.killed === true,
  }))

  const allByTool = aggregateByTool(records)
  const toolCount = allByTool.length
  const byTool = allByTool.slice(0, MAX_TOOLS)

  // Session pulse — invocation velocity over the recent window (the SPARK ramp).
  // The ticking `now` keeps the window sliding between bus refreshes.
  const pulse = aggregateVelocity(records, now)

  return (
    // footer honesty: the table LOOKS navigable but binds no
    // cursor — say so instead of letting arrows die silently. `r` IS bound.
    <CommandCenter view="trace" onClose={onClose} footer="r refresh · display only — no cursor">
      {/* rollup: N calls · M high-risk class · K killed · E errored · ↻ freshness.
          The class tally stays FAINT (every shell/net call classes 'high' — a
          count, not a warning); CRIMSON is reserved for REAL kills. */}
      <Box marginTop={1}>
        <Text>
          <Text color={IVORY}>{total}</Text>
          <Text color={FAINT}> {total === 1 ? 'call' : 'calls'} · </Text>
          <Text color={FAINT}>{highRisk} high-risk class · </Text>
          <Text color={killed > 0 ? CRIMSON : FAINT}>{killed}</Text>
          <Text color={FAINT}> killed · </Text>
          <Text color={FAINT}>{errors} errored · </Text>
        </Text>
        <FreshnessLine at={refreshedAt} now={now} />
      </Box>

      {/* session pulse — calls/min over the recent window as a sparkline + trend.
          The aggregate "WHEN/how fast" a long autonomous run can't see in a table. */}
      {pulse.total > 0 ? (
        <Box marginTop={1}>
          <Text color={SECOND}>pulse  </Text>
          <Sparkline values={pulse.perMin} color={TEAL} />
          <Text color={FAINT}>{`  peak ${pulse.peakPerMin}/min · `}</Text>
          <Text color={pulse.trend === 'rising' ? TEAL : pulse.trend === 'falling' ? AMBER : FAINT}>
            {pulse.trend}
          </Text>
          {pulse.idleSec > 0 ? <Text color={FAINT}>{` · idle ${fmtIdle(pulse.idleSec)}`}</Text> : null}
        </Box>
      ) : null}

      {/* the per-turn response-immediacy record ('s
          operator diagnostic): latest-turn waterfall separating
          acknowledgement / local preparation / provider wait / token→paint,
          plus warm p50/p95 over the bounded in-process ring. */}
      <PulseSection />

      {/* HZ8 FRAME LATENCY TRACE — the render-pipeline ring: which stage
          consumed the frame budget, what the newest keystroke resolved to
          (and where focus lived), whether full clears fired, and why this
          terminal selected its capability tier. Numbers + identifiers only
          (frame-trace.ts's schema law). */}
      <FrictionSection />
      <FrameSection />

      {/* by-tool breakdown — the aggregate the last-N table can't give on a long run */}
      {byTool.length > 0 ? (
        <>
          <SectionHeader>
            {`By tool (${byTool.length}${toolCount > MAX_TOOLS ? ` of ${toolCount}` : ''})`}
          </SectionHeader>
          {byTool.map(t => {
            // WIDTH: display-width truncate/pad (MCP tool ids carry user-chosen
            // server names — CJK/wide glyphs mis-truncated + desynced the column
            // under .length/.padEnd).
            const label = truncateToWidth(t.tool, 26)
            return (
              <Text key={t.tool}>
                <Text color={IVORY}>{padTo(label, 27)}</Text>
                <Text color={TEAL}>{String(t.count).padStart(4)}x</Text>
                <Text color={FAINT}>{'  '}</Text>
                {t.failed > 0 ? (
                  <Text color={AMBER}>{`${t.failed}${GLYPH.fail}`.padEnd(5)}</Text>
                ) : (
                  <Text color={FAINT}>{'·'.padEnd(5)}</Text>
                )}
                <Text color={FAINT}>{t.avgDurationMs > 0 ? `~${fmtDuration(t.avgDurationMs)}` : ''}</Text>
              </Text>
            )
          })}
        </>
      ) : null}

      {/* compaction lane — silent context-shaping a local trace must not
          miss; count + tokens freed per event. */}
      {compaction && compaction.total > 0 ? (
        <>
          <SectionHeader>
            {`Compaction (${compaction.total} event${compaction.total === 1 ? '' : 's'}${
              compaction.totalTokensFreed > 0
                ? ` · ~${compaction.totalTokensFreed.toLocaleString()} tok freed`
                : ''
            })`}
          </SectionHeader>
          {compaction.byEvent.map(e => (
            <Text key={e.event}>
              <Text color={IVORY}>{e.event.padEnd(20)}</Text>
              <Text color={TEAL}>{String(e.count).padStart(4)}x</Text>
              <Text color={FAINT}>
                {e.tokensFreed > 0 ? `   ~${e.tokensFreed.toLocaleString()} tok` : ''}
              </Text>
            </Text>
          ))}
        </>
      ) : null}

      <SectionHeader>{`Recent (last ${Math.min(total, MAX_ROWS)})`}</SectionHeader>
      <ActivityFeed events={rows} />
    </CommandCenter>
  )
}

// ── section ───────────────────────────────────────────────────

function fmtMs(ms: number | null): string {
  if (ms === null) return '—'
  return fmtDuration(ms)
}

/** One proportional waterfall bar: prep · provider wait · post-first-chunk.
 *  Bounded width; each segment ≥1 cell when its span is non-zero. */
function waterfallBar(s: PulseTurnSummary, width: number): React.ReactNode {
  const prep = s.localPrepMs ?? 0
  const wait = s.providerWaitMs ?? 0
  const rest = Math.max(0, s.totalMs - prep - wait)
  const total = prep + wait + rest
  if (total <= 0) return null
  const cells = (v: number) => (v <= 0 ? 0 : Math.max(1, Math.round((v / total) * width)))
  return (
    <Text>
      <Text color={AMBER}>{'█'.repeat(cells(prep))}</Text>
      <Text color={FAINT}>{'█'.repeat(cells(wait))}</Text>
      <Text color={TEAL}>{'█'.repeat(cells(rest))}</Text>
    </Text>
  )
}

/** HZ8 frame block: the render-pipeline ring, attributed by stage. Ceil-index
 *  p95 over a bounded ring IS the max at small n — the sample count is named
 *  so the number can never impersonate a bigger population. */
// FRICTION — the stopwatch rows (frictionStopwatch: time-to-interactive per
// major transition vs its NAMED budget). A row exists only once its
// transition was actually observed; the LAST observation over budget
// renders red — the regression signal the budgets exist for. Derives from
// the ONE frictionSnapshot owner; adaptive tokens like FrameSection.
function FrictionSection(): React.ReactNode {
  const tok = useMercuryTokens()
  const rows = frictionSnapshot().filter(r => r.samples > 0)
  if (rows.length === 0) return null
  const label: Record<FrictionTransition, string> = {
    'boot-interactive': 'boot→interactive',
    'screen-switch': 'screen switch',
    'picker-open': 'picker open',
  }
  const ms = (v: number): string => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`)
  return (
    <>
      <SectionHeader>friction</SectionHeader>
      {rows.map(r => (
        <Box key={r.transition}>
          <Text>
            <Text color={tok.textMuted}>{padTo(label[r.transition], 18)}</Text>
            <Text color={r.over ? tok.failure : tok.success}>{ms(r.lastMs ?? 0)}</Text>
            <Text color={tok.textMuted}>{` / ${ms(r.budgetMs)} budget`}</Text>
            {r.over ? <Text color={tok.failure}> · over budget</Text> : null}
            {r.worstMs !== null && r.samples > 1 ? (
              <Text color={tok.textMuted}>{` · worst ${ms(r.worstMs)} · n=${r.samples}`}</Text>
            ) : null}
          </Text>
        </Box>
      ))}
    </>
  )
}

// Exported for the frames-window prover (FC-133): the section reads only
// the in-process ring, so it mounts bare without the telemetry bus.
export function FrameSection(): React.ReactNode {
  // This section rides the
  // adaptive token layer, not the fixed dark palette the older sections
  // still carry as migration debt.
  const tok = useMercuryTokens()
  const rows = readFrameTrace()
  if (rows.length === 0) return null
  const pct = (values: number[], q: number): number => {
    const s = [...values].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? 0
  }
  const totals = rows.map(r => r.totalMs)
  const slowest = rows.reduce((a, b) => (b.totalMs > a.totalMs ? b : a))
  const lastInput = [...rows].reverse().find(r => r.inputToFrameMs !== null)
  const clears = rows.reduce((n, r) => n + r.fullClears, 0)
  const lastClear = [...rows].reverse().find(r => r.lastClearReason !== null)
  const profile = resolveTerminalProfile()
  const failing = profile.checks.find(c => !c.ok)
  const ms = (v: number): string => `${v.toFixed(1)}ms`
  const frameSpanLabel = (all: readonly FrameTraceRow[]): string => {
    if (all.length === 0) return '0s'
    const spanMs = performance.now() - all[0]!.at
    return spanMs >= 60_000 ? `${(spanMs / 60_000).toFixed(1)}m` : `${Math.max(1, Math.round(spanMs / 1000))}s`
  }
  return (
    <>
      <SectionHeader>frames</SectionHeader>
      <Box>
        <Text>
          {/* FC-133: the ring is count-bounded — n alone implied an
              unbounded history while 75 idle seconds can flush the very
              frame the panel was opened to attribute. The live span and
              the cap make the window a stated fact. */}
          <Text color={tok.textMuted}>{`n=${rows.length}/${FRAME_TRACE_RING_CAP} · last ${frameSpanLabel(rows)} · p50 `}</Text>
          <Text color={tok.textPrimary}>{ms(pct(totals, 0.5))}</Text>
          <Text color={tok.textMuted}>{` · p95 `}</Text>
          <Text color={tok.textPrimary}>{ms(pct(totals, 0.95))}</Text>
          <Text color={clears > 0 ? tok.warning : tok.textMuted}>{` · ${clears} full clear${clears === 1 ? '' : 's'}`}</Text>
          {lastClear ? <Text color={tok.textMuted}>{` (${lastClear.lastClearReason})`}</Text> : null}
        </Text>
      </Box>
      <Box>
        <Text color={tok.textMuted} wrap="truncate-end">
          {`slowest ${ms(slowest.totalMs)} — yoga ${ms(slowest.yogaMs)} · commit ${ms(slowest.commitMs)} · compose ${ms(slowest.rendererMs)} · diff ${ms(slowest.diffMs)} · write ${ms(slowest.writeMs)} · ${slowest.patches} patch${slowest.patches === 1 ? '' : 'es'}`}
        </Text>
      </Box>
      {lastInput ? (
        <Box>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{'input→frame '}</Text>
            <Text color={tok.info}>{ms(lastInput.inputToFrameMs ?? 0)}</Text>
            <Text color={tok.textMuted}>
              {` · ${lastInput.actionId ?? 'typed'} · focus ${lastInput.contexts.slice(0, 3).join('/') || '—'} · chord detail: /keys`}
            </Text>
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text color={tok.textMuted} wrap="truncate-end">
          {`profile ${profile.verdict}${failing ? ` — ${failing.id}: ${failing.evidence}` : ' — every capability check ok'}`}
        </Text>
      </Box>
    </>
  )
}

/** Turn-pulse block: honest attribution of the last turn + ring percentiles.
 *  Reads the in-process pulse ring directly (same process as the turns). */
function PulseSection(): React.ReactNode {
  const ring = getPulseRing()
  if (ring.length === 0) return null
  const last = ring[ring.length - 1]!
  const warm = (s: PulseTurnSummary) => !s.cold && s.dispatched
  const p = (field: Parameters<typeof pulsePercentile>[0], pct: number) =>
    pulsePercentile(field, pct, warm)
  const warmCount = ring.filter(warm).length
  return (
    <>
      <SectionHeader>
        {`Turn pulse (${ring.length} turn${ring.length === 1 ? '' : 's'}${warmCount > 0 ? ` · ${warmCount} warm` : ''})`}
      </SectionHeader>
      {warmCount > 0 ? (
        <Text>
          <Text color={SECOND}>{'warm p50/p95  '}</Text>
          <Text color={IVORY}>{`prep ${fmtMs(p('localPrepMs', 50))}/${fmtMs(p('localPrepMs', 95))}`}</Text>
          <Text color={FAINT}>{' · '}</Text>
          <Text color={IVORY}>{`provider ${fmtMs(p('providerWaitMs', 50))}/${fmtMs(p('providerWaitMs', 95))}`}</Text>
          <Text color={FAINT}>{' · '}</Text>
          <Text color={IVORY}>{`first visible ${fmtMs(p('firstVisibleMs', 50))}/${fmtMs(p('firstVisibleMs', 95))}`}</Text>
        </Text>
      ) : null}
      <Text>
        <Text color={SECOND}>{`last ${last.key} `}</Text>
        <Text color={last.cold ? AMBER : FAINT}>{last.cold ? 'cold' : 'warm'}</Text>
        <Text color={FAINT}>{` ${last.status}${last.model ? ` · ${last.model}${last.effort ? ` @${last.effort}` : ''}` : ''}`}</Text>
      </Text>
      <Text>
        <Text color={SECOND}>{'  ack '}</Text>
        <Text color={IVORY}>{fmtMs(last.ackMs)}</Text>
        <Text color={SECOND}>{' · prep '}</Text>
        <Text color={AMBER}>{fmtMs(last.localPrepMs)}</Text>
        <Text color={SECOND}>{' · provider '}</Text>
        <Text color={IVORY}>{fmtMs(last.providerWaitMs)}</Text>
        <Text color={SECOND}>{' · paint '}</Text>
        <Text color={TEAL}>{fmtMs(last.paintMs)}</Text>
        <Text color={SECOND}>{' · total '}</Text>
        <Text color={IVORY}>{fmtMs(last.totalMs)}</Text>
      </Text>
      {last.dispatched ? (
        <Box>
          <Text color={FAINT}>{'  '}</Text>
          {waterfallBar(last, 40)}
        </Box>
      ) : (
        <Text color={FAINT}>{'  local-only turn (never dispatched)'}</Text>
      )}
      {last.slowestStage || last.slowestProducer ? (
        <Text color={FAINT}>
          {`  slowest local${last.slowestStage ? ` ${last.slowestStage.name} ${fmtDuration(last.slowestStage.ms)}` : ''}${
            last.slowestProducer ? ` · producer ${last.slowestProducer.label} ${fmtDuration(last.slowestProducer.ms)}` : ''
          }`}
        </Text>
      ) : null}
    </>
  )
}
