import { join } from 'node:path'
import { logForDebugging } from '../utils/debug.js'
import { stampLocal } from './entryPage.js'
import { readProjectState, stateQuery, stateQueryChunks, type ProjectState } from './entryState.js'
import { readLedger } from './ledger.js'
import { currentBufferPath, pendingRows } from './mnemeBuffer.js'
import { listArchiveDocs, listTopicDocs } from './mnemeLibrary.js'
import { liveEntryIndex, pinnedLine, pinnedView, readPinnedStatus } from './mnemeFrontPage.js'
import { mnemeEnabled, mnemeLibraryDir } from './mnemeGates.js'
import { scoreCandidates, semanticRanking, type LookupCandidate } from './mnemeLookup.js'
import { docFileName, serializeSignature, type MnemeEntry, type MnemeTopicDoc } from './mnemeTopicDocs.js'
import { readPins, readUsage, startTextLimit, usageOf, type UsageRecord } from './mnemeUsage.js'
import { factMemoryState, memoryStatusWords } from './memoryRefs.js'
import { lineagePath } from './paths.js'
import type { LedgerEntry } from './types.js'
import { gradeLines, HANDOFF_GRADE, recordGrade } from './memoryEvidence.js'

export const MEMORY_AT_START_HEADING = '# Memory at start'
export const EARLIER_NOTE_HEADING = '## An earlier note left'
const FUSE_K = 60

export interface StartTask {
  prompt?: string
  continuation?: { objective: string; source: string; summary?: string }
  required?: ReadonlyArray<{ id: string; source: string }>
}

export interface StartCandidate extends LookupCandidate {
  block: string
  chars: number
  stale?: boolean
  session?: number
}

interface StartScored extends StartCandidate {
  score: number
  density: number
  tier: number
  tie: number
}

interface StartChoice {
  rode: StartScored[]
  left: StartScored[]
  limit: number
  pinnedChars: number
  used: number
}

interface MemoryAtStartStatus {
  limit: number
  pinnedCount: number
  pinnedChars: number
  used: number
  facts: number
  rodeFacts: number
  notes: number
  rodeNotes: number
  pending: number
}

let lastStatus: MemoryAtStartStatus | null = null

export function memoryAtStartStatus(): MemoryAtStartStatus | null {
  return lastStatus
}

function _resetMemoryAtStartForTesting(): void {
  lastStatus = null
}

function factCandidate(entry: MnemeEntry, doc: MnemeTopicDoc, dir: string, usage: Record<string, UsageRecord>): StartCandidate {
  const block = `- ${recordGrade(`seq:${entry.seq}`, entry.source, dir)} ${entry.text} <seq=${entry.seq}>`
  return {
    id: `seq:${entry.seq}`,
    text: entry.text,
    signature: serializeSignature(entry),
    slug: doc.slug,
    pagePath: join(dir, docFileName(doc.slug)),
    seq: entry.seq,
    pending: false,
    time: entry.time,
    pinned: false,
    kind: 'fact',
    useCount: usageOf(entry.seq, usage).count,
    block,
    chars: block.length + 1,
  }
}

function noteCandidate(entry: LedgerEntry, projectKey: string): StartCandidate | null {
  if (entry.handoff === null) return null
  const block = `${EARLIER_NOTE_HEADING} (session ${entry.ordinal}, ${stampLocal(entry.handoff.at)})\n${gradeLines(entry.handoff.text, HANDOFF_GRADE)}`
  return {
    id: `note:${entry.ordinal}`,
    text: entry.handoff.text,
    signature: '',
    slug: 'lineage',
    pagePath: lineagePath(projectKey),
    pending: false,
    time: entry.handoff.at,
    pinned: false,
    kind: 'handoff',
    useCount: 0,
    block,
    chars: block.length + 1,
    session: entry.ordinal,
  }
}

interface PinnedNow {
  count: number
  chars: number
  excluded: Set<number>
}

function pinnedNow(dir: string, topics: readonly MnemeTopicDoc[]): PinnedNow {
  const pins = readPins(dir)
  const excluded = new Set(pins.map(pin => pin.seq))
  const status = readPinnedStatus(dir)
  if (status !== null) {
    for (const seq of status.loaded) excluded.add(seq)
    return { count: status.pinned, chars: status.used, excluded }
  }
  const view = pinnedView(pins, liveEntryIndex(topics))
  const lines = view.loaded.map(row => pinnedLine(row.entry, row.pin))
  return { count: view.loaded.length, chars: lines.reduce((n, line) => n + line.length + 1, 0), excluded }
}

