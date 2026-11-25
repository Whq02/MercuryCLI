#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID, type UUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'fold-parallel-home-')))
const workdir = realpathSync(mkdtempSync(join(tmpdir(), 'fold-parallel-cwd-')))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(workdir)

const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const { getTranscriptPath, recordTranscript, flushSessionStorage, resetProjectForTesting } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { loadConversationForResume } = await import('../../src/sessions/resume/conversationRecovery.ts')
const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
const { buildConversationChain, findLatestMessage } = await import('../../src/sessions/transcripts/chain.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { historyHead, historyLines, sealedFile } = await import('../../src/sessions/transcripts/historyParts.ts')
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')
const { QueuePart } = await import('../../src/sessions/transcripts/writer/queue.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createFoldBoundaryMessage, createSystemMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { annotateBoundaryWithPreservedSegment } = await import('../../src/engine/compaction/foldConversation.ts')
const { pairConversationMessages } = await import('../../src/engine/message-shapes/resultPairing.ts')
const { ENDED_RUN_TOOL_RESULT, SYNTHETIC_TOOL_RESULT_PLACEHOLDER } = await import('../../src/engine/message-shapes/rejectionText.ts')
import type { AssistantMessage, Message, UserMessage } from '../../src/engine/message-shapes/message.ts'
import type { Entry } from '../../src/sessions/transcripts/transcriptEntries.ts'


let checks = 0
let failures = 0
const hint = 'sealHistoryPart in src/sessions/transcripts/writer/sealPart.ts and keptBySegment in src/sessions/transcripts/rowGraph.ts must carry side-branch rows by keptBesideSpine in src/sessions/transcripts/branchSelection.ts'
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail}; ` : ''}${hint}`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

interface RawRecordLine {
  recordId: string
  parentId?: string
}

function readRecordOrder(file: string): RawRecordLine[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as RawRecordLine)
}

function toolUseRow(messageId: string, callId: string, name: string, input: Record<string, unknown>): AssistantMessage {
  const row = createAssistantMessage({
    content: [{ type: 'tool_use', id: callId, name, input }],
  })
  row.message.id = messageId
  row.message.model = 'claude-sonnet-5-5'
  row.message.stop_reason = 'tool_use'
  return row
}

function toolResultRow(callId: string, assistantUuid: UUID, body: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'tool_result', tool_use_id: callId, content: body }],
    sourceToolAssistantUUID: assistantUuid,
  })
}

function extractToolCallsAndResults(messages: readonly Message[]): {
  calls: string[]
  results: Map<string, { content: string; isError: boolean }>
} {
  const calls: string[] = []
  const results = new Map<string, { content: string; isError: boolean }>()
  for (const row of messages) {
    if (row.type === 'assistant' && Array.isArray(row.message.content)) {
      for (const block of row.message.content) {
        if (block.type === 'tool_use') calls.push(block.id)
      }
    } else if (row.type === 'user' && Array.isArray(row.message.content)) {
      for (const block of row.message.content) {
        if (block.type === 'tool_result') {
          const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
          results.set(block.tool_use_id, { content: text, isError: block.is_error === true })
        }
      }
    }
  }
  return { calls, results }
}

function startFreshSession(): UUID {
  resetProjectForTesting()
  _resetTranscriptReaderForTesting()
  const sid = randomUUID()
  switchSession(sid)
  return sid
}

