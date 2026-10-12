import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { AMBER, CRIMSON, FAINT, SECOND, TEAL } from '../mercuryPalette.js'
import { EmptyState, StateBadge } from '../mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth } from '../mercury-ui/glyphs.js'
import { MenuFilterLine } from '../mercury-ui/menuFold.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useFlatList } from '../mercury-ui/useFlatList.js'
import { collectMemoryRefs, type MemoryRef } from '../../mneme/memoryRefs.js'
import { pendingRows } from '../../mneme/mnemeBuffer.js'
import { correctFact, retireFact } from '../../mneme/mnemeCorrect.js'
import { mnemeEnabled } from '../../mneme/mnemeGates.js'
import { mnemeStatus, readMaintenanceReceipts, runDueMaintenance } from '../../mneme/mnemeMaintenance.js'
import { readDocLines } from '../../mneme/mnemeRetrieval.js'
import { indexLines, liveEntryIndex, pinnedLine, pinnedView, readPinnedStatus, type IndexLine } from '../../mneme/mnemeFrontPage.js'
import { handoverDue, handoverIfDue, readHandoverReceipt, renderHandoverReceipt } from '../../mneme/mnemeHandover.js'
import { journalEnabled, journalPath, readJournal, type JournalEntry } from '../../mneme/journal.js'
import { listArchiveDocs, listTopicDocs } from '../../mneme/mnemeLibrary.js'
import type { MnemeEntry, MnemeTopicDoc } from '../../mneme/mnemeTopicDocs.js'
import { formatTextSize, pinFact, pinnedTextLimit, readPins, unpinFact, type PinRecord } from '../../mneme/mnemeUsage.js'
import { getMnemeHome, mnemeProjectKey } from '../../mneme/paths.js'
import { readLedger } from '../../mneme/ledger.js'
import { conversationIdHere } from '../../services/engine-connector/focusedConnector.js'
import { getInstructionCompositionState, getInstructionFiles } from '../../services/instructions/engine.js'
import { toRelativePath, toTildePath } from '../../utils/path.js'
import {
  MEMORY_SEARCH_READS,
  LINEAGE_COLUMNS,
  OVERVIEW_COLUMNS,
  VIEW_LEGEND,
  conventionHits,
  conventionRowLabel,
  filePageLines,
  humanStamp,
  itemLines,
  journalHeading,
  lineageHeading,
  lineageRows,
  lineageWidths,
  memoryBodySpacing,
  memoryFooter,
  newestOf,
  overviewCells,
  overviewRows,
  overviewWidths,
  pageLines,
  pageWindow,
  pinnedHeading,
  plural,
  searchPlaceholder,
  tableLine,
  topicsHeading,
  wrapText,
  type ConventionHit,
  type LineageTableRow,
  type MemoryFooterState,
  type OverviewRow,
  type PageLine,
} from './memoryCentreLayout.js'

const NOTE_COLOR: Record<'ok' | 'warn' | 'fail' | 'pending', string> = {
  ok: TEAL,
  warn: SECOND,
  fail: CRIMSON,
  pending: FAINT,
}

const STATUS_TONE: Record<MemoryRef['status'], { glyph: string; color: string; label: string }> = {
  current: { glyph: '●', color: TEAL, label: 'current' },
  unconsolidated: { glyph: '◌', color: SECOND, label: 'recent, unconsolidated' },
  'needs-review': { glyph: '▲', color: AMBER, label: 'needs review — cited path moved' },
}

const WARNING_STATES = new Set(['off', 'over', 'due', 'degraded', 'no note', 'unclosed'])
const QUIET_STATES = new Set(['none', 'first', '—'])

type View = 'overview' | 'facts' | 'pinned' | 'topics' | 'lineage' | 'journal'

const VIEW_WORDS: Record<Exclude<View, 'overview'>, string> = {
  facts: 'facts and decisions',
  pinned: 'pinned rules',
  topics: 'topics',
  lineage: 'lineage',
  journal: 'journal',
}

const VIEW_OF_SECTION: Partial<Record<string, Exclude<View, 'overview'>>> = {
  facts: 'facts',
  pinned: 'pinned',
  topics: 'topics',
  lineage: 'lineage',
  journal: 'journal',
}

const EMPTY_WORDS: Record<Exclude<View, 'overview'>, string> = {
  facts: 'the first fact Mercury saves lands here',
  pinned: 'open a fact and press p to pin it as said',
  topics: 'the first fact Mercury saves opens a page',
  lineage: 'the ledger starts with this session',
  journal: 'the model writes an entry, in its own words, when a session ends',
}

export const NEXT_SESSION_WORDS = 'this chat keeps what it loaded; new sessions get this'

interface CentreRow {
  id: string
  kind: 'overview' | 'ref' | 'pin' | 'missing-pin' | 'topic' | 'session' | 'journal' | 'convention'
  label: string
  cells?: string[]
  overview?: OverviewRow
  ref?: MemoryRef
  session?: LineageTableRow
  entry?: JournalEntry
  convention?: ConventionHit
}

interface Page {
  kind: 'topic' | 'note' | 'journal' | 'file'
  crumb: string
  title: string
  meta: string
  lines: PageLine[]
  path?: string
  focus?: number
}

export type OpenRef = MemoryRef & { missing?: boolean }

export const MEMORY_DEFAULT_INNER = 76
export const MEMORY_DEFAULT_ROWS = 30

function seqOf(ref: MemoryRef): number | null {
  const m = /^mneme:(\d+)$/.exec(ref.refId)
  return m ? Number(m[1]) : null
}

function slugOf(ref: MemoryRef): string | null {
  if (ref.kind === 'mneme-topic') return ref.refId.slice('mneme-topic:'.length)
  if (ref.kind === 'mneme-fact') {
    const m = /^Recall read:"doc:(.+)"$/.exec(ref.deref)
    return m ? m[1]! : null
  }
  return null
}