function libraryCandidates(dir: string, excluded: ReadonlySet<number>, docs?: { topics: readonly MnemeTopicDoc[]; archives: readonly MnemeTopicDoc[] }): StartCandidate[] {
  const usage = readUsage(dir)
  const topics = docs?.topics ?? listTopicDocs(dir)
  const archives = docs?.archives ?? listArchiveDocs(dir)
  const out: StartCandidate[] = []
  for (const doc of [...topics, ...archives]) {
    for (const section of doc.sections) {
      for (const entry of section.entries) {
        if (excluded.has(entry.seq)) continue
        out.push(factCandidate(entry, doc, dir, usage))
      }
    }
  }
  const texts = new Set([...topics, ...archives].flatMap(doc => doc.sections.flatMap(section => section.entries.map(entry => entry.text))))
  for (const row of pendingRows(dir)) {
    if (texts.has(row.text)) continue
    const id = `pending:${row.ts}`
    const block = `- ${recordGrade(id, row.source, dir)} ${row.text} [${id}]`
    out.push({ id, text: row.text, signature: `[unconsolidated, ${row.ts}, ${row.source}]`, slug: row.topicHint ?? 'general', pagePath: currentBufferPath(dir), pending: true, time: row.ts, kind: 'fact', block, chars: block.length + 1 })
    texts.add(row.text)
  }
  return out
}

function earlierNotes(previous: readonly LedgerEntry[], projectKey: string): StartCandidate[] {
  const newest = [...previous].reverse().find(entry => entry.handoff !== null) ?? null
  const out: StartCandidate[] = []
  for (const entry of previous) {
    if (newest !== null && entry.ordinal === newest.ordinal) continue
    const candidate = noteCandidate(entry, projectKey)
    if (candidate !== null) out.push(candidate)
  }
  return out
}

const byScore = (a: StartScored, b: StartScored): number => b.tier - a.tier || b.score - a.score || b.tie - a.tie || a.id.localeCompare(b.id)

function channelScores(chunks: readonly string[], input: { candidates: readonly StartCandidate[]; now: number; dir?: string }): Map<string, number> {
  const words = new Map<string, number>()
  const meaning = new Map<string, number>()
  for (const chunk of [...new Set(chunks)]) {
    const lexical = scoreCandidates(chunk, input.candidates, input.now).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    lexical.forEach((hit, rank) => words.set(hit.id, Math.max(words.get(hit.id) ?? 0, 1 / (FUSE_K + rank + 1))))
    semanticRanking(chunk, input.candidates, input.dir ?? mnemeLibraryDir()).forEach((id, rank) => meaning.set(id, Math.max(meaning.get(id) ?? 0, 1 / (FUSE_K + rank + 1))))
  }
  return new Map([...new Set([...words.keys(), ...meaning.keys()])].map(id => [id, (words.get(id) ?? 0) + (meaning.get(id) ?? 0)]))
}

export function chooseAtStart(input: { candidates: readonly StartCandidate[]; chunks: readonly string[]; limit: number; pinnedChars: number; now: number; dir?: string; task?: StartTask }): StartChoice {
  const task = input.task
  const prompt = channelScores(stateQueryChunks((task?.prompt ?? '').split(/\s+/)), input)
  const continuation = task?.continuation?.source ? channelScores(stateQueryChunks(task.continuation.objective.split(/\s+/)), input) : new Map<string, number>()
  const summary = task?.continuation?.source ? channelScores(stateQueryChunks((task.continuation.summary ?? '').split(/\s+/)), input) : new Map<string, number>()
  const fallback = task?.prompt?.trim() || task?.continuation?.objective.trim() ? new Map<string, number>() : channelScores(input.chunks, input)
  const required = new Set((task?.required ?? []).filter(row => row.source.trim()).map(row => row.id))
  const scored: StartScored[] = input.candidates.map(candidate => {
    const tier = required.has(candidate.id) ? 4 : prompt.has(candidate.id) ? 3 : continuation.has(candidate.id) ? 2 : fallback.has(candidate.id) ? 1 : 0
    const score = tier === 4 ? 1 : (tier === 3 ? prompt : tier === 2 ? continuation : fallback).get(candidate.id) ?? 0
    return { ...candidate, tier, score, tie: tier === 2 ? summary.get(candidate.id) ?? 0 : 0, density: candidate.chars > 0 ? score / Math.sqrt(candidate.chars) : 0 }
  })
  const order = [...scored].sort((a, b) => b.tier - a.tier || Number(a.stale === true) - Number(b.stale === true) || b.density - a.density || b.tie - a.tie || a.id.localeCompare(b.id))
  const rode: StartScored[] = []
  const left: StartScored[] = []
  const limit = Math.min(input.limit, 600 * Math.ceil(Math.log2(1 + scored.filter(row => row.score > 0 && row.tier !== 4).length)))
  let used = 0
  for (const candidate of order) {
    if (candidate.tier === 4 || candidate.score > 0 && used + candidate.chars <= limit) {
      rode.push(candidate)
      if (candidate.tier !== 4) used += candidate.chars
    } else if (candidate.score > 0 && candidate.kind === 'fact') {
      const block = `- ${recordGrade(candidate.id, candidate.signature, input.dir)} [${candidate.id}] Recall read:"${candidate.id}" before the affected decision; full text did not fit.`
      if (used + block.length + 1 <= limit) {
        rode.push({ ...candidate, block, chars: block.length + 1 })
        used += block.length + 1
      } else left.push(candidate)
    } else left.push(candidate)
  }
  rode.sort(byScore)
  left.sort(byScore)
  return { rode, left, limit, pinnedChars: input.pinnedChars, used }
}