try {
  section('§1 real-session fold: two parallel tool calls with notices and reply C, kept by /compact')
  {
    const sid = startFreshSession()
    const u0 = createUserMessage({ content: 'Earlier prompt to be folded away.' })
    const a0 = createAssistantMessage({ content: 'Earlier answer to be folded away.' })
    a0.message.stop_reason = 'end_turn'
    await recordTranscript([u0, a0])

    const u1 = createUserMessage({ content: 'Call CrewBoard and Write together.' })
    const msgId = 'msg_parallel_01'
    const callA = 'toolu_crewboard_A'
    const callB = 'toolu_write_B'
    const aCall = toolUseRow(msgId, callA, 'CrewBoard', { op: 'read' })
    const notice1 = createSystemMessage('Notice 1 between A and B', 'info')
    const bCall = toolUseRow(msgId, callB, 'Write', { file_path: 'note.md', content: 'ok' })
    const notice2 = createSystemMessage('Notice 2 hanging on B', 'info')
    const aRes = toolResultRow(callA, aCall.uuid, 'CrewBoard result A')
    const bRes = toolResultRow(callB, bCall.uuid, 'Write result B')
    const replyC = createAssistantMessage({ content: 'Both tool calls finished.' })
    replyC.message.stop_reason = 'end_turn'

    await recordTranscript([u1, aCall])
    await recordTranscript([notice1])
    await recordTranscript([bCall])
    await recordTranscript([notice2])
    await recordTranscript([aRes])
    await recordTranscript([bRes])
    await recordTranscript([replyC])
    await flushSessionStorage()

    const file = getTranscriptPath()
    const preRows = readRecordOrder(file)
    const preParent = new Map(preRows.map(r => [r.recordId, r.parentId]))
    check(
      'scene: writer linked A -> notice1 -> B, notice2 -> B, A_res -> A, B_res -> B, C -> B_res',
      preParent.get(notice1.uuid) === aCall.uuid &&
        preParent.get(bCall.uuid) === notice1.uuid &&
        preParent.get(notice2.uuid) === bCall.uuid &&
        preParent.get(aRes.uuid) === aCall.uuid &&
        preParent.get(bRes.uuid) === bCall.uuid &&
        preParent.get(replyC.uuid) === bRes.uuid,
      JSON.stringify({
        n1: preParent.get(notice1.uuid),
        b: preParent.get(bCall.uuid),
        n2: preParent.get(notice2.uuid),
        aRes: preParent.get(aRes.uuid),
        bRes: preParent.get(bRes.uuid),
        c: preParent.get(replyC.uuid),
      }),
    )

    const kept: Message[] = [u1, aCall, notice1, bCall, notice2, aRes, bRes, replyC]
    const boundary = createFoldBoundaryMessage('manual', 50_000, replyC.uuid)
    const summary = createUserMessage({
      content: 'Summary of earlier turn.',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    annotateBoundaryWithPreservedSegment(boundary, summary.uuid, kept)
    await recordTranscript([boundary, summary, ...kept])
    await flushSessionStorage()

    const head = historyHead(file)
    check('the fold sealed the earlier history part and dropped u0/a0 from the live file', head.before > 0 && existsSync(sealedFile(file, head.before)))

    const postRows = readRecordOrder(file)
    const postIds = postRows.map(r => r.recordId)
    const postSet = new Set(postIds)
    check('u0 and a0 are folded out of the live file', !postSet.has(u0.uuid) && !postSet.has(a0.uuid))
    check(
      '(a) rewritten live file holds BOTH A_res and B_res and notice2',
      postSet.has(aRes.uuid) && postSet.has(bRes.uuid) && postSet.has(notice2.uuid),
      JSON.stringify({ aRes: postSet.has(aRes.uuid), bRes: postSet.has(bRes.uuid), notice2: postSet.has(notice2.uuid) }),
    )
    const expectedOrder = [u1.uuid, aCall.uuid, notice1.uuid, bCall.uuid, notice2.uuid, aRes.uuid, bRes.uuid, replyC.uuid, boundary.uuid, summary.uuid]
    const actualOrder = expectedOrder.filter(id => postSet.has(id)).map(id => postIds.indexOf(id))
    const strictlyOrdered = actualOrder.length === expectedOrder.length && actualOrder.every((idx, i) => i === 0 || idx > actualOrder[i - 1]!)
    check('carried rows stand in their original chronological order before the boundary', strictlyOrdered, JSON.stringify(actualOrder))

    _resetTranscriptReaderForTesting()
    const resumed = await loadConversationForResume(sid, file)
    check('loadConversationForResume succeeds', resumed !== null)
    const { calls, results } = extractToolCallsAndResults(resumed?.messages ?? [])
    check(
      '(b) continued session keeps BOTH tool calls A and B',
      calls.includes(callA) && calls.includes(callB),
      `calls=${JSON.stringify(calls)}`,
    )
    check(
      '(b) continued session keeps BOTH real tool results A and B (no missing or synthetic result)',
      results.get(callA)?.content === 'CrewBoard result A' &&
        results.get(callA)?.isError === false &&
        results.get(callB)?.content === 'Write result B' &&
        results.get(callB)?.isError === false,
      JSON.stringify([...results]),
    )
    check(
      'continued session keeps notice2 beside B',
      (resumed?.messages ?? []).some(m => m.uuid === notice2.uuid),
    )

    _resetTranscriptReaderForTesting()
    const resumedById = await loadConversationForResume(sid, undefined)
    const byId = extractToolCallsAndResults(resumedById?.messages ?? [])
    check(
      'loadConversationForResume by sessionId (lastSession road) also keeps both calls and results',
      byId.calls.includes(callA) &&
        byId.calls.includes(callB) &&
        byId.results.get(callA)?.content === 'CrewBoard result A' &&
        byId.results.get(callB)?.content === 'Write result B',
      JSON.stringify({ calls: byId.calls, results: [...byId.results] }),
    )

    const wireRows = (resumed?.messages ?? []).filter(
      (m): m is UserMessage | AssistantMessage => m.type === 'user' || m.type === 'assistant',
    )
    const paired = pairConversationMessages(wireRows, 'split')
    const pairedCheck = extractToolCallsAndResults(paired)
    check(
      'wire pairing keeps both tool calls and both real results with no placeholder',
      pairedCheck.calls.includes(callA) &&
        pairedCheck.calls.includes(callB) &&
        pairedCheck.results.get(callA)?.content === 'CrewBoard result A' &&
        pairedCheck.results.get(callB)?.content === 'Write result B' &&
        !JSON.stringify(paired).includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER) &&
        !JSON.stringify(paired).includes(ENDED_RUN_TOOL_RESULT),
    )

    const oneFile = join(home, 'scene1-one-file.jsonl')
    writeFileSync(oneFile, '', { flag: 'wx' })
    for (const line of historyLines(file)) appendFileSync(oneFile, line)
    _resetTranscriptReaderForTesting()
    const sealedFold = await loadTranscriptFile(file, { throwOnError: true })
    const oneFileFold = await loadTranscriptFile(oneFile, { throwOnError: true })
    const sealedLeaf = findLatestMessage(sealedFold.messages.values(), r => sealedFold.leafUuids.has(r.uuid))
    const oneFileLeaf = findLatestMessage(oneFileFold.messages.values(), r => oneFileFold.leafUuids.has(r.uuid))
    const sealedChain = sealedLeaf ? buildConversationChain(sealedFold.messages, sealedLeaf).map(m => m.uuid) : []
    const oneFileChain = oneFileLeaf ? buildConversationChain(oneFileFold.messages, oneFileLeaf).map(m => m.uuid) : []
    check(
      'sealed live file and one-file historyLines load the exact same chain uuid for uuid',
      sealedChain.length > 0 && JSON.stringify(sealedChain) === JSON.stringify(oneFileChain),
      `sealed=${sealedChain.length} oneFile=${oneFileChain.length}`,
    )

    section('§4 refold (second consecutive fold) still retains both parallel tool results and notice2')
    const u2 = createUserMessage({ content: 'Follow-up after first fold.' })
    const a2 = createAssistantMessage({ content: 'Follow-up reply.' })
    a2.message.stop_reason = 'end_turn'
    await recordTranscript([u2, a2])
    const kept2: Message[] = [...kept, u2, a2]
    const boundary2 = createFoldBoundaryMessage('manual', 60_000, a2.uuid)
    const summary2 = createUserMessage({
      content: 'Summary after second fold.',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    annotateBoundaryWithPreservedSegment(boundary2, summary2.uuid, kept2)
    await recordTranscript([boundary2, summary2, ...kept2])
    await flushSessionStorage()

    const post2Set = new Set(readRecordOrder(file).map(r => r.recordId))
    check(
      'after second fold, rewritten file still holds A_res, B_res and notice2',
      post2Set.has(aRes.uuid) && post2Set.has(bRes.uuid) && post2Set.has(notice2.uuid),
    )
    _resetTranscriptReaderForTesting()
    const resumed2 = await loadConversationForResume(sid, file)
    const after2 = extractToolCallsAndResults(resumed2?.messages ?? [])
    check(
      'after second fold, continued session still holds both calls and real results',
      after2.calls.includes(callA) &&
        after2.calls.includes(callB) &&
        after2.results.get(callA)?.content === 'CrewBoard result A' &&
        after2.results.get(callB)?.content === 'Write result B',
    )
  }

  section('§2 fold right after B_res (before next assistant reply): no fabricated ENDED_RUN_TOOL_RESULT')
  {
    const sid = startFreshSession()
    const u0 = createUserMessage({ content: 'Earlier prompt.' })
    const a0 = createAssistantMessage({ content: 'Earlier reply.' })
    a0.message.stop_reason = 'end_turn'
    await recordTranscript([u0, a0])

    const u1 = createUserMessage({ content: 'Run two tools.' })
    const msgId = 'msg_parallel_02'
    const callA = 'toolu_tail_A'
    const callB = 'toolu_tail_B'
    const aCall = toolUseRow(msgId, callA, 'CrewBoard', { op: 'read' })
    const notice1 = createSystemMessage('Notice 1', 'info')
    const bCall = toolUseRow(msgId, callB, 'Write', { file_path: 'y.md', content: 'ok' })
    const notice2 = createSystemMessage('Notice 2', 'info')
    const aRes = toolResultRow(callA, aCall.uuid, 'Real result A')
    const bRes = toolResultRow(callB, bCall.uuid, 'Real result B')

    await recordTranscript([u1, aCall])
    await recordTranscript([notice1])
    await recordTranscript([bCall])
    await recordTranscript([notice2])
    await recordTranscript([aRes])
    await recordTranscript([bRes])
    await flushSessionStorage()

    const kept: Message[] = [u1, aCall, notice1, bCall, notice2, aRes, bRes]
    const boundary = createFoldBoundaryMessage('manual', 50_000, bRes.uuid)
    const summary = createUserMessage({
      content: 'Summary.',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    annotateBoundaryWithPreservedSegment(boundary, summary.uuid, kept)
    await recordTranscript([boundary, summary, ...kept])
    await flushSessionStorage()

    const file = getTranscriptPath()
    const postSet = new Set(readRecordOrder(file).map(r => r.recordId))
    check(
      'rewritten file holds A_res, B_res and notice2 when tailUuid is B_res',
      postSet.has(aRes.uuid) && postSet.has(bRes.uuid) && postSet.has(notice2.uuid),
    )
    _resetTranscriptReaderForTesting()
    const resumed = await loadConversationForResume(sid, file)
    const { calls, results } = extractToolCallsAndResults(resumed?.messages ?? [])
    check(
      'continued session keeps real result A (not fabricated ENDED_RUN_TOOL_RESULT)',
      calls.includes(callA) &&
        calls.includes(callB) &&
        results.get(callA)?.content === 'Real result A' &&
        results.get(callA)?.isError === false &&
        results.get(callB)?.content === 'Real result B',
      JSON.stringify([...results]),
    )
  }

  section('§3 reverse completion order (B_res lands before A_res): sibling assistant B and B_res survive fold')
  {
    const sid = startFreshSession()
    const u0 = createUserMessage({ content: 'Old prompt.' })
    const a0 = createAssistantMessage({ content: 'Old reply.' })
    a0.message.stop_reason = 'end_turn'
    await recordTranscript([u0, a0])

    const u1 = createUserMessage({ content: 'Run two tools, B finishes first.' })
    const msgId = 'msg_parallel_03'
    const callA = 'toolu_rev_A'
    const callB = 'toolu_rev_B'
    const aCall = toolUseRow(msgId, callA, 'CrewBoard', { op: 'read' })
    const notice1 = createSystemMessage('Notice 1', 'info')
    const bCall = toolUseRow(msgId, callB, 'Write', { file_path: 'z.md', content: 'ok' })
    const bRes = toolResultRow(callB, bCall.uuid, 'Reverse result B')
    const aRes = toolResultRow(callA, aCall.uuid, 'Reverse result A')
    const replyC = createAssistantMessage({ content: 'Done in reverse.' })
    replyC.message.stop_reason = 'end_turn'

    await recordTranscript([u1, aCall])
    await recordTranscript([notice1])
    await recordTranscript([bCall])
    await recordTranscript([bRes])
    await recordTranscript([aRes])
    await recordTranscript([replyC])
    await flushSessionStorage()

    const kept: Message[] = [u1, aCall, notice1, bCall, bRes, aRes, replyC]
    const boundary = createFoldBoundaryMessage('manual', 50_000, replyC.uuid)
    const summary = createUserMessage({
      content: 'Summary.',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    annotateBoundaryWithPreservedSegment(boundary, summary.uuid, kept)
    await recordTranscript([boundary, summary, ...kept])
    await flushSessionStorage()

    const file = getTranscriptPath()
    const postSet = new Set(readRecordOrder(file).map(r => r.recordId))
    check(
      'rewritten file holds sibling assistant B, notice1, B_res and A_res',
      postSet.has(bCall.uuid) &&
        postSet.has(notice1.uuid) &&
        postSet.has(bRes.uuid) &&
        postSet.has(aRes.uuid),
      JSON.stringify({
        b: postSet.has(bCall.uuid),
        n1: postSet.has(notice1.uuid),
        bRes: postSet.has(bRes.uuid),
        aRes: postSet.has(aRes.uuid),
      }),
    )
    _resetTranscriptReaderForTesting()
    const resumed = await loadConversationForResume(sid, file)
    const { calls, results } = extractToolCallsAndResults(resumed?.messages ?? [])
    check(
      'continued session holds both calls and both real results in reverse completion order',
      calls.includes(callA) &&
        calls.includes(callB) &&
        results.get(callA)?.content === 'Reverse result A' &&
        results.get(callB)?.content === 'Reverse result B',
      JSON.stringify({ calls, results: [...results] }),
    )
  }

  section('§5 a rewound dead branch off a kept user prompt is NOT carried by the fold')
  {
    const sid = randomUUID()
    const file = join(home, `${sid}.jsonl`)
    const stamp = (offset: number): string => new Date(Date.parse('2026-11-25T23:00:00.000Z') + offset * 1000).toISOString()
    const u0 = randomUUID()
    const u1 = randomUUID()
    const deadAsst = randomUUID()
    const deadRes = randomUUID()
    const liveAsst = randomUUID()
    const liveRes = randomUUID()
    const b1 = randomUUID()
    const s1 = randomUUID()
    const baseRow = (uuid: UUID, parentUuid: UUID | null, offset: number) => ({
      uuid,
      parentUuid,
      isSidechain: false,
      cwd: workdir,
      sessionId: sid,
      version: '1.0.0',
      timestamp: stamp(offset),
    })
    const rows: Record<string, unknown>[] = [
      { ...baseRow(u0, null, 1), type: 'user', message: { role: 'user', content: 'old' } },
      { ...baseRow(u1, u0, 2), type: 'user', message: { role: 'user', content: 'kept prompt' } },
      {
        ...baseRow(deadAsst, u1, 3),
        type: 'assistant',
        message: {
          id: 'msg_dead',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_dead', name: 'Read', input: { file_path: 'a' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        ...baseRow(deadRes, deadAsst, 4),
        type: 'user',
        sourceToolAssistantUUID: deadAsst,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_dead', content: 'dead result' }] },
      },
      {
        ...baseRow(liveAsst, u1, 5),
        type: 'assistant',
        message: {
          id: 'msg_live',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_live', name: 'Read', input: { file_path: 'b' } }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
      {
        ...baseRow(liveRes, liveAsst, 6),
        type: 'user',
        sourceToolAssistantUUID: liveAsst,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_live', content: 'live result' }] },
      },
    ]
    writeFileSync(file, rows.map(r => encodeTranscriptLine(file, r).line).join(''))
    const queue = new QueuePart()
    const boundaryEntry: Record<string, unknown> = {
      ...baseRow(b1, null, 7),
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      compactMetadata: {
        trigger: 'manual',
        preTokens: 1000,
        preservedSegment: { headUuid: u1, tailUuid: liveRes, anchorUuid: s1 },
      },
    }
    const p = queue.enqueueWrite(file, boundaryEntry as Entry)
    await queue.flush()
    await p
    const postSet = new Set(readRecordOrder(file).map(r => r.recordId))
    check(
      'live turn survives and dead rewound branch off u1 stays dropped',
      postSet.has(u1) && postSet.has(liveAsst) && postSet.has(liveRes) && !postSet.has(deadAsst) && !postSet.has(deadRes),
      JSON.stringify({ deadAsst: postSet.has(deadAsst), deadRes: postSet.has(deadRes) }),
    )
  }
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} fold-keeps-parallel-tool-results: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
