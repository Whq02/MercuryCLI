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
import { listTopicDocs } from './mnemeLibrary.js'
import { containment, contentStems, firstWords, isNumberWord, jaccard, sentencesOf, wordsOf } from './mnemeText.js'
import { readPins } from './mnemeUsage.js'

export const CONTRADICTION_OVERLAP_SHARE = 0.75
export const CONTRADICTION_CONFIDENCE = 0.6
export const NUMBER_FLIP = 'a number that differs'
export const NEGATION_FLIP = 'a negation'
const NEGATION_REACH = 3

export const NEGATION_WORDS: readonly string[] = ['not', 'never', 'no', 'none', 'nothing', 'neither', 'nor', 'without']

export const POLARITY_PAIRS: ReadonlyArray<{ name: string; left: readonly string[]; right: readonly string[] }> = [
  { name: 'always/never', left: ['always'], right: ['never'] },
  { name: 'on/off', left: ['on'], right: ['off'] },
  { name: 'enabled/disabled', left: ['enable', 'enables', 'enabled', 'enabling'], right: ['disable', 'disables', 'disabled', 'disabling'] },
  { name: 'allowed/forbidden', left: ['allow', 'allows', 'allowed', 'allowing'], right: ['forbid', 'forbids', 'forbade', 'forbidden', 'forbidding', 'deny', 'denies', 'denied', 'denying'] },
  { name: 'included/excluded', left: ['include', 'includes', 'included', 'including'], right: ['exclude', 'excludes', 'excluded', 'excluding'] },
  { name: 'before/after', left: ['before'], right: ['after'] },
  { name: 'true/false', left: ['true'], right: ['false'] },
]

export const SCOPE_WORDS: readonly string[] = ['except', 'excepting', 'exception', 'exceptions', 'unless', 'when', 'whenever', 'if', 'while', 'until', 'during']

export const SCOPE_PHRASES: readonly string[] = ['only for', 'only when', 'only if', 'only in', 'only on', 'only with', 'only after', 'only before', 'only by', 'only under', 'only during', 'only once', 'only where', 'only while', 'apart from', 'aside from', 'other than', 'save for', 'in case', 'but not', 'but only']

export const IDENTIFIER_MARKERS: readonly string[] = ['rule', 'rules', 'seq', 'fact', 'facts', 'session', 'sessions', 'line', 'lines', 'page', 'pages', 'row', 'rows', 'issue', 'pr', 'step', 'steps', 'item', 'items', 'id', 'number', 'no', 'ordinal']

const SKIP = new Set<string>([...NEGATION_WORDS, ...SCOPE_WORDS, 'only', 'but', ...POLARITY_PAIRS.flatMap(pair => [...pair.left, ...pair.right])])

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
  negated: Set<string>
  sides: Map<string, { left: boolean; right: boolean }>
  quantities: Set<string>
  scoped: boolean
}

function isContent(word: string): boolean {
  return contentStems([word], SKIP).length === 1
}

function negatedStems(words: readonly string[]): Set<string> {
  const out = new Set<string>()
  words.forEach((word, index) => {
    if (!NEGATION_WORDS.includes(word)) return
    for (let ahead = index + 1; ahead <= index + NEGATION_REACH && ahead < words.length; ahead++) {
      if (isContent(words[ahead]!)) {
        out.add(contentStems([words[ahead]!], SKIP)[0]!)
        return
      }
    }
    for (let back = index - 1; back >= 0 && back >= index - NEGATION_REACH; back--) {
      if (isContent(words[back]!)) {
        out.add(contentStems([words[back]!], SKIP)[0]!)
        return
      }
    }
  })
  return out
}

function isScoped(words: readonly string[]): boolean {
  if (words.some(word => SCOPE_WORDS.includes(word))) return true
  const joined = ` ${words.join(' ')} `
  return SCOPE_PHRASES.some(phrase => joined.includes(` ${phrase} `))
}

