import { basename } from 'node:path'
import { GLYPH, displayWidth, padTo, truncateToWidth } from '../mercury-ui/glyphs.js'
import { formatTextSize } from '../../mneme/mnemeUsage.js'
import type { LedgerEntry } from '../../mneme/types.js'
import type { HandoverReceipt } from '../../mneme/mnemeHandover.js'
import type { MnemeMaintenanceReceipt } from '../../mneme/mnemeMaintenance.js'

export const MEMORY_POPUP_WIDTH = 92
export const MEMORY_POPUP_ROWS = 36
export const MEMORY_POPUP_TITLE_VIEW = 'memory'
export const MEMORY_SEARCH_PLACEHOLDER = 'type to search facts, rules and instruction files'
export const MEMORY_SEARCH_READS = 'the search reads topic pages, pinned rules, recent facts and the instruction files'
export const MEMORY_CLOSE_HINT = 'esc or click outside closes'
export const MEMORY_ROOMY_BUDGET = 12
export const NO_DATE = '—'

export const MEMORY_TWO_LINE_BUDGET = 16

export function memoryBodySpacing(rowBudget: number): { roomy: boolean; fixedRows: number; detailLines: 1 | 2 } {
  const roomy = rowBudget >= MEMORY_ROOMY_BUDGET
  const detailLines = rowBudget >= MEMORY_TWO_LINE_BUDGET ? 2 : 1
  return { roomy, fixedRows: roomy ? 3 + detailLines : 2, detailLines }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number): string => String(n).padStart(2, '0')

export function humanStamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return NO_DATE
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16)
  return `${two(d.getDate())} ${MONTHS[d.getMonth()]} ${two(d.getHours())}:${two(d.getMinutes())}`
}

