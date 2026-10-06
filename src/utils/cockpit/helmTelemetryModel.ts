import { formatClock, formatCountdown, formatCountdownCoarse } from './quota.js'
import {
  scheduledUsageLine,
  usageCarryWords,
  usageCreditsLine,
  usageViewIsStale,
  usageWindowReached,
  type ActiveSourceUsage,
  type UsageWindowView,
} from '../../services/providers/providerUsage.js'
import { providerIdentityLine } from '../../services/providers/providerIdentityLine.js'
import { localWindowReasonTag } from '../../services/providers/local/localWindow.js'
import { openrouterSlots } from '../../services/providers/accountSlots.js'
import { NO_USAGE_READ_WORDS, usageAgeTail, usageAgeWords } from '../../services/providers/usageFreshness.js'
import { formatLaneSpend } from '../../cost-tracker.js'
import { crewAgentsOf, crewUsageLine } from '../../services/engine-connector/crewFacts.js'
import { WORK_UNREPORTED_MARK, workUnreported } from '../../services/engine-connector/workCounts.js'
import type { WorkRosterV1, WorkRowV1 } from '../../services/engine-connector/types.js'
import { workflowRowDetail } from '../../components/tasks/workflowRollup.js'
import { contextPercentLabel, contextWindowLabel } from '../contextFill.js'
import type { LiveContextUsage } from './contextUsageLive.js'
import type { ComposedCertChip } from '../healthCertCore.js'
import type { Snapshot } from './types.js'
import type { TraceData } from './traceSnapshot.js'
import type { ConsoleEntry } from './helmConsole.js'
import { consoleInputWindow, fmtTok, plainifyAnswer, wrapPlain } from './helmConsoleText.js'
import { GLYPH, truncateToWidth } from '../../components/mercury-ui/glyphs.js'
import { AMBER, CRIMSON, TEAL } from '../../components/mercury-ui/theme.js'
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js'
import { railPanelInnerWidth } from '../../components/mercury-ui/RailPanel.js'
import type { HelmRow } from './helmFocus.js'
import type { MercuryThemeTokens } from '../mercuryTokens.js'

export const TRACE_ROWS = 2
export const WF_ROWS = 3

