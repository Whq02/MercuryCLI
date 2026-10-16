import { createHash } from 'node:crypto'
import { getSessionId } from '../../bootstrap/state.js'
import { memoryVerbsEnabled, retainItems } from '../../mneme/memoryVerbs.js'
import { pendingRows } from '../../mneme/mnemeBuffer.js'
import { recordEntries } from '../../mneme/mnemeContradiction.js'
import { currentLedger, sessionOrdinal } from '../../mneme/mnemeFootnotes.js'
import { mnemeLibraryDir } from '../../mneme/mnemeGates.js'
import { memoryPointerForId, type MemoryPointer } from '../../mneme/mnemePointers.js'
import type { LedgerEntry } from '../../mneme/types.js'
import type { Message } from '../../types/message.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { getRunSnapshot } from '../run/runCoordinator.js'
import type { RunSnapshot } from '../run/runKernel.js'
import { groupMessagesByApiRound } from './grouping.js'

export type FoldMemoryItem = { content: string; context: string; topic: string }
export type FoldMemorySourceRange = { firstRecordId: string; lastRecordId: string; firstTurn: number; lastTurn: number }
export type FoldMemoryEnvelope = {
  version: 1
  epoch: number
  sessionOrdinal: number | null
  sourceRange: FoldMemorySourceRange
  contentWitness: { algorithm: 'sha256'; digest: string }
  item: FoldMemoryItem | null
} & ({ state: 'committed'; pointer: MemoryPointer } | { state: 'pending' | 'failed'; reason: string })

const FOLD_MEMORY_TOPIC = 'project'
const FOLD_CONTEXT_MARK = 'context epoch '
const FIELD_CHARS = 400
const DELIVERABLES_SHOWN = 8
const RECORD_SHORT = 8

export const foldMemoryWitness = (text: string): string => createHash('sha256').update(text).digest('hex')
export const foldMemoryStoredText = (item: FoldMemoryItem): string => `${item.content} (context: ${item.context})`

const oneLine = (text: string): string => text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const short = (id: string): string => id.slice(0, RECORD_SHORT)

function foldMemorySourceRange(messages: readonly Message[]): FoldMemorySourceRange {
  let priorLastTurn = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const row = messages[index]
    if (row?.type === 'system' && row.subtype === 'compact_boundary' && row.compactMetadata.memory) {
      priorLastTurn = row.compactMetadata.memory.sourceRange.lastTurn
      break
    }
  }
  const rounds = groupMessagesByApiRound(messages as Message[]).length
  return {
    firstRecordId: messages[0]?.uuid ?? '',
    lastRecordId: messages[messages.length - 1]?.uuid ?? '',
    firstTurn: priorLastTurn + 1,
    lastTurn: priorLastTurn + Math.max(rounds, 1),
  }
}

function selectFoldMemoryItem(snapshot: RunSnapshot | null, sessionId: string, epoch: number, range: FoldMemorySourceRange, records: number): FoldMemoryItem | null {
  if (!snapshot?.substantive) return null
  const deliverables = snapshot.deliverables.slice(0, DELIVERABLES_SHOWN).map(d => `${clip(oneLine(d.title || d.id), 80)} [${d.state}]`)
  const more = snapshot.deliverables.length - deliverables.length
  const blocker = snapshot.blocker
    ? `${clip(oneLine(snapshot.blocker.description), FIELD_CHARS)} (owned by ${snapshot.blocker.ownedBy}; resumes when ${clip(oneLine(snapshot.blocker.resumeCondition), 160)})`
    : 'none'
  const content = oneLine([
    `Run state (session ${short(sessionId)}):`,
    `objective — ${clip(oneLine(snapshot.objective), FIELD_CHARS)};`,
    `deliverables — ${deliverables.length === 0 ? 'none declared' : deliverables.join(', ')}${more > 0 ? ` (+${more} more)` : ''};`,
    `next action — ${clip(oneLine(snapshot.nextAction), FIELD_CHARS) || 'none stated'};`,
    `blocker — ${blocker};`,
    `verification — ${snapshot.verification.state}.`,
  ].join(' '))
  const context = oneLine(`${FOLD_CONTEXT_MARK}${epoch}; source records ${short(range.firstRecordId)}…${short(range.lastRecordId)} (${records} records, rounds ${range.firstTurn}–${range.lastTurn})`)
  return { content, context, topic: FOLD_MEMORY_TOPIC }
}

export function readBackStoredRow(id: string, dir: string): { text: string; source: string; pin: boolean } | null {
  if (!id.startsWith('pending:')) return null
  const row = pendingRows(dir).find(candidate => `pending:${candidate.ts}` === id)
  return row ? { text: row.text, source: row.source, pin: row.pin === true } : null
}