export function newestOf(stamps: Iterable<string | null | undefined>): string | null {
  let best: string | null = null
  for (const stamp of stamps) {
    if (!stamp) continue
    const t = new Date(stamp).getTime()
    if (Number.isNaN(t)) continue
    if (best === null || t > new Date(best).getTime()) best = stamp
  }
  return best
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function memoryPopupLine(projectRoot: string, memoryHome: string): string {
  const name = basename(projectRoot.replace(/[\\/]+$/, '')) || projectRoot
  return `${name} · ${memoryHome.replace(/[\\/]+$/, '')}`
}

export function tableLine(cells: readonly string[], widths: readonly number[]): string {
  const out: string[] = []
  cells.forEach((cell, i) => {
    const width = widths[i] ?? 0
    const last = i === cells.length - 1
    const text = truncateToWidth(cell, width)
    out.push(last ? text : padTo(text, width))
  })
  return out.join(' ').replace(/\s+$/, '')
}

export const OVERVIEW_COLUMNS = ['section', 'count', 'newest', 'state'] as const

export function overviewWidths(inner: number): number[] {
  const section = 19
  const newest = 12
  const state = 9
  const count = Math.max(12, inner - 2 - section - newest - state - 3)
  return [section, count, newest, state]
}

export const LINEAGE_COLUMNS = ['session', 'engine', 'started', 'ended', 'note'] as const

export function lineageWidths(inner: number): number[] {
  const session = 9
  const started = 12
  const ended = 12
  const note = 4
  const engine = Math.max(10, inner - 2 - session - started - ended - note - 4)
  return [session, engine, started, ended, note]
}

export interface OverviewRow {
  id: string
  section: string
  count: string
  newest: string
  state: string
  detail: string
  action: string | null
}

export interface OverviewFacts {
  enabled: boolean
  entryCount: number
  recent: number
  historyCount: number
  topicCount: number
  newestFact: string | null
  pinned: { pinned: number; used: number; limit: number; over: boolean } | null
  pinnedLimit: number
  newestPin: string | null
  newestTopic: string | null
  ledger: readonly LedgerEntry[]
  sessionId: string
  journal: { enabled: boolean; entries: readonly { at: string; text: string }[] }
  intake: { kind: 'done'; receipt: HandoverReceipt } | { kind: 'due' } | null
  maintenance: {
    due: boolean
    dueReason: string | null
    running: boolean
    degraded: readonly string[]
    lastConsolidatedAt: string | null
    receipts: readonly MnemeMaintenanceReceipt[]
  }
  files: { count: number; profile: string } | null
}

export function factsRow(facts: Pick<OverviewFacts, 'enabled' | 'entryCount' | 'recent' | 'historyCount' | 'topicCount' | 'newestFact'>): OverviewRow {
  if (!facts.enabled) {
    return {
      id: 'facts',
      section: 'facts and decisions',
      count: NO_DATE,
      newest: NO_DATE,
      state: 'off',
      detail: 'memory is disabled in settings (memory.enabled) — nothing is loaded, saved or looked up',
      action: null,
    }
  }
  const recent = facts.recent > 0 ? ` · ${facts.recent} recent` : ''
  return {
    id: 'facts',
    section: 'facts and decisions',
    count: `${facts.entryCount} current${recent}`,
    newest: humanStamp(facts.newestFact),
    state: 'on',
    detail: `facts live in topic pages · ${facts.historyCount} in history${facts.recent > 0 ? ` · ${facts.recent} recent, consolidated at the next pass` : ''} · corrections keep history`,
    action: facts.entryCount + facts.recent > 0 ? 'list the facts' : null,
  }
}

export function pinnedRow(status: OverviewFacts['pinned'], limit: number, newestPin: string | null): OverviewRow {
  if (status === null || status.pinned === 0) {
    return {
      id: 'pinned',
      section: 'pinned rules',
      count: 'none',
      newest: NO_DATE,
      state: 'none',
      detail: `${formatTextSize(status?.limit ?? limit)} of room; open a fact and press p to pin it as said`,
      action: null,
    }
  }
  const fill = `${formatTextSize(status.used)} of ${formatTextSize(status.limit)}`
  return {
    id: 'pinned',
    section: 'pinned rules',
    count: `${status.pinned} · ${fill}`,
    newest: humanStamp(newestPin),
    state: status.over ? 'over' : 'loaded',
    detail: status.over ? 'over the limit, all still loaded · /config raises the limit' : 'loaded word for word every session',
    action: 'list the rules',
  }
}

export function topicsRow(count: number, newestTopic: string | null): OverviewRow {
  if (count === 0) {
    return { id: 'topics', section: 'topics', count: 'none', newest: NO_DATE, state: 'none', detail: 'the first fact Mercury saves opens one', action: null }
  }
  return {
    id: 'topics',
    section: 'topics',
    count: plural(count, 'page'),
    newest: humanStamp(newestTopic),
    state: 'indexed',
    detail: 'the index the model reads, one page per topic',
    action: 'list the topics',
  }
}

export function lineageRow(entries: readonly LedgerEntry[], sessionId: string): OverviewRow {
  const previous = entries.filter(entry => entry.sessionId !== sessionId)
  if (previous.length === 0) {
    return { id: 'lineage', section: 'lineage', count: 'first session', newest: NO_DATE, state: 'first', detail: 'first session of this work — no record before it', action: 'open the sessions' }
  }
  const own = entries.find(entry => entry.sessionId === sessionId)
  const ordinal = own?.ordinal ?? entries.length + 1
  const last = previous[previous.length - 1]!
  const lastNoted = [...previous].reverse().find(entry => entry.handoff !== null)
  return {
    id: 'lineage',
    section: 'lineage',
    count: `session ${ordinal} · ${previous.length} before`,
    newest: humanStamp(last.endedAt ?? last.startedAt),
    state: last.handoff !== null ? 'noted' : 'no note',
    detail: `${plural(previous.length, 'session')} before this one · ${lastNoted ? `last note from session ${lastNoted.ordinal}` : 'no note left yet'}`,
    action: 'open the sessions',
  }
}

export function journalRow(journal: OverviewFacts['journal']): OverviewRow {
  if (!journal.enabled) {
    return { id: 'journal', section: 'journal', count: NO_DATE, newest: NO_DATE, state: 'off', detail: 'memory.journal in /config turns it on', action: null }
  }
  if (journal.entries.length === 0) {
    return { id: 'journal', section: 'journal', count: 'none', newest: NO_DATE, state: 'on', detail: 'the model writes one, in its own words, when a session ends', action: null }
  }
  return {
    id: 'journal',
    section: 'journal',
    count: plural(journal.entries.length, 'entry', 'entries'),
    newest: humanStamp(newestOf(journal.entries.map(entry => entry.at))),
    state: 'on',
    detail: "the model's own account of each session · kept in the home, never synced",
    action: 'read the entries',
  }
}

export function intakeRow(intake: OverviewFacts['intake']): OverviewRow | null {
  if (intake === null) return null
  if (intake.kind === 'due') {
    return { id: 'intake', section: 'notes to take in', count: NO_DATE, newest: NO_DATE, state: 'due', detail: 'the existing notes are not in memory yet', action: 'take them in now' }
  }
  const r = intake.receipt
  const pages = Object.entries(r.pages).sort((a, b) => a[0].localeCompare(b[0])).map(([slug, n]) => `${slug} ${n}`).join(' · ')
  const waiting = !r.consolidated && r.facts > 0 ? ' · the facts wait in the buffer — run maintenance' : ''
  return {
    id: 'intake',
    section: 'notes taken in',
    count: `${plural(r.notes, 'note')} → ${plural(r.facts, 'fact')}`,
    newest: humanStamp(r.ranAt),
    state: 'done',
    detail: `${r.pinned} pinned · pages: ${pages || 'none'}${r.skipped.length > 0 ? ` · skipped ${r.skipped.length}` : ''}${waiting}`,
    action: null,
  }
}

export function maintenanceRow(m: OverviewFacts['maintenance']): OverviewRow {
  const last = m.receipts[0] ?? null
  const state = m.due ? 'due' : m.running ? 'running' : m.degraded.length > 0 ? 'degraded' : 'idle'
  const lastWords = last ? `last run ${humanStamp(last.ts)} (${last.trigger}): ${last.reason}${last.entries ? ` — ${plural(last.entries, 'entry', 'entries')}` : ''}` : 'no run yet'
  const degraded = m.degraded.length > 0 ? ` · ${GLYPH.warn} ${m.degraded[0]}` : ''
  return {
    id: 'maintenance',
    section: 'maintenance',
    count: m.receipts.length === 0 ? 'none' : plural(m.receipts.length, 'run'),
    newest: humanStamp(last?.ts ?? m.lastConsolidatedAt),
    state,
    detail: `${m.due ? `due — ${m.dueReason ?? 'work is waiting'} · ` : ''}${lastWords}${degraded}`,
    action: 'run now',
  }
}

export function filesRow(files: OverviewFacts['files']): OverviewRow {
  const profile = files?.profile ?? 'auto'
  return {
    id: 'files',
    section: 'instruction files',
    count: files === null ? NO_DATE : plural(files.count, 'file'),
    newest: NO_DATE,
    state: profile,
    detail: `${profile === 'native' ? 'MERCURY.md only' : 'MERCURY.md, or AGENTS.md when there is none'} · editor and the memory switch`,
    action: 'open the picker',
  }
}

export function overviewRows(facts: OverviewFacts): OverviewRow[] {
  const rows: OverviewRow[] = [factsRow(facts)]
  if (facts.enabled) {
    rows.push(pinnedRow(facts.pinned, facts.pinnedLimit, facts.newestPin))
    rows.push(topicsRow(facts.topicCount, facts.newestTopic))
    rows.push(lineageRow(facts.ledger, facts.sessionId))
    rows.push(journalRow(facts.journal))
    const intake = intakeRow(facts.intake)
    if (intake) rows.push(intake)
    rows.push(maintenanceRow(facts.maintenance))
  }
  rows.push(filesRow(facts.files))
  return rows
}

export function overviewCells(row: OverviewRow): string[] {
  return [row.section, row.count, row.newest, row.state]
}

export interface LineageTableRow {
  id: string
  entry: LedgerEntry
  cells: string[]
  current: boolean
}

export function lineageRows(entries: readonly LedgerEntry[], sessionId: string): LineageTableRow[] {
  return [...entries]
    .sort((a, b) => b.ordinal - a.ordinal)
    .map(entry => {
      const current = entry.sessionId === sessionId
      const engines = [...new Set(entry.engines.map(engine => engine.model))]
      return {
        id: `session-${entry.ordinal}`,
        entry,
        current,
        cells: [
          current ? `${entry.ordinal} (this)` : String(entry.ordinal),
          engines.join(', ') || NO_DATE,
          humanStamp(entry.startedAt),
          entry.endedAt === null ? (current ? 'open' : 'unclosed') : humanStamp(entry.endedAt),
          entry.handoff === null ? 'no' : 'yes',
        ],
      }
    })
}

export function lineageHeading(entries: readonly LedgerEntry[], sessionId: string): string {
  const previous = entries.filter(entry => entry.sessionId !== sessionId).length
  if (previous === 0) return 'first session of this work · the ledger starts here'
  return `${plural(previous, 'session')} before this one, newest first`
}

export function pinnedHeading(status: { pinned: number; used: number; limit: number; over: boolean } | null, limit: number): string {
  const fill = `${formatTextSize(status?.used ?? 0)} of ${formatTextSize(status?.limit ?? limit)}`
  return status?.over ? `${fill} · over the limit, all still loaded` : `${fill} · loaded word for word every session`
}

export function topicsHeading(count: number): string {
  return `${plural(count, 'topic')} on the index, as the model reads ${count === 1 ? 'it' : 'them'}`
}

export function journalHeading(count: number): string {
  return `${plural(count, 'entry', 'entries')}, newest first · the model's own words`
}

export const VIEW_LEGEND = {
  pinned: '↵ opens a rule: c corrects it, x retires it, u unpins it · /config raises the limit',
  topics: 'one page per topic · a page holds its facts and their history',
  lineage: 'every session of this work · a noted session left words for the next one',
  journal: 'kept in the Mercury home, never pushed or synced · /config turns it off',
} as const

export function wrapText(text: string, width: number): string[] {
  const out: string[] = []
  const room = Math.max(8, width)
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (line === '') line = word
      else if (displayWidth(line) + 1 + displayWidth(word) <= room) line = `${line} ${word}`
      else {
        out.push(line)
        line = word
      }
    }
    if (line !== '') out.push(line)
  }
  return out
}

