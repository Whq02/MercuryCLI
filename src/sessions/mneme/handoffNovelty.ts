import { readLedger } from './ledger.js'
import { recordEntries, type RecordEntry } from './mnemeContradiction.js'
import { mnemeLibraryDir } from './mnemeGates.js'
import { containment, contentStems, countInWords, sentencesOf, shingles, wordsOf } from './mnemeText.js'

export const NOVELTY_SENTENCE_SHARE = 0.5
export const NOVELTY_REASK_SHARE = 0.5
export const NOVELTY_REASK_MIN_REPEATED = 2
export const PREVIOUS_NOTE_LABEL = 'the previous note'
const NOTHING_NEW_HINT = 'if nothing is new, say so'

interface RecordUnit {
  label: string
  kind: RecordEntry['kind'] | 'note'
  seq?: number
  shingles: Set<string>
}

interface NoveltyMeasure {
  sentences: number
  repeated: number
  sources: RecordUnit[]
  reask: boolean
}

function shinglesOf(text: string): Set<string> {
  return shingles(contentStems(wordsOf(text)), 2)
}

function recordUnitOf(entry: RecordEntry): RecordUnit {
  const label = entry.kind === 'rule' ? (entry.seq === undefined ? 'a pinned rule' : `rule ${entry.seq}`) : entry.kind === 'fact' ? `fact ${entry.seq}` : 'a pending fact'
  return { label, kind: entry.kind, ...(entry.seq === undefined ? {} : { seq: entry.seq }), shingles: shinglesOf(entry.text) }
}

function previousNote(projectKey: string, sessionId: string): string | null {
  const entries = readLedger(projectKey).filter(entry => entry.sessionId !== sessionId && entry.handoff !== null)
  const last = entries[entries.length - 1]
  return last?.handoff?.text ?? null
}

export function noveltyRecord(projectKey: string, sessionId: string, dir: string = mnemeLibraryDir()): RecordUnit[] {
  const units = recordEntries(dir).map(recordUnitOf)
  const note = previousNote(projectKey, sessionId)
  if (note !== null) units.push({ label: PREVIOUS_NOTE_LABEL, kind: 'note', shingles: shinglesOf(note) })
  return units
}

export function measureNovelty(note: string, record: readonly RecordUnit[]): NoveltyMeasure {
  const sentences = sentencesOf(note)
  const sources: RecordUnit[] = []
  let repeated = 0
  for (const sentence of sentences) {
    const own = shinglesOf(sentence)
    if (own.size === 0) continue
    let best: RecordUnit | null = null
    let bestShare = 0
    for (const unit of record) {
      const share = containment(own, unit.shingles)
      if (share > bestShare) {
        bestShare = share
        best = unit
      }
    }
    if (best === null || bestShare <= NOVELTY_SENTENCE_SHARE) continue
    repeated++
    if (!sources.includes(best)) sources.push(best)
  }
  const reask = repeated >= NOVELTY_REASK_MIN_REPEATED && repeated > sentences.length * NOVELTY_REASK_SHARE
  return { sentences: sentences.length, repeated, sources, reask }
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function sourcesInWords(sources: readonly RecordUnit[]): string {
  const rules = sources.filter(unit => unit.kind === 'rule' && unit.seq !== undefined).map(unit => String(unit.seq))
  const facts = sources.filter(unit => unit.kind === 'fact' && unit.seq !== undefined).map(unit => String(unit.seq))
  const parts: string[] = []
  if (rules.length > 0) parts.push(`${rules.length === 1 ? 'rule' : 'rules'} ${listOf(rules)}`)
  if (sources.some(unit => unit.kind === 'rule' && unit.seq === undefined)) parts.push('a pinned rule')
  if (facts.length > 0) parts.push(`${facts.length === 1 ? 'fact' : 'facts'} ${listOf(facts)}`)
  if (sources.some(unit => unit.kind === 'pending')) parts.push('a pending fact')
  if (sources.some(unit => unit.kind === 'note')) parts.push(PREVIOUS_NOTE_LABEL)
  return parts.join(', ')
}

const capital = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1)

export function repetitionInWords(measure: NoveltyMeasure): string {
  const count = measure.repeated === measure.sentences ? (measure.sentences === 2 ? 'Both of your sentences' : `All ${countInWords(measure.sentences)} of your sentences`) : `${capital(countInWords(measure.repeated))} of your ${countInWords(measure.sentences)} sentences`
  return `${count} are already on record (${sourcesInWords(measure.sources)}).`
}

export function handoffReask(measure: NoveltyMeasure): string {
  return `${repetitionInWords(measure)} Leave one note for the next session again: reply with the note alone, keeping only what is new — it is stored exactly as written; ${NOTHING_NEW_HINT}.`
}
