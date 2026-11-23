import * as React from 'react'
import { join } from 'node:path'
import { useLayoutPublish, useLoad, usePublish } from '../effects/effects.js'
import { useInput } from '../themedRenderer.js'
import { useSessionAccent } from '../widgets/sessionAccent.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { useFlatList } from '../widgets/useFlatList.js'
import { factMemoryState, type MemoryRef } from '../../sessions/mneme/memoryRefs.js'
import { pendingRows } from '../../sessions/mneme/mnemeBuffer.js'
import { mnemeEnabled, mnemeLibraryDir } from '../../sessions/mneme/mnemeGates.js'
import { mnemeUnreadSentence } from '../../sessions/mneme/mnemeUnread.js'
import { getMemoryBaseDir, mnemeProjectKey, projectRecordsDir } from '../../sessions/mneme/paths.js'
import { readSignalLog, signalCounts, SIGNAL_TURN_LIMIT } from '../../sessions/mneme/mnemeSignal.js'
import { readDocLines } from '../../sessions/mneme/mnemeRetrieval.js'
import { liveEntryIndex } from '../../sessions/mneme/mnemeFrontPage.js'
import { journalPath, type JournalEntry } from '../../sessions/mneme/journal.js'
import { listArchiveDocs, listTopicDocs } from '../../sessions/mneme/mnemeLibrary.js'
import type { MnemeEntry, MnemeTopicDoc } from '../../sessions/mneme/mnemeTopicDocs.js'
import { bumpUsage, readPins } from '../../sessions/mneme/mnemeUsage.js'
import { filePageLines, humanStamp, itemLines, memoryBodySpacing, memoryFooter, pageLines, pageWindow, plural, wrapText, type ConventionHit, type LineageTableRow, type MemoryFooterState, type PageLine } from './memoryCentreLayout.js'
import { type View, type CentreRow, type Page, type OpenRef, seqOf, sourceWords, fileWords, instructionTexts } from './centre/refs.js'
import { buildCentreRows } from './centre/rows.js'
import { type CentreActions, openPageOf, runMaintenanceOf, runIntakeOf, togglePinOf, commitCorrectionOf, retirePendingOf, pinPendingOf, retireSelectedOf } from './centre/actions.js'
import { type CentreKeys, correctingKeys, openKeys, listKeys } from './centre/keys.js'
import { centreView } from './centre/views.js'

export { NEXT_SESSION_WORDS, type OpenRef, sourceWords, fileWords, journalEntryRows, journalRowLabel, topicRef, factRef, pinnedRuleRow, factListRows, pendingRef, refHeader, refWhyLine, printable } from './centre/refs.js'

const VIEW_OF_SECTION: Partial<Record<string, Exclude<View, 'overview'>>> = {
  facts: 'facts',
  pinned: 'pinned',
  topics: 'topics',
  lineage: 'lineage',
  journal: 'journal',
}

export const MEMORY_DEFAULT_INNER = 76

export const MEMORY_DEFAULT_ROWS = 30

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

export function topicTitle(doc: Pick<MnemeTopicDoc, 'slug' | 'summary'>): string {
  const summary = doc.summary.replace(/ \(split\)$/, '').trim()
  const bare = summary === '' || summary.toLowerCase() === doc.slug || summary.toLowerCase().replace(/[^a-z0-9]+/g, '-') === doc.slug
  return bare ? doc.slug : `${doc.slug} — ${summary}`
}

