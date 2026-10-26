import { jevSystemOne } from '../services/jev/jevClient.js'
import type { JevQuestion } from '../services/jev/jevContract.js'
import { jevKeyPresence, resolveJevApiKey } from '../services/jev/jevKey.js'
import { noteJevAttempt, noteJevWireFailure, settleJevCall } from '../services/jev/jevLedger.js'
import { readJevSettings } from '../services/jev/jevSetting.js'
import { jevStatus } from '../services/jev/jevStatus.js'
import { getAgentContext } from '../utils/agentContext.js'
import { logForDebugging } from '../utils/debug.js'
import { pendingRows } from './mnemeBuffer.js'
import { USER_ASKED_RULE_ROAD } from './mnemeCorrect.js'
import { listArchiveDocs, listTopicDocs } from './mnemeLibrary.js'
import { POLARITY_WORDS, flippedPolarity, polaritySides, type PolaritySides } from './mnemePolarity.js'
import { clausesOf, containment, contentStems, firstWords, isNumberWord, jaccard, normalisedText, sentencesOf, wordsOf } from './mnemeText.js'
import { readPins } from './mnemeUsage.js'

export { POLARITY_PAIRS } from './mnemePolarity.js'

export const CONTRADICTION_OVERLAP_SHARE = 0.75
export const CONTRADICTION_CONFIDENCE = 0.6
export const COMPARABLE_LENGTH_RATIO = 0.4
const NUMBER_FLIP = 'a number that differs'
const VALUE_FLIP = 'a value that differs'
const NEGATION_FLIP = 'a negation'
const VALUE_PREDICATES = new Set(['is', 'are', 'was', 'were', 'has', 'have', 'had', 'holds', 'hold', 'contains', 'contain', 'runs', 'run', 'lives', 'live'])

export const NEGATION_WORDS: readonly string[] = ['not', 'never', 'no', 'none', 'nothing', 'neither', 'nor', 'without']

const SCOPE_WORDS: readonly string[] = ['except', 'excepting', 'exception', 'exceptions', 'unless', 'when', 'whenever', 'if', 'while', 'until', 'during']

const SCOPE_PHRASES: readonly string[] = ['only for', 'only when', 'only if', 'only in', 'only on', 'only with', 'only after', 'only before', 'only by', 'only under', 'only during', 'only once', 'only where', 'only while', 'apart from', 'aside from', 'other than', 'save for', 'in case', 'but not', 'but only']

const IDENTIFIER_MARKERS: readonly string[] = ['rule', 'rules', 'seq', 'fact', 'facts', 'session', 'sessions', 'line', 'lines', 'page', 'pages', 'row', 'rows', 'issue', 'pr', 'step', 'steps', 'item', 'items', 'id', 'number', 'no', 'ordinal']

const SKIP = new Set<string>([...NEGATION_WORDS, ...SCOPE_WORDS, 'only', 'but', ...POLARITY_WORDS])

export interface RecordEntry {
  id: string
  seq?: number
  kind: 'rule' | 'fact' | 'pending'
  asked: boolean
  text: string
}

export interface ContradictionCandidate {
  entry: RecordEntry
  overlap: number
  flip: string
}

export interface ContradictionVerdict {
  candidate: ContradictionCandidate
  judged: number | null
}

interface Analysed {
  stems: Set<string>
  negatedClauses: string[][]
  negated: Set<string>
  sides: PolaritySides
  valueWords: string[]
  labelWords: number
  scoped: boolean
}

const LABEL_HEAD = /^([^:.!?]+):\s+\S/

function labelWordCount(text: string): number {
  const label = LABEL_HEAD.exec(text)?.[1]
  return label === undefined ? 0 : valueWordsOf(label).length
}

function valueWordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function negatedClausesOf(text: string): string[][] {
  const out: string[][] = []
  for (const clause of clausesOf(text)) {
    clause.forEach((word, index) => {
      if (!NEGATION_WORDS.includes(word)) return
      const governed = [...new Set(contentStems(clause.slice(index + 1), SKIP))]
      if (governed.length > 0) out.push(governed)
    })
  }
  return out
}

