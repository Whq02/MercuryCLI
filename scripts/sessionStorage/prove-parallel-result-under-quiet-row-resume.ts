#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID, type UUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'parallel-quiet-resume-home-')))
const workdir = realpathSync(mkdtempSync(join(tmpdir(), 'parallel-quiet-resume-cwd-')))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(workdir)

const { switchSession } = await import('../../src/boot/process-state/processState.ts')
const { flushSessionStorage, getTranscriptPath, recordTranscript, resetProjectForTesting } = await import(
  '../../src/sessions/transcripts/sessionStorage.ts'
)
const { loadConversationForResume } = await import('../../src/sessions/resume/conversationRecovery.ts')
const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
const { buildConversationChain, buildScreenConversation } = await import('../../src/sessions/transcripts/chain.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { createTranscriptRows, transcriptRows } = await import('../../src/sessions/transcripts/rowGraph.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createFoldBoundaryMessage, createSystemMessage } = await import(
  '../../src/engine/message-shapes/systemMessages.ts'
)
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.ts')
const { pairConversationMessages } = await import('../../src/engine/message-shapes/resultPairing.ts')
const { ENDED_RUN_TOOL_RESULT, SYNTHETIC_TOOL_RESULT_PLACEHOLDER } = await import(
  '../../src/engine/message-shapes/rejectionText.ts'
)
import type { AssistantMessage, Message, UserMessage } from '../../src/engine/message-shapes/message.ts'
import type { TranscriptMessage } from '../../src/sessions/transcripts/transcriptEntries.ts'

let checks = 0
let failures = 0
const HINT =
  'decorateOf in src/sessions/transcripts/rowGraph.ts must walk below quiet system and attachment rows (excluding fold boundaries) to gather sibling tool results without duplicating spine rows'

