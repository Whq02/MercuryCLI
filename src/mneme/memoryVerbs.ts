
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { appendObservation, observationOverflow, pendingRows } from './mnemeBuffer.js'
import { listArchiveDocs, listTopicDocs } from './mnemeLibrary.js'
import { grepAll, readDocLines, catalogDocs, pageFileForSlug, PENDING_SLUG } from './mnemeRetrieval.js'
import { correctFact, pointFact, replacePendingRow, retireFact, strikePendingRow, userAskedRuleMessage, type MnemeCorrectResult, type PendingCorrectResult } from './mnemeCorrect.js'
import { memorySecretRefusal } from './mnemeSecretGuard.js'
import { ARCHIVE_PREFIX, isArchiveDoc, parseEntryLine, liveSeqs, serializeSignature, type MnemeTopicDoc } from './mnemeTopicDocs.js'
import { bumpUsage, readPins, readUsage } from './mnemeUsage.js'
import { candidates, fuseRankings, rankAllCandidates } from './mnemeLookup.js'
import { noteCorrected, noteRetained } from './lineageSession.js'
import { currentLedger, footnoteContext, footnotesOf, renderLedgerEntry, type Footnotes } from './mnemeFootnotes.js'
import type { LedgerEntry } from './types.js'
import { factMemoryState, type MemoryRef } from './memoryRefs.js'

function allDocs(dir: string): MnemeTopicDoc[] {
  return [...listTopicDocs(dir), ...listArchiveDocs(dir)]
}

function recallSlug(doc: MnemeTopicDoc): string {
  return isArchiveDoc(doc) ? `${ARCHIVE_PREFIX}${doc.slug}` : doc.slug
}


export function memoryVerbsEnabled(): boolean {
  return mnemeEnabled()
}

export function memoryVerbsWhyNot(): string | null {
  if (!mnemeEnabled()) return 'memory is off (memory.enabled is false in settings)'
  return null
}


export interface RetainItemInput {
  content: string
  context?: string
  topic?: string
  pin?: boolean
  replaces?: string
}

export function replacementTarget(
  spec: string,
  dir: string,
): { ok: true; seq: number; slug: string } | { ok: false; reason: string } {
  const m = /^seq:(\d+)$/.exec(spec.trim())
  if (!m) return { ok: false, reason: `replaces must name the rule it replaces as seq:<n> (got '${spec}')` }
  const seq = Number(m[1])
  const pin = readPins(dir).find(p => p.seq === seq)
  if (pin?.asked) return { ok: false, reason: `${userAskedRuleMessage(seq)}; retain the new rule without replaces to add it beside` }
  const holder = allDocs(dir).find(doc => liveSeqs(doc).has(seq))
  if (!holder) return { ok: false, reason: `seq ${seq} is not live in this library — recall it again for its current id` }
  return { ok: true, seq, slug: holder.slug }
}

export type RetainItemOutcome =
  | { index: number; status: 'stored'; id: string }
  | { index: number; status: 'already-staged'; id: string }
  | { index: number; status: 'refused'; reason: string }

const sessionRetained = new Map<string, string>()

export function _resetMemoryVerbSessionStateForTesting(): void {
  sessionRetained.clear()
  seenFullRows.clear()
  seenPendingRows.clear()
}