export type PageLineKind = 'heading' | 'text' | 'item' | 'blank' | 'meta'

export interface PageLine {
  kind: PageLineKind
  text: string
  seq?: number
  marked?: boolean
}

export function itemLines(text: string, width: number, seq?: number, indent = 0): PageLine[] {
  const lead = `${' '.repeat(indent)}• `
  const hang = ' '.repeat(displayWidth(lead))
  return wrapText(text, Math.max(8, width) - displayWidth(lead)).map((piece, i) => ({ kind: 'item' as const, text: `${i === 0 ? lead : hang}${piece}`, ...(seq === undefined ? {} : { seq }) }))
}

export function pageLines(text: string, width: number): PageLine[] {
  const out: PageLine[] = []
  const room = Math.max(8, width)
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') {
      if (out.length > 0 && out[out.length - 1]!.kind !== 'blank') out.push({ kind: 'blank', text: '' })
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      for (const piece of wrapText(heading[1]!, room)) out.push({ kind: 'heading', text: piece })
      continue
    }
    const item = /^(\s*)([-*•]|\d+\.)\s+(.*)$/.exec(line)
    if (item) {
      const indent = item[1]!.length
      if (item[2]!.length === 1) {
        out.push(...itemLines(item[3]!, room, undefined, indent))
        continue
      }
      const lead = `${' '.repeat(indent)}${item[2]} `
      const hang = ' '.repeat(displayWidth(lead))
      wrapText(item[3]!, room - displayWidth(lead)).forEach((piece, i) => out.push({ kind: 'item', text: `${i === 0 ? lead : hang}${piece}` }))
      continue
    }
    for (const piece of wrapText(line, room)) out.push({ kind: 'text', text: piece })
  }
  while (out.length > 0 && out[out.length - 1]!.kind === 'blank') out.pop()
  return out
}

