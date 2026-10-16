import { recallQuery, type RecallHit } from './memoryVerbs.js'
import { factMemoryState, memoryStatusWords, type MemoryRef } from './memoryRefs.js'
import { pendingRows } from './mnemeBuffer.js'
import {
  footnoteContext,
  footnotesOf,
  renderFootnotes,
  sessionOfSource,
  sessionOrdinal,
  currentLedger,
  type FootnoteContext,
  type Footnotes,
} from './mnemeFootnotes.js'
import { mnemeLibraryDir } from './mnemeGates.js'
import { listArchiveDocs, listTopicDocs } from './mnemeLibrary.js'
import { lookupTokens } from './mnemeLookup.js'
import { escapeRegExp } from '../utils/stringUtils.js'
import { ARCHIVE_PREFIX, isArchiveDoc, type MnemeEntry } from './mnemeTopicDocs.js'
import { readPins } from './mnemeUsage.js'
import { noteMemoryOffered } from './mnemeSignal.js'
import type { LedgerEntry } from './types.js'

type PointerKind = 'fact' | 'ruling' | 'handoff' | 'session'

export interface MemoryPointer {
  id: string
  title: string
  kind: PointerKind
  footnotes: Footnotes
  source?: { kind: 'entry' | 'pending' | 'ledger'; source: string; time: string; page?: string; heading?: string }
  freshness?: { status: MemoryRef['status']; confirmedAt?: string }
}

export interface PointerResult {
  pointers: MemoryPointer[]
  elidable: boolean
  catalog: Array<{ slug: string; summary: string }>
  found: number
  cutStale: number
}

export const POINTER_LIMIT = 20
export const POINTER_DEFAULT_LIMIT = 12
const LEDGER_POINTERS_MAX = 5
const MATCHED_WORDS_SHOWN = 4

interface LiveRow {
  entry: MnemeEntry
  slug: string
  heading: string
}

function liveRows(dir: string, history = false): Map<number, LiveRow> {
  const out = new Map<number, LiveRow>()
  for (const doc of [...listTopicDocs(dir), ...listArchiveDocs(dir)]) {
    const slug = isArchiveDoc(doc) ? `${ARCHIVE_PREFIX}${doc.slug}` : doc.slug
    for (const s of doc.sections) for (const e of s.entries) out.set(e.seq, { entry: e, slug, heading: s.heading })
    if (history) for (const e of doc.history) out.set(e.seq, { entry: e, slug, heading: 'history' })
  }
  return out
}

const day = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso)