function retiredFactFor(content: string, dir: string): { id: string; text: string } | null {
  const marker = `${content} (context: ${FOLD_CONTEXT_MARK}`
  const entry = recordEntries(dir).find(candidate => candidate.kind !== 'rule' && candidate.text.startsWith(marker))
  return entry ? { id: entry.id, text: entry.text } : null
}

export function retireFoldToMemory(input: {
  messages: readonly Message[]
  owner: OwnerKey
  epoch: number
  records: number
  aborted?: boolean
  agent?: string
  dir?: string
  sessions?: readonly LedgerEntry[]
  now?: Date
}): FoldMemoryEnvelope {
  const sessionId = String(getSessionId())
  const sessions = input.sessions ?? currentLedger()
  const sourceRange = foldMemorySourceRange(input.messages)
  const item = selectFoldMemoryItem(getRunSnapshot(input.owner), sessionId, input.epoch, sourceRange, input.records)
  const expected = item ? foldMemoryStoredText(item) : ''
  const base = {
    version: 1 as const,
    epoch: input.epoch,
    sessionOrdinal: sessionOrdinal(sessionId, sessions) ?? null,
    sourceRange,
    contentWitness: { algorithm: 'sha256' as const, digest: foldMemoryWitness(expected) },
    item,
  }
  if (item === null) return { ...base, state: 'failed', reason: 'nothing to retire: the run holds no substantive state' }
  if (input.agent !== undefined) return { ...base, state: 'failed', reason: 'a crewmate fold writes no project memory; its run state stays in its own transcript' }
  if (input.aborted) return { ...base, state: 'failed', reason: 'the fold was cancelled before the memory write' }
  if (!memoryVerbsEnabled()) return { ...base, state: 'failed', reason: 'memory is off — nothing was stored' }
  const dir = input.dir ?? mnemeLibraryDir()
  const retired = retiredFactFor(item.content, dir)
  if (retired !== null) {
    const held = {
      ...base,
      contentWitness: { algorithm: 'sha256' as const, digest: foldMemoryWitness(retired.text) },
      item: { ...item, context: retired.text.slice(`${item.content} (context: `.length, -1) },
    }
    const pointer = memoryPointerForId(retired.id, { dir, sessions, now: input.now })
    if (pointer === null) return { ...held, state: 'pending', reason: `already in memory as ${retired.id} but no pointer resolves for it` }
    return { ...held, state: 'committed', pointer }
  }
  const source = `fold s:${short(sessionId)} e:${input.epoch}`
  const [outcome] = retainItems([{ content: item.content, context: item.context, topic: item.topic }], { session: sessionId, source }, dir)
  if (outcome === undefined || outcome.status === 'refused') return { ...base, state: 'failed', reason: outcome?.reason ?? 'the memory write returned no outcome' }
  const row = readBackStoredRow(outcome.id, dir)
  if (row === null || row.text !== expected || row.pin) {
    return { ...base, state: 'pending', reason: `written as ${outcome.id} but the stored row read back ${row === null ? 'absent' : row.pin ? 'pinned' : 'with different text'}` }
  }
  const pointer = memoryPointerForId(outcome.id, { dir, sessions, now: input.now })
  if (pointer === null) return { ...base, state: 'pending', reason: `written and read back as ${outcome.id} but no pointer resolves for it` }
  return { ...base, state: 'committed', pointer }
}

export function renderFoldMemory(envelope: FoldMemoryEnvelope): string {
  const range = envelope.sourceRange
  const rest = `Everything else folded stays in the transcript, source records ${short(range.firstRecordId)}…${short(range.lastRecordId)} (rounds ${range.firstTurn}–${range.lastTurn}), indexed by the fold ledger below.`
  if (envelope.state === 'committed') {
    return [
      '## Moved to memory',
      `[${envelope.pointer.id}] ${envelope.pointer.kind} · ${envelope.pointer.title} — stored in project memory, read back whole (sha256 ${envelope.contentWitness.digest.slice(0, 12)}); Recall read:"${envelope.pointer.id}" returns it.`,
      rest,
    ].join('\n')
  }
  const head = envelope.state === 'pending' ? 'Not confirmed in memory' : 'Nothing moved to memory'
  const kept = envelope.item === null ? '' : ' The unsaved run state is in this epoch\'s boundary record; the run capsule above carries the same state.'
  return ['## Moved to memory', `${head}: ${envelope.reason}.${kept}`, rest].join('\n')
}
