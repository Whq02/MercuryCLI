import * as React from 'react'
import { useEffect, useSyncExternalStore } from 'react'
import { Box, Text } from '../ink.js'
import {
  getHelmCursor,
  getHelmFocus,
  getHelmTelemetryVersion,
  helmRowSig,
  publishHelmRows,
  subscribeHelmFocus,
  type HelmRow,
} from '../utils/cockpit/helmFocus.js'
import {
  getLiveContextUsage,
  getLiveContextUsageVersion,
  subscribeLiveContextUsage,
  traceSnapshot,
  type Snapshot,
  type TraceData,
} from '../utils/cockpit/index.js'
import { contextPercentLabel, contextWindowLabel } from '../utils/contextFill.js'
import { ctxForecastEnabled, estimateTurnsToCompact } from '../utils/cockpit/ctxForecast.js'
import { formatCountdown, formatCountdownCoarse } from '../utils/cockpit/quota.js'
import { usageCreditsLine, windowSourceUsages, type UsageWindowView } from '../services/providers/providerUsage.js'
import { NO_USAGE_READ_WORDS, usageStaleTail } from '../services/providers/usageFreshness.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../services/claudeAiLimits.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../services/engine-connector/focusedConnector.js'
import { formatLaneSpend } from '../cost-tracker.js'
import { healthCertSnapshot } from '../utils/cockpit/healthCertSnapshot.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { pidAlive } from '../utils/pidAlive.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { GLYPH, SPARK, truncateToWidth } from './mercury-ui/glyphs.js'
import { requestCommandDispatch, requestHelmRowActivationByLabel, setHelmCursor } from '../utils/cockpit/helmFocus.js'
import { ctxGrowthHistory } from '../utils/cockpit/ctxForecast.js'
import { usageActivityBins } from '../utils/cockpit/usageActivity.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { RailPanel, railPanelInnerWidth } from './mercury-ui/RailPanel.js'
import { Sparkline, UsageMeter, useNowTick } from './mercury-ui/components.js'
import { CURSOR_NUDGE_MS, AttentionPulse, ValueGlow, WorkingGlyph } from './mercury-ui/LiveGlyphs.js'
import { gaugeColor } from './mercury-ui/theme.js'
import { useAppState, type AppState } from '../state/AppState.js'
import { partitionDiskRuns } from '../tools/WorkflowTool/runManifest.js'
import { useTelemetry } from '../state/telemetryBus.js'
import type { TaskState } from '../tasks/types.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import {
  consoleEnabled,
  getConsoleAskCount,
  getConsoleBuffer,
  getConsoleCursor,
  getConsoleEntries,
  getConsolePending,
  getConsoleVersion,
  isConsoleComposing,
  subscribeConsole,
} from '../utils/cockpit/helmConsole.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import {
  consoleInputWindow,
  fmtTok,
  plainifyAnswer,
  wrapPlain,
} from '../utils/cockpit/helmConsoleText.js'


const TRACE_ROWS = 2
const WF_ROWS = 3

const subscribeFocusedRailModel = subscribeThroughFocused((connector, listener) =>
  connector.subscribeModel(listener),
)
const getFocusedRailModel = (): string => getFocusedSessionConnector().modelFacts().main

function workflowLabel(t: TaskState): string {
  const w = t as TaskState & { workflowName?: string; summary?: string; description?: string }
  return w.workflowName ?? w.summary ?? w.description ?? 'workflow'
}