function isScoped(words: readonly string[]): boolean {
  if (words.some(word => SCOPE_WORDS.includes(word))) return true
  const joined = ` ${words.join(' ')} `
  return SCOPE_PHRASES.some(phrase => joined.includes(` ${phrase} `))
}

function analyse(text: string): Analysed {
  const words = wordsOf(text)
  const sides = polaritySides(words)
  const valueWords = valueWordsOf(text)
  const negatedClauses = negatedClausesOf(text)
  return {
    stems: new Set(contentStems(words, SKIP)),
    negatedClauses,
    negated: new Set(negatedClauses.flat()),
    sides,
    valueWords,
    labelWords: labelWordCount(text),
    scoped: isScoped(words),
  }
}

export function polarityFlip(a: string, b: string): string | null {
  return flipOf(analyse(a), analyse(b))
}

function negationFlip(a: Analysed, b: Analysed): boolean {
  return a.negatedClauses.some(clause => clause.every(stem => b.stems.has(stem)) && clause.some(stem => !b.negated.has(stem)))
}

function slotFlip(left: readonly string[], right: readonly string[]): string | null {
  let changed = -1
  for (let index = 0; index < left.length; index++) {
    if (left[index] === right[index]) continue
    if (changed !== -1) return null
    changed = index
  }
  if (changed < 1 || IDENTIFIER_MARKERS.includes(left[changed - 1]!)) return null
  const predicate = left.slice(0, changed).findLastIndex(word => VALUE_PREDICATES.has(word))
  if (predicate < 1) return null
  const oldValue = left[changed]!
  const newValue = right[changed]!
  if (isNumberWord(oldValue) && isNumberWord(newValue)) return Number(oldValue) === Number(newValue) ? null : NUMBER_FLIP
  const prep = ['the', 'a', 'an'].includes(left[changed - 1]!) ? left[changed - 2] : left[changed - 1]
  return ['from', 'in'].includes(prep ?? '') ? VALUE_FLIP : null
}

function valueFlip(a: Analysed, b: Analysed): string | null {
  const left = a.valueWords
  const right = b.valueWords
  if (left.length === right.length) return slotFlip(left, right)
  const [shorter, longer, label] = left.length < right.length ? [left, right, b.labelWords] : [right, left, a.labelWords]
  if (label === 0 || longer.length - label !== shorter.length) return null
  return slotFlip(shorter, longer.slice(label))
}

const CONTEXT_TAIL = /\s*\(context:[\s\S]*\)\s*$/i

function factOf(text: string): string {
  return text.replace(CONTEXT_TAIL, '')
}

function flipOf(a: Analysed, b: Analysed): string | null {
  if (negationFlip(a, b) || negationFlip(b, a)) return NEGATION_FLIP
  const polarity = flippedPolarity(a.sides, b.sides)
  return polarity ?? valueFlip(a, b)
}

function shareOfShorter(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size < 2 || b.size < 2) return 0
  return a.size <= b.size ? containment(a, b) : containment(b, a)
}

export function comparableLength(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const shorter = Math.min(a.size, b.size)
  const longer = Math.max(a.size, b.size)
  return shorter >= 2 && shorter / longer >= COMPARABLE_LENGTH_RATIO
}

function shareOf(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  return comparableLength(a, b) ? shareOfShorter(a, b) : jaccard(a, b)
}

export function restates(candidate: string, existing: string): boolean {
  const fresh = sentencesOf(factOf(candidate)).map(s => ({ norm: normalisedText(s), analysed: analyse(s) })).filter(s => s.norm !== '')
  const old = sentencesOf(factOf(existing)).map(s => ({ norm: normalisedText(s), analysed: analyse(s) })).filter(s => s.norm !== '')
  if (fresh.length === 0 || old.length === 0) return false
  const [part, whole] = fresh.length <= old.length ? [fresh, old] : [old, fresh]
  return part.every(p => whole.some(w => w.norm === p.norm && valueFlip(p.analysed, w.analysed) === null))
}

