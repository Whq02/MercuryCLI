import type { Footnotes } from './mnemeFootnotes.js'
import { lookupTokens } from './mnemeLookup.js'
import { escapeRegExp, wordCount } from '../../platform/text/strings.js'
import type { MemoryRef } from './memoryRefs.js'
import type { LedgerEntry } from './types.js'

type PointerKind = 'fact' | 'ruling' | 'handoff' | 'session'

export interface MemoryPointer {
  id: string
  title: string
  kind: PointerKind
  footnotes: Footnotes
  source?: { kind: 'entry' | 'pending' | 'ledger'; source: string; time: string; page?: string; heading?: string; grade?: string; library?: string }
  freshness?: { status: MemoryRef['status']; confirmedAt?: string }
}

const LEDGER_POINTERS_MAX = 5
const MATCHED_WORDS_SHOWN = 4

export const day = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso)

export function matchers(query: string): Array<{ token: string; re: RegExp }> {
  return lookupTokens(query).map(token => ({ token, re: new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}`) }))
}

export function matchedWords(text: string, ms: ReadonlyArray<{ token: string; re: RegExp }>): string[] {
  const lowered = text.toLowerCase()
  return ms.filter(m => m.re.test(lowered)).map(m => m.token)
}

export function matchesLine(words: string[]): string {
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

export function ledgerPointer(s: LedgerEntry, count: number, kind: 'session' | 'handoff', words: string[]): MemoryPointer {
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