function hhmm(ts: unknown): string {
  if (typeof ts !== 'string') return '--:--'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function TelemetryRow({
  label,
  index,
  selected,
  width,
  children,
}: {
  label: string
  index: number
  selected: boolean
  width: number
  children: React.ReactNode
}): React.ReactNode {
  return (
    <InteractiveRow
      id={`helm:telemetry:${label}`}
      selected={selected}
      onSelect={() => setHelmCursor('telemetry', index)}
      onActivate={() => requestHelmRowActivationByLabel('telemetry', label)}
      width={width}
      height={1}
    >
      {children}
    </InteractiveRow>
  )
}

function EmptyHint({
  text,
  width,
  selected = false,
  label,
  index,
}: {
  text: string
  width: number
  selected?: boolean
  label?: string
  index?: number
}): React.ReactNode {
  const tok = useMercuryTokens()
  const { accent } = useSessionAccent()
  const body = (
    <Text wrap="truncate-end">
      <Text color={accent}>{selected ? `${GLYPH.prompt} ` : '  '}</Text>
      <Text color={tok.textMuted}>{text}</Text>
    </Text>
  )
  if (label !== undefined && index !== undefined) {
    return (
      <TelemetryRow label={label} index={index} selected={selected} width={width}>
        {body}
      </TelemetryRow>
    )
  }
  return <Box width={width}>{body}</Box>
}

export const HelmTelemetryRail = React.memo(HelmTelemetryRailImpl)

function HelmTelemetryRailImpl({
  width,
  availRows,
}: {
  width: number
  availRows?: number
}): React.ReactNode {
  fluxMark('render:rail-telemetry')
  const tok = useMercuryTokens()
  useSyncExternalStore(subscribeHelmFocus, getHelmTelemetryVersion, getHelmTelemetryVersion)
  const focused = getHelmFocus() === 'telemetry'
  const cur = getHelmCursor('telemetry')
  const { accent } = useSessionAccent()
  const rowW = railPanelInnerWidth(width)
  const rowsModel: HelmRow[] = []
  const sel = (row: HelmRow): number => {
    rowsModel.push(row)
    return rowsModel.length - 1
  }
  const isOn = (i: number): boolean => focused && cur === i
  const caret = (i: number): React.ReactNode => (
    <Text color={accent}>{isOn(i) ? `${GLYPH.prompt} ` : '  '}</Text>
  )

  const sessionModel = useSyncExternalStore(
    subscribeFocusedRailModel,
    getFocusedRailModel,
    getFocusedRailModel,
  )
  useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  const { primary: usage, others: otherUsages } = windowSourceUsages({ model: sessionModel })
  const liveWindows = usage.windows.filter(w => w.state === 'live')
  useSyncExternalStore(subscribeConsole, getConsoleVersion, getConsoleVersion)
  const consoleOn = consoleEnabled()
  const consoleComposing = consoleOn && isConsoleComposing()
  const consolePending = consoleOn ? getConsolePending() : null
  const consoleLast = consoleOn ? getConsoleEntries().at(-1) : undefined
  const consoleCount = consoleOn ? getConsoleAskCount() : 0
  const { rows: termRows } = useTerminalSize()
  const now = useNowTick(consolePending ? 1000 : 30_000)
  const meterTail = (w: UsageWindowView, pool: boolean): string | undefined => {
    const stale = usageStaleTail(w, now)
    if (stale !== undefined) return stale
    if (w.resetsAtMs == null) return undefined
    return pool ? formatCountdownCoarse(w.resetsAtMs - now) : formatCountdown(w.resetsAtMs - now)
  }
  const usageEmpty = usage.shape !== 'api-spend' && liveWindows.length === 0

  useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const ctx = getLiveContextUsage()
  const ctxPct = ctx.usedPct != null ? Math.round(ctx.usedPct) : null

  const trace = useTelemetry().trace
  const traceLive = trace?.state === 'live'
  const traceTotal = traceLive ? trace.data.total : 0
  const recent = traceLive ? trace.data.records.slice(-TRACE_ROWS).reverse() : []

  const tasks = useAppState((s: AppState) => s.tasks) as Record<string, TaskState> | undefined
  const runningWf = Object.values(tasks ?? {}).filter(
    (t): t is TaskState => !!t && t.type === 'local_workflow' && t.status === 'running',
  )
  const wfDisk = useTelemetry().workflowsDisk
  const localRunIds = new Set(
    runningWf.map(t => (t as { workflowRunId?: string }).workflowRunId ?? ''),
  )
  const externalWf = partitionDiskRuns(wfDisk, localRunIds, now, pidAlive).external

  const usageNodes: React.ReactNode[] = []
  usageNodes.push(
    <Box key="usage:source" width={rowW}>
      <Text wrap="truncate-end">
        <Text color={tok.textMuted}>{'  '}</Text>
        <Text color={tok.textMuted}>{usage.label}</Text>
      </Text>
    </Box>,
  )
  if (usage.shape === 'api-spend') {
    usageNodes.push(
      ((): React.ReactNode => {
        const i = sel({ kind: 'command', command: '/usage', label: 'usage:spend' })
        return (
          <TelemetryRow key="usage:spend" label="usage:spend" index={i} selected={isOn(i)} width={rowW}>
            <Text wrap="truncate-end">
              {caret(i)}
              <Text color={tok.textMuted}>{'spend '}</Text>
              <Text color={tok.textSecondary}>
                {usage.spend.models > 0 ? `${formatLaneSpend(usage.spend)} session` : 'none yet'}
              </Text>
            </Text>
          </TelemetryRow>
        )
      })(),
    )
    const credits = usageCreditsLine(usage.credits, now, 'compact')
    if (credits !== undefined) {
      usageNodes.push(
        <Box key="usage:credits" width={rowW}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{`  ${credits}`}</Text>
          </Text>
        </Box>,
      )
    }
  } else if (usageEmpty && usage.sourceKind === 'none') {
    usageNodes.push(<EmptyHint key="usage:whynot" text={usage.whyNot ?? 'not connected'} width={rowW} />)
  } else if (usageEmpty && usage.absence) {
    usageNodes.push(<EmptyHint key="usage:absence" text={usage.absence} width={rowW} />)
  } else if (usageEmpty) {
    usageNodes.push(<EmptyHint key="usage:none" text={`${NO_USAGE_READ_WORDS} · fills after first reply`} width={rowW} />)
  } else {
    const windowCommand = usage.provider === 'anthropic' ? '/deck' : '/usage'
    const meterRows: Array<{ w: UsageWindowView; pool: boolean }> = [
      ...liveWindows.map(w => ({ w, pool: false })),
      ...usage.pools.filter(w => w.state === 'live').map(w => ({ w, pool: true })),
    ]
    for (const { w, pool } of meterRows) {
      usageNodes.push(
        ((): React.ReactNode => {
          const i = sel({ kind: 'command', command: windowCommand, label: `usage:${w.key}` })
          return (
            <TelemetryRow key={`usage:${w.key}`} label={`usage:${w.key}`} index={i} selected={isOn(i)} width={rowW}>
              <Text wrap="truncate-end">
                {caret(i)}
                <UsageMeter
                  compact
                  window={w.label}
                  state="live"
                  value={w.usedPct ?? undefined}
                  resetIn={meterTail(w, pool)}
                />
              </Text>
            </TelemetryRow>
          )
        })(),
      )
    }
  }
  if (usage.limited !== undefined) {
    usageNodes.push(
      <Box key="usage:limited" width={rowW}>
        <Text wrap="truncate-end">
          <Text color={tok.warning}>
            {`  limit reached · resets ${formatCountdown(usage.limited.resetsAtMs - now)}`}
          </Text>
        </Text>
      </Box>,
    )
  }
  for (const other of otherUsages) {
    const otherCommand = other.provider === 'anthropic' ? '/deck' : '/usage'
    usageNodes.push(
      <Box key={`usage:other:${other.provider}`} width={rowW}>
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>{`  ${other.label}`}</Text>
        </Text>
      </Box>,
    )
    const otherRows: Array<{ w: UsageWindowView; pool: boolean }> = [
      ...other.windows.filter(x => x.state === 'live').map(w => ({ w, pool: false })),
      ...other.pools.filter(x => x.state === 'live').map(w => ({ w, pool: true })),
    ]
    for (const { w, pool } of otherRows) {
      usageNodes.push(
        ((): React.ReactNode => {
          const i = sel({ kind: 'command', command: otherCommand, label: `usage:${other.provider}:${w.key}` })
          return (
            <TelemetryRow key={`usage:${other.provider}:${w.key}`} label={`usage:${other.provider}:${w.key}`} index={i} selected={isOn(i)} width={rowW}>
              <Text wrap="truncate-end">
                {caret(i)}
                <UsageMeter
                  compact
                  window={w.label}
                  state="live"
                  value={w.usedPct ?? undefined}
                  resetIn={meterTail(w, pool)}
                />
              </Text>
            </TelemetryRow>
          )
        })(),
      )
    }
  }
  {
    const act = usageActivityBins(now)
    if (act.pulses >= 2) {
      usageNodes.push(
        <Box key="usage:activity" width={rowW}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{'  1h '}</Text>
            <Sparkline values={act.perBin} />
          </Text>
        </Box>,
      )
    }
  }
  if (ctx.window > 0) {
    const turns = ctxForecastEnabled()
      ? estimateTurnsToCompact(ctx.usedPct, ctx.compactAtPct)
      : null
    usageNodes.push(
      ((): React.ReactNode => {
        const i = sel({ kind: 'command', command: '/deck', label: 'ctx' })
        return (
      <TelemetryRow key="usage:ctx" label="ctx" index={i} selected={isOn(i)} width={rowW}>
        <Text wrap="truncate-end">
          {caret(i)}
          <Text color={tok.textMuted}>{'ctx '}</Text>
          {ctxPct != null ? (
            <ValueGlow value={ctxPct} color={gaugeColor(ctxPct)}>{contextPercentLabel(ctxPct, ctx.fillSource)}</ValueGlow>
          ) : (
            <Text color={tok.textMuted}>{'—'}</Text>
          )}
          {
}
          {turns == null ? (
            <Text color={tok.textMuted}>{` · ${contextWindowLabel(ctx.window, ctx.windowSource)}`}</Text>
          ) : null}
          {turns != null ? (
            <Text color={turns <= 2 ? gaugeColor(95) : tok.textMuted}>{` · ≈${turns} turns`}</Text>
          ) : null}
        </Text>
      </TelemetryRow>
        )
      })(),
    )
    const growth = ctxGrowthHistory()
    if (growth.length >= 2) {
      usageNodes.push(
        <Box key="usage:ctx:trend" width={rowW}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{'  /turn '}</Text>
            <Sparkline values={[...growth]} />
          </Text>
        </Box>,
      )
    }
  }

  const wfNodes: React.ReactNode[] = []
  if (runningWf.length === 0 && externalWf.length === 0) {
    wfNodes.push(<EmptyHint key="wf:idle" text="idle" width={rowW} />)
  } else if (runningWf.length > 0) {
    type WfProgEvent = {
      type: string
      title?: string
      state?: string
      phaseTitle?: string
    }
    const lead = runningWf[0] as TaskState & {
      workflowProgress?: WfProgEvent[]
      agentCount?: number
    }
    const leadProg: WfProgEvent[] = lead.workflowProgress ?? []
    const leadAgents = leadProg.filter((e: WfProgEvent) => e.type === 'workflow_agent')
    const leadDone = leadAgents.filter((e: WfProgEvent) => e.state === 'done').length
    const leadPhase =
      [...leadAgents].reverse().find(e => e.phaseTitle)?.phaseTitle ??
      [...leadProg].reverse().find(e => e.type === 'workflow_phase')?.title
    const leadDetail =
      leadAgents.length > 0
        ? `${leadDone}/${leadAgents.length} agent${leadAgents.length === 1 ? '' : 's'}${leadPhase ? ` · ${leadPhase}` : ''}`
        : leadPhase ?? null
    for (const [i, t] of runningWf.slice(0, WF_ROWS).entries()) {
      const asks = (t as { pendingPermissions?: Map<string, unknown> }).pendingPermissions?.size ?? 0
      const wfKey = `wf:${(t as { id?: string }).id ?? `pos${i}`}`
      wfNodes.push(
        ((): React.ReactNode => {
          const ri = sel({ kind: 'command', command: '/workflows', label: wfKey })
          return (
        <TelemetryRow key={wfKey} label={wfKey} index={ri} selected={isOn(ri)} width={rowW}>
          <Text wrap="truncate-end">
            {caret(ri)}
            {
}
            <WorkingGlyph color={asks > 0 ? tok.warning : tok.success} active={asks === 0} />
            <Text> </Text>
            <Text color={tok.textPrimary}>
              {truncateToWidth(workflowLabel(t), Math.max(3, rowW - 4 - (asks > 0 ? 8 : 0)))}
            </Text>
            {asks > 0 ? (
              <AttentionPulse>{` ${asks} ask${asks > 1 ? 's' : ''}`}</AttentionPulse>
            ) : null}
          </Text>
        </TelemetryRow>
          )
        })(),
      )
      if (i === 0 && leadDetail) {
        wfNodes.push(
          <Box key="wf:detail" width={rowW}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{'    '}</Text>
              <Text color={tok.textMuted}>
                {truncateToWidth(`${GLYPH.turns} ${leadDetail}`, Math.max(3, rowW - 4))}
              </Text>
            </Text>
          </Box>,
        )
      }
    }
    if (runningWf.length > WF_ROWS) {
      wfNodes.push(
        ((): React.ReactNode => {
          const i = sel({ kind: 'command', command: '/workflows', label: 'wf:more' })
          return (
            <EmptyHint
              key="wf:more"
              text={`+${runningWf.length - WF_ROWS} more`}
              width={rowW}
              selected={isOn(i)}
              label="wf:more"
              index={i}
            />
          )
        })(),
      )
    }
  }
  for (const m of externalWf.slice(0, WF_ROWS)) {
    const extKey = `wf:ext:${m.runId}`
    wfNodes.push(
      ((): React.ReactNode => {
        const ri = sel({ kind: 'command', command: '/workflows', label: extKey })
        return (
      <TelemetryRow key={extKey} label={extKey} index={ri} selected={isOn(ri)} width={rowW}>
        <Text wrap="truncate-end">
          {caret(ri)}
          <Text color={m.liveness === 'wedged' ? tok.warning : tok.textMuted}>{`${GLYPH.pending} `}</Text>
          <Text color={tok.textPrimary}>
            {truncateToWidth(m.workflowName ?? m.title ?? m.runId, Math.max(3, rowW - 16))}
          </Text>
          <Text color={m.liveness === 'wedged' ? tok.warning : tok.textMuted}>
            {m.liveness === 'wedged' ? ' wedged?' : ` elsewhere·${m.ownerPid}`}
          </Text>
        </Text>
      </TelemetryRow>
        )
      })(),
    )
  }

  const certChip = healthCertSnapshot()
  const certAlert = certChip.state === 'live' ? certChip.data.alert : undefined
  const RAIL_PANEL_CHROME = 3
  const sectionRows = (children: number): number => children + RAIL_PANEL_CHROME
  const shedCeiling = availRows ?? termRows - 7
  let spentRows =
    1 +
    
    sectionRows(usageNodes.length) +
    sectionRows(wfNodes.length)
  const fitsSection = (children: number): boolean =>
    spentRows + sectionRows(children) <= shedCeiling

  const healthRowsIntended = 1 + (certAlert ? 1 : 0)
  const healthShed = !fitsSection(healthRowsIntended)
  const healthNodes: React.ReactNode[] = healthShed ? [] : [
    ((): React.ReactNode => {
      const i = sel({ kind: 'command', command: '/health', label: 'health' })
      return (
    <TelemetryRow key="health:cert" label="health" index={i} selected={isOn(i)} width={rowW}>
      <Text wrap="truncate-end">
        {caret(i)}
        {certChip.state === 'live' && certChip.data.verdict !== null ? (
          <Text>
            {
}
            <Text color={tok.textMuted}>health </Text>
            {certChip.data.verdict === 'certified' ? (
              <Text color={tok.success}>{GLYPH.check} certified</Text>
            ) : certChip.data.verdict === 'caution' ? (
              <Text color={tok.warning}>{GLYPH.warn} caution</Text>
            ) : (
              <Text color={tok.failure}>{GLYPH.fail} fault</Text>
            )}
            <Text color={certChip.data.stale ? tok.warning : tok.textMuted}>
              {` · ${certChip.data.ageLabel.replace(' ago', '')}${certChip.data.stale ? ' stale' : ''}`}
            </Text>
          </Text>
        ) : (
          <Text color={tok.textMuted}>{`${GLYPH.read} no cert · /health`}</Text>
        )}
      </Text>
    </TelemetryRow>
      )
    })(),
    ...(certAlert
      ? [
          <Box key="health:alert" width={rowW}>
            <Text wrap="truncate-end">
              <Text color={tok.textMuted}>{'  '}</Text>
              {certAlert.tone === 'fault' ? (
                <Text color={tok.failure}>{`${GLYPH.fail} ${certAlert.text}`}</Text>
              ) : (
                <Text color={tok.textMuted}>{certAlert.text}</Text>
              )}
            </Text>
          </Box>,
        ]
      : []),
  ]
  if (!healthShed) spentRows += sectionRows(healthNodes.length)

  const traceRowsIntended = trace === null || recent.length === 0 ? 1 : recent.length
  const traceShed = !fitsSection(traceRowsIntended)
  const traceNodes: React.ReactNode[] = []
  if (!traceShed) {
    if (trace === null) {
      traceNodes.push(<EmptyHint key="trace:loading" text="loading…" width={rowW} />)
    } else if (recent.length === 0) {
      traceNodes.push(<EmptyHint key="trace:none" text="fills as tools run" width={rowW} />)
    } else {
      const seenTraceKeys = new Map<string, number>()
      for (const r of recent) {
        const bad = r.ok === false || r.killed === true
        const toolBudget = Math.max(3, rowW - 10)
        const baseKey = `trace:${r.ts}:${typeof r.tool === 'string' ? r.tool : '?'}`
        const dupes = seenTraceKeys.get(baseKey) ?? 0
        seenTraceKeys.set(baseKey, dupes + 1)
        const traceKey = dupes === 0 ? baseKey : `${baseKey}:${dupes}`
        traceNodes.push(
          ((): React.ReactNode => {
            const ri = sel({ kind: 'command', command: '/trace', label: traceKey })
            return (
          <TelemetryRow key={traceKey} label={traceKey} index={ri} selected={isOn(ri)} width={rowW}>
            <Text wrap="truncate-end">
              {caret(ri)}
              <Text color={tok.textMuted}>{`${hhmm(r.ts)} `}</Text>
              <Text color={bad ? tok.failure : tok.textPrimary}>
                {truncateToWidth(typeof r.tool === 'string' ? r.tool : '?', toolBudget)}
              </Text>
            </Text>
          </TelemetryRow>
            )
          })(),
        )
      }
    }
    spentRows += sectionRows(traceNodes.length)
  }

  const consoleShed = consoleOn && !fitsSection(1)
  const shedPointers = [
    ...(healthShed ? ['/health'] : []),
    ...(traceShed ? ['/trace'] : []),
    ...(consoleShed ? ['/console'] : []),
  ]
  const shedPointerFits = spentRows < shedCeiling

  const consoleNodes: React.ReactNode[] = []
  if (consoleOn && !consoleShed) {
    const inputIdx = sel({ kind: 'console', label: 'console:input' })
    const inputBudget = Math.max(4, rowW - 2)
    if (consoleComposing) {
      const win = consoleInputWindow(getConsoleBuffer(), getConsoleCursor(), inputBudget)
      consoleNodes.push(
        <TelemetryRow key="console:input" label="console:input" index={inputIdx} selected={isOn(inputIdx)} width={rowW}>
          <Text wrap="truncate-end">
            <Text color={accent}>{`${GLYPH.prompt} `}</Text>
            <Text color={tok.textPrimary}>{win.pre}</Text>
            <Text color={accent}>{GLYPH.caretBlock}</Text>
            <Text color={tok.textSecondary}>{win.post}</Text>
          </Text>
        </TelemetryRow>,
        <Box key="console:hint" width={rowW}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{'  ↵ ask · esc · ↑↓ hist'}</Text>
          </Text>
        </Box>,
      )
    } else {
      const draft = getConsoleBuffer()
      consoleNodes.push(
        <TelemetryRow key="console:input" label="console:input" index={inputIdx} selected={isOn(inputIdx)} width={rowW}>
          <Text wrap="truncate-end">
            {caret(inputIdx)}
            {draft ? (
              <Text color={tok.textSecondary}>{truncateToWidth(draft, inputBudget)}</Text>
            ) : (
              <Text color={tok.textMuted}>{isOn(inputIdx) ? 'ask — type or ↵' : 'ask anything…'}</Text>
            )}
          </Text>
        </TelemetryRow>,
      )
    }
    if (consolePending) {
      const secs = Math.max(0, Math.round((now - consolePending.startedAt) / 1000))
      consoleNodes.push(
        <Box key="console:asking" width={rowW}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{'  '}</Text>
            <WorkingGlyph color={tok.success} active />
            <Text> </Text>
            <Text color={tok.textPrimary}>{truncateToWidth(consolePending.question, Math.max(3, rowW - 10))}</Text>
            <Text color={tok.textMuted}>{` · ${secs}s`}</Text>
          </Text>
        </Box>,
      )
    }
    if (consoleLast && (consoleLast.answer || consoleLast.error)) {
      const rowsAbove =
        1 +
    
        (3 + usageNodes.length) +
        (3 + wfNodes.length) +
        (3 + healthNodes.length) +
        (3 + traceNodes.length) +
        3 +
        consoleNodes.length +
        2
      const CHROME_ROWS = 7
      const ceiling = availRows ?? termRows - CHROME_ROWS
      const answerBudget = Math.max(0, Math.min(9, ceiling - rowsAbove))
      consoleNodes.push(
        <Box key="console:q" width={rowW}>
          <Text wrap="truncate-end">
            <Text color={tok.textMuted}>{'  '}</Text>
            <Text color={tok.textMuted}>{truncateToWidth(`${GLYPH.dot} ${consoleLast.question}`, Math.max(3, rowW - 2))}</Text>
          </Text>
        </Box>,
      )
      let hidden = 0
      if (consoleLast.answer) {
        const lines = wrapPlain(plainifyAnswer(consoleLast.answer), Math.max(4, rowW - 2))
        const shown = lines.slice(0, answerBudget)
        hidden = lines.length - shown.length
        for (const [i, l] of shown.entries()) {
          consoleNodes.push(
            <Box key={`console:a:${i}`} width={rowW}>
              <Text wrap="truncate-end">
                <Text color={tok.textMuted}>{'  '}</Text>
                <Text color={tok.textPrimary}>{l === '' ? ' ' : l}</Text>
              </Text>
            </Box>,
          )
        }
      } else if (consoleLast.error) {
        const lines = wrapPlain(consoleLast.error, Math.max(4, rowW - 4)).slice(0, 2)
        for (const [i, l] of lines.entries()) {
          consoleNodes.push(
            <Box key={`console:err:${i}`} width={rowW}>
              <Text wrap="truncate-end">
                <Text color={tok.textMuted}>{'  '}</Text>
                <Text color={tok.failure}>{i === 0 ? `${GLYPH.fail} ` : '  '}{l === '' ? ' ' : l}</Text>
              </Text>
            </Box>,
          )
        }
      }
      const dur = consoleLast.durationMs != null ? `${Math.max(1, Math.round(consoleLast.durationMs / 1000))}s` : null
      const u = consoleLast.usage
      const toks = u ? `${fmtTok(u.in + u.cacheRead + u.cacheWrite)}→${fmtTok(u.out)}` : null
      const receipt = [
        ...(hidden > 0 ? [`${GLYPH.cursor} +${hidden}`] : []),
        ...(dur ? [dur] : []),
        ...(toks ? [toks] : []),
        '↵ full',
      ].join(' · ')
      consoleNodes.push(
        ((): React.ReactNode => {
          const i = sel({ kind: 'command', command: '/console', label: 'console:full' })
          return (
            <EmptyHint
              key="console:full"
              text={receipt}
              width={rowW}
              selected={isOn(i)}
              label="console:full"
              index={i}
            />
          )
        })(),
      )
    }
  }

  const rowsSig = rowsModel.map(helmRowSig).join('|')
  useEffect(() => {
    publishHelmRows('telemetry', rowsModel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsSig])

  return (
    <Box flexDirection="column" width={width}>
      {
}
      <Box width={width} height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          {
}
          <ValueGlow value={focused} color={focused ? accent : tok.textMuted} ms={CURSOR_NUDGE_MS}>
            {focused ? <Text bold>{`${GLYPH.prompt} `}</Text> : '  '}
          </ValueGlow>
          {focused ? (
            <>
              <Text color={accent} bold>{'telemetry'}</Text>
              <Text color={tok.textMuted}>{' · ↑↓ ↵ tab esc'}</Text>
            </>
          ) : (
            <Text color={tok.textMuted}>{'telemetry'}</Text>
          )}
        </Text>
      </Box>

      {}
      <RailPanel
        glyph={SPARK[5]}
        label="USAGE"
        width={width}
        headerAction={{ id: 'helm:panel:usage', run: () => requestCommandDispatch('/usage') }}
      >
        {usageNodes}
      </RailPanel>

      {}
      <RailPanel
        glyph={GLYPH.turns}
        label="WORKFLOW"
        count={
          runningWf.length + externalWf.length > 0
            ? String(runningWf.length + externalWf.length)
            : undefined
        }
        width={width}
        headerAction={{ id: 'helm:panel:workflow', run: () => requestCommandDispatch('/workflows') }}
      >
        {wfNodes}
      </RailPanel>

      {
}
      {healthShed ? null : (
        <RailPanel
          glyph={GLYPH.check}
          label="HEALTH"
          count={certChip.state === 'live' && certChip.data.verdict !== null ? certChip.data.ageLabel.replace(' ago', '') : undefined}
          width={width}
          headerAction={{ id: 'helm:panel:health', run: () => requestCommandDispatch('/health') }}
        >
          {healthNodes}
        </RailPanel>
      )}

      {
}
      {traceShed ? null : (
        <RailPanel
          glyph={GLYPH.trace}
          label="TRACE"
          count={`${traceTotal} · repo`}
          width={width}
          headerAction={{ id: 'helm:panel:trace', run: () => requestCommandDispatch('/trace') }}
        >
          {traceNodes}
        </RailPanel>
      )}

      {
}
      {consoleOn && !consoleShed ? (
        <RailPanel
          glyph={GLYPH.prompt}
          label="CONSOLE"
          count={consoleCount > 0 ? String(consoleCount) : undefined}
          width={width}
          headerAction={{ id: 'helm:panel:console', run: () => requestCommandDispatch('/console') }}
        >
          {consoleNodes}
        </RailPanel>
      ) : null}

      {
}
      {shedPointers.length > 0 && shedPointerFits ? (
        <Box width={width}>
          <Text wrap="truncate-end" color={tok.textMuted}>{`  ${GLYPH.cursor} short height — ${shedPointers.join(' · ')}`}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