export function retainItems(
  items: RetainItemInput[],
  provenance: { session: string; agent?: string; source?: string; pin?: boolean; asked?: boolean },
  dir: string = mnemeLibraryDir(),
): RetainItemOutcome[] {
  const outcomes: RetainItemOutcome[] = []
  const sourceBase = provenance.source ?? `tool:Retain s:${provenance.session.slice(0, 8)}${provenance.agent ? ` a:${provenance.agent.slice(0, 12)}` : ''}`
  const usersOwnChat = provenance.agent === undefined
  items.forEach((item, index) => {
    const content = (item.content ?? '').trim()
    if (!content) {
      outcomes.push({ index, status: 'refused', reason: 'empty content' })
      return
    }
    const context = item.context?.trim() ?? ''
    const topic = item.topic?.trim() ?? ''
    const replaces = item.replaces?.trim() ?? ''
    const text = context ? `${content} (context: ${context})` : content
    const overflow = observationOverflow(text)
    if (overflow !== null) {
      outcomes.push({ index, status: 'refused', reason: context ? overflow.replace(' characters;', ' characters with its context;') : overflow })
      return
    }
    const secret = memorySecretRefusal(text)
    if (secret !== null) {
      outcomes.push({ index, status: 'refused', reason: secret })
      return
    }
    const duplicateKey = text
    const existing = sessionRetained.get(duplicateKey)
    if (existing && pendingRows(dir).some(row => `pending:${row.ts}` === existing && row.text === text)) {
      outcomes.push({ index, status: 'already-staged', id: existing })
      return
    }
    const replacement = replaces ? replacementTarget(replaces, dir) : null
    if (replacement && !replacement.ok) {
      outcomes.push({ index, status: 'refused', reason: replacement.reason })
      return
    }
    const pin = provenance.pin || item.pin || replacement !== null
    const askedByUser = (provenance.pin && provenance.asked) || (usersOwnChat && (item.pin || replacement !== null))
    const before = pendingRows(dir).length
    const written = appendObservation(
      {
        text,
        source: sourceBase,
        ...(topic ? { topicHint: topic } : replacement?.ok ? { topicHint: replacement.slug } : {}),
        ...(pin ? { pin: true } : {}),
        ...(askedByUser ? { asked: true } : {}),
        ...(replacement?.ok ? { replaces: replacement.seq } : {}),
      },
      dir,
    )
    if (!written) {
      outcomes.push({
        index,
        status: 'refused',
        reason: mnemeEnabled()
          ? 'the buffer append failed (a disk error) — the fact was NOT stored'
          : 'memory is off — nothing was stored',
      })
      return
    }
    const after = pendingRows(dir)
    if (after.length <= before) {
      outcomes.push({ index, status: 'refused', reason: 'the append did not land (post-write read saw no new row)' })
      return
    }
    const row = after[after.length - 1]!
    const id = `pending:${row.ts}`
    sessionRetained.set(duplicateKey, id)
    outcomes.push({ index, status: 'stored', id })
    noteRetained(id, pin === true)
  })
  return outcomes
}


export interface RecallHit {
  id: string
  label: 'consolidated' | 'pending' | 'archived'
  slug: string
  preview: string
  signature: string
  status?: MemoryRef['status']
  confirmedAt?: string
}

export interface RecallResult {
  hits: RecallHit[]
  elidable: boolean
  catalog: Array<{ slug: string; summary: string }>
}