export function entryWords(e: MnemeEntry): string {
  const by = e.supersededBy !== undefined ? ` · superseded by ${e.supersededBy}` : ''
  return `${e.text} ${`(seq ${e.seq} · ${humanStamp(e.time)} · ${sourceWords(e.source, e.text)}${by})`.replace(/ /g, '\u00a0')}`
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

export function factSignalLine(ref: OpenRef, dir: string = mnemeLibraryDir()): string | null {
  const seq = seqOf(ref)
  const id = seq !== null ? `seq:${seq}` : ref.kind === 'mneme-pending' && ref.capturedAt !== undefined ? `pending:${ref.capturedAt}` : null
  if (id === null) return null
  const counts = signalCounts(readSignalLog(dir))[id] ?? { offered: 0, opened: 0, cited: 0 }
  return `offered ${counts.offered} · opened ${counts.opened} · cited ${counts.cited} (last ${SIGNAL_TURN_LIMIT} turns)`
}

export function factPageLines(ref: OpenRef, width: number, docs: MnemeTopicDoc[] = topicPageDocs()): PageLine[] {
  if (ref.missing) return [{ kind: 'meta', text: 'pinned, but no topic page holds this fact any more · u unpins it' }]
  const slug = slugOf(ref)
  const signal = factSignalLine(ref)
  const signalLines: PageLine[] = signal === null ? [] : wrapText(signal, width).map(text => ({ kind: 'meta', text }))
  if (slug === null) {
    const row = ref.kind === 'mneme-pending' && ref.capturedAt !== undefined ? pendingRows().find(r => r.ts === ref.capturedAt) : undefined
    const body = wrapText(row?.text ?? ref.summary, Math.max(8, width - 4)).map(text => ({ kind: 'text' as const, text }))
    return [...signalLines, ...body, { kind: 'meta', text: `(unconsolidated — consolidates at the next maintenance pass${row?.pin === true ? ' · pinned from then on' : ''})` }]
  }
  const page = topicPage(slug, width, docs)
  if (page.lines.length === 0) return [{ kind: 'meta', text: '(topic page unavailable)' }]
  const seq = seqOf(ref)
  const lines = page.lines.map(line => (seq !== null && line.seq === seq ? { ...line, marked: true } : line))
  return [{ kind: 'heading', text: page.title }, { kind: 'meta', text: page.meta }, ...signalLines, { kind: 'blank', text: '' }, ...lines]
}

export function MemoryCentreView({
  onClose,
  onOpenFiles,
  onOpenFile,
  initialRow = null,
  width = MEMORY_DEFAULT_INNER,
  rowBudget = MEMORY_DEFAULT_ROWS,
  onHint,
}: {
  onClose: () => void
  onOpenFiles?: () => void
  onOpenFile?: (path: string) => void
  initialRow?: string | null
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
  const [correcting, setCorrecting] = React.useState<{ seq: number | null; ts: string | null; buffer: string } | null>(null)
  const [armed, setArmed] = React.useState<number | string | null>(null)
  const cameFromRef = React.useRef<string | null>(initialRow)
  const inner = Math.max(20, width)
  const textWidth = Math.max(8, inner - 2)
  const detailLines = React.useMemo(() => (detail ? factPageLines(detail, textWidth) : []), [detail, textWidth])

  const buildRows = React.useCallback((): Promise<CentreRow[]> => buildCentreRows(view, query), [query, view])

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
          const seq = seqOf(row.ref)
          const live = seq === null ? undefined : liveEntryIndex([...listTopicDocs(), ...listArchiveDocs()]).get(seq)
          if (live) bumpUsage([live.entry.seq])
          setPageOffset(0)
          setDetail(live ? { ...row.ref, ...factMemoryState(live.entry) } : row.ref)
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
  const nextOverflow = fl.list.length > listRoom
  if (nextOverflow !== overflow) setOverflow(nextOverflow)

  const reloadRef = React.useRef(fl.reload)
  reloadRef.current = fl.reload
  const setNoteRef = React.useRef(fl.setNote)
  setNoteRef.current = fl.setNote
  useLoad(() => {
    setNoteRef.current(null)
    if (view === 'overview' && cameFromRef.current !== null) {
      const at = cameFromRef.current
      cameFromRef.current = null
      reloadRef.current({ at })
    } else reloadRef.current({ top: true })
  }, [query, view])

  const actions: CentreActions = { fl, setPageOffset, setPage, correcting, detail, setCorrecting, setDetail }
  function openPage(next: Page): void { return openPageOf(actions, next) }
  function runMaintenance(): void { return runMaintenanceOf(actions) }
  function runIntake(): void { return runIntakeOf(actions) }
  function togglePin(seq: number, pin: boolean): void { return togglePinOf(actions, seq, pin) }
  function commitCorrection(): void { return commitCorrectionOf(actions) }
  function retirePending(ts: string): void { return retirePendingOf(actions, ts) }
  function pinPending(ts: string): void { return pinPendingOf(actions, ts) }
  function retireSelected(seq: number): void { return retireSelectedOf(actions, seq) }

  const detailSeq = detail ? seqOf(detail) : null
  const pins = readPins()
  const detailPin = detailSeq === null ? undefined : pins.find(p => p.seq === detailSeq)
  const detailPinned = detailPin !== undefined
  const detailLive = detailSeq !== null && liveEntryIndex(listTopicDocs()).has(detailSeq)
  const detailPendingTs = detail !== null && detail.kind === 'mneme-pending' && detail.capturedAt !== undefined && pendingRows().some(r => r.ts === detail.capturedAt) ? detail.capturedAt : null
  const detailPendingPinned = detailPendingTs !== null && pendingRows().some(r => r.ts === detailPendingTs && r.pin === true)
  const detailActs = mnemeEnabled() && ((detailSeq !== null && (detailLive || detailPinned)) || detailPendingTs !== null)
  const correctingLines = React.useMemo(() => {
    if (!correcting) return []
    const live = correcting.seq === null ? undefined : liveEntryIndex(listTopicDocs()).get(correcting.seq)
    const pending = correcting.ts === null ? undefined : pendingRows().find(r => r.ts === correcting.ts)
    return wrapText(live?.entry.text ?? pending?.text ?? detail?.summary ?? '', Math.max(8, textWidth - 5))
  }, [correcting, detail, textWidth])
  const unreadText = mnemeUnreadSentence([mnemeLibraryDir(), projectRecordsDir(mnemeProjectKey())], [join(getMemoryBaseDir(), 'projects')])
  const activeNote = fl.note ?? (unreadText !== null ? { kind: 'warn' as const, text: unreadText } : null)
  const pageRows = Math.max(1, rowBudget - (roomy ? 2 : 1) - 6 - (activeNote ? 2 : 0))
  const openLines = page ? page.lines : detail ? detailLines : []
  const pageWin = pageWindow(openLines.length, pageOffset, pageRows)
  const openedPage = React.useRef<{ page: Page | null; seqs: Set<number> }>({ page: null, seqs: new Set() })
  usePublish(() => {
    if (openedPage.current.page !== page) openedPage.current = { page, seqs: new Set() }
    if (page?.kind !== 'topic') return
    const live = liveEntryIndex([...listTopicDocs(), ...listArchiveDocs()])
    const seqs = [...new Set(page.lines.slice(pageWin.start, pageWin.end).flatMap(line => line.seq !== undefined && live.has(line.seq) && !openedPage.current.seqs.has(line.seq) ? [line.seq] : []))]
    bumpUsage(seqs)
    for (const seq of seqs) openedPage.current.seqs.add(seq)
  }, [page, pageWin.start, pageWin.end])
  const { visible, above, below, clampedSel, loadError, list } = fl

  useInput(
    (input, key, event) => {
      const keys: CentreKeys = { correcting, setCorrecting, commitCorrection, page, detail, armed, setArmed, fl, setPage, setDetail, setPageOffset, pageRows, openLines, onOpenFile, detailActs, detailSeq, detailPendingTs, retirePending, pinPending, detailPendingPinned, retireSelected, detailLive, togglePin, detailPinned, loadError, query, setQuery, setSearchFocus }
      if (correctingKeys(keys, input, key, event)) return
      if (openKeys(keys, input, key, event)) return
      listKeys(keys, input, key)
    },
    { isActive: true },
  )

  const selectedOverview = fl.selected?.kind === 'overview' ? fl.selected.overview ?? null : null
  const verbs = detail && detailActs
    ? detailPendingTs !== null
      ? ['c correct', 'x retire', detailPendingPinned ? '' : 'p pin'].filter(Boolean).join(' · ')
      : [detailLive ? 'c correct' : '', detailLive ? 'x retire' : '', detailPinned ? 'u unpin' : detailLive ? 'p pin' : ''].filter(Boolean).join(' · ')
    : null
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
  useLayoutPublish(() => {
    onHint?.(footer)
  }, [footer, onHint])

  return centreView({ view, list, query, searchFocus, detail, page, correcting, inner, tok, accent, textWidth, roomy, detailLineBudget, pageWin, openLines, fl, pins, detailPinned, detailPin, correctingLines, loadError, searching, above, visible, clampedSel, below, note: activeNote, selectedOverview, onHint, footer })
}