function matchers(query: string): Array<{ token: string; re: RegExp }> {
  return lookupTokens(query).map(token => ({ token, re: new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}`) }))
}

function matchedWords(text: string, ms: ReadonlyArray<{ token: string; re: RegExp }>): string[] {
  const lowered = text.toLowerCase()
  return ms.filter(m => m.re.test(lowered)).map(m => m.token)
}

function matchesLine(words: string[]): string {
  if (words.length === 0) return 'matches the pattern'
  const shown = words.slice(0, MATCHED_WORDS_SHOWN).join(', ')
  return `matches ${shown}${words.length > MATCHED_WORDS_SHOWN ? ` +${words.length - MATCHED_WORDS_SHOWN}` : ''}`
}

function patternOf(query: string): RegExp {
  try {
    return new RegExp(query, 'i')
  } catch {
    return new RegExp(escapeRegExp(query), 'i')
  }
}

interface SearchContext extends FootnoteContext {
  dir: string
}

function factPointer(hit: RecallHit, row: LiveRow | undefined, pinned: ReadonlySet<number>, ms: ReadonlyArray<{ token: string; re: RegExp }>, ctx: SearchContext): MemoryPointer | null {
  if (hit.label === 'pending') {
    const ts = hit.id.slice('pending:'.length)
    const pending = pendingRows(ctx.dir).find(r => r.ts === ts)
    if (!pending) return null
    const ordinal = sessionOrdinal(sessionOfSource(pending.source), ctx.sessions)
    return {
      id: hit.id,
      title: `pending · ${pending.topicHint ?? 'general'} · ${day(pending.ts)} · ${pending.source} · ${matchesLine(matchedWords(pending.text, ms))}`,
      kind: 'fact',
      footnotes: ordinal !== undefined ? { session: ordinal } : {},
      source: { kind: 'pending', source: pending.source, time: pending.ts },
      freshness: { status: 'unconsolidated' },
    }
  }
  if (!row) return null
  const { entry } = row
  const status = hit.status && hit.status !== 'current' ? ` [${memoryStatusWords({ status: hit.status, confirmedAt: hit.confirmedAt })}]` : ''
  return {
    id: hit.id,
    title: `${row.slug} › ${row.heading}${status} · ${day(entry.time)} · ${entry.source} · ${matchesLine(matchedWords(entry.text, ms))}`,
    kind: pinned.has(entry.seq) ? 'ruling' : 'fact',
    footnotes: footnotesOf(entry, ctx),
    source: { kind: 'entry', source: entry.source, time: entry.time, page: row.slug, heading: row.heading },
    freshness: { status: hit.status ?? 'current', confirmedAt: hit.confirmedAt },
  }
}

function sessionText(s: LedgerEntry): string {
  return [
    `session ${s.ordinal}`,
    s.sessionId,
    ...s.engines.map(e => e.model),
    s.outcome ?? '',
    ...s.files,
    ...s.rulings,
    ...s.retained,
    ...s.corrected,
  ].join(' ')
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

function ledgerPointer(s: LedgerEntry, count: number, kind: 'session' | 'handoff', words: string[]): MemoryPointer {
  const ended = s.endedAt === null ? 'still open' : s.handoff === null ? 'no note left' : 'note left'
  return {
    id: `ledger:${s.ordinal}`,
    title: kind === 'handoff'
      ? `handoff of session ${s.ordinal} of ${count} · ${day(s.handoff!.at)} · ${wordCount(s.handoff!.text)} words · ${matchesLine(words)}`
      : `session ${s.ordinal} of ${count} · ${day(s.startedAt)} · ${ended} · ${matchesLine(words)}`,
    kind,
    footnotes: { session: s.ordinal },
    source: { kind: 'ledger', source: s.sessionId, time: kind === 'handoff' ? s.handoff!.at : s.startedAt },
    freshness: { status: 'current' },
  }
}

export function ledgerPointers(query: string, sessions: readonly LedgerEntry[], limit: number = LEDGER_POINTERS_MAX): MemoryPointer[] {
  const ms = matchers(query)
  const pattern = patternOf(query)
  const count = sessions.length
  const scored: Array<{ pointer: MemoryPointer; score: number; ordinal: number }> = []
  for (const s of sessions) {
    if (s.endedAt === null || !s.handoff?.text.trim()) continue
    const handoff = s.handoff.text
    const handoffWords = matchedWords(handoff, ms)
    if (handoff !== '' && (pattern.test(handoff) || handoffWords.length > 0)) {
      scored.push({ pointer: ledgerPointer(s, count, 'handoff', handoffWords), score: handoffWords.length + 1, ordinal: s.ordinal })
      continue
    }
    const words = matchedWords(sessionText(s), ms)
    if (!(pattern.test(sessionText(s)) || words.length > 0)) continue
    scored.push({ pointer: ledgerPointer(s, count, 'session', words), score: words.length, ordinal: s.ordinal })
  }
  scored.sort((a, b) => b.score - a.score || b.ordinal - a.ordinal)
  return scored.slice(0, Math.max(0, limit)).map(x => x.pointer)
}

export function memoryPointerForId(
  id: string,
  opts: { dir?: string; sessions?: readonly LedgerEntry[]; query?: string; now?: Date } = {},
): MemoryPointer | null {
  const dir = opts.dir ?? mnemeLibraryDir()
  const sessions = opts.sessions ?? currentLedger()
  const query = opts.query ?? ''
  const ms = matchers(query)
  const ledger = /^ledger:(\d+)$/.exec(id)
  if (ledger) {
    const session = sessions.find(s => s.ordinal === Number(ledger[1]))
    if (!session) return null
    const matched = ledgerPointers(query, sessions, sessions.length).find(p => p.id === id)
    return matched ?? ledgerPointer(session, sessions.length, session.handoff?.text.trim() ? 'handoff' : 'session', [])
  }
  const seq = /^seq:(\d+)$/.exec(id)
  if (!seq && !id.startsWith('pending:')) return null
  const row = seq ? liveRows(dir, true).get(Number(seq[1])) : undefined
  if (seq && !row) return null
  const pins = readPins(dir)
  const state = row ? factMemoryState(row.entry, { pins, libraryDir: dir, now: opts.now }) : undefined
  const hit: RecallHit = { id, label: seq ? 'consolidated' : 'pending', slug: row?.slug ?? 'pending', preview: '', signature: '', ...state }
  return factPointer(hit, row, new Set(pins.map(p => p.seq)), ms, { ...footnoteContext(dir, sessions), dir })
}

function wantsLedger(query: string): boolean {
  return /\bledger\b|\b(?:session|handoff)s?\s*#?\d+\b/i.test(query)
    || /\b(?:last|latest|previous|recent|prior)\s+(?:session|handoff)s?\b/i.test(query)
    || /^(?:the\s+)?(?:(?:last|latest|previous|recent)\s+(?:session|handoff)s?\b|sessions?\s+(?:handoffs?|notes?|history)\b|handoffs?\s+notes?\b)/i.test(query.trim())
    || /^(?:(?:show|find|read|open|list|search|recall|summari[sz]e)\s+(?:(?:me|the|a|all|our|my|last|latest|previous|recent)\s+)*(?:sessions?|handoffs?)\b|(?:which|what)\s+(?:(?:previous|last|recent)\s+)?(?:session|handoff)\b|handoffs?(?:\s+(?:for|from|of|about)\b|$)|sessions?$)/i.test(query.trim())
}

export function searchPointers(
  query: string,
  opts: { dir?: string; limit?: number; sessions?: readonly LedgerEntry[]; now?: Date } = {},
): PointerResult {
  const dir = opts.dir ?? mnemeLibraryDir()
  const limit = Math.min(Math.max(opts.limit ?? POINTER_DEFAULT_LIMIT, 1), POINTER_LIMIT)
  const sessions = opts.sessions ?? currentLedger()
  const recall = recallQuery(query, { limit, dir, now: opts.now })
  const ctx: SearchContext = { ...footnoteContext(dir, sessions), dir }
  const rows = liveRows(dir)
  const pinned = new Set(readPins(dir).map(p => p.seq))
  const ms = matchers(query)
  const facts: MemoryPointer[] = []
  const seen = new Set<string>()
  for (const hit of recall.hits) {
    if (seen.has(hit.id)) continue
    const seq = /^seq:(\d+)$/.exec(hit.id)
    const pointer = factPointer(hit, seq ? rows.get(Number(seq[1])) : undefined, pinned, ms, ctx)
    if (!pointer) continue
    seen.add(pointer.id)
    facts.push(pointer)
  }
  const ledger = ledgerPointers(query, sessions)
  const pointers = wantsLedger(query) ? [...ledger, ...facts] : [...facts, ...ledger]
  const offered = pointers.slice(0, limit)
  const stale = new Set(recall.hits.filter(hit => hit.status === 'stale').map(hit => hit.id))
  const cutStale = recall.cut.stale + pointers.slice(limit).filter(p => stale.has(p.id)).length
  noteMemoryOffered(query, offered, dir)
  return { pointers: offered, elidable: pointers.length === 0, catalog: recall.catalog, found: pointers.length + recall.cut.hits, cutStale }
}

export function limitCutLine(result: Pick<PointerResult, 'pointers' | 'found' | 'cutStale'>): string | null {
  if (result.found <= result.pointers.length) return null
  return `${result.pointers.length} of ${result.found} hits shown; narrow the words or raise the limit${result.cutStale > 0 ? `, ${result.cutStale} of them stale` : ''}`
}

export function renderPointerLine(p: MemoryPointer): string {
  const notes = renderFootnotes(p.footnotes)
  return `- [${p.id}] ${p.kind} · ${p.title}${notes ? ` {${notes}}` : ''}`
}
