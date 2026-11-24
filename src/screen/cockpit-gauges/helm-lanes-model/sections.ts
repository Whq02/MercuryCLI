import type { TaskStatus } from '../../../engine/tasks/taskBase.js'
import type { SessionListing } from '../../../sessions/transcripts/transcriptEntries.js'
import { crewSettled, crewStateLabel, crewTokensLabel } from '../../../engine/connector/crewFacts.js'
import { usageAgeTail } from '../../../models/roads/usageFreshness.js'
import { formatSessionCost } from '../../../models/usage/sessionCost.js'
import { contextPercentLabel, contextWindowLabel } from '../../../engine/context-window/contextFill.js'
import { isLocalModelId } from '../../../models/roads/local/localCatalogue.js'
import { formatCountdown, formatCountdownCoarse } from '../quota.js'
import { saturnWakeGlanceWords } from '../../../daemon/saturn/saturn.js'
import { GLYPH } from '../../theme/glyphs.js'
import { getListingDisplayTitle } from '../../../platform/logs/errorLog.js'
import { LEAD_ROW_NAME } from '../../cockpit/crewmateWords.js'
import type { MercuryThemeTokens } from '../../theme/mercuryTokens.js'
import type { CrewEntry, GlanceReads, LanesInput, LanesRowSpec, LanesSectionSpec, RunRow, WorkDigest } from './types.js'

