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
import { correctFact, retireFact } from '../../mneme/mnemeCorrect.js'
import { mnemeEnabled } from '../../mneme/mnemeGates.js'
import { mnemeStatus, readMaintenanceReceipts, runDueMaintenance } from '../../mneme/mnemeMaintenance.js'
import { readDocLines } from '../../mneme/mnemeRetrieval.js'
import { indexLines, liveEntryIndex, pinnedLine, pinnedView, readPinnedStatus, type IndexLine } from '../../mneme/mnemeFrontPage.js'
import { handoverDue, handoverIfDue, readHandoverReceipt, renderHandoverReceipt } from '../../mneme/mnemeHandover.js'
import { journalEnabled, journalPath, readJournal, type JournalEntry } from '../../mneme/journal.js'
import { listTopicDocs } from '../../mneme/mnemeLibrary.js'
import type { MnemeEntry, MnemeTopicDoc } from '../../mneme/mnemeTopicDocs.js'
import { formatTextSize, pinFact, pinnedTextLimit, readPins, unpinFact, type PinRecord } from '../../mneme/mnemeUsage.js'
import { getMnemeHome, mnemeProjectKey } from '../../mneme/paths.js'
import { readLedger } from '../../mneme/ledger.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getInstructionCompositionState, getInstructionFiles } from '../../services/instructions/engine.js'
import {
  MEMORY_SEARCH_PLACEHOLDER,
  LINEAGE_COLUMNS,
  OVERVIEW_COLUMNS,
  VIEW_LEGEND,
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
  tableLine,
  topicsHeading,
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

type View = 'overview' | 'pinned' | 'topics' | 'lineage' | 'journal'

const VIEW_WORDS: Record<Exclude<View, 'overview'>, string> = {
  pinned: 'pinned rules',
  topics: 'topics',
  lineage: 'lineage',
  journal: 'journal',
}

interface CentreRow {
  id: string
  kind: 'overview' | 'ref' | 'pin' | 'missing-pin' | 'topic' | 'session' | 'journal'
  label: string
  cells?: string[]
  overview?: OverviewRow
  ref?: MemoryRef
  session?: LineageTableRow
  entry?: JournalEntry
}

interface Page {
  kind: 'topic' | 'note' | 'journal'
  crumb: string
  title: string
  meta: string
  lines: PageLine[]
}

export const MEMORY_DEFAULT_INNER = 76
export const MEMORY_DEFAULT_ROWS = 30

function seqOf(ref: MemoryRef): number | null {
  const m = /^mneme:(\d+)$/.exec(ref.refId)
  return m ? Number(m[1]) : null
}

function slugOf(ref: MemoryRef): string | null {
  if (ref.kind === 'mneme-topic') return ref.refId.slice('mneme-topic:'.length)
  if (ref.kind === 'mneme-fact') return ref.deref.replace(/^Recall read:"doc:/, '').replace(/"$/, '')
  return null
}

export function topicTitle(doc: Pick<MnemeTopicDoc, 'slug' | 'summary'>): string {
  const summary = doc.summary.replace(/ \(split\)$/, '').trim()
  const bare = summary === '' || summary.toLowerCase() === doc.slug || summary.toLowerCase().replace(/[^a-z0-9]+/g, '-') === doc.slug
  return bare ? doc.slug : `${doc.slug} — ${summary}`
}

export function entryWords(e: MnemeEntry): string {
  const by = e.supersededBy !== undefined ? ` · superseded by ${e.supersededBy}` : ''
  return `${e.text} ${`(seq ${e.seq} · ${humanStamp(e.time)} · ${e.source}${by})`.replace(/ /g, '\u00a0')}`
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

export function topicPage(slug: string, width: number, docs: MnemeTopicDoc[] = listTopicDocs()): Page {
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
    meta: `written ${journalStamp(entry.at)} UTC · the model's own words · ${journalPath()}`,
    lines: pageLines(entry.text, width),
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

export function pinnedRuleRow(row: { pin: PinRecord; entry: MnemeEntry; slug: string }): { label: string; ref: MemoryRef } {
  const size = pinnedLine(row.entry, row.pin).length + 1
  return {
    label: `${formatTextSize(size)} chars · ${row.pin.asked ? 'asked for by you' : 'pinned by Mercury'} · ${row.entry.text}`,
    ref: {
      refId: `mneme:${row.entry.seq}`,
      kind: 'mneme-fact',
      store: 'mneme',
      scope: 'project',
      status: 'current',
      summary: row.entry.text.length > 140 ? `${row.entry.text.slice(0, 139)}…` : row.entry.text,
      source: row.entry.source,
      capturedAt: row.entry.time,
      why: `pinned ${humanStamp(row.pin.at)}${row.pin.asked ? ' · asked for by you' : ' · by Mercury'}`,
      deref: `Recall read:"doc:${row.slug}"`,
      tier: 1,
    },
  }
}

function matches(query: string, text: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || text.toLowerCase().includes(needle)
}

async function instructionFileFacts(): Promise<{ count: number; profile: string } | null> {
  try {
    const files = await getInstructionFiles()
    return { count: files.length, profile: getInstructionCompositionState().resolution.resolved }
  } catch {
    return null
  }
}

export function factPageLines(ref: MemoryRef, width: number, docs: MnemeTopicDoc[] = listTopicDocs()): PageLine[] {
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
  width = MEMORY_DEFAULT_INNER,
  rowBudget = MEMORY_DEFAULT_ROWS,
  onHint,
}: {
  onClose: () => void
  onOpenFiles?: () => void
  width?: number
  rowBudget?: number
  onHint?: (hint: string) => void
}): React.ReactNode {
  const tok = useMercuryTokens()
  const accent = useSessionAccent().accent
  const [query, setQuery] = React.useState('')
  const [view, setView] = React.useState<View>('overview')
  const [detail, setDetail] = React.useState<MemoryRef | null>(null)
  const [page, setPage] = React.useState<Page | null>(null)
  const [pageOffset, setPageOffset] = React.useState(0)
  const [correcting, setCorrecting] = React.useState<{ seq: number; buffer: string } | null>(null)
  const inner = Math.max(20, width)
  const textWidth = Math.max(8, inner - 2)
  const detailLines = React.useMemo(() => (detail ? factPageLines(detail, textWidth) : []), [detail, textWidth])

  const buildRows = React.useCallback(async (): Promise<CentreRow[]> => {
    if (view === 'overview' && query.trim().length > 0) {
      const pins = new Set(readPins().map(p => p.seq))
      const refs = collectMemoryRefs(query, { maxRefs: 12 })
      return refs.map(r => {
        const seq = seqOf(r)
        return { id: r.refId, kind: 'ref' as const, label: `${seq !== null && pins.has(seq) ? 'pinned · ' : ''}${r.summary}`, ref: r }
      })
    }
    if (view === 'pinned') {
      const shelf = pinnedView(readPins(), liveEntryIndex(listTopicDocs()))
      const rows: CentreRow[] = []
      for (const row of shelf.loaded) {
        const built = pinnedRuleRow(row)
        if (matches(query, built.label)) rows.push({ id: `pin-${row.entry.seq}`, kind: 'pin', label: built.label, ref: built.ref })
      }
      for (const seq of shelf.missing) {
        const label = `seq ${seq} — pinned, but no page holds it any more; u unpins`
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
      return lineageRows(readLedger(mnemeProjectKey()), String(getSessionId()))
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
      sessionId: String(getSessionId()),
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
  const { roomy, fixedRows } = memoryBodySpacing(rowBudget)
  const headerRows = view === 'lineage' ? 2 : 1
  const listRoom = Math.max(1, rowBudget - fixedRows - headerRows)
  const [overflow, setOverflow] = React.useState(false)
  const maxRows = overflow ? Math.max(1, listRoom - 2) : listRoom
  const engineActive = detail === null && page === null && correcting === null

  const fl = useFlatList<CentreRow>({
    load: buildRows,
    maxRows,
    charKeys: false,
    isActive: engineActive,
    onClose: () => {
      if (query) setQuery('')
      else if (view !== 'overview') setView('overview')
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
      if (section.id === 'pinned' && section.action) setView('pinned')
      else if (section.id === 'topics' && section.action) setView('topics')
      else if (section.id === 'lineage') setView('lineage')
      else if (section.id === 'journal' && section.action) setView('journal')
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
  React.useEffect(() => {
    reloadRef.current({ top: true })
  }, [query, view])

  function openPage(next: Page): void {
    setPageOffset(0)
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
        fl.setNote({ text: `${GLYPH.check} seq ${seq} ${pin ? 'pinned word for word, marked as asked for by you' : 'unpinned'}${over}`, kind: over ? 'warn' : 'ok' })
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
      fl.setNote({ text: `${GLYPH.check} corrected seq ${r.targetSeq} → ${r.seq} (old kept as history)`, kind: 'ok' })
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
        ? { text: `${GLYPH.check} retired seq ${r.targetSeq} — kept in history`, kind: 'ok' }
        : { text: `${GLYPH.fail} retire ${r.code}: ${truncateToWidth(r.message, 52)}`, kind: 'fail' },
    )
    if (r.ok) setDetail(null)
    fl.reload()
  }

  const detailSeq = detail ? seqOf(detail) : null
  const detailPinned = detailSeq !== null && readPins().some(p => p.seq === detailSeq)
  const pageRows = Math.max(1, rowBudget - fixedRows - 4 - (fl.note ? 2 : 0))
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
        else if (key.backspace || key.delete) setCorrecting({ ...correcting, buffer: correcting.buffer.slice(0, -1) })
        else if (input && !key.ctrl && !key.meta) setCorrecting({ ...correcting, buffer: correcting.buffer + input })
        return
      }
      if (page || detail) {
        if (key.escape || key.leftArrow) {
          event.stopImmediatePropagation()
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
        if (page) return
        if (input === 'c' && !key.ctrl && !key.meta && detailSeq !== null && mnemeEnabled()) setCorrecting({ seq: detailSeq, buffer: '' })
        else if (input === 'x' && detailSeq !== null && mnemeEnabled()) retireSelected(detailSeq)
        else if (input === 'p' && detailSeq !== null && mnemeEnabled() && !detailPinned) togglePin(detailSeq, true)
        else if (input === 'u' && detailSeq !== null && mnemeEnabled() && detailPinned) togglePin(detailSeq, false)
        return
      }
      if (loadError && input === 'r' && !key.ctrl && !key.meta) {
        fl.reload()
        return
      }
      if (view === 'pinned' && input === 'u' && !key.ctrl && !key.meta) {
        const pinSeq = /^pin-(\d+)$/.exec(fl.selected?.id ?? '')
        if (pinSeq && mnemeEnabled()) togglePin(Number(pinSeq[1]), false)
        return
      }
      if (key.backspace || key.delete) {
        if (query.length > 0) setQuery(q => q.slice(0, -1))
        return
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta && !key.return && !key.upArrow && !key.downArrow && !key.tab && !key.escape && !key.leftArrow && !key.rightArrow) {
        setQuery(q => q + input)
      }
    },
    { isActive: true },
  )

  const selectedOverview = fl.selected?.kind === 'overview' ? fl.selected.overview ?? null : null
  const footerState: MemoryFooterState = correcting
    ? { kind: 'correcting' }
    : detail
      ? { kind: 'fact', verbs: detailSeq !== null && mnemeEnabled() ? `c correct · x retire · ${detailPinned ? 'u unpin' : 'p pin'}` : null }
      : page
        ? { kind: 'page', scrolls: openLines.length > pageRows }
        : searching
          ? { kind: 'search' }
          : view === 'pinned'
            ? { kind: 'pinned' }
            : view === 'topics'
              ? { kind: 'topics' }
              : view === 'lineage'
                ? { kind: 'lineage', noted: (fl.selected?.session?.entry.handoff ?? null) !== null }
                : view === 'journal'
                  ? { kind: 'journal' }
                  : { kind: 'overview', action: selectedOverview?.action ?? null }
  const footer = memoryFooter(footerState)
  React.useLayoutEffect(() => {
    onHint?.(footer)
  }, [footer, onHint])

  const subHeading = (): string => {
    if (view === 'pinned') return pinnedHeading(readPinnedStatus(), pinnedTextLimit())
    if (view === 'topics') return topicsHeading(list.length)
    if (view === 'lineage') return lineageHeading(readLedger(mnemeProjectKey()), String(getSessionId()))
    if (view === 'journal') return journalHeading(list.length)
    return ''
  }

  const widths = view === 'lineage' ? lineageWidths(inner) : overviewWidths(inner)
  const columns = view === 'lineage' ? LINEAGE_COLUMNS : OVERVIEW_COLUMNS
  const stateColor = (state: string): string => (WARNING_STATES.has(state) ? tok.warning : QUIET_STATES.has(state) ? tok.textMuted : tok.textSecondary)

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
    const tone = row.ref && (row.kind === 'ref' || row.kind === 'pin') ? STATUS_TONE[row.ref.status] : null
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

  return (
    <Box flexDirection="column">
      <MenuFilterLine focused={query !== ''} text={query} placeholder={MEMORY_SEARCH_PLACEHOLDER} accent={accent} muted={tok.textMuted} primary={tok.textPrimary} />
      {roomy ? <Box height={1} /> : null}
      {correcting && detail ? (
        <Box flexDirection="column">
          <Text color={AMBER}>{`correcting seq ${correcting.seq} — the old fact moves to history:`}</Text>
          <Text color={tok.textPrimary}>{`> ${correcting.buffer}`}<Text color={accent}>▁</Text></Text>
        </Box>
      ) : detail ? (
        <Box flexDirection="column">
          <Box>
            <StateBadge state={detail.status === 'current' ? 'live' : 'gated'} label={STATUS_TONE[detail.status].label} />
            <Text color={tok.textMuted}>{`  ${detail.refId}${detailPinned ? ' · pinned' : ''}`}</Text>
          </Box>
          <Text color={tok.textInstruction} wrap="truncate-end">{truncateToWidth(`why recalled: ${detail.why}${detail.capturedAt ? ` · captured ${humanStamp(detail.capturedAt)}` : ''}${detail.source ? ` · source ${detail.source}` : ''}`, inner)}</Text>
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
              <EmptyState glyph="○" title={searching || query ? 'nothing matches' : 'nothing here yet'} hint={searching || query ? 'different words, or esc to clear the search' : 'esc back'} />
            </Box>
          ) : null}
          {above > 0 ? <Text color={tok.textMuted}>{`  +${above} above`}</Text> : null}
          {visible.map((row, i) => (row.cells ? renderTableRow(row, i === clampedSel) : renderListRow(row, i === clampedSel)))}
          {below > 0 ? <Text color={tok.textMuted}>{`  +${below} more below`}</Text> : null}
          <Box marginTop={roomy ? 1 : 0}>
            {note ? (
              <Text color={NOTE_COLOR[note.kind]} wrap="truncate-end">{truncateToWidth(`  ${note.text}`, inner)}</Text>
            ) : selectedOverview ? (
              <Text color={tok.textInstruction} wrap="truncate-end">{truncateToWidth(`  ${selectedOverview.detail}`, inner)}</Text>
            ) : searching ? (
              <Text color={tok.textInstruction} wrap="truncate-end">{truncateToWidth(fl.selected?.ref ? `  ${fl.selected.ref.why} · ${STATUS_TONE[fl.selected.ref.status].label}` : '  the search reads topic pages, pinned rules and recent facts', inner)}</Text>
            ) : view !== 'overview' ? (
              <Text color={tok.textInstruction} wrap="truncate-end">{truncateToWidth(`  ${VIEW_LEGEND[view]}`, inner)}</Text>
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
