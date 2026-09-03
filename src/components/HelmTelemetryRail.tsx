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
import { crewAgentsOf, crewUsageLine } from '../services/engine-connector/crewFacts.js'
import { focusedSessionIdOrNull, useFocusedWorkRoster } from './tasks/useFocusedWork.js'
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

// ============================================================================
//  HelmTelemetryRail — the RIGHT rail of the A2.2 three-pane cockpit. A narrow
//  (~24-col) READ-ONLY column stacking three telemetry sections, each a header
//  + a few truncated rows:
//    · USAGE     — ACTIVE-SOURCE-AWARE gauges (activeSourceUsage() — the one
//                  usage owner the settings tab reads too): a quiet label
//                  names whose truth the meters tell, and the shape follows
//                  the source (Anthropic 5h/7d · OpenAI observed weekly ·
//                  API key = spend truth); honest-empty when nothing stated.
//    · TRACE     — the invocation-trace rollup (traceSnapshot() — the SAME async
//                  read TraceView uses): the `trace · N` count + the top 2 recent
//                  events (time · tool), NOT the full ActivityFeed table.
//    (The SUBSTRATE box left the rail: the
//    capability catalog is /substrate's surface, not a per-paint rail section.)
//
//  INTERACTIVE (A2.2 Phase-3): Tab cycles focus here (prompt → lanes →
//  telemetry); ↑↓ move the ❯ cursor, ↵ opens the row's OWNING surface (usage/
//  ctx → /deck, workflow → /workflows, trace → /trace),
//  esc returns to the prompt — the rail converts from poster to cockpit. The
//  KEYS live in PromptInput (the one input owner); this rail renders the ring/
//  caret and PUBLISHES its selectable row model to the helmFocus store. It
//  still adds NO telemetry producer — it only READS the existing snapshots.
//  HONESTY: each section renders an honest-empty hint when its source is
//  empty/off (e.g. `no trace yet`), never a fabricated row. Every colour binds
//  to a mercuryPalette token.
// ============================================================================

const TRACE_ROWS = 2
const WF_ROWS = 3

// The focused chat's main-model feed for the USAGE panel — the connector's
// model facts through the focused slot (the Spinner idiom): a hop re-points
// the slot, a queued switch settles in the facts, and both repaint the
// meters at once.
const subscribeFocusedRailModel = subscribeThroughFocused((connector, listener) =>
  connector.subscribeModel(listener),
)
const getFocusedRailModel = (): string => getFocusedSessionConnector().modelFacts().main

// The label the tasks/workflow menu shows for a run: workflowName → summary →
// description → a generic fallback. Same precedence WorkflowRunningIndicator uses,
// so the rail chip and the transcript indicator name a run identically.
function workflowLabel(t: TaskState): string {
  const w = t as TaskState & { workflowName?: string; summary?: string; description?: string }
  return w.workflowName ?? w.summary ?? w.description ?? 'workflow'
}