export function recentLaneLabel(log: SessionListing): string {
  const cleaned = Array.from(getListingDisplayTitle(log, 'untitled'), ch => (ch.charCodeAt(0) < 0x20 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'untitled'
}

function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = s / 60
  if (m < 90) return `${Math.round(m)}m`
  const h = m / 60
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`
  return `${Math.round(h / 24)}d`
}

function statusTone(status: TaskStatus, tok: MercuryThemeTokens): { label: string; tone: string } {
  switch (status) {
    case 'running':
      return { label: 'running', tone: tok.success }
    case 'pending':
      return { label: 'pending', tone: tok.textSecondary }
    case 'completed':
      return { label: 'done', tone: tok.textMuted }
    case 'failed':
      return { label: 'failed', tone: tok.failure }
    case 'killed':
      return { label: 'killed', tone: tok.failure }
    default:
      return { label: status, tone: tok.textMuted }
  }
}

function glanceLabelsOf(reads: GlanceReads, tok: MercuryThemeTokens): {
  usage: string
  ctx: string
  health: string
  healthTone: string
  healthGlyph: string
} {
  const { usage, focusedSpendUSD, focusedUnpriced, ctx, chip, nowMs } = reads
  const bindingPool = usage.pools.find(pool => pool.state === 'live' && pool.usedPct != null && pool.key === usage.binding?.window.key)
  const lead = bindingPool ?? usage.windows.find(w => w.state === 'live' && w.usedPct != null)
  const leadAge = lead !== undefined ? usageAgeTail(lead, nowMs) : undefined
  const usageLabel =
    usage.rental ? `spend $${usage.rental.spendUSD.toFixed(2)} · $${usage.rental.price.toFixed(2)}/hr` : lead !== undefined
      ? `${lead.label} ${Math.round(lead.usedPct!)}%${lead.resetsAtMs != null ? ` · ${(bindingPool !== undefined ? formatCountdownCoarse : formatCountdown)(lead.resetsAtMs - nowMs)}` : ''}${leadAge !== undefined ? ` · ${leadAge}` : ''}`
      : usage.shape === 'api-spend'
        ? `spend ${focusedUnpriced > 0 ? formatSessionCost(focusedSpendUSD, focusedUnpriced) : focusedSpendUSD > 0 ? `$${focusedSpendUSD.toFixed(2)}` : '—'}`
        : 'usage — after first reply'
  const ctxLabel = `ctx ${contextPercentLabel(ctx.usedPct, ctx.fillSource)} · ${contextWindowLabel(ctx.window, ctx.windowSource, ctx.windowPinned, isLocalModelId(reads.sessionModel))}`
  const verdictUp = chip.verdict != null ? String(chip.verdict).toUpperCase() : null
  const healthLabel =
    chip.verdict != null
      ? `${String(chip.verdict).toLowerCase()}${chip.ageMs != null ? ` · ${formatCountdown(chip.ageMs)} old` : ''}`
      : 'health — run /health'
  const healthTone = verdictUp === 'FAULT' ? tok.failure : verdictUp === 'CAUTION' ? tok.warning : tok.textSecondary
  const healthGlyph = verdictUp === 'FAULT' ? GLYPH.fail : verdictUp === 'CAUTION' ? GLYPH.warn : GLYPH.dot
  return { usage: usageLabel, ctx: ctxLabel, health: healthLabel, healthTone, healthGlyph }
}

interface SectionFacts {
  input: LanesInput
  tok: MercuryThemeTokens
  accent: string
  nowMs: number
  keptIds: string[]
  crewEntries: CrewEntry[]
  crewShown: CrewEntry[]
  crewMore: number
  runsShown: RunRow[]
  runsMore: number
  runsLive: number
  work: WorkDigest | null
  workbenchRows: string[] | null
  solo: boolean
  mission: string | null
  hintCap: number
  viewingChild: boolean
  mainChatTint: string
}

export function crewSection({ input, tok, accent, keptIds, crewEntries, crewShown, crewMore, solo, viewingChild, mainChatTint }: SectionFacts): LanesSectionSpec | null {
  if (solo) return null
  if (crewEntries.length === 0 && keptIds.length === 0) return null
  const rows: LanesRowSpec[] = []
  rows.push({
    kind: 'rail',
    key: 'crewroot',
    glyph: GLYPH.spark,
    glyphColor: viewingChild ? tok.textMuted : accent,
    name: LEAD_ROW_NAME,
    nameColor: viewingChild ? tok.textPrimary : accent,
    nameBold: true,
    marked: !viewingChild,
    directActivate: true,
    row: { kind: 'main', label: 'crew:root' },
  })
  for (const entry of crewShown) {
    const c = entry.row
    const isViewing = input.viewingCrewmateTaskId != null && c.id === input.viewingCrewmateTaskId
    const isMainChat = input.mainChatTaskId != null && c.id === input.mainChatTaskId
    const base = statusTone(c.status, tok)
    const finished = c.facts !== undefined ? crewSettled(c.facts) : c.status !== 'running' && c.status !== 'pending'
    const greyed = finished && c.facts?.state !== 'failed'
    const idle = c.facts?.state === 'idle'
    const live = c.status === 'running' && !idle
    const tokensVerb = live && c.facts !== undefined ? crewTokensLabel(c.facts) : null
    const verbLabel = tokensVerb ?? (c.facts !== undefined ? crewStateLabel(c.facts) : base.label)
    rows.push({
      kind: 'rail',
      key: `crew:${c.id}`,
      glyph: isMainChat ? GLYPH.star : isViewing ? GLYPH.circledBullet : live ? GLYPH.busy : GLYPH.idle,
      glyphColor: isMainChat ? tok.warning : isViewing ? accent : live ? tok.success : tok.textMuted,
      glyphLive: live && !isViewing && !isMainChat,
      name: c.label,
      nameColor: greyed ? tok.textMuted : tok.textPrimary,
      nameBold: isViewing || isMainChat,
      marked: isViewing,
      tint: isMainChat ? mainChatTint : isViewing ? tok.selection : undefined,
      directActivate: true,
      verb: verbLabel,
      verbColor: greyed ? tok.textMuted : base.tone,
      row: { kind: 'crewmate', id: c.id, label: c.hosted ? `crew:h:${c.id}` : c.label },
    })
  }
  if (crewMore > 0) rows.push({ kind: 'more', key: 'crew:more', n: crewMore, row: { kind: 'command', command: '/crewmates', label: 'crew:more' } })
  const crewWord = crewEntries.length === 1 ? 'crewmate' : 'crewmates'
  return { key: 'crew', glyph: GLYPH.fisheye, label: 'CREW', count: `${crewEntries.length} ${crewWord}`, open: '/crewmates', rows }
}

export function workSection({ work }: SectionFacts): LanesSectionSpec | null {
  if (!work) return null
  return {
    key: 'work',
    glyph: work.terminal ? GLYPH.done : GLYPH.busy,
    label: 'WORK',
    count: work.total > 0 ? `${work.doneCount}/${work.total}` : undefined,
    open: '/workbench',
    rows: work.rows.map((r, i) => ({ kind: 'text', key: `work:${i}`, text: `  ${r.text}`, color: r.color })),
  }
}

export function runsSection({ tok, nowMs, runsShown, runsMore, runsLive, solo }: SectionFacts): LanesSectionSpec | null {
  if (solo || runsShown.length === 0) return null
  const rows: LanesRowSpec[] = runsShown.map(r => {
    const live = r.status === 'running'
    const verb = live && r.startedAtMs > 0 ? `${r.kind} ${formatSpan(nowMs - r.startedAtMs)}` : r.kind
    return {
      kind: 'rail',
      key: `run:${r.id}`,
      glyph: live ? GLYPH.busy : GLYPH.pending,
      glyphColor: live ? tok.success : tok.textMuted,
      glyphLive: live,
      name: r.title,
      nameColor: live ? tok.textPrimary : tok.textSecondary,
      verb,
      verbColor: live ? tok.textSecondary : tok.textMuted,
      row: { kind: 'command', command: `/runs ${r.id}`, label: `run:${r.id}` },
    }
  })
  if (runsMore > 0) rows.push({ kind: 'more', key: 'runs:more', n: runsMore, row: { kind: 'command', command: '/runs', label: 'runs:more' } })
  return { key: 'runs', glyph: GLYPH.turns, label: 'RUNS', count: `${runsLive} live`, open: '/runs', rows }
}

export function recentSection({ input, tok, solo }: SectionFacts): LanesSectionSpec | null {
  if (!solo) return null
  const rows: LanesRowSpec[] = []
  for (const log of input.recent ?? []) {
    const label = recentLaneLabel(log)
    rows.push({
      kind: 'rail',
      key: `recent:${log.value}`,
      glyph: GLYPH.pending,
      glyphColor: tok.textMuted,
      name: label,
      nameColor: tok.textSecondary,
      row: { kind: 'command', command: '/sessions', label: `recent:${label}` },
    })
  }
  if (input.recent == null) rows.push({ kind: 'text', key: 'recent:scanning', text: '  scanning…', color: tok.textMuted })
  if (rows.length === 0) return null
  return { key: 'recent', glyph: GLYPH.read, label: 'RECENT', open: '/sessions', rows }
}

export function missionSection({ tok, solo, mission }: SectionFacts): LanesSectionSpec | null {
  if (!solo || mission === null) return null
  return {
    key: 'mission',
    glyph: GLYPH.mission,
    label: 'MISSION',
    open: '/mission',
    rows: [
      {
        kind: 'rail',
        key: 'mission',
        glyph: GLYPH.mission,
        glyphColor: tok.success,
        name: mission,
        nameColor: tok.textPrimary,
        row: { kind: 'command', command: '/mission', label: 'mission' },
      },
    ],
  }
}

export function workbenchSection({ workbenchRows }: SectionFacts): LanesSectionSpec {
  return {
    key: 'workbench',
    glyph: GLYPH.prompt,
    label: 'WORKBENCH',
    open: '/workbench',
    rows: [{ kind: 'card', key: 'workbench:last', lines: workbenchRows, row: { kind: 'command', command: '/workbench', label: 'workbench:last' } }],
  }
}

export function nextSection({ tok, solo, mission, hintCap }: SectionFacts): LanesSectionSpec | null {
  if (!solo) return null
  const hints: Array<{ command: string; label: string }> = [
    { command: '/health', label: '/health — health cert' },
    { command: '/memory', label: '/memory — memory' },
  ]
  if (mission === null) hints.push({ command: '/mission', label: '/mission — set a mission' })
  const rows: LanesRowSpec[] = hints.slice(0, hintCap).map(h => ({
    kind: 'rail',
    key: `hint:${h.command}`,
    glyph: GLYPH.dot,
    glyphColor: tok.textMuted,
    name: h.label,
    nameColor: tok.textMuted,
    row: { kind: 'command', command: h.command, label: `hint:${h.command}` },
  }))
  if (rows.length === 0) return null
  return { key: 'next', glyph: GLYPH.cursor, label: 'NEXT', open: '/help', rows }
}

export function filesSection({ input, tok }: SectionFacts): LanesSectionSpec | null {
  if (input.filesOff) return null
  return {
    key: 'files',
    glyph: '▤',
    label: 'FILES',
    count: input.filesFolder,
    open: 'files',
    rows: [
      {
        kind: 'rail',
        key: 'files:browse',
        glyph: '↵',
        glyphColor: tok.textMuted,
        name: 'or click · browse',
        nameColor: tok.textMuted,
        row: { kind: 'files', label: 'files:browse' },
      },
    ],
  }
}

export function saturnSection({ input, tok, nowMs }: SectionFacts): LanesSectionSpec | null {
  if (input.wakeGlance === null) return null
  const words = saturnWakeGlanceWords(input.wakeGlance, nowMs)
  return {
    key: 'saturn',
    glyph: GLYPH.inProgress,
    label: 'SATURN',
    open: '/saturn',
    rows: [
      {
        kind: 'rail',
        key: 'wake:glance',
        glyph: GLYPH.inProgress,
        glyphColor: tok.success,
        name: words.name,
        nameColor: tok.textSecondary,
        verb: words.verb,
        verbColor: tok.textMuted,
        row: { kind: 'command', command: '/saturn', label: 'wake:glance' },
      },
    ],
  }
}

export function glanceSection({ input, tok }: SectionFacts): LanesSectionSpec | null {
  if (!input.mergedVitals || input.glance === null) return null
  const labels = glanceLabelsOf(input.glance, tok)
  const muted = (name: string, label: string, command: string): LanesRowSpec => ({
    kind: 'rail',
    key: label,
    glyph: GLYPH.dot,
    glyphColor: tok.textMuted,
    name,
    nameColor: tok.textSecondary,
    row: { kind: 'command', command, label },
  })
  return {
    key: 'vitals',
    glyph: '',
    label: 'VITALS',
    marginAlways: true,
    rows: [
      muted(labels.usage, 'tel:usage', '/usage'),
      muted(labels.ctx, 'tel:ctx', '/context'),
      {
        kind: 'rail',
        key: 'tel:health',
        glyph: labels.healthGlyph,
        glyphColor: labels.healthTone === tok.textSecondary ? tok.textMuted : labels.healthTone,
        name: labels.health,
        nameColor: labels.healthTone,
        row: { kind: 'command', command: '/health', label: 'tel:health' },
      },
    ],
  }
}