const PREVIEW_CHARS = 200
const clip = (text: string): string => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… [clipped — read the full record by id]` : text)

function historyStartLine(slug: string, dir: string, cache: Map<string, number>): number {
  const cached = cache.get(slug)
  if (cached !== undefined) return cached
  let start = Number.POSITIVE_INFINITY
  try {
    const path = join(dir, pageFileForSlug(slug))
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex(line => /^##\s+history\s*$/i.test(line))
      if (index >= 0) start = index + 1
    }
  } catch {
  }
  cache.set(slug, start)
  return start
}

export function recallQuery(
  query: string,
  opts: { limit?: number; dir?: string; now?: Date } = {},
): RecallResult {
  const dir = opts.dir ?? mnemeLibraryDir()
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50)
  const hits: RecallHit[] = []
  const historyStarts = new Map<string, number>()
  for (const hit of grepAll(query, { maxHits: Infinity, dir })) {
    if (hit.slug !== PENDING_SLUG && hit.line >= historyStartLine(hit.slug, dir, historyStarts)) {
      continue
    }
    if (hit.slug === PENDING_SLUG) {
      const signatureMatch = /\[unconsolidated, ([^,]+), ([^\]]+)\]$/.exec(hit.text)
      const ts = signatureMatch?.[1] ?? ''
      hits.push({
        id: `pending:${ts}`,
        label: 'pending',
        slug: PENDING_SLUG,
        preview: clip(hit.text.replace(/ \[unconsolidated.*$/, '')),
        signature: signatureMatch ? `time=${signatureMatch[1]}, source=${signatureMatch[2]}` : 'unconsolidated',
      })
      continue
    }
    const entry = hit.entry ?? parseEntryLine(hit.text.trim())
    if (entry) {
      hits.push({
        id: `seq:${entry.seq}`,
        label: hit.slug.startsWith(ARCHIVE_PREFIX) ? 'archived' : 'consolidated',
        slug: hit.slug,
        preview: clip(entry.text),
        signature: `seq=${entry.seq}, time=${entry.time}, source=${entry.source}`,
      })
      continue
    }
    hits.push({
      id: `doc:${hit.slug}:${hit.line}`,
      label: 'consolidated',
      slug: hit.slug,
      preview: clip(hit.text.trim()),
      signature: `doc=${hit.slug} line=${hit.line}`,
    })
  }
  if (hits.length === 0 || /^[a-z0-9_\s-]+$/i.test(query)) {
    const pool = candidates(dir)
    const pins = new Set(readPins(dir).map(pin => pin.seq))
    for (const doc of listArchiveDocs(dir)) {
      const slug = recallSlug(doc)
      const pagePath = join(dir, pageFileForSlug(slug))
      for (const section of doc.sections) {
        for (const entry of section.entries) {
          pool.push({ id: `seq:${entry.seq}`, text: entry.text, signature: serializeSignature(entry), slug, pagePath, seq: entry.seq, pending: false, time: entry.time, pinned: pins.has(entry.seq) })
        }
      }
    }
    const ranked: RecallHit[] = rankAllCandidates(query, pool, { usage: readUsage(dir), now: opts.now?.getTime() }).map(hit => ({
      id: hit.id,
      label: hit.pending ? 'pending' : hit.slug.startsWith(ARCHIVE_PREFIX) ? 'archived' : 'consolidated',
      slug: hit.pending ? PENDING_SLUG : hit.slug,
      preview: clip(hit.text),
      signature: hit.pending ? hit.signature.replace(/^\[unconsolidated, ([^,]+), ([^\]]+)\]$/, 'time=$1, source=$2') : hit.signature.replace(/^<|>$/g, ''),
    }))
    const order = fuseRankings([hits.map(hit => hit.id), ranked.map(hit => hit.id)])
    const byId = new Map([...ranked, ...hits].map(hit => [hit.id, hit]))
    hits.splice(0, hits.length, ...order.map(id => byId.get(id)!))
  }
  const catalogRows = catalogDocs(dir)
    .filter(row => row.slug.includes(query.toLowerCase()) || row.summary.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 6)
    .map(row => ({ slug: row.slug, summary: row.summary }))
  const pins = readPins(dir)
  const usage = readUsage(dir)
  const entries = new Map(allDocs(dir).flatMap(doc => doc.sections.flatMap(section => section.entries.map(entry => [String(`seq:${entry.seq}`), entry] as const))))
  for (const hit of hits) {
    const entry = entries.get(hit.id)
    if (entry) Object.assign(hit, factMemoryState(entry, { pins, usage, now: opts.now }))
  }
  hits.sort((a, b) => Number(a.status === 'stale') - Number(b.status === 'stale'))
  return { hits: hits.slice(0, limit), elidable: hits.length === 0, catalog: catalogRows }
}


export const RECALL_RESULT_CAP_CHARS = 40_000

const DOC_RENDER_BUDGET_CHARS = RECALL_RESULT_CAP_CHARS - 2_000

const seenFullRows = new Set<number>()
const seenPendingRows = new Set<string>()

export function hasSeenFullRow(seq: number): boolean {
  return seenFullRows.has(seq)
}

export interface MemoryReadResult {
  found: boolean
  id: string
  content?: string
  slug?: string
  note?: string
  footnotes?: Footnotes
}

function clipDocRender(
  content: string,
  live: Set<number>,
  budget: number,
): {
  clipped: boolean
  content: string
  renderedSeqs: Set<number>
  droppedSeqs: number[]
  renderedLines: number
  totalLines: number
} {
  const lines = content.split('\n')
  const liveSeqOf = (line: string): number | null => {
    const entry = parseEntryLine(line)
    return entry && entry.supersededBy === undefined && live.has(entry.seq) ? entry.seq : null
  }
  const kept: string[] = []
  let used = 0
  const clipped = content.length > budget
  for (const line of lines) {
    if (clipped && used + line.length + 1 > budget) break
    kept.push(line)
    used += line.length + 1
  }
  const renderedSeqs = new Set<number>()
  for (const line of kept) {
    const seq = liveSeqOf(line)
    if (seq !== null) renderedSeqs.add(seq)
  }
  const droppedSeqs: number[] = []
  for (const line of lines.slice(kept.length)) {
    const seq = liveSeqOf(line)
    if (seq !== null && !renderedSeqs.has(seq)) droppedSeqs.push(seq)
  }
  return { clipped, content: kept.join('\n'), renderedSeqs, droppedSeqs, renderedLines: kept.length, totalLines: lines.length }
}

function nameDroppedRows(droppedSeqs: number[]): string {
  if (droppedSeqs.length === 0) return 'no live rows'
  const named = droppedSeqs.slice(0, 12).map(seq => `seq:${seq}`).join(', ')
  return droppedSeqs.length > 12 ? `${named} … and ${droppedSeqs.length - 12} more` : named
}

export function readMemoryRecord(
  id: string,
  dir: string = mnemeLibraryDir(),
  opts: { sessions?: readonly LedgerEntry[] } = {},
): MemoryReadResult {
  const sessions = opts.sessions ?? currentLedger()
  const seqMatch = /^seq:(\d+)$/.exec(id)
  if (seqMatch) {
    const seq = Number(seqMatch[1])
    for (const doc of allDocs(dir)) {
      const path = join(dir, pageFileForSlug(recallSlug(doc)))
      if (!existsSync(path)) continue
      const lines = readFileSync(path, 'utf8').split('\n')
      const lineIndex = lines.findIndex(line => line.includes(`<seq=${seq},`))
      if (lineIndex < 0) continue
      bumpUsage([seq], dir)
      const row = parseEntryLine(lines[lineIndex]!.trim())
      const footnotes = row ? footnotesOf(row, footnoteContext(dir, sessions)) : {}
      const block = readDocLines(recallSlug(doc), { from: lineIndex + 1, to: lineIndex + 1, dir, recent: 0 })
      const sectionContent = block?.content ?? lines[lineIndex]!
      if (sectionContent.length > DOC_RENDER_BUDGET_CHARS) {
        const rowLine = lines[lineIndex]!
        if (rowLine.length > DOC_RENDER_BUDGET_CHARS) {
          return {
            found: true,
            id,
            slug: doc.slug,
            content: `${rowLine.slice(0, DOC_RENDER_BUDGET_CHARS)}…`,
            note: `this row alone is ${rowLine.length} chars — past the ${DOC_RENDER_BUDGET_CHARS}-char render budget, the FULL row cannot be shown, and amend stays locked for seq ${seq}`,
            footnotes,
          }
        }
        seenFullRows.add(seq)
        return {
          found: true,
          id,
          slug: doc.slug,
          content: rowLine,
          note: `full record read — amend is now unlocked for this seq (only the row is shown: its enclosing section is ${sectionContent.length} chars, past the ${DOC_RENDER_BUDGET_CHARS}-char render budget)`,
          footnotes,
        }
      }
      seenFullRows.add(seq)
      return {
        found: true,
        id,
        slug: doc.slug,
        content: sectionContent,
        note: 'full record read — amend is now unlocked for this seq',
        footnotes,
      }
    }
    return { found: false, id, note: `seq ${seq} is not live in this library (it may be history — recall again)` }
  }
  const ledgerMatch = /^ledger:(\d+)$/.exec(id)
  if (ledgerMatch) {
    const ordinal = Number(ledgerMatch[1])
    const session = sessions.find(s => s.ordinal === ordinal)
    if (!session) {
      return { found: false, id, note: sessions.length === 0 ? 'the ledger has no session yet' : `no session ${ordinal} in the ledger (${sessions.length} so far)` }
    }
    return { found: true, id, content: renderLedgerEntry(session, sessions.length) }
  }
  const docMatch = /^doc:([a-z0-9-]+)/.exec(id)
  const slug = docMatch?.[1] ?? (id.startsWith('pending:') ? null : id)
  if (slug) {
    const result = readDocLines(slug, { dir, recent: 0 })
    if (!result) return { found: false, id, note: `no topic page '${slug}'` }
    const doc = allDocs(dir).find(d => recallSlug(d) === slug)
    const live = doc ? liveSeqs(doc) : new Set<number>()
    const render = clipDocRender(result.content, live, DOC_RENDER_BUDGET_CHARS)
    for (const seq of render.renderedSeqs) seenFullRows.add(seq)
    bumpUsage([...render.renderedSeqs], dir)
    if (!render.clipped) return { found: true, id, slug, content: render.content }
    return {
      found: true,
      id,
      slug,
      content: render.content,
      note:
        `TRUNCATED: the doc is ${result.content.length} chars, past the ${DOC_RENDER_BUDGET_CHARS}-char render budget — showing lines 1–${render.renderedLines} of ${render.totalLines}. ` +
        `DROPPED ${render.totalLines - render.renderedLines} line(s) carrying ${render.droppedSeqs.length} live row(s): ${nameDroppedRows(render.droppedSeqs)}. ` +
        `Dropped rows are NOT marked seen — read one with read:"seq:<n>" before amending it`,
    }
  }
  if (id.startsWith('pending:')) {
    const ts = id.slice('pending:'.length)
    const row = pendingRows(dir).find(r => r.ts === ts)
    if (!row) return { found: false, id, note: 'that pending row is gone (consolidated, struck or never existed) — recall again' }
    seenPendingRows.add(ts)
    return { found: true, id, content: `${row.text} [unconsolidated, ${row.ts}, ${row.source}]`, note: 'full record read — amend is now unlocked for this pending row' }
  }
  return { found: false, id, note: 'unrecognized id — use seq:<n>, doc:<slug>, pending:<ts>, or ledger:<ordinal>' }
}


export type CorrectOp = 'supersede' | 'amend' | 'retract'

export type CorrectOutcome =
  | { ok: true; op: CorrectOp; newSeq: number; targetSeq: number; slug: string }
  | { ok: true; op: CorrectOp; draft: true; targetId: string; newId: string | null; replacedBy?: number }
  | { ok: false; op: CorrectOp; code: string; message: string }

function liveReplacementSeq(spec: string, dir: string): { ok: true; seq: number } | { ok: false; code: string; message: string } {
  const match = /^seq:(\d+)$/.exec(spec)
  if (!match) return { ok: false, code: 'invalid', message: `replacementId must be a seq:<n> id (got '${spec}')` }
  const seq = Number(match[1])
  if (!allDocs(dir).some(doc => liveSeqs(doc).has(seq))) return { ok: false, code: 'unknown-target', message: `replacement seq ${seq} is not live in this library` }
  return { ok: true, seq }
}

function correctPending(
  input: { op: CorrectOp; id: string; ts: string; content?: string; replacementId?: string; reason: string; source: string },
  dir: string,
): CorrectOutcome {
  const { op, id, ts, reason, source } = input
  const landed = (result: PendingCorrectResult, replacedBy?: number): CorrectOutcome => {
    if (!result.ok) return { ok: false, op, code: result.code, message: result.message }
    noteCorrected(id)
    return { ok: true, op, draft: true, targetId: id, newId: result.row ? `pending:${result.row.ts}` : null, ...(replacedBy === undefined ? {} : { replacedBy }) }
  }
  switch (op) {
    case 'retract':
      return landed(strikePendingRow({ ts, dir }))
    case 'supersede': {
      if (input.replacementId) {
        const replacement = liveReplacementSeq(input.replacementId, dir)
        if (!replacement.ok) return { ok: false, op, code: replacement.code, message: replacement.message }
        return landed(strikePendingRow({ ts, dir }), replacement.seq)
      }
      const content = (input.content ?? '').trim()
      if (!content) return { ok: false, op, code: 'invalid', message: 'supersede needs content (the new truth) or a replacementId' }
      return landed(replacePendingRow({ ts, text: `${content} (why: ${reason})`, source, dir }))
    }
    case 'amend': {
      const content = (input.content ?? '').trim()
      if (!content) return { ok: false, op, code: 'invalid', message: 'amend needs the corrected content' }
      if (!seenPendingRows.has(ts)) {
        return {
          ok: false,
          op,
          code: 'unseen-evidence',
          message: `amend refused: the full pending row ${id} has not been read this session — a clipped preview must never destroy an unseen tail. Read it first (Recall with read:"${id}").`,
        }
      }
      return landed(replacePendingRow({ ts, text: `${content} (amended: ${reason})`, source, dir }))
    }
  }
}

export function correctMemory(
  input: {
    op: CorrectOp
    id: string
    content?: string
    replacementId?: string
    reason: string
    session: string
  },
  dir: string = mnemeLibraryDir(),
): CorrectOutcome {
  const { op } = input
  const source = `tool:Correct s:${input.session.slice(0, 8)}`
  const reason = (input.reason ?? '').trim()
  if (input.id.startsWith('pending:')) {
    if (!reason) return { ok: false, op, code: 'invalid', message: 'a correction always carries its reason' }
    return correctPending({ op, id: input.id, ts: input.id.slice('pending:'.length), ...(input.content !== undefined ? { content: input.content } : {}), ...(input.replacementId !== undefined ? { replacementId: input.replacementId } : {}), reason, source }, dir)
  }
  const seqMatch = /^seq:(\d+)$/.exec(input.id)
  if (!seqMatch) {
    return {
      ok: false,
      op,
      code: 'not-editable',
      message: `corrections address a consolidated row by its seq:<n> id or a pending row by its pending:<ts> id (got '${input.id}')`,
    }
  }
  const targetSeq = Number(seqMatch[1])
  if (!reason) return { ok: false, op, code: 'invalid', message: 'a correction always carries its reason' }

  const finish = (result: MnemeCorrectResult): CorrectOutcome => {
    if (result.ok) {
      noteCorrected(`seq:${result.targetSeq}`)
      return { ok: true, op, newSeq: result.seq, targetSeq: result.targetSeq, slug: result.slug }
    }
    return { ok: false, op, code: result.code, message: result.message }
  }

  switch (op) {
    case 'retract':
      return finish(retireFact({ targetSeq, reason, source, dir }))
    case 'supersede': {
      if (input.replacementId) {
        const replacement = liveReplacementSeq(input.replacementId, dir)
        if (!replacement.ok) return { ok: false, op, code: replacement.code, message: replacement.message }
        return finish(pointFact({ targetSeq, replacementSeq: replacement.seq, reason, source, dir }))
      }
      const content = (input.content ?? '').trim()
      if (!content) return { ok: false, op, code: 'invalid', message: 'supersede needs content (the new truth) or a replacementId' }
      return finish(correctFact({ targetSeq, text: `${content} (why: ${reason})`, source, dir }))
    }
    case 'amend': {
      const content = (input.content ?? '').trim()
      if (!content) return { ok: false, op, code: 'invalid', message: 'amend needs the corrected content' }
      if (!hasSeenFullRow(targetSeq)) {
        return {
          ok: false,
          op,
          code: 'unseen-evidence',
          message: `amend refused: the CURRENT full row for seq ${targetSeq} has not been read this session — a clipped preview must never destroy an unseen tail. Read it first (Recall with read:"seq:${targetSeq}").`,
        }
      }
      return finish(correctFact({ targetSeq, text: `${content} (amended: ${reason})`, source, dir }))
    }
  }
}
