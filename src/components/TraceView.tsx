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
  const { trace: snap, refreshedAt } = useTelemetry()
  const now = useNowTick()
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
        {
}
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

  const pulse = aggregateVelocity(records, now)

  return (
    <CommandCenter view="trace" onClose={onClose} footer="r refresh · display only — no cursor">
      {
}
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

      {
}
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

      {
}
      <PulseSection />

      {
}
      <FrictionSection />
      <FrameSection />

      {}
      {byTool.length > 0 ? (
        <>
          <SectionHeader>
            {`By tool (${byTool.length}${toolCount > MAX_TOOLS ? ` of ${toolCount}` : ''})`}
          </SectionHeader>
          {byTool.map(t => {
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

      {
}
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


function fmtMs(ms: number | null): string {
  if (ms === null) return '—'
  return fmtDuration(ms)
}

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

export function FrameSection(): React.ReactNode {
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
          {
}
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