// HH:MM for a trace record's ISO `ts`; malformed/missing → an honest placeholder.
function hhmm(ts: unknown): string {
  if (typeof ts !== 'string') return '--:--'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// The ONE pointer adapter for telemetry rows (interaction-finish slice 3):
// InteractiveRow's select-then-activate over the helm focus model — a click
// on an unselected row moves the ❯ cursor here (setHelmCursor: pane focus +
// selection parity with ↑↓), a click on the selected row opens the row's
// owning surface (the exact ↵ meaning), and hover rides the single-owner
// store so exactly one row anywhere wears the fill.
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

// A tok.textMuted honest-empty hint line (e.g. `no trace yet`) — never a fabricated row.
// `selected` renders the rail cursor caret; passing `label`+`index` makes the
// row a REAL selectable (the '+N more' / receipt rows) with full pointer
// parity through TelemetryRow. Without them the line stays inert.
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

// React.memo boundary (perf audit): same shape as HelmLanesRail —
// parent commits blocked, own subscriptions (pane-scoped helm version, extra
// usage, fable, telemetry) still drive updates. Props: `width` + the measured
// `availRows` ceiling (changes only on real layout shifts — mount + resize).
export const HelmTelemetryRail = React.memo(HelmTelemetryRailImpl)

function HelmTelemetryRailImpl({
  width,
  availRows,
}: {
  width: number
  /** MEASURED rail height (FullscreenLayout measureElement on the rail's
   *  wrapper Box) — the honest budget ceiling for the console answer block.
   *  The old `termRows - CHROME_ROWS(7)` guess under-counted the variable
   *  bottom block (SESSIONS card + prompt + hints + alarm bands), so the rail
   *  over-allocated and the column's overflow:hidden clipped its OWN tail —
   *  eating exactly the `▸ +N · ↵ full` receipt row that routes to /console
   *  (an operator screenshot: answer cut mid-sentence, no
   *  continuation cue). Optional: pre-measurement frames fall back to the
   *  legacy estimate. */
  availRows?: number
}): React.ReactNode {
  fluxMark('render:rail-telemetry')
  const tok = useMercuryTokens()
  // A2.2 Phase-3 focus model (see HelmLanesRail — same version-snapshot pattern;
  // the KEYS live in PromptInput, this rail renders the ring/caret + publishes
  // its selectable row model).
  useSyncExternalStore(subscribeHelmFocus, getHelmTelemetryVersion, getHelmTelemetryVersion)
  const focused = getHelmFocus() === 'telemetry'
  const cur = getHelmCursor('telemetry')
  const { accent } = useSessionAccent()
  // BOXED sections (panel pass): this rail only mounts in the WIDE
  // both-rails zone (railPlan ≥150 cols), so every section wears the RailPanel
  // card unconditionally. Rows are built at the panel's interior width.
  const rowW = railPanelInnerWidth(width)
  const rowsModel: HelmRow[] = []
  const sel = (row: HelmRow): number => {
    rowsModel.push(row)
    return rowsModel.length - 1
  }
  const isOn = (i: number): boolean => focused && cur === i
  // The 2-char row prefix: the rail cursor caret when selected, else the indent.
  const caret = (i: number): React.ReactNode => (
    <Text color={accent}>{isOn(i) ? `${GLYPH.prompt} ` : '  '}</Text>
  )

  // --- USAGE: ACTIVE-SOURCE-AWARE (model-truth lane): the meters
  // tell the usage of whatever account source is actively serving THIS
  // session, and a quiet label names WHICH truth it is. Shapes follow the
  // source honestly — Anthropic subscription: the 5h/7d windows; OpenAI
  // subscription: its live-observed bands (the weekly meter; no 5h row);
  // an active API key: billing/spend truth (no subscription bars exist for
  // a key — a bar would be fabricated). ONE derivation
  // (providerUsage.windowSourceUsages — the same stores the dispatch-side
  // cap-failover/429-pause logic reads), recomputed at render: source
  // switches repaint to the new source's shape, never a stale bar.
  // THE FOCUS ROAD (operator-sighted; re-trued): the
  // panel follows the FOCUSED chat's model — the CONNECTOR's model facts,
  // the same source MercuryFrame's usage meter reads. The first cut read
  // AppState's mainLoopModelForSession, which only LOCAL roads write (the
  // /model transition) — a daemon-hosted chat entered by
  // hop never fed it, so a focused GPT session still painted the
  // cockpit-local default's Anthropic windows (the overnight re-sighting).
  // Beside the focused source, every other logged-in window-metered account
  // with signal paints its own rows, the focused provider's first
  // (prove-usage-follows-focus).
  const sessionModel = useSyncExternalStore(
    subscribeFocusedRailModel,
    getFocusedRailModel,
    getFocusedRailModel,
  )
  // The meters repaint the instant the first-party record changes (a
  // /usage sample, a reply's headers, a reset) — not on the next 30s tick.
  useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  const { primary: usage, others: otherUsages } = windowSourceUsages({ model: sessionModel })
  const liveWindows = usage.windows.filter(w => w.state === 'live')
  // The focused session's crew — its sub-agents' settled tokens ride the
  // USAGE section as an attribution line (the ONE crew record, crewFacts
  // over the session's own work roster).
  const workRoster = useFocusedWorkRoster()
  // --- CONSOLE (MERCURY_HELM_CONSOLE): the cockpit mini-REPL, the rail's last section.
  // Version-subscribed to its module store (helmConsole.ts — the same
  // useSyncExternalStore idiom as the pane focus above); all reads below are
  // post-subscription getters. The section costs ZERO tokens until ↵.
  useSyncExternalStore(subscribeConsole, getConsoleVersion, getConsoleVersion)
  const consoleOn = consoleEnabled()
  const consoleComposing = consoleOn && isConsoleComposing()
  const consolePending = consoleOn ? getConsolePending() : null
  const consoleLast = consoleOn ? getConsoleEntries().at(-1) : undefined
  const consoleCount = consoleOn ? getConsoleAskCount() : 0
  // Real terminal height — the console answer block budgets itself against
  // what is actually left below the sections above it (never a guess).
  const { rows: termRows } = useTerminalSize()
  // A slow 30s tick keeps the reset countdowns + staleness checks MOVING
  // between re-renders — `Date.now()` at render froze them until something
  // else happened to repaint the rail (the "static countdown" flatness).
  // While a console ask is in flight the tick tightens to 1s so its elapsed
  // counter moves (useNowTick handles a changing interval).
  const now = useNowTick(consolePending ? 1000 : 30_000)
  // A meter row's tail: the reset countdown while the read is live; the
  // STALE mark with the read's age once it is older than its reader's own
  // horizon (usageFreshness — never a stale number painted as live). The
  // per-model pool rows carry longer labels than '5h', so their countdown
  // is the coarse spelling (days/hours) to keep the row inside the rail.
  const meterTail = (w: UsageWindowView, pool: boolean): string | undefined => {
    const stale = usageStaleTail(w, now)
    if (stale !== undefined) return stale
    if (w.resetsAtMs == null) return undefined
    return pool ? formatCountdownCoarse(w.resetsAtMs - now) : formatCountdown(w.resetsAtMs - now)
  }
  const usageEmpty = usage.shape !== 'api-spend' && liveWindows.length === 0

  // --- CTX: the live context-window fill. MercuryFrame publishes it every render
  // (it has `messages`); the deck would otherwise own this gauge, but the cockpit replaces
  // the deck, so the telemetry rail carries the ctx signal here — the cue that
  // staves off surprise auto-compaction. Read at render (the rail repaints per
  // message via its `center` prop), no poll. Null until the frame renders once.
  // Subscribed to the publish version, so a window landing from a catalogue
  // or a usage arriving repaints the row at once.
  useSyncExternalStore(subscribeLiveContextUsage, getLiveContextUsageVersion, getLiveContextUsageVersion)
  const ctx = getLiveContextUsage()
  const ctxPct = ctx.usedPct != null ? Math.round(ctx.usedPct) : null

  // --- TRACE: the invocation-trace sidecar (TraceView's async source). Read once
  // on mount; null while loading. Only the count + the top 2 recent events here —
  // the full ActivityFeed / by-tool rollup live in the /trace view.
  // LIVE via the shared telemetry bus (reactive-substrate Phase 3c) — this rail
  // would otherwise read the trace once on mount and stay stale for the whole session.
  const trace = useTelemetry().trace
  const traceLive = trace?.state === 'live'
  const traceTotal = traceLive ? trace.data.total : 0
  // Newest events last in the sidecar → take the tail, show newest-first.
  const recent = traceLive ? trace.data.records.slice(-TRACE_ROWS).reverse() : []

  // --- WORKFLOW: live local_workflow runs (WorkflowRunningIndicator's source), as a
  // persistent rail chip so a running workflow never scrolls out of view in the
  // cockpit (the transcript indicator scrolls away). ↵ opens /workflows.
  const tasks = useAppState((s: AppState) => s.tasks) as Record<string, TaskState> | undefined
  const runningWf = Object.values(tasks ?? {}).filter(
    (t): t is TaskState => !!t && t.type === 'local_workflow' && t.status === 'running',
  )
  // Cross-process honesty (trust-cockpit): a run owned by ANOTHER live process
  // (a daemon fire, a second session) would otherwise be cockpit-invisible here — the
  // rail read only this process's AppState. The telemetry bus now carries the
  // disk manifests; partitionDiskRuns dedups vs the local runIds and keeps
  // only alive-elsewhere ('live') or hung-elsewhere ('wedged') claims.
  const wfDisk = useTelemetry().workflowsDisk
  const localRunIds = new Set(
    runningWf.map(t => (t as { workflowRunId?: string }).workflowRunId ?? ''),
  )
  const externalWf = partitionDiskRuns(wfDisk, localRunIds, now, pidAlive).external

  // ---- Node builders (imperative, in VISUAL order — hooks below need the row
  // model complete before render returns, and sel() order must match the eye).
  const usageNodes: React.ReactNode[] = []
  // The quiet source label — WHICH truth the meters below tell ('Anthropic
  // usage' · 'OpenAI usage' · 'API usage'). Display-only, never selectable.
  usageNodes.push(
    <Box key="usage:source" width={rowW}>
      <Text wrap="truncate-end">
        <Text color={tok.textMuted}>{'  '}</Text>
        <Text color={tok.textMuted}>{usage.label}</Text>
      </Text>
    </Box>,
  )
  if (usage.shape === 'api-spend') {
    // An active API key: billing truth for the key — session spend, never a
    // fabricated subscription bar. ↵ opens the full Usage tab.
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
    // The key's credit balance as the provider states it — or the honest
    // "not reported" — from the ONE owner (the same line the tab and the
    // doctor carry, in the rail's compact spelling).
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
    // Nothing connected on the active lane: the honest why-not from the ONE
    // usage owner — the same truth the settings tab's not-connected line
    // tells, so the rail and the tab can never split over the same family
    // (the operator's frame). A "fills after first reply" hint
    // here would promise data a signed-out lane cannot produce.
    usageNodes.push(<EmptyHint key="usage:whynot" text={usage.whyNot ?? 'not connected'} width={rowW} />)
  } else if (usageEmpty && usage.absence) {
    // A connected source that meters nothing (local servers): the honest
    // line, never a "fills later" promise that can never come true.
    usageNodes.push(<EmptyHint key="usage:absence" text={usage.absence} width={rowW} />)
  } else if (usageEmpty) {
    // A connected source whose meters genuinely fill later (a subscription
    // lane before its first observed response): the one no-read spelling,
    // and WHEN it fills.
    usageNodes.push(<EmptyHint key="usage:none" text={`${NO_USAGE_READ_WORDS} · fills after first reply`} width={rowW} />)
  } else {
    // Subscription windows in the source's own shape: the first-party
    // subscription serves 5h + 7d AND its per-model weekly pools (Fable ·
    // Opus · Sonnet — folded into the same block, the shared pair first);
    // OpenAI serves what it stated (the weekly band — no 5h row). Row
    // labels/keys ride the window key so a source switch republishes an
    // honest row model. ↵ opens the owning surface per provider.
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
  // The crew's share of the session's usage: the sub-agents' settled tokens
  // from the ONE crew record. They are IN the session total (the runner's
  // ledger folds every response its process settles, a sub-agent's
  // included); this line attributes them. Display-only, never selectable.
  const crewLine = crewUsageLine(crewAgentsOf(workRoster.rows, focusedSessionIdOrNull()))
  if (crewLine !== null) {
    usageNodes.push(
      <Box key="usage:crew" width={rowW}>
        <Text wrap="truncate-end">
          <Text color={tok.textMuted}>{`  ${crewLine}`}</Text>
        </Text>
      </Box>,
    )
  }
  // A reached limit on the active source: one quiet warning line with the
  // observed reset — real observations only (the openaiLimitState law).
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
  // The OTHER logged-in window-metered accounts (the ruled design): each
  // with signal paints its quiet source label, its live windows and its
  // per-model pools after the focused source's rows — all accounts
  // visible, the focused one first and emphasized by position.
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
  // Recent usage activity (interaction-finish slice 3): the session's REAL
  // spend pulse — one point per settled API response (usageActivity records
  // at the cost-tracker seam; no polling). Requires ≥2 real pulses in the
  // hour window; below that the strip renders NOTHING (honest quiet).
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
    // P7 ctx-forecast (MERCURY_CTX_FORECAST=1): '≈N turns' to the autocompact
    // threshold, from the sampled growth rate — the cue that staves off a
    // SURPRISE compaction. Honest-null during warmup/no-growth (renders nothing).
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
            // change-flash: the fill that silently climbs ACKNOWLEDGES each move;
            // ≈ marks a character estimate (no wire usage yet)
            <ValueGlow value={ctxPct} color={gaugeColor(ctxPct)}>{contextPercentLabel(ctxPct, ctx.fillSource)}</ValueGlow>
          ) : (
            <Text color={tok.textMuted}>{'—'}</Text>
          )}
          {/* Width budget (rail is 23 wide): pct + winK + '≈N turns' is
              24-27 cols and truncates mid-word (audit C5). The window size is
              the least session-specific datum, so the forecast REPLACES it:
              'ctx 34% · ≈3 turns' (18) vs 'ctx 34% · 200k' (14). A ~ before
              the size marks the labelled conservative default window. */}
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
    // Context-use history (interaction-finish slice 3): the forecast's OWN
    // sampled per-turn appetite deltas, as a strip beside the estimate —
    // the same series the '≈N turns' averages, never a second derivation.
    // ≥2 real growth steps required (matches the estimate's honest-null).
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
    // Live run interior for the LEAD run (one bounded detail line): current
    // phase + agent progress, derived from the coalesced progress events the
    // /workflows inspector reads — the cockpit gets the run's pulse without
    // opening the board. Display-only (no row-model entry).
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
    // Fraction-FIRST (task #4b): the detail budget is rowW−4 (~18 cells at
    // the 24-col rail tier) under truncate-end — phase-first clipped the
    // FRACTION on any phase name >5 chars; the progress numbers are the datum,
    // the phase name is the garnish that may clip.
    const leadDetail =
      leadAgents.length > 0
        ? `${leadDone}/${leadAgents.length} agent${leadAgents.length === 1 ? '' : 's'}${leadPhase ? ` · ${leadPhase}` : ''}`
        : leadPhase ?? null
    for (const [i, t] of runningWf.slice(0, WF_ROWS).entries()) {
      // A run blocked on operator permission asks paints tok.warning with an
      // explicit "N ask(s)" suffix — waiting-on-you is a different state
      // than working, and must never render as a busy spinner.
      const asks = (t as { pendingPermissions?: Map<string, unknown> }).pendingPermissions?.size ?? 0
      // Stable interaction identity: the row's identity is the RUN, not its list position —
      // label/key/hover ride the task id so a workflow finishing above a
      // resting cursor can never hand its hover/selection/pending-click to a
      // different run.
      const wfKey = `wf:${(t as { id?: string }).id ?? `pos${i}`}`
      wfNodes.push(
        ((): React.ReactNode => {
          const ri = sel({ kind: 'command', command: '/workflows', label: wfKey })
          return (
        <TelemetryRow key={wfKey} label={wfKey} index={ri} selected={isOn(ri)} width={rowW}>
          <Text wrap="truncate-end">
            {caret(ri)}
            {/* running ⇒ the marker ROTATES; blocked-on-asks ⇒ it holds tok.warning
                (waiting is not working) and the ask count BREATHES for the eye */}
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
  // External runs render regardless of the local section's emptiness — they
  // are exactly the runs the operator would otherwise believe don't exist.
  for (const m of externalWf.slice(0, WF_ROWS)) {
    // Stable interaction identity: identity = the run id (see the wf rows above).
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

  // HEALTH — the /health certificate chip (docs/HEALTH-CERTIFICATE.md): the
  // persisted last-cert summary's verdict + AGE (the honesty signal — a cert
  // issued before a resume shows exactly how old its evidence is; > 24h reads
  // stale). `◌ no cert` is the honest never-issued state, not an error.
  // ↵ opens /health to re-certify. Sync snapshot — never blocks a render.
  // The chip is COMPOSED (healthCertCore.composeChip): a boot-preflight fault
  // or a newer gate verdict adds one alert row under it — newer evidence only
  // downgrades/annotates, never re-issues the certificate.
  const certChip = healthCertSnapshot()
  const certAlert = certChip.state === 'live' ? certChip.data.alert : undefined
  // ── HEIGHT-AWARE SHEDDING (short-wide cockpit; audit finding 3) ────────────
  // At legal short heights (~26–35 rows) the fixed sections overflow the
  // rail's measured box (flexShrink={0} inside overflow:hidden), clipping
  // whole sections while their SELECTABLE rows stayed published — the ❯
  // cursor could walk rows that were not on screen. Sections now shed in
  // reverse priority (CONSOLE → TRACE → HEALTH) against
  // the measured ceiling: a shed section's builder never runs, so it renders
  // nothing AND registers no selectable rows — the published model is exactly
  // the rendered rows. Everything shed folds into ONE honest pointer line.
  const RAIL_PANEL_CHROME = 3 // RailPanel rows: top border + header + bottom border
  const sectionRows = (children: number): number => children + RAIL_PANEL_CHROME
  // Same fallback shape as the console answer budget below (that literal is
  // proof-pinned in scripts/helm-console — keep both spellings).
  const shedCeiling = availRows ?? termRows - 7
  let spentRows =
    1 + // the RESERVED focus-banner row (always present — stable geometry)
    
    sectionRows(usageNodes.length) +
    sectionRows(wfNodes.length)
  const fitsSection = (children: number): boolean =>
    spentRows + sectionRows(children) <= shedCeiling

  // HEALTH — gated like the tail sections (intended rows derivable pre-build).
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
            {/* the ONE chip grammar: `health <glyph> <verdict> · <age>` — the
                noun stays on the row (a dropped noun leaves a bare
                '✕ fault' among noun-less magnitudes). */}
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
      // explain WHEN the data appears instead of "no X yet".
      traceNodes.push(<EmptyHint key="trace:none" text="fills as tools run" width={rowW} />)
    } else {
      // Stable interaction identity: a trace row's identity is the CALL (ts+tool), not its
      // ring position — new calls pushing the ring can never slide
      // hover/selection onto a different entry. Same-ts+tool duplicates get
      // an ordinal suffix so labels stay unique (labels ARE the row keys).
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
  // (Shed sections share ONE combined pointer line — its row is the reserve
  // subtracted from shedCeiling above, so it never adds to spentRows.)

  // CONSOLE sheds last (it is the interactive mini-REPL): only when even its
  // minimum (input row + panel chrome) cannot fit. /console stays the full
  // surface either way.
  const consoleShed = consoleOn && !fitsSection(1)
  // The combined pointer for everything shed — 1 row; rendered only when its
  // row is actually inside the ceiling (an exactly-full rail shows nothing
  // rather than a clipped line).
  const shedPointers = [
    ...(healthShed ? ['/health'] : []),
    ...(traceShed ? ['/trace'] : []),
    ...(consoleShed ? ['/console'] : []),
  ]
  const shedPointerFits = spentRows < shedCeiling

  // ---- CONSOLE (the mini-REPL, LAST section — "under substrate"). Rows:
  //   input  — ❯ + live buffer with a ▌ block cursor while composing, the
  //            draft/placeholder otherwise. ↵/typing enters compose IN PLACE.
 // hint — compose-only key legend -honest: only while armed).
  //   asking — WorkingGlyph + the pending question + a moving elapsed.
  //   answer — the latest entry: tok.textMuted question echo, wrapped plain-text
  //            lines (height-budgeted against the REAL terminal), and one
  //            selectable receipt row (tokens→out · ↵ full → /console).
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
      // Height budget for the answer: what the rail ACTUALLY has left after
      // every row above (banner + five sections + console chrome). The console
      // is the last section, so a lean budget degrades to fewer lines — never
      // to clipping a section above. Panel-tier accounting:
      // every section is a RailPanel card — 2 border rows + 1 header row +
      // its nodes, no inter-section margins.
      const rowsAbove =
        1 + // the RESERVED focus-banner row (always present — stable geometry)
    
        (3 + usageNodes.length) +
        (3 + wfNodes.length) +
        (3 + healthNodes.length) +
        (3 + traceNodes.length) +
        3 + // console panel border + header
        consoleNodes.length +
        2 // question echo + receipt row
      // Ceiling: the MEASURED rail height when FullscreenLayout has one
      // (honest — tracks the real bottom block), else the legacy estimate for
      // the pre-measurement frame. Floor 0, not 2: when the terminal is that
      // tight the receipt row (`▸ +N · ↵ full`) IS the answer surface — it
      // must never be the row that clips.
      const CHROME_ROWS = 7 // legacy fallback: frame band + tab strip + prompt block
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
      // ONE selectable receipt row: duration + tokens (prompt→out) + the
      // ↵-full affordance (opens the /console overlay — full Markdown +
      // history). Truncation surfaces as an honest `+N`.
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

  // Publish the selectable model (signature-compared in the store — no loop).
  const rowsSig = rowsModel.map(helmRowSig).join('|')
  useEffect(() => {
    publishHelmRows('telemetry', rowsModel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsSig])

  return (
    <Box flexDirection="column" width={width}>
      {/* Focus banner — the visible focus ring for the rail (accent ❯ + keys).
          The ROW IS RESERVED permanently (the stable-
          geometry law): focusing must never INSERT this row — an inserted row
          shifts every rail row down one, and the second click of the
          select-then-activate contract
          lands on the wrong row. Unfocused it carries a calm tok.textMuted label;
          only the CONTENT changes on focus, never the geometry. */}
      <Box width={width} height={1} flexShrink={0}>
        <Text wrap="truncate-end">
          {/* LUSTRE L6 — the focus-LANDING beat (the lanes-rail idiom): the
              ❯ slot rides ValueGlow on the cursor-nudge beat; the unfocused
              slot is blank, so only the GAIN flashes. */}
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

      {/* USAGE — header click opens /usage (the full usage detail). */}
      <RailPanel
        glyph={SPARK[5]}
        label="USAGE"
        width={width}
        headerAction={{ id: 'helm:panel:usage', run: () => requestCommandDispatch('/usage') }}
      >
        {usageNodes}
      </RailPanel>

      {/* WORKFLOW — header click opens the /workflows board. */}
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

      {/* HEALTH — the /health certificate chip (verdict + evidence age).
          Sheds into the pointer line at short heights. */}
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

      {/* TRACE — '· repo': the count is PROJECT-scoped (other sessions'
          entries included), not this-session (uniqueness-program D5 label).
          SHED at short heights: folded into the one pointer line below,
          zero selectable rows. */}
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

      {/* CONSOLE — the cockpit mini-REPL (MERCURY_HELM_CONSOLE; =0 removes the
          section entirely). Usage is spent ONLY on an explicit ↵ — the /btw
          side-question fork, cache-hit prefix, no tools, one turn. Sheds last
          (interactive) — /console remains the full surface. */}
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

      {/* Everything shed at this height folds into ONE honest pointer line —
          rendered only when its own row fits inside the measured ceiling. */}
      {shedPointers.length > 0 && shedPointerFits ? (
        <Box width={width}>
          <Text wrap="truncate-end" color={tok.textMuted}>{`  ${GLYPH.cursor} short height — ${shedPointers.join(' · ')}`}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