export function contradictionBetween(candidateText: string, existingText: string): { overlap: number; flip: string } | null {
  const candidate = factOf(candidateText)
  const existing = factOf(existingText)
  const fresh = analyse(candidate)
  const old = analyse(existing)
  if (restates(candidate, existing)) return null
  const wholeShare = shareOf(fresh.stems, old.stems)
  const pairs: Array<{ fresh: Analysed; old: Analysed; share: number }> = [{ fresh, old, share: wholeShare }]
  const freshSentences = sentencesOf(candidate)
  const oldSentences = sentencesOf(existing)
  if (freshSentences.length > 1 || oldSentences.length > 1) {
    const freshUnits = freshSentences.map(analyse)
    for (const sentence of oldSentences) {
      const oldUnit = analyse(sentence)
      for (const freshUnit of freshUnits) {
        pairs.push({ fresh: freshUnit, old: oldUnit, share: comparableLength(freshUnit.stems, oldUnit.stems) ? shareOfShorter(freshUnit.stems, oldUnit.stems) : wholeShare })
      }
    }
  }
  let best: { overlap: number; flip: string } | null = null
  for (const pair of pairs) {
    if (pair.fresh.scoped || pair.old.scoped) continue
    const flip = flipOf(pair.fresh, pair.old)
    if (flip === null) continue
    const overlap = flip === VALUE_FLIP || flip === NUMBER_FLIP ? 1 : pair.share
    if (overlap < CONTRADICTION_OVERLAP_SHARE) continue
    if (best === null || overlap > best.overlap) best = { overlap, flip }
  }
  return best
}

export function recordEntries(dir: string): RecordEntry[] {
  const pins = new Map(readPins(dir).map(pin => [pin.seq, pin]))
  const out: RecordEntry[] = []
  for (const doc of [...listTopicDocs(dir), ...listArchiveDocs(dir)]) {
    for (const section of doc.sections) {
      for (const entry of section.entries) {
        const pin = pins.get(entry.seq)
        out.push({ id: `seq:${entry.seq}`, seq: entry.seq, kind: pin ? 'rule' : 'fact', asked: pin?.asked === true, text: entry.text })
      }
    }
  }
  for (const row of pendingRows(dir)) {
    out.push({ id: `pending:${row.ts}`, kind: row.pin === true ? 'rule' : 'pending', asked: row.asked === true, text: row.text })
  }
  return out
}

export function contradictionCandidates(text: string, dir: string, opts: { exclude?: ReadonlySet<string> } = {}): ContradictionCandidate[] {
  const out: ContradictionCandidate[] = []
  for (const entry of recordEntries(dir)) {
    if (opts.exclude?.has(entry.id)) continue
    const found = contradictionBetween(text, entry.text)
    if (found !== null) out.push({ entry, ...found })
  }
  out.sort((a, b) => b.overlap - a.overlap)
  return out
}

function entryName(entry: RecordEntry): string {
  if (entry.kind === 'rule') return entry.seq === undefined ? 'a pinned rule' : `rule ${entry.seq}`
  if (entry.kind === 'fact') return `fact ${entry.seq}`
  return 'a pending fact'
}

export function conflictReason(candidate: ContradictionCandidate): string {
  const entry = candidate.entry
  const head = `conflicts with ${entryName(entry)}: "${firstWords(factOf(entry.text))}"`
  if (entry.kind === 'rule') return `${head} — a pinned rule stands until the user changes it: ${USER_ASKED_RULE_ROAD}; if both are true, retain it again with the difference stated (when, where, which)`
  return `${head}: ask the user which is true; on their word, Correct ${entry.id} with their reason, or retain both with the difference stated (when, where, which)`
}

export function conflictNotice(candidate: ContradictionCandidate): string {
  const entry = candidate.entry
  return `not stored: it conflicts with ${entryName(entry)}, "${firstWords(factOf(entry.text))}"${entry.kind === 'rule' ? ' — the rule stands' : ''}`
}

const CONTRADICTION_QUESTION: JevQuestion = {
  type: 'noul',
  instructions:
    '`candidate` is a fact or rule about to be saved to memory; `existing` is one already on record. They contradict each other: both cannot be true, or followed, at once — one says to do, allow or be what the other says not to do, not to allow or not to be, or the two give different values for the same thing. A restatement of `existing` in other words, an exception that narrows it to a case, or a statement about a different thing that merely shares words with it, is not a contradiction.',
}