export function withThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

function memoryAtStartLine(input: { task?: StartTask; choice: StartChoice; pinnedCount: number; facts: number; notes: number; pending: number; state: Pick<ProjectState, 'branch' | 'files' | 'note'> }): string {
  const { choice, pinnedCount, facts, notes, pending, state } = input
  const pins = pinnedCount === 0 ? 'no pinned rule' : `${plural(pinnedCount, 'pinned rule')} (${withThousands(choice.pinnedChars)} characters)`
  if (facts + notes === 0) return `Memory at start: ${pins}; nothing rode (${plural(pending, 'fact')} pending); Recall finds them.`
  const pool = joinWords([facts > 0 ? plural(facts, 'fact') : null, notes > 0 ? plural(notes, 'earlier note') : null].filter((part): part is string => part !== null))
  const target = [input.task?.prompt?.trim() ? 'the current prompt' : input.task?.continuation?.source ? 'the source-linked continuation' : null, state.branch !== null ? `branch ${state.branch}` : null, state.files.length > 0 ? 'the files touched lately' : null, state.note !== null ? 'the last note' : null].filter((part): part is string => part !== null)
  if (target.length === 0) return `Memory at start: ${pins}; the ${pool} wait for a branch, touched files or a note to match against; Recall finds them.`
  const rodeFacts = choice.rode.filter(c => c.kind === 'fact').length
  const rodeNotes = choice.rode.filter(c => c.kind === 'handoff').length
  const rode = joinWords([facts > 0 ? `${rodeFacts} of ${plural(facts, 'fact')}` : null, notes > 0 ? `${rodeNotes} of ${plural(notes, 'earlier note')}` : null].filter((part): part is string => part !== null))
  return `Memory at start: ${pins} and ${rode} most relevant to ${joinWords(target)}; Recall finds the rest.`
}

export function memoryAtStartRowWords(status: MemoryAtStartStatus): string {
  const pins = status.pinnedCount > 0 ? plural(status.pinnedCount, 'pinned rule') : null
  const pending = status.pending > 0 ? ` (${plural(status.pending, 'fact')} pending)` : ''
  if (status.facts + status.notes === 0) {
    if (pins === null && status.pending === 0) return 'nothing on record yet'
    return `${pins === null ? 'nothing' : `${pins}; nothing else`} rode at start${pending}; Recall finds them`
  }
  const rode = joinWords([status.facts > 0 ? `${status.rodeFacts} of ${plural(status.facts, 'fact')}` : null, status.notes > 0 ? `${status.rodeNotes} of ${plural(status.notes, 'earlier note')}` : null].filter((part): part is string => part !== null))
  return `${pins === null ? '' : `${pins} and `}${rode} rode at start${pending}; Recall finds the rest`
}

function renderMemoryAtStart(input: { task?: StartTask; choice: StartChoice; pinnedCount: number; facts: number; notes: number; pending: number; state: ProjectState }): string | null {
  if (input.facts + input.notes + input.pending === 0 && !input.task?.required?.length) return null
  const lines: string[] = [MEMORY_AT_START_HEADING, memoryAtStartLine(input)]
  for (const candidate of input.choice.rode) if (candidate.kind === 'fact') lines.push(candidate.block)
  for (const candidate of input.choice.rode) if (candidate.kind === 'handoff') lines.push('', candidate.block)
  for (const row of input.task?.required ?? []) if (row.source && !input.choice.rode.some(candidate => candidate.id === row.id)) lines.push(`- [${row.id}] [possible obligation · unknown] source ${row.source}; read the source before the affected decision.`)
  return lines.join('\n')
}

