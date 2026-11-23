import { collectMemoryRefs } from '../../../sessions/mneme/memoryRefs.js'
import { pendingRows } from '../../../sessions/mneme/mnemeBuffer.js'
import { mnemeStatus, readMaintenanceReceipts } from '../../../sessions/mneme/mnemeMaintenance.js'
import { indexLines, liveEntryIndex, pinnedView, readPinnedStatus } from '../../../sessions/mneme/mnemeFrontPage.js'
import { handoverDue, readHandoverReceipt } from '../../../sessions/mneme/mnemeHandover.js'
import { journalEnabled, readJournal } from '../../../sessions/mneme/journal.js'
import { listTopicDocs } from '../../../sessions/mneme/mnemeLibrary.js'
import { pinnedTextLimit, readPins } from '../../../sessions/mneme/mnemeUsage.js'
import { getMnemeHome, mnemeProjectKey } from '../../../sessions/mneme/paths.js'
import { readLedger } from '../../../sessions/mneme/ledger.js'
import { conversationIdHere } from '../../../engine/connector/focusedConnector.js'
import { conventionHits, conventionRowLabel, humanStamp, lineageRows, newestOf, overviewCells, overviewRows } from '../memoryCentreLayout.js'
import { type View, type CentreRow, seqOf, journalEntryRows, journalRowLabel, topicRef, pinnedRuleRow, factListRows, pendingRef, matches, instructionFileFacts, instructionTexts } from './refs.js'

export async function buildCentreRows(view: View, query: string): Promise<CentreRow[]> {
  if (view === 'overview' && query.trim().length > 0) {
    const pins = new Set(readPins().map(p => p.seq))
    const refs = collectMemoryRefs(query, { maxRefs: 12 })
    const rows: CentreRow[] = refs.map(r => {
      const seq = seqOf(r)
      return { id: r.refId, kind: 'ref' as const, label: `${seq !== null && pins.has(seq) ? 'pinned · ' : r.status === 'stale' ? 'stale · ' : ''}${r.summary}`, ref: r }
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
}