export function jevJudgeOpen(): boolean {
  const settings = readJevSettings()
  if (!settings.enabled || !jevKeyPresence(process.env, settings.road).present) return false
  const context = getAgentContext()
  const agent = context === undefined ? undefined : { id: context.agentId, subagent: true }
  if (agent !== undefined && !settings.subagents) return false
  return jevStatus(agent, Date.now(), settings).kind === 'ready'
}

export type ContradictionJudge = (pairs: ReadonlyArray<{ existing: string; candidate: string }>, signal?: AbortSignal) => Promise<Array<number | null>>

const judgeWithJev: ContradictionJudge = async (pairs, signal) => {
  const settings = readJevSettings()
  const road = settings.road
  const key = resolveJevApiKey(process.env, road)
  if (key === undefined) return pairs.map(() => null)
  const context = getAgentContext()
  const agent = context === undefined ? undefined : { id: context.agentId, subagent: true }
  const flights = pairs.map(async (pair): Promise<number | null> => {
    const at = Date.now()
    if (jevStatus(agent, at, settings).kind !== 'ready') return null
    noteJevAttempt(at, agent?.id, road)
    const outcome = await jevSystemOne({ state: { existing: pair.existing, candidate: pair.candidate }, questions: { contradicts: CONTRADICTION_QUESTION } }, key.key, { road, ...(signal ? { signal } : {}) })
    const now = Date.now()
    if (!outcome.ok) {
      noteJevWireFailure(outcome.failure, now, Math.random, road)
      logForDebugging(`memory write guard: Jev gave no verdict — ${outcome.failure.kind}: ${outcome.failure.detail}`)
      return null
    }
    settleJevCall(outcome.response.usage, outcome.response.model, now, road, outcome.requestId)
    const answer = outcome.response.answers.contradicts
    return answer?.type === 'noul' ? answer.noul : null
  })
  return Promise.all(flights)
}

export function contradictionHolds(verdict: ContradictionVerdict): boolean {
  return verdict.judged === null || verdict.judged >= CONTRADICTION_CONFIDENCE
}

export async function judgeContradictions(
  texts: ReadonlyArray<string | null>,
  dir: string,
  io: { judge?: ContradictionJudge | null; signal?: AbortSignal; exclude?: ReadonlySet<string> } = {},
): Promise<Map<number, ContradictionVerdict[]>> {
  const found = new Map<number, ContradictionCandidate[]>()
  texts.forEach((text, index) => {
    if (text === null || text.trim() === '') return
    const candidates = contradictionCandidates(text, dir, io.exclude === undefined ? {} : { exclude: io.exclude })
    if (candidates.length > 0) found.set(index, candidates)
  })
  const judge = io.judge === undefined ? (jevJudgeOpen() ? judgeWithJev : null) : io.judge
  const verdicts = new Map<number, ContradictionVerdict[]>()
  if (judge === null || found.size === 0) {
    for (const [index, candidates] of found) verdicts.set(index, candidates.map(candidate => ({ candidate, judged: null })))
    return verdicts
  }
  const pairs: Array<{ index: number; candidate: ContradictionCandidate }> = []
  for (const [index, candidates] of found) for (const candidate of candidates) pairs.push({ index, candidate })
  let scores: Array<number | null>
  try {
    scores = await judge(pairs.map(pair => ({ existing: pair.candidate.entry.text, candidate: texts[pair.index]! })), io.signal)
  } catch (error) {
    logForDebugging(`memory write guard: the judge failed — ${error instanceof Error ? error.message : String(error)}`)
    scores = pairs.map(() => null)
  }
  pairs.forEach((pair, at) => {
    const list = verdicts.get(pair.index) ?? []
    list.push({ candidate: pair.candidate, judged: scores[at] ?? null })
    verdicts.set(pair.index, list)
  })
  return verdicts
}

export function firstConflict(verdicts: readonly ContradictionVerdict[] | undefined): ContradictionVerdict | null {
  if (verdicts === undefined) return null
  return verdicts.find(contradictionHolds) ?? null
}