export function missingPinRef(seq: number): OpenRef {
  return {
    refId: `mneme:${seq}`,
    kind: 'mneme-fact',
    store: 'mneme',
    scope: 'project',
    status: 'current',
    summary: `seq ${seq}`,
    why: 'pinned, but no topic page holds it any more',
    deref: 'Recall',
    tier: 1,
    missing: true,
  }
}

export function sourceWords(source: string | undefined): string {
  if (!source) return ''
  if (source === 'operator') return 'from /memory'
  if (source.startsWith('tool:Retain')) return 'from the chat'
  if (source.startsWith('tool:Correct')) return 'corrected from the chat'
  if (source.startsWith('handover:')) return `taken in from ${source.slice('handover:'.length)}`
  return source
}

export function topicTitle(doc: Pick<MnemeTopicDoc, 'slug' | 'summary'>): string {
  const summary = doc.summary.replace(/ \(split\)$/, '').trim()
  const bare = summary === '' || summary.toLowerCase() === doc.slug || summary.toLowerCase().replace(/[^a-z0-9]+/g, '-') === doc.slug
  return bare ? doc.slug : `${doc.slug} — ${summary}`
}

export function entryWords(e: MnemeEntry): string {
  const by = e.supersededBy !== undefined ? ` · superseded by ${e.supersededBy}` : ''
  return `${e.text} ${`(seq ${e.seq} · ${humanStamp(e.time)} · ${sourceWords(e.source)}${by})`.replace(/ /g, '\u00a0')}`
}

export function topicPageLines(doc: MnemeTopicDoc, width: number): PageLine[] {
  const out: PageLine[] = []
  for (const section of doc.sections) {
    out.push({ kind: 'heading', text: section.heading }, { kind: 'blank', text: '' })
    for (const e of section.entries) out.push(...itemLines(entryWords(e), width, e.seq))
    out.push({ kind: 'blank', text: '' })
  }
  if (doc.history.length > 0) {
    out.push({ kind: 'heading', text: 'history' }, { kind: 'blank', text: '' })
    for (const e of doc.history) out.push(...itemLines(entryWords(e), width, e.seq))
  }
  while (out.length > 0 && out[out.length - 1]!.kind === 'blank') out.pop()
  return out
}

function topicPageDocs(): MnemeTopicDoc[] {
  return [...listTopicDocs(), ...listArchiveDocs().map(doc => ({ ...doc, slug: doc.id }))]
}

export function topicPage(slug: string, width: number, docs: MnemeTopicDoc[] = topicPageDocs()): Page {
  const doc = docs.find(d => d.slug === slug)
  if (!doc) return { kind: 'topic', crumb: `topics › ${slug}`, title: slug, meta: 'topic page unavailable', lines: [] }
  const facts = doc.sections.reduce((n, s) => n + s.entries.length, 0)
  const recent = readDocLines(slug, {})?.recent.length ?? 0
  const lines = topicPageLines(doc, width)
  if (recent > 0) lines.push({ kind: 'blank', text: '' }, { kind: 'meta', text: `+${recent} recent, unconsolidated — consolidated at the next maintenance pass` })
  return {
    kind: 'topic',
    crumb: `topics › ${slug}`,
    title: topicTitle(doc),
    meta: `${plural(facts, 'fact')} · ${doc.history.length} in history · updated ${humanStamp(doc.updated)}`,
    lines,
  }
}

export function notePage(row: LineageTableRow, width: number): Page {
  const entry = row.entry
  const engines = [...new Set(entry.engines.map(engine => engine.model))].join(', ')
  const note = entry.handoff
  return {
    kind: 'note',
    crumb: `lineage › session ${entry.ordinal}`,
    title: `session ${entry.ordinal}${row.current ? ' (this session)' : ''} — the note it left`,
    meta: `${humanStamp(entry.startedAt)} → ${entry.endedAt === null ? 'open' : humanStamp(entry.endedAt)} · ${engines || 'no engine recorded'}${note ? ` · note left ${humanStamp(note.at)}` : ''}`,
    lines: note ? pageLines(note.text, width) : [{ kind: 'meta', text: 'this session left no note' }],
  }
}

export function journalStamp(at: string): string {
  return at.slice(0, 16).replace('T', ' ')
}

export function journalPage(entry: JournalEntry, width: number): Page {
  return {
    kind: 'journal',
    crumb: `journal › ${humanStamp(entry.at)}`,
    title: `journal · ${humanStamp(entry.at)}`,
    meta: `written ${journalStamp(entry.at)} UTC · the model's own words · ${fileWords(journalPath())}`,
    lines: pageLines(entry.text, width),
  }
}

export function fileWords(path: string): string {
  const relative = toRelativePath(path)
  return relative === path ? toTildePath(path) : `./${relative}`
}

export function filePage(hit: ConventionHit, text: string, width: number): Page {
  const lines = filePageLines(text, width, hit.line)
  const focus = lines.findIndex(line => line.marked === true)
  return {
    kind: 'file',
    crumb: `instruction files › ${hit.file}`,
    title: hit.file,
    meta: `line ${hit.line} · loads every session · ${fileWords(hit.path)}`,
    lines,
    path: hit.path,
    focus: focus < 0 ? 0 : focus,
  }
}

export function journalEntryRows(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) => (a.at === b.at ? 0 : a.at > b.at ? -1 : 1))
}

export function journalRowLabel(entry: JournalEntry): string {
  return `${humanStamp(entry.at)}  ${entry.text.split('\n')[0] ?? ''}`
}