export function pageWindow(total: number, offset: number, rows: number): { start: number; end: number; above: number; below: number } {
  const size = Math.max(1, rows)
  const start = Math.max(0, Math.min(offset, Math.max(0, total - size)))
  const end = Math.min(total, start + size)
  return { start, end, above: start, below: Math.max(0, total - end) }
}

export interface ConventionHit {
  path: string
  file: string
  line: number
  text: string
}

export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map(w => w.trim()).filter(w => w.length >= 2)
}

export function conventionHits(query: string, files: readonly { path: string; text: string }[], max = 8): ConventionHit[] {
  const words = searchWords(query)
  if (words.length === 0) return []
  const out: ConventionHit[] = []
  for (const file of files) {
    const lines = file.text.split('\n')
    for (let i = 0; i < lines.length && out.length < max; i++) {
      const line = lines[i]!.replace(/\s+$/, '')
      const plain = line.toLowerCase()
      if (line.trim() === '' || /^#{1,6}\s/.test(line) || !words.every(w => plain.includes(w))) continue
      out.push({ path: file.path, file: basename(file.path), line: i + 1, text: line.trim().replace(/^([-*•]|\d+\.)\s+/, '') })
    }
    if (out.length >= max) break
  }
  return out
}

export function conventionRowLabel(hit: ConventionHit): string {
  return `${hit.file}:${hit.line} · ${hit.text}`
}

export function filePageLines(text: string, width: number, markLine: number | null): PageLine[] {
  const out: PageLine[] = []
  const raw = text.split('\n')
  for (let i = 0; i < raw.length; i++) {
    const pieces = pageLines(raw[i]!, width)
    if (pieces.length === 0) {
      if (out.length > 0 && out[out.length - 1]!.kind !== 'blank') out.push({ kind: 'blank', text: '' })
      continue
    }
    const marked = markLine !== null && i + 1 === markLine
    for (const piece of pieces) out.push(marked ? { ...piece, marked: true } : piece)
  }
  while (out.length > 0 && out[out.length - 1]!.kind === 'blank') out.pop()
  return out
}

export function searchPlaceholder(where: 'overview' | 'list' | 'open'): string {
  if (where === 'overview') return MEMORY_SEARCH_PLACEHOLDER
  if (where === 'list') return 'type to filter the list'
  return 'esc back, then type to search'
}

export type MemoryFooterState =
  | { kind: 'overview'; action: string | null }
  | { kind: 'search'; empty: boolean }
  | { kind: 'list'; open: string | null; empty: boolean }
  | { kind: 'page'; scrolls: boolean; editable: boolean }
  | { kind: 'fact'; verbs: string | null }
  | { kind: 'correcting' }
  | { kind: 'files'; direct: boolean }

export function memoryFooter(state: MemoryFooterState): string {
  switch (state.kind) {
    case 'overview':
      return `↑↓ move · pgup/pgdn page${state.action ? ` · ↵ ${state.action}` : ''} · ${MEMORY_CLOSE_HINT}`
    case 'search':
      return state.empty ? 'esc clears the search' : '↑↓ move · pgup/pgdn page · ↵ open · esc clears the search'
    case 'list':
      return state.empty ? 'esc back' : `↑↓ move · pgup/pgdn page${state.open ? ` · ↵ ${state.open}` : ''} · esc back`
    case 'page':
      return `${state.editable ? 'e open in editor · ' : ''}${state.scrolls ? '↑↓ scroll · pgup/pgdn page · ' : ''}esc back`
    case 'fact':
      return `↑↓ scroll · pgup/pgdn page · ${state.verbs ? `${state.verbs} · ` : ''}esc back`
    case 'correcting':
      return '↵ save correction · esc cancel'
    case 'files':
      return state.direct ? `↑↓ move · pgup/pgdn page · ↵ open in editor · ${MEMORY_CLOSE_HINT}` : '↑↓ move · pgup/pgdn page · ↵ open in editor · esc back'
  }
}
