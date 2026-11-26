import { randomUUID, type UUID } from 'node:crypto'
import { switchSession } from '../../src/boot/process-state/processState.ts'
import { annotateBoundaryWithPreservedSegment } from '../../src/engine/compaction/fold/foldResult.ts'
import { createAssistantMessage, createUserMessage } from '../../src/engine/message-shapes/factories.ts'
import type { AssistantMessage, Message, UserMessage } from '../../src/engine/message-shapes/message.ts'
import { createFoldBoundaryMessage, createSystemMessage } from '../../src/engine/message-shapes/systemMessages.ts'
import { asSessionId } from '../../src/sessions/transcripts/ids.ts'
import { flushSessionStorage, getTranscriptPath, recordTranscript, resetProjectForTesting } from '../../src/sessions/transcripts/sessionStorage.ts'
import { _resetTranscriptReaderForTesting } from '../../src/sessions/transcripts/transcriptReader.ts'

export const LEAF_SCENES = ['plain', 'tie', 'tie-behind', 'fold', 'kept', 'kept-late', 'two', 'double-fold', 'large', 'onward'] as const
export const LEAF_UNFINISHED_SCENE = 'unfinished'
type LeafSceneName = (typeof LEAF_SCENES)[number] | typeof LEAF_UNFINISHED_SCENE

export type LeafScene = {
  name: LeafSceneName
  sid: UUID
  file: string
  prompt: UUID
  calls: [UUID, UUID]
  reports: UUID[]
  final: UUID
  second: { prompt: UUID; end: UUID } | undefined
  end: UUID
  boundary: UUID | undefined
  summary: UUID | undefined
  summaryText: string | undefined
}

const CALL_IDS = ['call_a', 'call_b'] as const
const MODEL = 'claude-sonnet-5'
const LARGE_PAD_BYTES = 5 * 1024 * 1024 + 20_000

export async function writeLeafScene(name: LeafSceneName): Promise<LeafScene> {
  resetProjectForTesting()
  _resetTranscriptReaderForTesting()
  const sid = randomUUID()
  switchSession(asSessionId(sid))

  let clock = Date.now() - 120_000
  const stamped = <T extends Message>(row: T): T => {
    row.timestamp = new Date(++clock).toISOString()
    return row
  }
  const call = (id: string, group = 'msg_leaf'): AssistantMessage => {
    const row = stamped(createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'fixture' } }] }))
    row.message.id = group
    row.message.model = MODEL
    row.message.stop_reason = 'tool_use'
    return row
  }
  const report = (id: string, issuer: AssistantMessage): UserMessage =>
    stamped(createUserMessage({ sourceToolAssistantUUID: issuer.uuid, content: [{ type: 'tool_result', tool_use_id: id, content: 'fixture report' }] }))
  const reply = (text: string): AssistantMessage => {
    const row = stamped(createAssistantMessage({ content: text }))
    row.message.model = MODEL
    row.message.stop_reason = 'end_turn'
    return row
  }
  const write = (...rows: Message[]): Promise<UUID | null> => recordTranscript(rows)

  const folded = name !== 'plain' && name !== 'tie' && name !== 'tie-behind'
  const prompt = stamped(createUserMessage({ content: 'fixture turn' }))
  const a = call(CALL_IDS[0])
  const b = call(CALL_IDS[1])
  await write(prompt, a, b)
  await write(stamped(createSystemMessage('work observed', 'info')))
  const kept = name === 'kept-late' ? ([stamped(createUserMessage({ content: 'kept fixture turn' })), reply('finished fixture reply')] as const) : undefined
  if (kept !== undefined) await write(...kept)

  let boundary: UUID | undefined
  let summary: UUID | undefined
  let summaryText: string | undefined
  if (folded) {
    const first = stamped(createFoldBoundaryMessage('auto', 1500, (kept?.[1] ?? b).uuid))
    summaryText = 'active summary'
    const firstSummary = stamped(createUserMessage({ content: name === 'large' ? `${summaryText} ${'a'.repeat(LARGE_PAD_BYTES)}` : summaryText, isCompactSummary: true }))
    if (name === 'kept') annotateBoundaryWithPreservedSegment(first, firstSummary.uuid, [prompt, a, b])
    if (kept !== undefined) annotateBoundaryWithPreservedSegment(first, firstSummary.uuid, [...kept])
    await write(first)
    await write(firstSummary)
    boundary = first.uuid
    summary = firstSummary.uuid
    if (name === 'double-fold') {
      const second = stamped(createFoldBoundaryMessage('auto', 610, firstSummary.uuid))
      summaryText = 'second summary'
      const secondSummary = stamped(createUserMessage({ content: summaryText, isCompactSummary: true }))
      await write(second)
      await write(secondSummary)
      boundary = second.uuid
      summary = secondSummary.uuid
    }
  }

  const reports: UserMessage[] = []
  let behind: UserMessage | undefined
  if (!folded) {
    const forB = report(CALL_IDS[1], b)
    const forA = report(CALL_IDS[0], a)
    if (name === 'tie') forA.timestamp = forB.timestamp
    await write(forB)
    if (name === 'tie-behind') behind = forA
    else await write(forA)
    reports.push(forB, forA)
  }
  const final = kept?.[1] ?? reply('finished fixture reply')
  if (name === 'tie') final.timestamp = reports[0]!.timestamp
  if (kept === undefined) await write(final)
  if (behind !== undefined) {
    behind.timestamp = final.timestamp
    await write(behind)
  }
  let second: LeafScene['second']
  if (name === LEAF_UNFINISHED_SCENE) {
    const again = stamped(createUserMessage({ content: 'second fixture turn' }))
    const pending = call('call_open', 'msg_open')
    await write(again, pending)
    second = { prompt: again.uuid, end: pending.uuid }
  }
  if (folded) {
    const late = report(CALL_IDS[0], a)
    await write(late)
    reports.push(late)
    if (name === 'two') {
      const later = report(CALL_IDS[1], b)
      await write(later)
      reports.push(later)
    }
  }
  if (name === 'onward' || name === 'kept-late') {
    const again = stamped(createUserMessage({ content: 'second fixture turn' }))
    const answered = reply('second fixture reply')
    await write(again)
    await write(answered)
    second = { prompt: again.uuid, end: answered.uuid }
  }

  await flushSessionStorage()
  const file = getTranscriptPath()
  _resetTranscriptReaderForTesting()
  return { name, sid, file, prompt: prompt.uuid, calls: [a.uuid, b.uuid], reports: reports.map(row => row.uuid), final: final.uuid, second, end: second?.end ?? final.uuid, boundary, summary, summaryText }
}