export function topicRef(row: IndexLine): MemoryRef {
  const slug = row.slugs[0] ?? row.key
  return {
    refId: `mneme-topic:${slug}`,
    kind: 'mneme-topic',
    store: 'mneme',
    scope: 'project',
    status: 'current',
    summary: row.line.slice(2),
    why: `${row.facts} fact${row.facts === 1 ? '' : 's'} on ${row.slugs.length} page${row.slugs.length === 1 ? '' : 's'}`,
    deref: `Recall read:"doc:${slug}"`,
    tier: 1,
  }
}

export function factRef(entry: MnemeEntry, slug: string): MemoryRef {
  return {
    refId: `mneme:${entry.seq}`,
    kind: 'mneme-fact',
    store: 'mneme',
    scope: 'project',
    status: 'current',
    summary: entry.text.length > 140 ? `${entry.text.slice(0, 139)}…` : entry.text,
    source: entry.source,
    capturedAt: entry.time,
    why: `saved ${humanStamp(entry.time)} ${sourceWords(entry.source)}`,
    deref: `Recall read:"doc:${slug}"`,
    tier: 2,
  }
}

export function pinnedRuleRow(row: { pin: PinRecord; entry: MnemeEntry; slug: string }): { label: string; ref: MemoryRef } {
  const size = pinnedLine(row.entry, row.pin).length + 1
  return {
    label: `${formatTextSize(size)} chars · ${row.pin.asked ? 'asked for by you' : 'pinned by Mercury'} · ${row.entry.text}`,
    ref: {
      ...factRef(row.entry, row.slug),
      why: `pinned ${humanStamp(row.pin.at)}${row.pin.asked ? ' · asked for by you' : ' · by Mercury'}`,
      tier: 1,
    },
  }
}

export function factListRows(docs: readonly MnemeTopicDoc[], pins: ReadonlySet<number>): { id: string; label: string; ref: MemoryRef }[] {
  const live: { entry: MnemeEntry; slug: string }[] = []
  for (const doc of docs) for (const section of doc.sections) for (const entry of section.entries) live.push({ entry, slug: doc.slug })
  live.sort((a, b) => (a.entry.time === b.entry.time ? b.entry.seq - a.entry.seq : a.entry.time > b.entry.time ? -1 : 1))
  return live.map(({ entry, slug }) => ({
    id: `fact-${entry.seq}`,
    label: `${humanStamp(entry.time)}  ${pins.has(entry.seq) ? 'pinned · ' : ''}${entry.text}`,
    ref: factRef(entry, slug),
  }))
}

export function pendingRef(row: { text: string; ts: string; source: string }, index: number): MemoryRef {
  return {
    refId: `mneme-pending:${index + 1}`,
    kind: 'mneme-pending',
    store: 'mneme',
    scope: 'project',
    status: 'unconsolidated',
    summary: row.text.length > 140 ? `${row.text.slice(0, 139)}…` : row.text,
    source: row.source,
    capturedAt: row.ts,
    why: `saved ${humanStamp(row.ts)} ${sourceWords(row.source)} · consolidates at the next maintenance pass`,
    deref: 'Recall',
    tier: 2,
  }
}

export function refHeader(ref: MemoryRef, pinned: boolean, asked: boolean): string {
  const seq = seqOf(ref)
  const id = seq !== null ? `seq ${seq}` : ref.kind === 'mneme-pending' ? 'recent' : ref.kind === 'mneme-topic' ? 'topic' : ''
  return [id, pinned ? 'pinned' : '', asked ? 'asked for by you' : ''].filter(Boolean).join(' · ')
}

export function refWhyLine(ref: MemoryRef, pins: readonly PinRecord[]): string {
  const seq = seqOf(ref)
  const pin = seq === null ? undefined : pins.find(p => p.seq === seq)
  const parts: string[] = []
  if (pin) parts.push(`pinned ${humanStamp(pin.at)}`)
  if (ref.capturedAt) parts.push(`saved ${humanStamp(ref.capturedAt)}${ref.source ? ` ${sourceWords(ref.source)}` : ''}`)
  const why = ref.why.replace(/^content matches/, 'matches').replace(/ · asked for by you$| · by Mercury$/, '')
  if (!/^(pinned|saved) /.test(why)) parts.push(why)
  return parts.join(' · ')
}

function matches(query: string, text: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || text.toLowerCase().includes(needle)
}

export function printable(input: string): string {
  return Array.from(input).filter(ch => ch >= ' ' && ch !== '\u007f').join('')
}

async function instructionFileFacts(): Promise<{ count: number; profile: string } | null> {
  try {
    const files = await getInstructionFiles()
    return { count: files.length, profile: getInstructionCompositionState().resolution.resolved }
  } catch {
    return null
  }
}

async function instructionTexts(): Promise<{ path: string; text: string }[]> {
  try {
    return (await getInstructionFiles()).map(file => ({ path: file.path, text: file.rawContent ?? file.content }))
  } catch {
    return []
  }
}

export function factPageLines(ref: OpenRef, width: number, docs: MnemeTopicDoc[] = topicPageDocs()): PageLine[] {
  if (ref.missing) return [{ kind: 'meta', text: 'pinned, but no topic page holds this fact any more · u unpins it' }]
  const slug = slugOf(ref)
  if (slug === null) {
    return [{ kind: 'text', text: ref.summary }, { kind: 'meta', text: '(unconsolidated — consolidates at the next maintenance pass)' }]
  }
  const page = topicPage(slug, width, docs)
  if (page.lines.length === 0) return [{ kind: 'meta', text: '(topic page unavailable)' }]
  const seq = seqOf(ref)
  const lines = page.lines.map(line => (seq !== null && line.seq === seq ? { ...line, marked: true } : line))
  return [{ kind: 'heading', text: page.title }, { kind: 'meta', text: page.meta }, { kind: 'blank', text: '' }, ...lines]
}