export function hhmm(ts: unknown): string {
  if (typeof ts !== 'string') return '--:--'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '--:--'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export type TelemetryRowSpec =
  | { kind: 'text'; key: string; text: string; color: string; fixed?: boolean }
  | { kind: 'empty'; key: string; text: string; row?: HelmRow }
  | { kind: 'meter'; key: string; window: string; value: number | undefined; resetIn: string | undefined; row: HelmRow }
  | { kind: 'spend'; key: string; value: string; row: HelmRow }
  | { kind: 'ctx'; key: string; pct: number | null; pctLabel: string; color: string; tail: string; tailColor: string; row: HelmRow }
  | { kind: 'spark'; key: string; label: string; values: number[] }
  | { kind: 'wf'; key: string; name: string; asks: number; row: HelmRow }
  | { kind: 'wfdetail'; key: string; text: string }
  | { kind: 'wfext'; key: string; name: string; wedged: boolean; tail: string; row: HelmRow }
  | { kind: 'health'; key: string; verdict: 'certified' | 'caution' | 'fault' | null; age: string; stale: boolean; row: HelmRow }
  | { kind: 'healthAlert'; key: string; text: string; fault: boolean }
  | { kind: 'trace'; key: string; clock: string; tool: string; bad: boolean; row: HelmRow }
  | { kind: 'consoleInput'; key: string; composing: { pre: string; post: string } | null; draft: string; row: HelmRow }
  | { kind: 'consoleAsking'; key: string; question: string; secs: number }
  | { kind: 'consoleLine'; key: string; text: string; tone: 'question' | 'answer' | 'errorLead' | 'errorRest' }

export type TelemetrySectionSpec = {
  key: 'usage' | 'workflow' | 'health' | 'trace' | 'console'
  glyph: string
  label: string
  count?: string
  open: string
  rows: TelemetryRowSpec[]
}

export type TelemetryInput = {
  width: number
  availRows: number | undefined
  termRows: number
  sessionModel: string
  usage: ActiveSourceUsage
  otherUsages: readonly ActiveSourceUsage[]
  workRoster: WorkRosterV1
  focusedSessionId: string | null
  runningWf: readonly WorkRowV1[]
  externalWf: ReadonlyArray<{ runId: string; ownerPid: number; liveness: 'live' | 'wedged'; workflowName?: string; title?: string }>
  ctx: LiveContextUsage
  ctxTurns: number | null
  ctxGrowth: readonly number[]
  activity: { pulses: number; perBin: number[] }
  trace: Snapshot<{ data: TraceData }> | null
  cert: Snapshot<{ data: ComposedCertChip }>
  console: {
    on: boolean
    composing: boolean
    buffer: string
    cursor: number
    pending: { question: string; startedAt: number } | null
    last: ConsoleEntry | undefined
    count: number
  }
  now: number
  readNow: number
  tok: MercuryThemeTokens
}

export type TelemetryModel = {
  rowW: number
  sections: TelemetrySectionSpec[]
  shed: Array<'health' | 'trace' | 'console'>
  pointer: string | null
  rows: HelmRow[]
  consoleOn: boolean
}

export function sessionTraceRecords(trace: Snapshot<{ data: TraceData }> | null, sessionId: string | null): TraceData['records'] {
  if (trace === null || trace.state !== 'live' || sessionId === null) return []
  return trace.data.records.filter(r => r.sessionId === sessionId)
}

export function buildTelemetryModel(input: TelemetryInput): TelemetryModel {
  const { tok, usage, otherUsages, readNow, now } = input
  const rowW = railPanelInnerWidth(input.width)
  const detailRows = (provider: ActiveSourceUsage['provider']): boolean => provider === 'moonshot' || provider === 'zai'
  const meterTail = (w: UsageWindowView, pool: boolean): string | undefined => {
    const age = usageAgeTail(w, readNow)
    if (age !== undefined && usageViewIsStale(w, readNow)) return age
    const reset = w.resetsAtMs == null ? undefined : pool ? formatCountdownCoarse(w.resetsAtMs - readNow) : formatCountdown(w.resetsAtMs - readNow)
    const tail = [reset, age].filter((part): part is string => part !== undefined).join(' ')
    return tail === '' ? undefined : tail
  }

  const usageRows: TelemetryRowSpec[] = []
  const muted = (key: string, text: string, fixed = false): void => {
    usageRows.push({ kind: 'text', key, text: `  ${text}`, color: tok.textMuted, fixed })
  }
  const appendKimiDetails = (w: UsageWindowView, key: string): void => {
    const details = [w.resetsAtMs !== undefined ? `resets ${formatClock(w.resetsAtMs)}` : undefined, usageAgeWords(w, readNow)].filter(
      (line): line is string => line !== undefined,
    )
    for (const [index, line] of details.flatMap(line => wrapPlain(line, rowW - 2)).entries()) muted(`${key}:detail:${index}`, line, true)
  }
  const identityLine = (source: ActiveSourceUsage, key: string): void => muted(key, providerIdentityLine(source.provider).text)
  const appendOpenrouterSlots = (source: ActiveSourceUsage, key: string): void => {
    if (source.provider !== 'openrouter') return
    for (const slot of openrouterSlots()) {
      const lines = [`${slot.kindLabel}${slot.active ? ' · active' : ''}`, ...(slot.stateNote ? [slot.stateNote] : [])]
      for (const [index, line] of lines.flatMap(text => wrapPlain(text, rowW - 2)).entries()) muted(`${key}:${slot.id}:${index}`, line, true)
    }
  }
  const meterRowsOf = (source: ActiveSourceUsage, keyPrefix: string, command: string): void => {
    const meterRows: Array<{ w: UsageWindowView; pool: boolean }> = [
      ...source.windows.filter(w => w.state === 'live').map(w => ({ w, pool: false })),
      ...source.pools.filter(w => w.state === 'live').map(w => ({ w, pool: true })),
    ]
    for (const { w, pool } of meterRows) {
      const label = `${keyPrefix}${w.key}`
      usageRows.push({
        kind: 'meter',
        key: label,
        window: w.label,
        value: w.usedPct ?? undefined,
        resetIn: detailRows(source.provider) ? undefined : meterTail(w, pool),
        row: { kind: 'command', command, label },
      })
      if (detailRows(source.provider)) appendKimiDetails(w, label)
    }
  }
  const creditsOf = (source: ActiveSourceUsage, key: string): void => {
    const credits = usageCreditsLine(source.credits, now, 'compact')
    if (credits === undefined) return
    for (const [index, line] of wrapPlain(credits, rowW - 2).entries()) muted(`${key}:${index}`, line, true)
  }

  const liveWindows = usage.windows.filter(w => w.state === 'live')
  const usageEmpty = usage.shape !== 'api-spend' && liveWindows.length === 0
  muted('usage:source', usage.label)
  identityLine(usage, 'usage:account')
  appendOpenrouterSlots(usage, 'usage:slots')
  if (usage.provider === 'zai' && usage.absence !== undefined) {
    for (const [index, line] of wrapPlain(usage.absence, rowW - 2).entries()) muted(`usage:absence:${index}`, line, true)
  } else if (usage.shape === 'api-spend') {
    usageRows.push({
      kind: 'spend',
      key: 'usage:spend',
      value: usage.spend.models > 0 ? `${formatLaneSpend(usage.spend)} session` : 'none yet',
      row: { kind: 'command', command: '/usage', label: 'usage:spend' },
    })
  } else if (usageEmpty && usage.sourceKind === 'none') {
    usageRows.push({ kind: 'empty', key: 'usage:whynot', text: usage.whyNot ?? 'not connected' })
  } else if (usageEmpty && usage.absence) {
    usageRows.push({ kind: 'empty', key: 'usage:absence', text: usage.absence })
  } else if (usageEmpty && usage.provider === 'zai') {
    if (usage.readerNoteCompact === undefined) usageRows.push({ kind: 'empty', key: 'usage:unsampled', text: `${NO_USAGE_READ_WORDS} · /usage` })
  } else if (usageEmpty) {
    usageRows.push({ kind: 'empty', key: 'usage:none', text: `${NO_USAGE_READ_WORDS} · fills after first reply` })
  } else {
    meterRowsOf(usage, 'usage:', '/usage')
  }
  creditsOf(usage, 'usage:credits')
  if (usage.provider === 'openrouter' && usage.readerNoteCompact !== undefined) {
    for (const [index, line] of wrapPlain(usage.readerNoteCompact, rowW - 2).entries()) {
      usageRows.push({ kind: 'text', key: `usage:reader:${index}`, text: `  ${line}`, color: tok.warning, fixed: true })
    }
  } else if (usage.readerNoteCompact !== undefined) {
    usageRows.push({ kind: 'text', key: 'usage:reader', text: `  ${usage.readerNoteCompact}`, color: tok.warning })
  }
  const crewLine = crewUsageLine(crewAgentsOf(input.workRoster.rows, input.focusedSessionId))
  if (crewLine !== null) muted('usage:crew', crewLine)
  const scheduledLine = scheduledUsageLine()
  if (scheduledLine !== null) muted('usage:scheduled', scheduledLine)
  if (usage.limited !== undefined) {
    usageRows.push({ kind: 'text', key: 'usage:limited', text: `  limit reached · resets ${formatCountdown(usage.limited.resetsAtMs - now)}`, color: tok.warning })
  }
  const reached = usageWindowReached(usage, readNow)
  const carry = reached !== null ? usageCarryWords(usage.carry, readNow, 'compact') : undefined
  if (carry !== undefined) {
    const carryLine = reached === 'wall' ? carry : `100% · ${carry}`
    const carryColor = usage.carry?.state === 'carries' ? tok.textSecondary : tok.warning
    for (const [index, line] of wrapPlain(carryLine, rowW - 2).entries()) {
      usageRows.push({ kind: 'text', key: `usage:carry:${index}`, text: `  ${line}`, color: carryColor, fixed: true })
    }
  }
  for (const other of otherUsages) {
    muted(`usage:other:${other.provider}`, other.label)
    identityLine(other, `usage:other:${other.provider}:account`)
    appendOpenrouterSlots(other, `usage:other:${other.provider}:slots`)
    meterRowsOf(other, `usage:${other.provider}:`, '/usage')
    creditsOf(other, `usage:other:${other.provider}:credits`)
  }
  if (input.activity.pulses >= 2) usageRows.push({ kind: 'spark', key: 'usage:activity', label: '  1h ', values: input.activity.perBin })
  const ctx = input.ctx
  if (ctx.window > 0) {
    const ctxPct = ctx.usedPct != null ? Math.round(ctx.usedPct) : null
    const level = ctx.usedTokens === null ? null : calculateTokenWarningState(ctx.usedTokens, input.sessionModel).level
    const ctxColor = level === null ? tok.textMuted : level === 'ok' ? TEAL : level === 'warn' ? AMBER : CRIMSON
    const turns = input.ctxTurns
    const ctxReason = localWindowReasonTag(input.sessionModel, ctx.window)
    usageRows.push({
      kind: 'ctx',
      key: 'usage:ctx',
      pct: ctxPct,
      pctLabel: ctxPct != null ? contextPercentLabel(ctxPct, ctx.fillSource) : '—',
      color: ctxColor,
      tail:
        turns == null
          ? ` · ${contextWindowLabel(ctx.window, ctx.windowSource, ctx.windowPinned)}${ctxReason !== undefined ? ` ${ctxReason}` : ''}`
          : ` · ≈${turns} turns`,
      tailColor: turns != null && turns <= 2 ? ctxColor : tok.textMuted,
      row: { kind: 'command', command: '/context', label: 'ctx' },
    })
    if (input.ctxGrowth.length >= 2) usageRows.push({ kind: 'spark', key: 'usage:ctx:trend', label: '  /turn ', values: [...input.ctxGrowth] })
  }

  const runningWf = input.runningWf
  const wfRows: TelemetryRowSpec[] = []
  if (runningWf.length === 0 && input.externalWf.length === 0) {
    wfRows.push({ kind: 'empty', key: 'wf:idle', text: workUnreported(input.workRoster) ? WORK_UNREPORTED_MARK : 'idle' })
  } else if (runningWf.length > 0) {
    const leadDetail = workflowRowDetail(runningWf[0]!)
    for (const [i, t] of runningWf.slice(0, WF_ROWS).entries()) {
      const asks = t.pendingAsks ?? 0
      const wfKey = `wf:${t.id}`
      wfRows.push({ kind: 'wf', key: wfKey, name: truncateToWidth(t.name, Math.max(3, rowW - 4 - (asks > 0 ? 8 : 0))), asks, row: { kind: 'command', command: '/workflows', label: wfKey } })
      if (i === 0 && leadDetail) wfRows.push({ kind: 'wfdetail', key: 'wf:detail', text: truncateToWidth(`${GLYPH.turns} ${leadDetail}`, Math.max(3, rowW - 4)) })
    }
    if (runningWf.length > WF_ROWS) {
      wfRows.push({ kind: 'empty', key: 'wf:more', text: `+${runningWf.length - WF_ROWS} more`, row: { kind: 'command', command: '/workflows', label: 'wf:more' } })
    }
  }
  for (const m of input.externalWf.slice(0, WF_ROWS)) {
    const extKey = `wf:ext:${m.runId}`
    wfRows.push({
      kind: 'wfext',
      key: extKey,
      name: truncateToWidth(m.workflowName ?? m.title ?? m.runId, Math.max(3, rowW - 16)),
      wedged: m.liveness === 'wedged',
      tail: m.liveness === 'wedged' ? ' wedged?' : ` elsewhere·${m.ownerPid}`,
      row: { kind: 'command', command: '/workflows', label: extKey },
    })
  }

  const certChip = input.cert
  const certAlert = certChip.state === 'live' ? certChip.data.alert : undefined
  const healthRows: TelemetryRowSpec[] = [
    {
      kind: 'health',
      key: 'health:cert',
      verdict: certChip.state === 'live' && certChip.data.verdict !== null ? certChip.data.verdict : null,
      age: certChip.state === 'live' ? certChip.data.ageLabel.replace(' ago', '') : '',
      stale: certChip.state === 'live' ? certChip.data.stale : false,
      row: { kind: 'command', command: '/health', label: 'health' },
    },
    ...(certAlert ? [{ kind: 'healthAlert' as const, key: 'health:alert', text: certAlert.text, fault: certAlert.tone === 'fault' }] : []),
  ]

  const trace = input.trace
  const own = sessionTraceRecords(trace, input.focusedSessionId)
  const traceTotal = own.length
  const recent = own.slice(-TRACE_ROWS).reverse()
  const traceRows: TelemetryRowSpec[] = []
  if (trace === null) traceRows.push({ kind: 'empty', key: 'trace:loading', text: 'loading…' })
  else if (recent.length === 0) traceRows.push({ kind: 'empty', key: 'trace:none', text: 'fills as tools run' })
  else {
    const seenTraceKeys = new Map<string, number>()
    for (const r of recent) {
      const bad = r.ok === false || r.killed === true
      const toolBudget = Math.max(3, rowW - 10)
      const baseKey = `trace:${r.ts}:${typeof r.tool === 'string' ? r.tool : '?'}`
      const dupes = seenTraceKeys.get(baseKey) ?? 0
      seenTraceKeys.set(baseKey, dupes + 1)
      const traceKey = dupes === 0 ? baseKey : `${baseKey}:${dupes}`
      traceRows.push({ kind: 'trace', key: traceKey, clock: hhmm(r.ts), tool: truncateToWidth(typeof r.tool === 'string' ? r.tool : '?', toolBudget), bad, row: { kind: 'command', command: '/trace', label: traceKey } })
    }
  }

  const RAIL_PANEL_CHROME = 3
  const CHROME_ROWS = 7
  const { availRows, termRows } = input
  const sectionRows = (children: number): number => children + RAIL_PANEL_CHROME
  const shedCeiling = availRows ?? termRows - CHROME_ROWS
  let spentRows = 1 + sectionRows(usageRows.length) + sectionRows(wfRows.length)
  const fitsSection = (children: number): boolean => spentRows + sectionRows(children) <= shedCeiling
  const healthShed = !fitsSection(healthRows.length)
  if (!healthShed) spentRows += sectionRows(healthRows.length)
  const traceShed = !fitsSection(traceRows.length)
  if (!traceShed) spentRows += sectionRows(traceRows.length)
  const consoleOn = input.console.on
  const consoleShed = consoleOn && !fitsSection(1)

  const consoleRows: TelemetryRowSpec[] = []
  if (consoleOn && !consoleShed) {
    const c = input.console
    const inputBudget = Math.max(4, rowW - 2)
    consoleRows.push({
      kind: 'consoleInput',
      key: 'console:input',
      composing: c.composing ? consoleInputWindow(c.buffer, c.cursor, inputBudget) : null,
      draft: c.composing ? '' : truncateToWidth(c.buffer, inputBudget),
      row: { kind: 'console', label: 'console:input' },
    })
    if (c.composing) consoleRows.push({ kind: 'text', key: 'console:hint', text: '  ↵ ask · esc · ↑↓ hist', color: tok.textMuted })
    if (c.pending) {
      consoleRows.push({ kind: 'consoleAsking', key: 'console:asking', question: truncateToWidth(c.pending.question, Math.max(3, rowW - 10)), secs: Math.max(0, Math.round((now - c.pending.startedAt) / 1000)) })
    }
    const last = c.last
    if (last && (last.answer || last.error)) {
      const rowsAbove = spentRows + RAIL_PANEL_CHROME + consoleRows.length + 2
      const answerBudget = Math.max(0, Math.min(9, shedCeiling - rowsAbove))
      consoleRows.push({ kind: 'consoleLine', key: 'console:q', text: truncateToWidth(`${GLYPH.dot} ${last.question}`, Math.max(3, rowW - 2)), tone: 'question' })
      let hidden = 0
      if (last.answer) {
        const lines = wrapPlain(plainifyAnswer(last.answer), Math.max(4, rowW - 2))
        const shown = lines.slice(0, answerBudget)
        hidden = lines.length - shown.length
        for (const [i, l] of shown.entries()) consoleRows.push({ kind: 'consoleLine', key: `console:a:${i}`, text: l === '' ? ' ' : l, tone: 'answer' })
      } else if (last.error) {
        const lines = wrapPlain(last.error, Math.max(4, rowW - 4)).slice(0, 2)
        for (const [i, l] of lines.entries()) consoleRows.push({ kind: 'consoleLine', key: `console:err:${i}`, text: l === '' ? ' ' : l, tone: i === 0 ? 'errorLead' : 'errorRest' })
      }
      const dur = last.durationMs != null ? `${Math.max(1, Math.round(last.durationMs / 1000))}s` : null
      const u = last.usage
      const toks = u ? `${fmtTok(u.in + u.cacheRead + u.cacheWrite)}→${fmtTok(u.out)}` : null
      const receipt = [...(hidden > 0 ? [`${GLYPH.cursor} +${hidden}`] : []), ...(dur ? [dur] : []), ...(toks ? [toks] : []), '↵ full'].join(' · ')
      consoleRows.push({ kind: 'empty', key: 'console:full', text: receipt, row: { kind: 'command', command: '/console', label: 'console:full' } })
    }
  }

  const shedPointers = [
    ...(healthShed ? ['/health'] : []),
    ...(traceShed ? ['/trace'] : []),
    ...(consoleShed ? ['/console'] : []),
  ]
  const shed = shedPointers.map(k => k.slice(1) as 'health' | 'trace' | 'console')
  const shedPointerFits = spentRows < shedCeiling
  const sections: TelemetrySectionSpec[] = [
    { key: 'usage', glyph: '', label: 'USAGE', open: '/usage', rows: usageRows },
    {
      key: 'workflow',
      glyph: GLYPH.turns,
      label: 'WORKFLOW',
      count: runningWf.length + input.externalWf.length > 0 ? String(runningWf.length + input.externalWf.length) : undefined,
      open: '/workflows',
      rows: wfRows,
    },
    ...(healthShed
      ? []
      : [
          {
            key: 'health' as const,
            glyph: GLYPH.check,
            label: 'HEALTH',
            count: certChip.state === 'live' && certChip.data.verdict !== null ? certChip.data.ageLabel.replace(' ago', '') : undefined,
            open: '/health',
            rows: healthRows,
          },
        ]),
    ...(traceShed ? [] : [{ key: 'trace' as const, glyph: GLYPH.trace, label: 'TRACE', count: String(traceTotal), open: '/trace', rows: traceRows }]),
    ...(consoleOn && !consoleShed
      ? [{ key: 'console' as const, glyph: GLYPH.prompt, label: 'CONSOLE', count: input.console.count > 0 ? String(input.console.count) : undefined, open: '/console', rows: consoleRows }]
      : []),
  ]
  const rows: HelmRow[] = []
  for (const s of sections) for (const r of s.rows) if ('row' in r && r.row !== undefined) rows.push(r.row)
  return {
    rowW,
    sections,
    shed,
    pointer: shedPointers.length > 0 && shedPointerFits ? `  ${GLYPH.cursor} short height — ${shedPointers.join(' · ')}` : null,
    rows,
    consoleOn,
  }
}