function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail}; ` : ''}${HINT}`}`)
}

function section(title: string): void {
  console.log(`\n${title}`)
}

interface RawRecordLine {
  recordId: string
  parentId?: string
}

function readParents(file: string): Map<string, string | undefined> {
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as RawRecordLine)
  return new Map(rows.map(row => [row.recordId, row.parentId]))
}

let tick = 0
function nextStamp(): string {
  return new Date(Date.parse('2026-11-26T00:00:00.000Z') + ++tick * 1000).toISOString()
}

function atNextTick<T extends Message>(row: T): T {
  row.timestamp = nextStamp()
  return row
}

function toolUseRow(messageId: string, callId: string, name: string, input: Record<string, unknown>): AssistantMessage {
  const row = atNextTick(
    createAssistantMessage({
      content: [{ type: 'tool_use', id: callId, name, input }],
    }),
  )
  row.message.id = messageId
  row.message.model = 'claude-sonnet-5-5'
  row.message.stop_reason = 'tool_use'
  return row
}

function toolResultRow(callId: string, assistantUuid: UUID, body: string): UserMessage {
  return atNextTick(
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: callId, content: body }],
      sourceToolAssistantUUID: assistantUuid,
    }),
  )
}

function extractCallsAndResults(messages: readonly Message[]): {
  calls: string[]
  results: Array<{ id: string; content: string; isError: boolean }>
} {
  const calls: string[] = []
  const results: Array<{ id: string; content: string; isError: boolean }> = []
  for (const row of messages) {
    if (row.type === 'assistant' && Array.isArray(row.message.content)) {
      for (const block of row.message.content) {
        if (block.type === 'tool_use') calls.push(block.id)
      }
    } else if (row.type === 'user' && Array.isArray(row.message.content)) {
      for (const block of row.message.content) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
          results.push({ id: block.tool_use_id, content, isError: block.is_error === true })
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
  section('§1 two parallel calls, second result lands first under quiet system rows: resumed and screen chains keep both')
  {
    const sid = startFreshSession()
    const u1 = atNextTick(createUserMessage({ content: 'launch two foreground crewmates' }))
    const msgId = 'msg_parallel_quiet_sys'
    const callA = 'toolu_crew_a'
    const callB = 'toolu_crew_b'
    const aCall = toolUseRow(msgId, callA, 'Crewmate', { description: 'tide-gauges', prompt: 'seat a' })
    const bCall = toolUseRow(msgId, callB, 'Crewmate', { description: 'reef-survey', prompt: 'seat b' })
    const joined1 = atNextTick(createSystemMessage('tide-gauges joined the board', 'info'))
    const joined2 = atNextTick(createSystemMessage('reef-survey joined the board', 'info'))
    const bRes = toolResultRow(callB, bCall.uuid, 'report from reef-survey')
    const aRes = toolResultRow(callA, aCall.uuid, 'report from tide-gauges')
    const reply = atNextTick(createAssistantMessage({ content: 'both crewmates landed.' }))
    reply.message.stop_reason = 'end_turn'

    await recordTranscript([u1, aCall, bCall])
    await recordTranscript([joined1])
    await recordTranscript([joined2])
    await recordTranscript([bRes])
    await recordTranscript([aRes])
    await recordTranscript([reply])
    await flushSessionStorage()

    const file = getTranscriptPath()
    const parents = readParents(file)
    check(
      'writer linked bCall -> joined1 -> joined2 -> bRes and aCall -> aRes -> reply',
      parents.get(joined1.uuid) === bCall.uuid &&
        parents.get(joined2.uuid) === joined1.uuid &&
        parents.get(bRes.uuid) === joined2.uuid &&
        parents.get(aRes.uuid) === aCall.uuid &&
        parents.get(reply.uuid) === aRes.uuid,
      JSON.stringify({
        joined1: parents.get(joined1.uuid),
        joined2: parents.get(joined2.uuid),
        bRes: parents.get(bRes.uuid),
        aRes: parents.get(aRes.uuid),
        reply: parents.get(reply.uuid),
      }),
    )

    _resetTranscriptReaderForTesting()
    const resumed = await loadConversationForResume(sid, file)
    check('loadConversationForResume succeeds', resumed !== null)
    const rows = resumed?.messages ?? []
    const uuids = rows.map(row => row.uuid)
    const uniqueUuids = new Set(uuids)
    check('resumed conversation holds no duplicate row UUIDs', uuids.length === uniqueUuids.size, `${uuids.length} vs ${uniqueUuids.size}`)

    const { calls, results } = extractCallsAndResults(rows)
    const byId = new Map(results.map(r => [r.id, r]))
    check(
      'resumed conversation keeps the final reply, both calls and both real tool results (no call left unanswered)',
      uniqueUuids.has(reply.uuid) &&
        calls.includes(callA) &&
        calls.includes(callB) &&
        results.length === 2 &&
        byId.get(callA)?.content === 'report from tide-gauges' &&
        byId.get(callA)?.isError === false &&
        byId.get(callB)?.content === 'report from reef-survey' &&
        byId.get(callB)?.isError === false,
      JSON.stringify({ hasReply: uniqueUuids.has(reply.uuid), calls, results }),
    )
    check(
      'resumed conversation keeps both quiet notes once',
      uniqueUuids.has(joined1.uuid) && uniqueUuids.has(joined2.uuid),
      JSON.stringify({ joined1: uniqueUuids.has(joined1.uuid), joined2: uniqueUuids.has(joined2.uuid) }),
    )

    const wireRows = rows.filter(
      (row): row is UserMessage | AssistantMessage => row.type === 'user' || row.type === 'assistant',
    )
    const paired = pairConversationMessages(wireRows, 'split')
    const pairedStats = extractCallsAndResults(paired)
    const pairedById = new Map(pairedStats.results.map(r => [r.id, r]))
    check(
      'wire pairing keeps both real reports with no synthetic or ended-run placeholder',
      pairedStats.calls.includes(callA) &&
        pairedStats.calls.includes(callB) &&
        pairedStats.results.length === 2 &&
        pairedById.get(callA)?.content === 'report from tide-gauges' &&
        pairedById.get(callB)?.content === 'report from reef-survey' &&
        !JSON.stringify(paired).includes(SYNTHETIC_TOOL_RESULT_PLACEHOLDER) &&
        !JSON.stringify(paired).includes(ENDED_RUN_TOOL_RESULT),
      JSON.stringify(pairedStats),
    )

    _resetTranscriptReaderForTesting()
    const loaded = await loadTranscriptFile(file)
    const screen = buildScreenConversation(loaded.messages)
    const screenIds = screen.map(row => row.uuid)
    check(
      'screen conversation holds both results once each',
      screenIds.filter(id => id === aRes.uuid).length === 1 && screenIds.filter(id => id === bRes.uuid).length === 1,
      JSON.stringify({ aCount: screenIds.filter(id => id === aRes.uuid).length, bCount: screenIds.filter(id => id === bRes.uuid).length }),
    )
  }

  section('§2 quiet attachment row on side branch restores result; spine result below quiet row is not duplicated')
  {
    const sid = startFreshSession()
    const u1 = atNextTick(createUserMessage({ content: 'run two tools with attachments' }))
    const msgId = 'msg_parallel_quiet_att'
    const callA = 'toolu_att_a'
    const callB = 'toolu_att_b'
    const aCall = toolUseRow(msgId, callA, 'Read', { file_path: '/a' })
    const bCall = toolUseRow(msgId, callB, 'Read', { file_path: '/b' })
    const attSide = atNextTick(
      createAttachmentMessage({
        type: 'dead_thinking',
        dead: [{ messageId: msgId, blockIndex: 0 }],
      }),
    )
    const bRes = toolResultRow(callB, bCall.uuid, 'contents of /b')
    const aRes = toolResultRow(callA, aCall.uuid, 'contents of /a')
    const reply = atNextTick(createAssistantMessage({ content: 'read both files.' }))
    reply.message.stop_reason = 'end_turn'

    await recordTranscript([u1, aCall, bCall])
    await recordTranscript([attSide])
    await recordTranscript([bRes])
    await recordTranscript([aRes])
    await recordTranscript([reply])
    await flushSessionStorage()

    const file = getTranscriptPath()
    const parents = readParents(file)
    check(
      'writer linked bCall -> attSide -> bRes and aCall -> aRes -> reply',
      parents.get(attSide.uuid) === bCall.uuid &&
        parents.get(bRes.uuid) === attSide.uuid &&
        parents.get(aRes.uuid) === aCall.uuid &&
        parents.get(reply.uuid) === aRes.uuid,
      JSON.stringify({ attSide: parents.get(attSide.uuid), bRes: parents.get(bRes.uuid), aRes: parents.get(aRes.uuid) }),
    )

    _resetTranscriptReaderForTesting()
    const resumed = await loadConversationForResume(sid, file)
    const rows = resumed?.messages ?? []
    const { calls, results } = extractCallsAndResults(rows)
    const byId = new Map(results.map(r => [r.id, r]))
    check(
      'resumed conversation restores bRes under the attachment row with the final reply and no duplicate results',
      rows.some(row => row.uuid === reply.uuid) &&
        calls.includes(callA) &&
        calls.includes(callB) &&
        results.length === 2 &&
        byId.get(callA)?.content === 'contents of /a' &&
        byId.get(callB)?.content === 'contents of /b',
      JSON.stringify({ hasReply: rows.some(row => row.uuid === reply.uuid), calls, results }),
    )

    const sidSpine = startFreshSession()
    const su1 = atNextTick(createUserMessage({ content: 'single call with spine quiet row' }))
    const sa1 = toolUseRow('msg_spine_quiet', 'toolu_spine_1', 'Read', { file_path: '/s' })
    const spineQuiet = atNextTick(createSystemMessage('quiet note on spine', 'info'))
    const sr1 = toolResultRow('toolu_spine_1', sa1.uuid, 'spine file')
    const sreply = atNextTick(createAssistantMessage({ content: 'done.' }))
    sreply.message.stop_reason = 'end_turn'
    await recordTranscript([su1, sa1])
    await recordTranscript([spineQuiet])
    await recordTranscript([sr1])
    await recordTranscript([sreply])
    await flushSessionStorage()

    _resetTranscriptReaderForTesting()
    const spineResumed = await loadConversationForResume(sidSpine, getTranscriptPath())
    const spineRows = spineResumed?.messages ?? []
    check(
      'a tool_result already on the spine below a quiet row appears exactly once',
      spineRows.filter(row => row.uuid === sr1.uuid).length === 1,
      `count=${spineRows.filter(row => row.uuid === sr1.uuid).length}`,
    )
  }

  section('§3 decorateOf does not walk across a fold boundary')
  {
    const sid = randomUUID()
    const u1 = atNextTick(createUserMessage({ content: 'ask' }))
    const a1 = toolUseRow('msg_boundary_stop', 'toolu_keep', 'Read', { file_path: '/k' })
    const r1 = toolResultRow('toolu_keep', a1.uuid, 'kept')
    const boundary = atNextTick(createFoldBoundaryMessage('auto', 1000, a1.uuid))
    const postResult = toolResultRow('toolu_post_fold', a1.uuid, 'behind fold boundary')
    const reply = atNextTick(createAssistantMessage({ content: 'done' }))
    reply.message.stop_reason = 'end_turn'

    const stampRow = (row: Message, parentUuid: UUID | null): TranscriptMessage => ({
      ...row,
      parentUuid,
      isSidechain: false,
      cwd: workdir,
      sessionId: sid,
      version: '1.0.0',
    }) as TranscriptMessage

    const entries: Array<[UUID, TranscriptMessage]> = [
      [u1.uuid, stampRow(u1, null)],
      [a1.uuid, stampRow(a1, u1.uuid)],
      [boundary.uuid, stampRow(boundary, a1.uuid)],
      [postResult.uuid, stampRow(postResult, boundary.uuid)],
      [r1.uuid, stampRow(r1, a1.uuid)],
      [reply.uuid, stampRow(reply, r1.uuid)],
    ]
    const map = createTranscriptRows(entries, entries.map(([id]) => id))
    const chain = buildConversationChain(map, map.get(reply.uuid)!)
    check(
      'a tool_result parented under a compact_boundary is not pulled into the pre-boundary call group',
      chain.some(row => row.uuid === r1.uuid) && !chain.some(row => row.uuid === postResult.uuid),
      JSON.stringify(chain.map(row => row.uuid)),
    )
  }

  section('§4 timestamp ties preserve position order and quiet-row descent avoids per-node sorting')
  {
    const sid = randomUUID()
    const stampRow = (row: Message, parentUuid: UUID | null): TranscriptMessage => ({
      ...row,
      parentUuid,
      isSidechain: false,
      cwd: workdir,
      sessionId: sid,
      version: '1.0.0',
    }) as TranscriptMessage

    const u1 = atNextTick(createUserMessage({ content: 'three parallel calls' }))
    const msgId = 'msg_tie_pos'
    const a1 = toolUseRow(msgId, 'toolu_t1', 'Read', { file_path: '/1' })
    const a2 = toolUseRow(msgId, 'toolu_t2', 'Read', { file_path: '/2' })
    const a3 = toolUseRow(msgId, 'toolu_t3', 'Read', { file_path: '/3' })
    const q2 = atNextTick(createSystemMessage('note 2', 'info'))
    const q3 = atNextTick(createSystemMessage('note 3', 'info'))
    const tiedStamp = nextStamp()
    const r2 = toolResultRow('toolu_t2', a2.uuid, 'res 2')
    const r3 = toolResultRow('toolu_t3', a3.uuid, 'res 3')
    r2.timestamp = tiedStamp
    r3.timestamp = tiedStamp
    const r1 = toolResultRow('toolu_t1', a1.uuid, 'res 1')
    const reply = atNextTick(createAssistantMessage({ content: 'all three.' }))
    reply.message.stop_reason = 'end_turn'

    const logicalOrder: UUID[] = [u1.uuid, a1.uuid, a2.uuid, a3.uuid, q2.uuid, q3.uuid, r2.uuid, r3.uuid, r1.uuid, reply.uuid]
    const reverseEntries: Array<[UUID, TranscriptMessage]> = [
      [u1.uuid, stampRow(u1, null)],
      [a1.uuid, stampRow(a1, u1.uuid)],
      [a3.uuid, stampRow(a3, a2.uuid)],
      [a2.uuid, stampRow(a2, a1.uuid)],
      [q3.uuid, stampRow(q3, a3.uuid)],
      [q2.uuid, stampRow(q2, a2.uuid)],
      [r3.uuid, stampRow(r3, q3.uuid)],
      [r2.uuid, stampRow(r2, q2.uuid)],
      [r1.uuid, stampRow(r1, a1.uuid)],
      [reply.uuid, stampRow(reply, r1.uuid)],
    ]
    const tieMap = createTranscriptRows(reverseEntries, logicalOrder)
    const tieChain = buildConversationChain(tieMap, tieMap.get(reply.uuid)!)
    const pos2 = tieChain.findIndex(row => row.uuid === r2.uuid)
    const pos3 = tieChain.findIndex(row => row.uuid === r3.uuid)
    check(
      'results with identical timestamps keep their positionOf order even when child set insertion order differs',
      pos2 >= 0 && pos3 >= 0 && pos2 < pos3,
      `pos2=${pos2} pos3=${pos3}`,
    )

    const N = 500
    for (const shape of ['chain', 'fanout'] as const) {
      const pu1 = atNextTick(createUserMessage({ content: `quiet ${shape}` }))
      const pMsgId = `msg_work_${shape}`
      const pa1 = toolUseRow(pMsgId, `toolu_${shape}_1`, 'Crewmate', { description: 'a' })
      const pa2 = toolUseRow(pMsgId, `toolu_${shape}_2`, 'Crewmate', { description: 'b' })
      const rows: Array<[UUID, TranscriptMessage]> = [
        [pu1.uuid, stampRow(pu1, null)],
        [pa1.uuid, stampRow(pa1, pu1.uuid)],
        [pa2.uuid, stampRow(pa2, pa1.uuid)],
      ]
      let parent = pa2.uuid
      for (let i = 0; i < N; i++) {
        const q = atNextTick(
          createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: pMsgId, blockIndex: i }] }),
        )
        rows.push([q.uuid, stampRow(q, shape === 'chain' ? parent : pa2.uuid)])
        parent = q.uuid
      }
      const pr2 = toolResultRow(`toolu_${shape}_2`, pa2.uuid, 'res b')
      const pr1 = toolResultRow(`toolu_${shape}_1`, pa1.uuid, 'res a')
      const preply = atNextTick(createAssistantMessage({ content: 'done' }))
      preply.message.stop_reason = 'end_turn'
      rows.push(
        [pr2.uuid, stampRow(pr2, parent)],
        [pr1.uuid, stampRow(pr1, pa1.uuid)],
        [preply.uuid, stampRow(preply, pr1.uuid)],
      )
      const map = createTranscriptRows(rows, rows.map(([id]) => id))
      const graph = transcriptRows(map)
      let orderedCalls = 0
      const origOrdered = graph.ordered.bind(graph)
      graph.ordered = (ids: Iterable<UUID>) => {
        orderedCalls++
        return origOrdered(ids)
      }
      const out = graph.chain(map.get(preply.uuid)!)
      graph.ordered = origOrdered
      check(
        `${shape} of ${N} quiet rows restores the result without per-node ordered() calls in decorateOf`,
        out.some(row => row.uuid === pr2.uuid) && orderedCalls <= 3 * N + 30,
        `hasResult=${out.some(row => row.uuid === pr2.uuid)} orderedCalls=${orderedCalls} (limit ${3 * N + 30})`,
      )
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
}

console.log(
  failures === 0
    ? `\n ✅ PARALLEL RESULT UNDER QUIET ROW RESUME PROVEN (${checks} checks)`
    : `\n ❌ ${failures} OF ${checks} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