function analyse(text: string): Analysed {
  const words = wordsOf(text)
  const sides = new Map<string, { left: boolean; right: boolean }>()
  for (const pair of POLARITY_PAIRS) {
    sides.set(pair.name, { left: words.some(word => pair.left.includes(word)), right: words.some(word => pair.right.includes(word)) })
  }
  const quantities = new Set<string>()
  words.forEach((word, index) => {
    if (!isNumberWord(word)) return
    const previous = index > 0 ? words[index - 1]! : ''
    if (IDENTIFIER_MARKERS.includes(previous)) return
    quantities.add(String(Number(word)))
  })
  return {
    stems: new Set(contentStems(words, SKIP)),
    negated: negatedStems(words),
    sides,
    quantities,
    scoped: isScoped(words),
  }
}

export function polarityFlip(a: string, b: string): string | null {
  return flipOf(analyse(a), analyse(b))
}

function flipOf(a: Analysed, b: Analysed): string | null {
  for (const stem of a.stems) {
    if (b.stems.has(stem) && a.negated.has(stem) !== b.negated.has(stem)) return NEGATION_FLIP
  }
  for (const pair of POLARITY_PAIRS) {
    const left = a.sides.get(pair.name)!
    const right = b.sides.get(pair.name)!
    if ((left.left && !left.right && right.right && !right.left) || (left.right && !left.left && right.left && !right.right)) return pair.name
  }
  if (a.quantities.size > 0 && b.quantities.size > 0) {
    const onlyA = [...a.quantities].some(n => !b.quantities.has(n))
    const onlyB = [...b.quantities].some(n => !a.quantities.has(n))
    if (onlyA && onlyB) return NUMBER_FLIP
  }
  return null
}

function unitsOf(text: string): string[] {
  const sentences = sentencesOf(text)
  return sentences.length > 1 ? [text, ...sentences] : [text]
}

function shareOfShorter(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size < 2 || b.size < 2) return 0
  return a.size <= b.size ? containment(a, b) : containment(b, a)
}

export function contradictionBetween(candidate: string, existing: string): { overlap: number; flip: string } | null {
  let best: { overlap: number; flip: string } | null = null
  const candidates = unitsOf(candidate).map(analyse)
  for (const unit of unitsOf(existing)) {
    const old = analyse(unit)
    for (const fresh of candidates) {
      if (fresh.scoped || old.scoped) continue
      const flip = flipOf(fresh, old)
      if (flip === null) continue
      const overlap = flip === NUMBER_FLIP ? jaccard(fresh.stems, old.stems) : shareOfShorter(fresh.stems, old.stems)
      if (overlap < CONTRADICTION_OVERLAP_SHARE) continue
      if (best === null || overlap > best.overlap) best = { overlap, flip }
    }
  }
  return best
}

export function recordEntries(dir: string): RecordEntry[] {
  const pins = new Map(readPins(dir).map(pin => [pin.seq, pin]))
  const out: RecordEntry[] = []
  for (const doc of listTopicDocs(dir)) {
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

export function entryName(entry: RecordEntry): string {
  if (entry.kind === 'rule') return entry.seq === undefined ? 'a pinned rule' : `rule ${entry.seq}`
  if (entry.kind === 'fact') return `fact ${entry.seq}`
  return 'a pending fact'
}

export function conflictReason(candidate: ContradictionCandidate): string {
  const entry = candidate.entry
  const head = `conflicts with ${entryName(entry)}: "${firstWords(entry.text)}"`
  if (entry.kind === 'rule') return `${head} — a pinned rule stands until the user changes it: ${USER_ASKED_RULE_ROAD}`
  return `${head} — if the new fact is right, Correct ${entry.id} (supersede, with the evidence as the reason); if it is not, leave the record as it is`
}

export function conflictNotice(candidate: ContradictionCandidate): string {
  const entry = candidate.entry
  return `not stored: it conflicts with ${entryName(entry)}, "${firstWords(entry.text)}"${entry.kind === 'rule' ? ' — the rule stands' : ''}`
}

export const CONTRADICTION_QUESTION: JevQuestion = {
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

export const judgeWithJev: ContradictionJudge = async (pairs, signal) => {
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