interface StartPage {
  text: string | null
  choice: StartChoice
  status: MemoryAtStartStatus
  state: ProjectState
}

export function staleMark(confirmedAt: string | undefined): string {
  return ` [${memoryStatusWords({ status: 'stale', confirmedAt })}]`
}

function markStale(candidate: StartCandidate, mark: string): StartCandidate {
  return { ...candidate, stale: true, block: `${candidate.block}${mark}`, chars: candidate.chars + mark.length }
}

export function composeStartPage(input: { task?: StartTask; dir: string; projectKey: string; state: ProjectState; previous: readonly LedgerEntry[]; limit: number; now: number; root: string | null; stale?: (candidate: StartCandidate) => boolean; confirmedAt?: (candidate: StartCandidate) => string | undefined; mark?: (candidate: StartCandidate) => string | undefined }): StartPage {
  const topics = listTopicDocs(input.dir)
  const archives = listArchiveDocs(input.dir)
  const pinned = pinnedNow(input.dir, topics)
  const facts = libraryCandidates(input.dir, pinned.excluded, { topics, archives })
  const notes = earlierNotes(input.previous, input.projectKey)
  const pending = pendingRows(input.dir).length
  const candidates = [...facts, ...notes].map(candidate => (input.stale?.(candidate) ? markStale(candidate, input.mark?.(candidate) ?? staleMark(input.confirmedAt?.(candidate))) : candidate))
  const choice = chooseAtStart({ task: input.task, candidates, chunks: stateQuery(input.state, input.root), limit: input.limit, pinnedChars: pinned.chars, now: input.now, dir: input.dir })
  const status: MemoryAtStartStatus = {
    limit: choice.limit,
    pinnedCount: pinned.count,
    pinnedChars: pinned.chars,
    used: choice.used,
    facts: facts.length,
    rodeFacts: choice.rode.filter(c => c.kind === 'fact').length,
    notes: notes.length,
    rodeNotes: choice.rode.filter(c => c.kind === 'handoff').length,
    pending,
  }
  return { text: renderMemoryAtStart({ task: input.task, choice, pinnedCount: pinned.count, facts: facts.length, notes: notes.length, pending, state: input.state }), choice, status, state: input.state }
}

export async function composeMemoryAtStart(input: { task?: StartTask; projectKey: string; sessionId?: string; root: string; dir?: string; now?: Date }): Promise<string | null> {
  if (!mnemeEnabled()) return null
  try {
    const dir = input.dir ?? mnemeLibraryDir()
    const now = input.now ?? new Date()
    const previous = readLedger(input.projectKey).filter(entry => entry.sessionId !== input.sessionId)
    const state = await readProjectState({ projectKey: input.projectKey, sessionId: input.sessionId, root: input.root, now, ledger: previous })
    const pins = readPins(dir)
    const usage = readUsage(dir)
    const states = new Map<string, ReturnType<typeof factMemoryState>>()
    const stateOf = (candidate: StartCandidate): ReturnType<typeof factMemoryState> | null => {
      if (candidate.seq === undefined) return null
      const known = states.get(candidate.id)
      if (known !== undefined) return known
      const state = factMemoryState({ seq: candidate.seq, time: candidate.time ?? '', text: candidate.text }, { pins, usage, now, libraryDir: dir, projectRoot: input.root })
      states.set(candidate.id, state)
      return state
    }
    const demoted = (candidate: StartCandidate): boolean => {
      const status = stateOf(candidate)?.status
      return status === 'stale' || status === 'needs-review'
    }
    const page = composeStartPage({
      task: input.task,
      dir,
      projectKey: input.projectKey,
      state,
      previous,
      limit: startTextLimit(),
      now: now.getTime(),
      root: input.root,
      stale: demoted,
      confirmedAt: candidate => stateOf(candidate)?.confirmedAt,
      mark: candidate => {
        const known = stateOf(candidate)
        return known === null ? undefined : ` [${memoryStatusWords(known)}]`
      },
    })
    lastStatus = page.status
    return page.text
  } catch (error) {
    logForDebugging(`memory at start failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
