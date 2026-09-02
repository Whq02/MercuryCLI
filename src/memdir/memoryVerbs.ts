// ============================================================================
//  memdir/memoryVerbs — the model-facing memory verb surface (Retain /
//  Recall / Reflect / Correct) over the EXISTING owners.
//
//  No new engine: Retain stages through the MNEME buffer (append-only,
//  validator-guarded consolidation), Recall packages the ratified journey
//  (catalog + grep over docs AND pending rows), Correct rides
//  mnemeCorrect's supersede-with-history. The three honesty refusals live
//  here structurally:
//    · a failed retain is a PER-ITEM typed failure, never a count that
//      papers over a swallowed error;
//    · the read tier never writes (Recall/Reflect touch no file);
//    · amend requires the CURRENT full row to have been read this session
//      (the seen-evidence check), so a clipped preview can never destroy an
//      unseen tail.
//  memdir's one-fact files and MEMORY.md are a DIFFERENT store on purpose
//  (curated index vs observational log) — no verb writes them.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { appendObservation, pendingRows } from './mnemeBuffer.js'
import { listTopicDocs } from './mnemeConsolidate.js'
import { grepAll, readDocLines, catalogDocs, PENDING_SLUG } from './mnemeRetrieval.js'
import { correctFact, retireFact, type MnemeCorrectResult } from './mnemeCorrect.js'
import { docFileName, parseEntryLine, liveSeqs } from './mnemeTopicDocs.js'
import { isAutoMemoryEnabled } from './paths.js'

// ── availability (the gate the tools + /health both read) ──────────────────

export function memoryVerbsEnabled(): boolean {
  return mnemeEnabled() && isAutoMemoryEnabled()
}

/** The honest why-not for /health when the verbs are absent. */
export function memoryVerbsWhyNot(): string | null {
  if (!mnemeEnabled()) return 'MERCURY_MNEME is off (the verbs ride the MNEME backend)'
  if (!isAutoMemoryEnabled()) return 'auto-memory is disabled in settings'
  return null
}

// ── Retain ─────────────────────────────────────────────────────────────────

export interface RetainItemInput {
  content: string
  context?: string
  topic?: string
}

export type RetainItemOutcome =
  | { index: number; status: 'stored'; id: string }
  | { index: number; status: 'already-staged'; id: string }
  | { index: number; status: 'refused'; reason: string }

/** In-session duplicate map: content → the id it landed under. Session
 *  lifetime IS process lifetime for this store. */
const sessionRetained = new Map<string, string>()

export function _resetMemoryVerbSessionStateForTesting(): void {
  sessionRetained.clear()
  seenFullRows.clear()
}

/**
 * Stage items into the MNEME buffer, one row each, PER-ITEM outcomes. The
 * id is the row's (ts, source) provenance pair — stable through
 * consolidation because both cues MOVE with the entry (the signature law).
 */
export function retainItems(
  items: RetainItemInput[],
  provenance: { session: string; agent?: string },
  dir: string = mnemeLibraryDir(),
): RetainItemOutcome[] {
  const outcomes: RetainItemOutcome[] = []
  const sourceBase = `tool:Retain s:${provenance.session.slice(0, 8)}${provenance.agent ? ` a:${provenance.agent.slice(0, 12)}` : ''}`
  items.forEach((item, index) => {
    const content = (item.content ?? '').trim()
    if (!content) {
      outcomes.push({ index, status: 'refused', reason: 'empty content' })
      return
    }
    const text = item.context ? `${content} (context: ${item.context.trim()})` : content
    const duplicateKey = text
    const existing = sessionRetained.get(duplicateKey)
    if (existing) {
      outcomes.push({ index, status: 'already-staged', id: existing })
      return
    }
    const before = pendingRows(dir).length
    const written = appendObservation(
      { text, source: sourceBase, ...(item.topic ? { topicHint: item.topic } : {}) },
      dir,
    )
    if (!written) {
      outcomes.push({
        index,
        status: 'refused',
        reason: mnemeEnabled()
          ? 'the buffer append failed (disk error or over-cap content) — the fact was NOT stored'
          : 'MNEME is off — nothing was stored',
      })
      return
    }
    // Honest write check: the row must actually be readable back.
    const after = pendingRows(dir)
    if (after.length <= before) {
      outcomes.push({ index, status: 'refused', reason: 'the append did not land (post-write read saw no new row)' })
      return
    }
    const row = after[after.length - 1]!
    const id = `pending:${row.ts}`
    sessionRetained.set(duplicateKey, id)
    outcomes.push({ index, status: 'stored', id })
  })
  return outcomes
}

// ── Recall ─────────────────────────────────────────────────────────────────

export interface RecallHit {
  /** Stable id: `seq:<n>` (consolidated) or `pending:<ts>` (unconsolidated). */
  id: string
  label: 'consolidated' | 'pending'
  slug: string
  /** Bounded preview with an explicit clip marker. */
  preview: string
  /** The row's own signature cues (seq/time/source, or ts+source). */
  signature: string
}