export function MemoryCentreView({
  onClose,
  onOpenFiles,
  onOpenFile,
  width = MEMORY_DEFAULT_INNER,
  rowBudget = MEMORY_DEFAULT_ROWS,
  onHint,
}: {
  onClose: () => void
  onOpenFiles?: () => void
  onOpenFile?: (path: string) => void
  width?: number
  rowBudget?: number
  onHint?: (hint: string) => void
}): React.ReactNode {
  const tok = useMercuryTokens()
  const accent = useSessionAccent().accent
  const [query, setQuery] = React.useState('')
  const [searchFocus, setSearchFocus] = React.useState(false)
  const [view, setView] = React.useState<View>('overview')
  const [detail, setDetail] = React.useState<OpenRef | null>(null)
  const [page, setPage] = React.useState<Page | null>(null)
  const [pageOffset, setPageOffset] = React.useState(0)
  const [correcting, setCorrecting] = React.useState<{ seq: number; buffer: string } | null>(null)
  const [armed, setArmed] = React.useState<number | null>(null)
  const cameFromRef = React.useRef<string | null>(null)
  const inner = Math.max(20, width)
  const textWidth = Math.max(8, inner - 2)
  const detailLines = React.useMemo(() => (detail ? factPageLines(detail, textWidth) : []), [detail, textWidth])

  const buildRows = React.useCallback(async (): Promise<CentreRow[]> => {
    if (view === 'overview' && query.trim().length > 0) {
      const pins = new Set(readPins().map(p => p.seq))
      const refs = collectMemoryRefs(query, { maxRefs: 12 })
      const rows: CentreRow[] = refs.map(r => {
        const seq = seqOf(r)
        return { id: r.refId, kind: 'ref' as const, label: `${seq !== null && pins.has(seq) ? 'pinned · ' : ''}${r.summary}`, ref: r }
      })
      for (const hit of conventionHits(query, await instructionTexts())) {
        rows.push({ id: `convention-${hit.path}:${hit.line}`, kind: 'convention', label: conventionRowLabel(hit), convention: hit })
      }
      return rows
    }
    if (view === 'facts') {
      const pins = new Set(readPins().map(p => p.seq))
      const rows: CentreRow[] = factListRows(listTopicDocs(), pins)
        .filter(row => matches(query, row.label))
        .map(row => ({ id: row.id, kind: 'ref' as const, label: row.label, ref: row.ref }))
      pendingRows().forEach((row, i) => {
        const label = `${humanStamp(row.ts)}  recent · ${row.text}`
        if (matches(query, label)) rows.unshift({ id: `pending-${i}`, kind: 'ref', label, ref: pendingRef(row, i) })
      })
      return rows
    }
    if (view === 'pinned') {
      const shelf = pinnedView(readPins(), liveEntryIndex(listTopicDocs()))
      const rows: CentreRow[] = []
      for (const row of shelf.loaded) {
        const built = pinnedRuleRow(row)
        if (matches(query, built.label)) rows.push({ id: `pin-${row.entry.seq}`, kind: 'pin', label: built.label, ref: built.ref })
      }
      for (const seq of shelf.missing) {
        const label = `seq ${seq} — pinned, but no page holds it any more; ↵ opens it, u unpins`
        if (matches(query, label)) rows.push({ id: `pin-${seq}`, kind: 'missing-pin', label })
      }
      return rows
    }
    if (view === 'topics') {
      return indexLines(listTopicDocs())
        .filter(row => matches(query, row.line))
        .map(row => ({ id: `topic-${row.key}`, kind: 'topic' as const, label: row.line.slice(2), ref: topicRef(row) }))
    }
    if (view === 'lineage') {
      return lineageRows(readLedger(mnemeProjectKey()), conversationIdHere())
        .filter(row => matches(query, row.cells.join(' ')))
        .map(row => ({ id: row.id, kind: 'session' as const, label: row.cells.join(' '), cells: row.cells, session: row }))
    }
    if (view === 'journal') {
      return journalEntryRows(readJournal())
        .map((entry, i) => ({ id: `journal-${i}`, kind: 'journal' as const, label: journalRowLabel(entry), entry }))
        .filter(row => matches(query, row.label))
    }
    const st = mnemeStatus()
    const docs = st.enabled ? listTopicDocs() : []
    const pins = st.enabled ? readPins() : []
    const receipt = st.enabled ? readHandoverReceipt() : null
    const rows = overviewRows({
      enabled: st.enabled,
      entryCount: st.entryCount,
      recent: st.buffered + st.pendingConsuming,
      historyCount: st.historyCount,
      topicCount: st.topicCount,
      newestFact: newestOf(docs.flatMap(d => d.sections.flatMap(s => s.entries.map(e => e.time)))),
      pinned: st.enabled ? readPinnedStatus() : null,
      pinnedLimit: pinnedTextLimit(),
      newestPin: newestOf(pins.map(p => p.at)),
      newestTopic: newestOf(docs.map(d => d.updated)),
      ledger: st.enabled ? readLedger(mnemeProjectKey()) : [],
      sessionId: conversationIdHere(),
      journal: st.enabled && journalEnabled() ? { enabled: true, entries: readJournal() } : { enabled: false, entries: [] },
      intake: receipt ? { kind: 'done', receipt } : st.enabled && handoverDue(getMnemeHome()) ? { kind: 'due' } : null,
      maintenance: {
        due: st.due,
        dueReason: st.dueReason,
        running: st.running,
        degraded: st.degraded,
        lastConsolidatedAt: st.lastConsolidatedAt,
        receipts: st.enabled ? readMaintenanceReceipts(undefined, 50).reverse() : [],
      },
      files: await instructionFileFacts(),
    })
    return rows.map(row => ({ id: row.id, kind: 'overview' as const, label: row.section, cells: overviewCells(row), overview: row }))
  }, [query, view])

  const searching = view === 'overview' && query.trim().length > 0
  const { roomy, fixedRows, detailLines: detailLineBudget } = memoryBodySpacing(rowBudget)
  const headerRows = view === 'lineage' ? 2 : 1
  const listRoom = Math.max(1, rowBudget - fixedRows - headerRows)
  const [overflow, setOverflow] = React.useState(false)
  const maxRows = overflow ? Math.max(1, listRoom - 2) : listRoom
  const engineActive = detail === null && page === null && correcting === null

  function openView(next: Exclude<View, 'overview'>, from: string): void {
    cameFromRef.current = from
    fl.setNote(null)
    setView(next)
  }

  function backToOverview(): void {
    fl.setNote(null)
    setView('overview')
  }

  const fl = useFlatList<CentreRow>({
    load: buildRows,
    maxRows,
    charKeys: false,
    isActive: engineActive,
    onClose: () => {
      if (query) {
        setQuery('')
        setSearchFocus(false)
      } else if (searchFocus) setSearchFocus(false)
      else if (view !== 'overview') backToOverview()
      else onClose()
    },
    onPrimary: row => {
      if (row.kind === 'ref' || row.kind === 'pin') {
        if (row.ref) {
          setPageOffset(0)
          setDetail(row.ref)
        }
        return
      }
      if (row.kind === 'missing-pin') {
        const seq = /^pin-(\d+)$/.exec(row.id)
        if (seq) setDetail(missingPinRef(Number(seq[1])))
        return
      }
      if (row.kind === 'convention' && row.convention) {
        const hit = row.convention
        void instructionTexts().then(files => {
          const file = files.find(f => f.path === hit.path)
          openPage(filePage(hit, file?.text ?? hit.text, textWidth))
        })
        return
      }
      if (row.kind === 'topic' && row.ref) {
        const slug = slugOf(row.ref)
        if (slug !== null) openPage(topicPage(slug, textWidth))
        return
      }
      if (row.kind === 'session' && row.session) {
        if (row.session.entry.handoff !== null) openPage(notePage(row.session, textWidth))
        return
      }
      if (row.kind === 'journal' && row.entry) {
        openPage(journalPage(row.entry, textWidth))
        return
      }
      const section = row.overview
      if (!section) return
      const target = VIEW_OF_SECTION[section.id]
      if (target && section.action) openView(target, section.id)
      else if (section.id === 'maintenance') runMaintenance()
      else if (section.id === 'intake' && section.action) runIntake()
      else if (section.id === 'files' && onOpenFiles) onOpenFiles()
    },
    reloadNote: 're-read memory stores',
    rowId: r => r.id,
  })
  const listLength = fl.list.length
  React.useLayoutEffect(() => {
    setOverflow(listLength > listRoom)
  }, [listLength, listRoom])

  const reloadRef = React.useRef(fl.reload)
  reloadRef.current = fl.reload
  const setNoteRef = React.useRef(fl.setNote)
  setNoteRef.current = fl.setNote
  React.useEffect(() => {
    setNoteRef.current(null)
    if (view === 'overview' && cameFromRef.current !== null) {
      const at = cameFromRef.current
      cameFromRef.current = null
      reloadRef.current({ at })
    } else reloadRef.current({ top: true })
  }, [query, view])

  function openPage(next: Page): void {
    setPageOffset(next.focus === undefined ? 0 : Math.max(0, next.focus - 2))
    setPage(next)
  }

  function runMaintenance(): void {
    if (fl.busyRef.current) return
    fl.busyRef.current = true
    fl.setNote({ text: 'running memory maintenance …', kind: 'pending' })
    void runDueMaintenance('operator', { force: true })
      .then(out =>
        fl.setNote(
          out.ran
            ? { text: `${GLYPH.check} maintenance: ${out.reason}${out.entries ? ` — ${out.entries} entr${out.entries === 1 ? 'y' : 'ies'} consolidated` : ''}`, kind: 'ok' }
            : { text: `maintenance skipped: ${out.reason}`, kind: 'warn' },
        ),
      )
      .catch((e: unknown) => fl.setNote({ text: `${GLYPH.fail} maintenance failed: ${String(e)}`, kind: 'fail' }))
      .finally(() => {
        fl.busyRef.current = false
        fl.reload()
      })
  }

  function runIntake(): void {
    if (fl.busyRef.current) return
    fl.busyRef.current = true
    fl.setNote({ text: 'taking the existing notes into memory …', kind: 'pending' })
    try {
      const receipt = handoverIfDue(getMnemeHome())
      fl.setNote(receipt ? { text: `${GLYPH.check} ${renderHandoverReceipt(receipt)[0]}`, kind: 'ok' } : { text: 'nothing to take in', kind: 'warn' })
    } catch (e) {
      fl.setNote({ text: `${GLYPH.fail} intake failed: ${String(e)}`, kind: 'fail' })
    } finally {
      fl.busyRef.current = false
      fl.reload()
    }
  }

  function togglePin(seq: number, pin: boolean): void {
    if (fl.busyRef.current) return
    fl.busyRef.current = true
    if (pin) pinFact(seq, undefined, undefined, { asked: true })
    else unpinFact(seq)
    fl.setNote({ text: pin ? 'pinning — republishing the front page …' : 'unpinning — republishing the front page …', kind: 'pending' })
    void runDueMaintenance('operator', { force: true })
      .then(() => {
        const status = readPinnedStatus()
        const over = status?.over ? ` — the shelf is over its limit (${formatTextSize(status.used)} of ${formatTextSize(status.limit)}); every rule still loads` : ''
        const undo = pin ? 'u unpins it again' : 'p pins it again'
        fl.setNote({ text: `${GLYPH.check} seq ${seq} ${pin ? 'pinned word for word, asked for by you' : 'unpinned'} · ${undo} · ${NEXT_SESSION_WORDS}${over}`, kind: over ? 'warn' : 'ok' })
      })
      .catch((e: unknown) => fl.setNote({ text: `${GLYPH.fail} pin failed: ${String(e)}`, kind: 'fail' }))
      .finally(() => {
        fl.busyRef.current = false
        fl.reload()
      })
  }

  function commitCorrection(): void {
    if (!correcting || !detail) return
    const text = correcting.buffer.trim()
    if (!text) {
      fl.setNote({ text: 'correction text is empty — nothing changed', kind: 'warn' })
      setCorrecting(null)
      return
    }
    const r = correctFact({ targetSeq: correcting.seq, text, source: 'operator', byUser: true })
    if (r.ok) {
      fl.setNote({ text: `${GLYPH.check} corrected seq ${r.targetSeq} → ${r.seq} (old kept as history) · ${NEXT_SESSION_WORDS}`, kind: 'ok' })
      setDetail(null)
    } else {
      fl.setNote({ text: `${GLYPH.fail} correction ${r.code}: ${truncateToWidth(r.message, 48)}`, kind: 'fail' })
    }
    setCorrecting(null)
    fl.reload()
  }

  function retireSelected(seq: number): void {
    const r = retireFact({ targetSeq: seq, reason: 'operator marked no longer current', source: 'operator', byUser: true })
    fl.setNote(
      r.ok
        ? { text: `${GLYPH.check} retired seq ${r.targetSeq} — kept in history · ${NEXT_SESSION_WORDS}`, kind: 'ok' }
        : { text: `${GLYPH.fail} retire ${r.code}: ${truncateToWidth(r.message, 52)}`, kind: 'fail' },
    )
    if (r.ok) setDetail(null)
    fl.reload()
  }

  const detailSeq = detail ? seqOf(detail) : null
  const pins = readPins()
  const detailPin = detailSeq === null ? undefined : pins.find(p => p.seq === detailSeq)
  const detailPinned = detailPin !== undefined
  const detailLive = detailSeq !== null && liveEntryIndex(listTopicDocs()).has(detailSeq)
  const detailActs = detailSeq !== null && mnemeEnabled() && (detailLive || detailPinned)
  const correctingLines = React.useMemo(() => {
    if (!correcting) return []
    const live = liveEntryIndex(listTopicDocs()).get(correcting.seq)
    return wrapText(live?.entry.text ?? detail?.summary ?? '', Math.max(8, textWidth - 5))
  }, [correcting, detail, textWidth])
  const pageRows = Math.max(1, rowBudget - (roomy ? 2 : 1) - 4 - (fl.note ? 2 : 0))
  const openLines = page ? page.lines : detail ? detailLines : []
  const pageWin = pageWindow(openLines.length, pageOffset, pageRows)
  const { visible, above, below, clampedSel, note, loadError, list } = fl

  useInput(
    (input, key, event) => {
      if (correcting) {
        if (key.escape) {
          event.stopImmediatePropagation()
          setCorrecting(null)
        } else if (key.return) commitCorrection()
        else if (key.backspace || key.delete) setCorrecting(prev => (prev ? { ...prev, buffer: prev.buffer.slice(0, -1) } : prev))
        else if (input && !key.ctrl && !key.meta) setCorrecting(prev => (prev ? { ...prev, buffer: prev.buffer + input } : prev))
        return
      }
      if (page || detail) {
        if (key.escape || key.leftArrow) {
          event.stopImmediatePropagation()
          if (armed !== null) {
            setArmed(null)
            fl.setNote(null)
            return
          }
          if (page) setPage(null)
          else setDetail(null)
          setPageOffset(0)
          return
        }
        if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
          event.stopImmediatePropagation()
          const step = key.pageUp || key.pageDown ? Math.max(1, pageRows - 1) : 1
          const direction = key.upArrow || key.pageUp ? -1 : 1
          setPageOffset(offset => Math.max(0, Math.min(Math.max(0, openLines.length - pageRows), offset + direction * step)))
          return
        }
        if (page) {
          if (input === 'e' && !key.ctrl && !key.meta && page.kind === 'file' && page.path && onOpenFile) onOpenFile(page.path)
          return
        }
        if (key.ctrl || key.meta || !detailActs || detailSeq === null) return
        if (armed !== null) {
          if (input === 'x' && armed === detailSeq) {
            setArmed(null)
            retireSelected(detailSeq)
          } else if (input) {
            setArmed(null)
            fl.setNote({ text: `kept seq ${detailSeq} — nothing changed`, kind: 'warn' })
          }
          return
        }
        if (input === 'c' && detailLive) setCorrecting({ seq: detailSeq, buffer: '' })
        else if (input === 'x' && detailLive) {
          setArmed(detailSeq)
          fl.setNote({ text: `retire seq ${detailSeq}? x again retires it (kept in history) · any other key keeps it`, kind: 'warn' })
        } else if (input === 'p' && !detailPinned && detailLive) togglePin(detailSeq, true)
        else if (input === 'u' && detailPinned) togglePin(detailSeq, false)
        return
      }
      if (loadError && input === 'r' && !key.ctrl && !key.meta) {
        fl.reload()
        return
      }
      if (key.backspace || key.delete) {
        if (query.length > 0) setQuery(q => q.slice(0, -1))
        return
      }
      if (input === '/' && !key.ctrl && !key.meta && query === '') {
        setSearchFocus(true)
        return
      }
      if (input && !key.ctrl && !key.meta && !key.return && !key.upArrow && !key.downArrow && !key.tab && !key.escape && !key.leftArrow && !key.rightArrow) {
        const typed = printable(input)
        if (typed !== '') setQuery(q => q + typed)
      }
    },
    { isActive: true },
  )

  const selectedOverview = fl.selected?.kind === 'overview' ? fl.selected.overview ?? null : null
  const verbs = detail && detailActs ? [detailLive ? 'c correct' : '', detailLive ? 'x retire' : '', detailPinned ? 'u unpin' : detailLive ? 'p pin' : ''].filter(Boolean).join(' · ') : null
  const footerState: MemoryFooterState = correcting
    ? { kind: 'correcting' }
    : detail
      ? { kind: 'fact', verbs }
      : page
        ? { kind: 'page', scrolls: openLines.length > pageRows, editable: page.kind === 'file' && onOpenFile !== undefined }
        : searching
          ? { kind: 'search', empty: list.length === 0 && fl.raw !== null }
          : view !== 'overview'
            ? {
                kind: 'list',
                empty: list.length === 0 && fl.raw !== null,
                open: fl.selected?.kind === 'session' ? ((fl.selected.session?.entry.handoff ?? null) !== null ? 'read the note' : null) : fl.selected?.kind === 'journal' ? 'read the entry' : fl.selected?.kind === 'topic' ? 'open the page' : 'open',
              }
            : { kind: 'overview', action: selectedOverview?.action ?? null }
  const footer = memoryFooter(footerState)
  React.useLayoutEffect(() => {
    onHint?.(footer)
  }, [footer, onHint])

  const subHeading = (): string => {
    if (view === 'facts') return `${plural(list.length, 'fact')}, newest first · ↵ opens one with its keys`
    if (view === 'pinned') return pinnedHeading(readPinnedStatus(), pinnedTextLimit())
    if (view === 'topics') return topicsHeading(list.length)
    if (view === 'lineage') return lineageHeading(readLedger(mnemeProjectKey()), conversationIdHere())
    if (view === 'journal') return journalHeading(list.length)
    return ''
  }

  const widths = view === 'lineage' ? lineageWidths(inner) : overviewWidths(inner)
  const columns = view === 'lineage' ? LINEAGE_COLUMNS : OVERVIEW_COLUMNS
  const stateColor = (state: string): string => (WARNING_STATES.has(state) ? tok.warning : QUIET_STATES.has(state) ? tok.textMuted : tok.textSecondary)
  const placeholder = searchPlaceholder(detail || page || correcting ? 'open' : view === 'overview' ? 'overview' : 'list')
  const legendLines = (text: string): string[] => (detailLineBudget === 2 ? wrapText(text, inner - 2).slice(0, 2) : [truncateToWidth(text, inner - 2)])

  const renderTableRow = (row: CentreRow, active: boolean): React.ReactNode => {
    const cells = row.cells ?? []
    const head = cells.slice(0, -1).map((cell, i) => padTo(cell, widths[i] ?? 0)).join(' ')
    const last = cells[cells.length - 1] ?? ''
    const lastWidth = widths[cells.length - 1] ?? 0
    return (
      <Text key={row.id} wrap="truncate-end">
        <Text color={active ? accent : tok.textMuted}>{active ? `${GLYPH.prompt} ` : '  '}</Text>
        <Text color={active ? tok.textPrimary : tok.textSecondary} bold={active}>{head}</Text>
        <Text> </Text>
        <Text color={active ? tok.textPrimary : stateColor(last)}>{truncateToWidth(last, lastWidth)}</Text>
      </Text>
    )
  }

  const renderListRow = (row: CentreRow, active: boolean): React.ReactNode => {
    const tone = row.ref && (row.kind === 'ref' || row.kind === 'pin') ? STATUS_TONE[row.ref.status] : row.kind === 'convention' ? { glyph: '§', color: tok.textInstruction } : null
    return (
      <Text key={row.id} wrap="truncate-end">
        <Text color={active ? accent : tok.textMuted}>{active ? `${GLYPH.prompt} ` : '  '}</Text>
        {tone ? <Text color={tone.color}>{`${tone.glyph} `}</Text> : null}
        <Text color={active ? tok.textPrimary : tok.textSecondary} bold={active}>{truncateToWidth(row.label, inner - (tone ? 4 : 2))}</Text>
      </Text>
    )
  }

  const renderPageLine = (line: PageLine, i: number): React.ReactNode => {
    const marked = line.marked === true
    const color = line.kind === 'heading' ? tok.textPrimary : line.kind === 'meta' ? tok.textMuted : marked ? tok.textPrimary : tok.textSecondary
    return (
      <Text key={i} wrap="truncate-end">
        <Text color={marked ? accent : tok.textMuted}>{marked ? `${GLYPH.prompt} ` : '  '}</Text>
        <Text color={color} bold={line.kind === 'heading' || marked}>{truncateToWidth(line.text, textWidth)}</Text>
      </Text>
    )
  }

  const pageBlock = (title: string, meta: string, crumb: string): React.ReactNode => (
    <Box flexDirection="column">
      <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(`memory › ${crumb}`, inner)}</Text>
      <Text color={tok.textPrimary} bold wrap="truncate-end">{truncateToWidth(title, inner)}</Text>
      <Text color={tok.textInstruction} wrap="truncate-end">{truncateToWidth(meta, inner)}</Text>
      {roomy ? <Box height={1} /> : null}
      {pageWin.above > 0 ? <Text color={tok.textMuted}>{`  +${pageWin.above} above`}</Text> : null}
      {openLines.slice(pageWin.start, pageWin.end).map((line, i) => renderPageLine(line, pageWin.start + i))}
      {pageWin.below > 0 ? <Text color={tok.textMuted}>{`  +${pageWin.below} more below`}</Text> : null}
    </Box>
  )

  const selectedWhy = (): string => {
    const row = fl.selected
    if (!row) return MEMORY_SEARCH_READS
    if (row.kind === 'convention' && row.convention) return `instruction file · line ${row.convention.line} · loads every session · ↵ opens it there · ${fileWords(row.convention.path)}`
    if (row.ref) return `${refWhyLine(row.ref, pins)} · ${STATUS_TONE[row.ref.status].label}`
    return MEMORY_SEARCH_READS
  }

  return (
    <Box flexDirection="column">
      <MenuFilterLine focused={query !== '' || searchFocus} text={query} placeholder={placeholder} accent={accent} muted={tok.textMuted} primary={tok.textPrimary} />
      {roomy ? <Box height={1} /> : null}
      {correcting && detail ? (
        <Box flexDirection="column">
          <Text color={AMBER} wrap="truncate-end">{`correcting seq ${correcting.seq} — retype it; the wording below goes to history:`}</Text>
          {detailPinned ? <Text color={AMBER} wrap="truncate-end">the pin and its asked-for mark follow the new wording</Text> : null}
          {correctingLines.map((line, i) => (
            <Text key={i} color={tok.textSecondary} wrap="truncate-end">{`${i === 0 ? 'now: ' : '     '}${line}`}</Text>
          ))}
          <Text color={tok.textPrimary}>{`> ${correcting.buffer}`}<Text color={accent}>▁</Text></Text>
        </Box>
      ) : detail ? (
        <Box flexDirection="column">
          <Box>
            <StateBadge state={detail.status === 'current' ? 'live' : 'gated'} label={STATUS_TONE[detail.status].label} />
            <Text color={tok.textMuted}>{`  ${refHeader(detail, detailPinned, detailPin?.asked === true)}`}</Text>
          </Box>
          <Text color={tok.textInstruction} wrap="truncate-end">{truncateToWidth(refWhyLine(detail, pins), inner)}</Text>
          {roomy ? <Box height={1} /> : null}
          {pageWin.above > 0 ? <Text color={tok.textMuted}>{`  +${pageWin.above} above`}</Text> : null}
          {openLines.slice(pageWin.start, pageWin.end).map((line, i) => renderPageLine(line, pageWin.start + i))}
          {pageWin.below > 0 ? <Text color={tok.textMuted}>{`  +${pageWin.below} more below`}</Text> : null}
        </Box>
      ) : page ? (
        pageBlock(page.title, page.meta, page.crumb)
      ) : fl.raw === null ? (
        <Text color={tok.textMuted}>◓ reading memory stores …</Text>
      ) : loadError ? (
        <Box flexDirection="column">
          <Text color={AMBER}>{`▲ memory unreadable — ${truncateToWidth(loadError, inner - 22)}`}</Text>
          <Text color={tok.textMuted}>the stores are unknown, not empty · r retries</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {view === 'overview' && !searching ? (
            <Text color={tok.textInstruction} wrap="truncate-end">{`  ${tableLine([...columns], widths)}`}</Text>
          ) : view === 'lineage' ? (
            <Box flexDirection="column">
              <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(`memory › ${VIEW_WORDS.lineage} · ${subHeading()}`, inner)}</Text>
              <Text color={tok.textInstruction} wrap="truncate-end">{`  ${tableLine([...columns], widths)}`}</Text>
            </Box>
          ) : searching ? (
            <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(`memory › matches for “${query}” · ${plural(list.length, 'match', 'matches')}`, inner)}</Text>
          ) : (
            <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(`memory › ${VIEW_WORDS[view as Exclude<View, 'overview'>]} · ${subHeading()}`, inner)}</Text>
          )}
          {list.length === 0 ? (
            <Box marginTop={1}>
              <EmptyState glyph="○" title={searching || query ? 'nothing matches' : 'nothing here yet'} hint={searching || query ? 'different words, or esc to clear the search' : view === 'overview' ? '' : EMPTY_WORDS[view as Exclude<View, 'overview'>]} />
            </Box>
          ) : null}
          {above > 0 ? <Text color={tok.textMuted}>{`  +${above} above`}</Text> : null}
          {visible.map((row, i) => (row.cells ? renderTableRow(row, i === clampedSel) : renderListRow(row, i === clampedSel)))}
          {below > 0 ? <Text color={tok.textMuted}>{`  +${below} more below`}</Text> : null}
          <Box marginTop={roomy ? 1 : 0} flexDirection="column">
            {note ? (
              <Text color={NOTE_COLOR[note.kind]} wrap="truncate-end">{truncateToWidth(`  ${note.text}`, inner)}</Text>
            ) : selectedOverview ? (
              legendLines(selectedOverview.detail).map((line, i) => <Text key={i} color={tok.textInstruction} wrap="truncate-end">{`  ${line}`}</Text>)
            ) : searching ? (
              legendLines(selectedWhy()).map((line, i) => <Text key={i} color={tok.textInstruction} wrap="truncate-end">{`  ${line}`}</Text>)
            ) : view !== 'overview' && view !== 'facts' ? (
              legendLines(VIEW_LEGEND[view]).map((line, i) => <Text key={i} color={tok.textInstruction} wrap="truncate-end">{`  ${line}`}</Text>)
            ) : null}
          </Box>
        </Box>
      )}
      {note && (detail !== null || page !== null || correcting !== null || fl.raw === null || loadError !== null) ? (
        <Box marginTop={1}>
          <Text color={NOTE_COLOR[note.kind]} wrap="truncate-end">{truncateToWidth(note.text, inner)}</Text>
        </Box>
      ) : null}
      {onHint === undefined ? (
        <Box marginTop={1}>
          <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(footer, inner)}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
