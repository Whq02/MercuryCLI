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
import { wrapPlain } from './helmConsoleText.js'
import { GLYPH, truncateToWidth } from '../../components/mercury-ui/glyphs.js'
import { AMBER, CRIMSON, TEAL } from '../../components/mercury-ui/theme.js'
import { calculateTokenWarningState } from '../../services/compact/autoCompact.js'
import { railPanelInnerWidth } from '../../components/mercury-ui/RailPanel.js'
import type { HelmRow } from './helmFocus.js'
import type { MercuryThemeTokens } from '../mercuryTokens.js'

export const WF_ROWS = 3

export type VitalsRowSpec =
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

export type VitalsSectionSpec = {
  key: 'usage' | 'workflow' | 'health'
  glyph: string
  label: string
  count?: string
  open: string
  rows: VitalsRowSpec[]
}

export type VitalsInput = {
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
  cert: Snapshot<{ data: ComposedCertChip }>
  now: number
  readNow: number
  tok: MercuryThemeTokens
}

export type VitalsModel = {
  rowW: number
  sections: VitalsSectionSpec[]
  shed: Array<'health'>
  pointer: string | null
  rows: HelmRow[]
}

export function buildVitalsModel(input: VitalsInput): VitalsModel {
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

  const usageRows: VitalsRowSpec[] = []
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
  const wfRows: VitalsRowSpec[] = []
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
  const healthRows: VitalsRowSpec[] = [
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

  const RAIL_PANEL_CHROME = 3
  const CHROME_ROWS = 7
  const { availRows, termRows } = input
  const sectionRows = (children: number): number => children + RAIL_PANEL_CHROME
  const shedCeiling = availRows ?? termRows - CHROME_ROWS
  let spentRows = 1 + sectionRows(usageRows.length) + sectionRows(wfRows.length)
  const fitsSection = (children: number): boolean => spentRows + sectionRows(children) <= shedCeiling
  const healthShed = !fitsSection(healthRows.length)
  if (!healthShed) spentRows += sectionRows(healthRows.length)

  const shedPointers = [...(healthShed ? ['/health'] : [])]
  const shed = shedPointers.map(k => k.slice(1) as 'health')
  const shedPointerFits = spentRows < shedCeiling
  const sections: VitalsSectionSpec[] = [
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
  ]
  const rows: HelmRow[] = []
  for (const s of sections) for (const r of s.rows) if ('row' in r && r.row !== undefined) rows.push(r.row)
  return {
    rowW,
    sections,
    shed,
    pointer: shedPointers.length > 0 && shedPointerFits ? `  ${GLYPH.cursor} short height — ${shedPointers.join(' · ')}` : null,
    rows,
  }
}