export interface RecallResult {
  hits: RecallHit[]
  /** Their useless-flag behaviour, adopted: an empty recall is elidable
   *  context (spec 07 feeds on this). */
  elidable: boolean
  catalog: Array<{ slug: string; summary: string }>
}

const PREVIEW_CHARS = 200
const clip = (text: string): string => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}… [clipped — read the full record by id]` : text)

/** 1-based line number of a doc's `## history` heading (Infinity: none). */
function historyStartLine(slug: string, dir: string, cache: Map<string, number>): number {
  const cached = cache.get(slug)
  if (cached !== undefined) return cached
  let start = Number.POSITIVE_INFINITY
  try {
    const path = join(dir, docFileName(slug))
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex(line => /^##\s+history\s*$/i.test(line))
      if (index >= 0) start = index + 1
    }
  } catch {
    /* unreadable doc — treat as no history section */
  }
  cache.set(slug, start)
  return start
}

export function recallQuery(
  query: string,
  opts: { limit?: number; dir?: string } = {},
): RecallResult {
  const dir = opts.dir ?? mnemeLibraryDir()
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 50)
  const hits: RecallHit[] = []
  const historyStarts = new Map<string, number>()
  for (const hit of grepAll(query, { maxHits: limit, dir })) {
    // Default recall answers with LIVE facts only: rows in a doc's
    // `## history` section (superseded originals, retire tombstones) stay
    // out — they remain readable through the doc read path by id.
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
    const entry = parseEntryLine(hit.text.trim())
    if (entry) {
      hits.push({
        id: `seq:${entry.seq}`,
        label: 'consolidated',
        slug: hit.slug,
        preview: clip(entry.text),
        signature: `seq=${entry.seq}, time=${entry.time}, source=${entry.source}`,
      })
      continue
    }
    // A doc line without a signature (heading, summary) still routes.
    hits.push({
      id: `doc:${hit.slug}:${hit.line}`,
      label: 'consolidated',
      slug: hit.slug,
      preview: clip(hit.text.trim()),
      signature: `doc=${hit.slug} line=${hit.line}`,
    })
  }
  const catalogRows = catalogDocs(dir)
    .filter(row => row.slug.includes(query.toLowerCase()) || row.summary.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 6)
    .map(row => ({ slug: row.slug, summary: row.summary }))
  return { hits, elidable: hits.length === 0, catalog: catalogRows }
}

// ── the full-record read path (+ the seen-evidence store) ──────────────────

/** The Recall tool's result-size cap (chars) — ONE owner for the number:
 *  the tool's maxResultSizeChars imports it, and the render budget below
 *  derives from it, so seen-marking can never outrun what the harness
 *  actually rendered. */
export const RECALL_RESULT_CAP_CHARS = 40_000

/** What a doc read may return as content: head-room under the cap absorbs
 *  the tool's framing (the trailing [note] line), so the harness truncation
 *  seam can never clip a row this module already marked as seen. */
const DOC_RENDER_BUDGET_CHARS = RECALL_RESULT_CAP_CHARS - 2_000

/** seqs whose CURRENT full row was read this session (amend's evidence). */
const seenFullRows = new Set<number>()

export function hasSeenFullRow(seq: number): boolean {
  return seenFullRows.has(seq)
}

export interface MemoryReadResult {
  found: boolean
  id: string
  content?: string
  slug?: string
  note?: string
}

/** Cut doc content at a LINE boundary inside `budget`, reporting which live
 *  rows survived the cut and which dropped — the truth both seen-marking
 *  and the elision note are built from. */
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

/** Name the dropped rows for the elision note: exact ids up to a dozen. */
function nameDroppedRows(droppedSeqs: number[]): string {
  if (droppedSeqs.length === 0) return 'no live rows'
  const named = droppedSeqs.slice(0, 12).map(seq => `seq:${seq}`).join(', ')
  return droppedSeqs.length > 12 ? `${named} … and ${droppedSeqs.length - 12} more` : named
}

/** Read one record (or one whole doc) by id; marks consolidated rows as
 *  seen-in-full for the amend evidence check. */
export function readMemoryRecord(id: string, dir: string = mnemeLibraryDir()): MemoryReadResult {
  const seqMatch = /^seq:(\d+)$/.exec(id)
  if (seqMatch) {
    const seq = Number(seqMatch[1])
    for (const doc of listTopicDocs(dir)) {
      const path = join(dir, docFileName(doc.slug))
      if (!existsSync(path)) continue
      const lines = readFileSync(path, 'utf8').split('\n')
      const lineIndex = lines.findIndex(line => line.includes(`<seq=${seq},`))
      if (lineIndex < 0) continue
      const block = readDocLines(doc.slug, { from: lineIndex + 1, to: lineIndex + 1, dir, recent: 0 })
      const sectionContent = block?.content ?? lines[lineIndex]!
      if (sectionContent.length > DOC_RENDER_BUDGET_CHARS) {
        // The heading-expanded section outruns the render budget. The row
        // itself is the evidence this read exists for: show it alone and
        // whole, never a clipped section render that would claim rows the
        // model was not actually shown.
        const rowLine = lines[lineIndex]!
        if (rowLine.length > DOC_RENDER_BUDGET_CHARS) {
          return {
            found: true,
            id,
            slug: doc.slug,
            content: `${rowLine.slice(0, DOC_RENDER_BUDGET_CHARS)}…`,
            note: `this row alone is ${rowLine.length} chars — past the ${DOC_RENDER_BUDGET_CHARS}-char render budget, the FULL row cannot be shown, and amend stays locked for seq ${seq}`,
          }
        }
        seenFullRows.add(seq)
        return {
          found: true,
          id,
          slug: doc.slug,
          content: rowLine,
          note: `full record read — amend is now unlocked for this seq (only the row is shown: its enclosing section is ${sectionContent.length} chars, past the ${DOC_RENDER_BUDGET_CHARS}-char render budget)`,
        }
      }
      seenFullRows.add(seq)
      return {
        found: true,
        id,
        slug: doc.slug,
        content: sectionContent,
        note: 'full record read — amend is now unlocked for this seq',
      }
    }
    return { found: false, id, note: `seq ${seq} is not live in this library (it may be history — recall again)` }
  }
  const docMatch = /^doc:([a-z0-9-]+)/.exec(id)
  const slug = docMatch?.[1] ?? (id.startsWith('pending:') ? null : id)
  if (slug) {
    const result = readDocLines(slug, { dir, recent: 0 })
    if (!result) return { found: false, id, note: `no topic doc '${slug}'` }
    const doc = listTopicDocs(dir).find(d => d.slug === slug)
    const live = doc ? liveSeqs(doc) : new Set<number>()
    const render = clipDocRender(result.content, live, DOC_RENDER_BUDGET_CHARS)
    // Seen-marking follows what was actually RENDERED, never the file: a
    // whole-doc read is full evidence exactly for the rows it showed, and a
    // row past the cut stays locked for amend (the truncation seam must
    // never quietly unlock evidence the model never saw).
    for (const seq of render.renderedSeqs) seenFullRows.add(seq)
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
    if (!row) return { found: false, id, note: 'that pending row is gone (consolidated or never existed) — recall again' }
    return { found: true, id, content: `${row.text} [unconsolidated, ${row.ts}, ${row.source}]` }
  }
  return { found: false, id, note: 'unrecognized id — use seq:<n>, doc:<slug>, or pending:<ts>' }
}

// ── Correct ────────────────────────────────────────────────────────────────

export type CorrectOp = 'supersede' | 'amend' | 'retract'

export type CorrectOutcome =
  | { ok: true; op: CorrectOp; newSeq: number; targetSeq: number; slug: string }
  | { ok: false; op: CorrectOp; code: string; message: string }

/**
 * One correction. supersede = a NEW truth replaces the old fact (history
 * retained); amend = fix the RECORD's own wording (requires the full row
 * read this session); retract = mark wrong-with-reason (never a hard
 * delete — history is the audit spine, their forget-erases op is refused
 * by design). replacementId on supersede names an EXISTING row that
 * already carries the truth.
 */
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
  const seqMatch = /^seq:(\d+)$/.exec(input.id)
  if (!seqMatch) {
    return {
      ok: false,
      op,
      code: 'not-editable',
      message: input.id.startsWith('pending:')
        ? 'pending rows are not correctable — they resolve at consolidation; correct the consolidated fact instead'
        : `corrections address consolidated rows by seq:<n> id (got '${input.id}')`,
    }
  }
  const targetSeq = Number(seqMatch[1])
  const source = `tool:Correct s:${input.session.slice(0, 8)}`
  const reason = (input.reason ?? '').trim()
  if (!reason) return { ok: false, op, code: 'invalid', message: 'a correction always carries its reason' }

  const finish = (result: MnemeCorrectResult): CorrectOutcome =>
    result.ok
      ? { ok: true, op, newSeq: result.seq, targetSeq: result.targetSeq, slug: result.slug }
      : { ok: false, op, code: result.code, message: result.message }

  switch (op) {
    case 'retract':
      return finish(retireFact({ targetSeq, reason, source, dir }))
    case 'supersede': {
      if (input.replacementId) {
        const replacementMatch = /^seq:(\d+)$/.exec(input.replacementId)
        if (!replacementMatch) {
          return { ok: false, op, code: 'invalid', message: `replacementId must be a seq:<n> id (got '${input.replacementId}')` }
        }
        const replacementSeq = Number(replacementMatch[1])
        const live = listTopicDocs(dir).some(doc => liveSeqs(doc).has(replacementSeq))
        if (!live) {
          return { ok: false, op, code: 'unknown-target', message: `replacement seq ${replacementSeq} is not live in this library` }
        }
        return finish(
          retireFact({ targetSeq, reason: `superseded by seq ${replacementSeq}: ${reason}`, source, dir }),
        )
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
