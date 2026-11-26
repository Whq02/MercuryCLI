#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID, type UUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const { loadTranscriptFile, pruneRecordBranchesBeforeParse } = await import('../../src/sessions/transcripts/loading.ts')
const { SKIP_BEFORE_FOLD_BOUNDARY_THRESHOLD } = await import('../../src/sessions/transcripts/sessionStoragePortable.ts')
const { buildConversationChain, buildScreenConversation } = await import('../../src/sessions/transcripts/chain.ts')
const { SNAPSHOT_SCHEMA, snapshotPathFor, tryLoadResumeSnapshot } = await import(
  '../../src/sessions/transcripts/resumeSnapshot.ts'
)
const { encodeTranscriptLine } = await import('../../src/sessions/transcripts/vnext.ts')
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
        `${shape} of ${N} quiet rows restores the result without per-node ordered() calls`,
        out.some(row => row.uuid === pr2.uuid) && orderedCalls <= 10,
        `hasResult=${out.some(row => row.uuid === pr2.uuid)} orderedCalls=${orderedCalls} (limit 10)`,
      )
    }
  }

  section('§5 deep quiet system chain survives load and iterative notesUnder matches recursive order on 300 random trees')
  {
    const writeSystemChain = async (count: number): Promise<{ file: string; replyId: UUID; noteIds: UUID[] }> => {
      startFreshSession()
      const u1 = atNextTick(createUserMessage({ content: `chain ${count}` }))
      const a1 = atNextTick(createAssistantMessage({ content: `reply ${count}` }))
      a1.message.stop_reason = 'end_turn'
      const notes: Message[] = []
      for (let i = 0; i < count; i++) notes.push(atNextTick(createSystemMessage(`board note ${i}`, 'info')))
      await recordTranscript([u1, a1, ...notes])
      await flushSessionStorage()
      return { file: getTranscriptPath(), replyId: a1.uuid, noteIds: notes.map(n => n.uuid) }
    }

    const shallow = await writeSystemChain(5)
    _resetTranscriptReaderForTesting()
    const shallowLoaded = await loadTranscriptFile(shallow.file, { keepAllLeaves: true })
    const shallowChain = buildConversationChain(shallowLoaded.messages, shallowLoaded.messages.get(shallow.replyId)!)
    const shallowSys = shallowChain.filter(row => row.type === 'system').map(row => row.uuid)
    check(
      'shallow chain of 5 system rows loads all 5 in creation order',
      shallowSys.length === 5 && shallowSys.every((id, i) => id === shallow.noteIds[i]),
      `len=${shallowSys.length}`,
    )

    const DEEP = 20_000
    const deep = await writeSystemChain(DEEP)
    _resetTranscriptReaderForTesting()
    const deepLoaded = await loadTranscriptFile(deep.file, { keepAllLeaves: true })
    let deepThrew: string | null = null
    let deepSys: UUID[] = []
    try {
      const deepChain = buildConversationChain(deepLoaded.messages, deepLoaded.messages.get(deep.replyId)!)
      deepSys = deepChain.filter(row => row.type === 'system').map(row => row.uuid)
    } catch (error) {
      deepThrew = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
    check(
      `deep chain of ${DEEP} quiet system rows loads without stack overflow in exact creation order`,
      deepThrew === null && deepSys.length === DEEP && deepSys.every((id, i) => id === deep.noteIds[i]),
      deepThrew ?? `len=${deepSys.length}`,
    )

    type Graph = ReturnType<typeof transcriptRows>
    const refOrdered = (graph: Graph, ids: Iterable<UUID>): TranscriptMessage[] =>
      [...ids].filter(id => graph.has(id)).sort((a, b) => graph.positionOf(a) - graph.positionOf(b)).map(id => graph.get(id)!)
    const refHookRows = (graph: Graph, id: UUID, seen: Set<UUID>): TranscriptMessage[] => {
      const hooks: TranscriptMessage[] = []
      const pending = [...refOrdered(graph, graph.children.get(id) ?? [])]
      while (pending.length > 0) {
        const row = pending.shift()!
        if (row.type !== 'attachment' || seen.has(row.uuid)) continue
        const attachment = (row as { attachment?: unknown }).attachment as { type?: unknown; callId?: unknown } | undefined
        if (typeof attachment === 'object' && attachment !== null && attachment.type === 'hook' && typeof attachment.callId === 'string') {
          seen.add(row.uuid)
          hooks.push(row)
        }
        pending.push(...refOrdered(graph, graph.children.get(row.uuid) ?? []))
      }
      return hooks
    }
    const refSysNotes = (graph: Graph, id: UUID, seen: Set<UUID>): TranscriptMessage[] => {
      const out: TranscriptMessage[] = []
      for (const note of refOrdered(graph, graph.children.get(id) ?? [])) {
        if (note.type !== 'system' || seen.has(note.uuid) || note.subtype === 'compact_boundary' || note.subtype === 'microcompact_boundary') continue
        seen.add(note.uuid)
        out.push(note, ...refNotesUnder(graph, note.uuid, seen))
      }
      return out
    }
    const refNotesUnder = (graph: Graph, id: UUID, seen: Set<UUID>): TranscriptMessage[] => {
      const out = refSysNotes(graph, id, seen)
      out.push(...refHookRows(graph, id, seen))
      const pending = [...refOrdered(graph, graph.children.get(id) ?? [])]
      while (pending.length > 0) {
        const row = pending.shift()!
        if (row.type !== 'attachment') continue
        out.push(...refSysNotes(graph, row.uuid, seen))
        pending.push(...refOrdered(graph, graph.children.get(row.uuid) ?? []))
      }
      return out
    }

    let seed = 0x51a7c0de
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 0x100000000
    }
    const sid = randomUUID()
    let mismatches = 0
    let firstMismatch = ''
    const TREES = 300
    for (let t = 0; t < TREES; t++) {
      const size = 6 + Math.floor(rand() * 35)
      const root = atNextTick(createAssistantMessage({ content: `root ${t}` }))
      const nodes: Array<{ id: UUID; row: TranscriptMessage }> = [
        {
          id: root.uuid,
          row: { ...root, parentUuid: null, isSidechain: false, cwd: workdir, sessionId: sid, version: '1.0.0' } as TranscriptMessage,
        },
      ]
      for (let i = 1; i < size; i++) {
        const parent = nodes[Math.floor(rand() * nodes.length)]!.id
        const pick = Math.floor(rand() * 8)
        let raw: Record<string, unknown>
        const id = randomUUID()
        const ts = nextStamp()
        if (pick < 2) {
          raw = { uuid: id, parentUuid: parent, isSidechain: false, cwd: workdir, sessionId: sid, version: '1.0.0', timestamp: ts, type: 'system', subtype: 'informational', content: `s${i}`, level: 'info' }
        } else if (pick === 2) {
          raw = { uuid: id, parentUuid: parent, isSidechain: false, cwd: workdir, sessionId: sid, version: '1.0.0', timestamp: ts, type: 'system', subtype: 'compact_boundary', content: 'fold', level: 'info', compactMetadata: { trigger: 'auto', preTokens: 10 } }
        } else if (pick === 3) {
          raw = { uuid: id, parentUuid: parent, isSidechain: false, cwd: workdir, sessionId: sid, version: '1.0.0', timestamp: ts, type: 'system', subtype: 'microcompact_boundary', content: 'micro', level: 'info' }
        } else if (pick === 4) {
          raw = { uuid: id, parentUuid: parent, isSidechain: false, cwd: workdir, sessionId: sid, version: '1.0.0', timestamp: ts, type: 'attachment', attachment: { type: 'dead_thinking', dead: [] } }
        } else if (pick === 5) {
          raw = { uuid: id, parentUuid: parent, isSidechain: false, cwd: workdir, sessionId: sid, version: '1.0.0', timestamp: ts, type: 'attachment', attachment: { type: 'hook', callId: `call_${i}`, event: 'post', outcome: 'context', words: 'ok' } }
        } else if (pick === 6) {
          raw = { uuid: id, parentUuid: parent, isSidechain: false, cwd: workdir, sessionId: sid, version: '1.0.0', timestamp: ts, type: 'attachment', attachment: { type: 'hook', event: 'post', outcome: 'context' } }
        } else {
          raw = { uuid: id, parentUuid: parent, isSidechain: false, cwd: workdir, sessionId: sid, version: '1.0.0', timestamp: ts, type: 'user', message: { role: 'user', content: `u${i}` } }
        }
        nodes.push({ id, row: raw as TranscriptMessage })
      }
      const order = nodes.map(n => n.id)
      const shuffled = [...nodes]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        const tmp = shuffled[i]!
        shuffled[i] = shuffled[j]!
        shuffled[j] = tmp
      }
      const map = createTranscriptRows(shuffled.map(n => [n.id, n.row]), order)
      const graph = transcriptRows(map)
      const preSeen = new Set<UUID>([root.uuid])
      for (let i = 1; i < nodes.length; i++) if (rand() < 0.2) preSeen.add(nodes[i]!.id)

      const seenRef = new Set(preSeen)
      const expected = refNotesUnder(graph, root.uuid, seenRef).map(r => r.uuid)
      const seenGot = new Set(preSeen)
      const actual = graph.notesUnder(root.uuid, seenGot).map(r => r.uuid)
      const sameOut = expected.length === actual.length && expected.every((id, i) => id === actual[i])
      const sameSeen = seenRef.size === seenGot.size && [...seenRef].every(id => seenGot.has(id))
      if (!sameOut || !sameSeen) {
        mismatches++
        if (!firstMismatch) firstMismatch = `tree ${t}: out=${sameOut} seen=${sameSeen} exp=${expected.length} got=${actual.length}`
      }
    }
    check(
      `notesUnder matches the recursive reference on all ${TREES} random mixed trees (order and seen set)`,
      mismatches === 0,
      firstMismatch || `${mismatches}/${TREES} mismatched`,
    )
  }

  section('§6 parity across the 5 MB pre-parse prune gate for system and attachment quiet rows')
  {
    const padOver5MB = (sourceFile: string, outFile: string, askMarker: string): { size: number; deadId: UUID } => {
      const lines = readFileSync(sourceFile, 'utf8').split('\n').filter(Boolean)
      const at = lines.findIndex(line => line.includes(askMarker))
      if (at < 0) throw new Error(`missing prompt marker ${askMarker}`)
      const prompt = JSON.parse(lines[at]!) as {
        recordId?: string
        annotations?: Record<string, unknown>
        payload?: Record<string, unknown>
      }
      const deadId = randomUUID()
      const deadLine = JSON.stringify({
        ...prompt,
        recordId: deadId,
        annotations: { ...prompt.annotations, uuid: deadId },
        payload: { ...prompt.payload, content: 'abandoned paste outside the live branch. '.repeat(160_000) },
      })
      const padded = [...lines.slice(0, at + 1), deadLine, ...lines.slice(at + 1)].join('\n') + '\n'
      writeFileSync(outFile, padded)
      return { size: Buffer.byteLength(padded), deadId }
    }

    const runParity = async (label: string, kind: 'system' | 'attachment'): Promise<void> => {
      const sid = startFreshSession()
      const askText = `parity-${kind}: launch two calls`
      const u1 = atNextTick(createUserMessage({ content: askText }))
      const msgId = `msg_parity_${kind}`
      const callA = `toolu_parity_${kind}_a`
      const callB = `toolu_parity_${kind}_b`
      const aCall = toolUseRow(msgId, callA, 'Crewmate', { description: 'seat-a', prompt: 'a' })
      const bCall = toolUseRow(msgId, callB, 'Crewmate', { description: 'seat-b', prompt: 'b' })
      const q1 =
        kind === 'system'
          ? atNextTick(createSystemMessage('Swarm launched', 'info'))
          : atNextTick(createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: msgId, blockIndex: 0 }] }))
      const q2 =
        kind === 'system'
          ? atNextTick(createSystemMessage('seat-b joined', 'info'))
          : atNextTick(createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: msgId, blockIndex: 1 }] }))
      const bRes = toolResultRow(callB, bCall.uuid, `report-${kind}-b`)
      const aRes = toolResultRow(callA, aCall.uuid, `report-${kind}-a`)
      const reply = atNextTick(createAssistantMessage({ content: `both ${kind} landed.` }))
      reply.message.stop_reason = 'end_turn'

      await recordTranscript([u1, aCall, bCall])
      await recordTranscript([q1])
      await recordTranscript([q2])
      await recordTranscript([bRes])
      await recordTranscript([aRes])
      await recordTranscript([reply])
      await flushSessionStorage()

      const smallFile = getTranscriptPath()
      const bigFile = join(home, `big-parity-${kind}.jsonl`)
      const { size, deadId } = padOver5MB(smallFile, bigFile, askText)
      const rawBig = readFileSync(bigFile)
      const prunedBuf = pruneRecordBranchesBeforeParse(rawBig)
      check(
        `${label}: padded transcript exceeds 5 MB and actually prunes the dead branch`,
        size > SKIP_BEFORE_FOLD_BOUNDARY_THRESHOLD && prunedBuf.length < rawBig.length && !prunedBuf.toString('utf8').includes(deadId),
        `size=${size} pruned=${prunedBuf.length}`,
      )

      const prevSnap = process.env.MERCURY_RESUME_SNAPSHOT
      process.env.MERCURY_RESUME_SNAPSHOT = '0'
      try {
        _resetTranscriptReaderForTesting()
        const smallResumed = await loadConversationForResume(sid, smallFile)
        _resetTranscriptReaderForTesting()
        const bigResumed = await loadConversationForResume(sid, bigFile)
        const smallIds = (smallResumed?.messages ?? []).map(row => row.uuid)
        const bigIds = (bigResumed?.messages ?? []).map(row => row.uuid)
        check(
          `${label}: <5 MB and >5 MB resumed conversations match uuid-for-uuid with both tool results`,
          smallIds.length > 0 &&
            JSON.stringify(smallIds) === JSON.stringify(bigIds) &&
            bigIds.includes(aRes.uuid) &&
            bigIds.includes(bRes.uuid) &&
            !bigIds.includes(deadId),
          `small=${smallIds.length} big=${bigIds.length} hasB=${bigIds.includes(bRes.uuid)}`,
        )

        _resetTranscriptReaderForTesting()
        const smallScreen = buildScreenConversation((await loadTranscriptFile(smallFile)).messages).map(row => row.uuid)
        _resetTranscriptReaderForTesting()
        const bigScreen = buildScreenConversation((await loadTranscriptFile(bigFile)).messages).map(row => row.uuid)
        check(
          `${label}: <5 MB and >5 MB screen conversations match uuid-for-uuid`,
          JSON.stringify(smallScreen) === JSON.stringify(bigScreen) && bigScreen.includes(bRes.uuid),
          `small=${smallScreen.length} big=${bigScreen.length}`,
        )
      } finally {
        if (prevSnap === undefined) delete process.env.MERCURY_RESUME_SNAPSHOT
        else process.env.MERCURY_RESUME_SNAPSHOT = prevSnap
      }
    }

    await runParity('system quiet chain', 'system')
    await runParity('attachment quiet chain', 'attachment')

    const sidGate = startFreshSession()
    const uGate = atNextTick(createUserMessage({ content: 'liveBytes half-dead gate check' }))
    const aGate1 = toolUseRow('msg_live_gate', 'toolu_lg_1', 'Crewmate', { description: 'a' })
    const aGate2 = toolUseRow('msg_live_gate', 'toolu_lg_2', 'Crewmate', { description: 'b' })
    const qGate1 = atNextTick(createSystemMessage('note 1', 'info'))
    const qGate2 = atNextTick(createSystemMessage('note 2', 'info'))
    const fatLiveBody = 'kept result payload under quiet rows. '.repeat(120_000)
    const rGate2 = toolResultRow('toolu_lg_2', aGate2.uuid, fatLiveBody)
    const rGate1 = toolResultRow('toolu_lg_1', aGate1.uuid, 'small a')
    const repGate = atNextTick(createAssistantMessage({ content: 'done gate.' }))
    repGate.message.stop_reason = 'end_turn'
    await recordTranscript([uGate, aGate1, aGate2])
    await recordTranscript([qGate1])
    await recordTranscript([qGate2])
    await recordTranscript([rGate2])
    await recordTranscript([rGate1])
    await recordTranscript([repGate])
    await flushSessionStorage()
    const gateFile = getTranscriptPath()
    const gateLines = readFileSync(gateFile, 'utf8').split('\n').filter(Boolean)
    const gateAt = gateLines.findIndex(line => line.includes('liveBytes half-dead gate check'))
    const gatePrompt = JSON.parse(gateLines[gateAt]!) as {
      recordId?: string
      annotations?: Record<string, unknown>
      payload?: Record<string, unknown>
    }
    const deadGateId = randomUUID()
    const smallerDead = JSON.stringify({
      ...gatePrompt,
      recordId: deadGateId,
      annotations: { ...gatePrompt.annotations, uuid: deadGateId },
      payload: { ...gatePrompt.payload, content: 'smaller dead paste. '.repeat(100_000) },
    })
    const gateBuf = Buffer.from([...gateLines.slice(0, gateAt + 1), smallerDead, ...gateLines.slice(gateAt + 1)].join('\n') + '\n')
    const gatePruned = pruneRecordBranchesBeforeParse(gateBuf)
    check(
      'half-dead gate counts newly kept tool_result bytes in liveBytes (returns unchanged when dead < 50%)',
      gateBuf.length > SKIP_BEFORE_FOLD_BOUNDARY_THRESHOLD && gatePruned === gateBuf && sidGate.length > 0,
      `total=${gateBuf.length} pruned=${gatePruned.length}`,
    )
  }

  section('§7 stale 1.1.0 resume snapshot (schemaVersion 6) is discarded so the rebuilt fold keeps the quiet-row tool result')
  {
    const sidSnap = startFreshSession()
    const askSnap = 'stale-snapshot: launch two calls'
    const u1 = atNextTick(createUserMessage({ content: askSnap }))
    const msgId = 'msg_stale_snap'
    const callA = 'toolu_snap_a'
    const callB = 'toolu_snap_b'
    const aCall = toolUseRow(msgId, callA, 'Crewmate', { description: 'seat-a', prompt: 'a' })
    const bCall = toolUseRow(msgId, callB, 'Crewmate', { description: 'seat-b', prompt: 'b' })
    const q1 = atNextTick(createSystemMessage('Swarm launched', 'info'))
    const q2 = atNextTick(createSystemMessage('seat-b joined', 'info'))
    const bRes = toolResultRow(callB, bCall.uuid, 'report from seat-b')
    const aRes = toolResultRow(callA, aCall.uuid, 'report from seat-a')
    const reply = atNextTick(createAssistantMessage({ content: 'both landed.' }))
    reply.message.stop_reason = 'end_turn'

    await recordTranscript([u1, aCall, bCall])
    await recordTranscript([q1])
    await recordTranscript([q2])
    await recordTranscript([bRes])
    await recordTranscript([aRes])
    await recordTranscript([reply])
    await flushSessionStorage()

    const srcLines = readFileSync(getTranscriptPath(), 'utf8').split('\n').filter(Boolean)
    const promptAt = srcLines.findIndex(line => line.includes(askSnap))
    const promptObj = JSON.parse(srcLines[promptAt]!) as {
      recordId?: string
      annotations?: Record<string, unknown>
      payload?: Record<string, unknown>
    }
    const deadId = randomUUID()
    const deadLine = JSON.stringify({
      ...promptObj,
      recordId: deadId,
      annotations: { ...promptObj.annotations, uuid: deadId },
      payload: { ...promptObj.payload, content: 'abandoned paste for stale snapshot. '.repeat(160_000) },
    })
    const bigSnapFile = join(home, `${sidSnap}-big-stale.jsonl`)
    const paddedText = [...srcLines.slice(0, promptAt + 1), deadLine, ...srcLines.slice(promptAt + 1)].join('\n') + '\n'
    writeFileSync(bigSnapFile, paddedText)

    const prevSnap = process.env.MERCURY_RESUME_SNAPSHOT
    delete process.env.MERCURY_RESUME_SNAPSHOT
    try {
      _resetTranscriptReaderForTesting()
      await loadTranscriptFile(bigSnapFile)
      const sidecar = snapshotPathFor(bigSnapFile)
      const snapObj = JSON.parse(readFileSync(sidecar, 'utf8')) as {
        schemaVersion: number
        byteCursor: number
        historyPart?: string
        prefixDigest: string
        fold: { messages: { '«map»': Array<[string, unknown]> } }
        order: string[]
      }
      const droppedBy110 = new Set<string>([q2.uuid, bRes.uuid])
      const stale110Snapshot = {
        ...snapObj,
        schemaVersion: 6,
        fold: {
          ...snapObj.fold,
          messages: {
            '«map»': snapObj.fold.messages['«map»'].filter(([id]) => !droppedBy110.has(id)),
          },
        },
        order: snapObj.order.filter(id => !droppedBy110.has(id)),
      }
      writeFileSync(sidecar, JSON.stringify(stale110Snapshot))

      check(
        'SNAPSHOT_SCHEMA moved past 1.1.0 schema 6 and rejects the stale 1.1.0 snapshot',
        SNAPSHOT_SCHEMA > 6 && (await tryLoadResumeSnapshot(bigSnapFile, true)) === null,
        `SNAPSHOT_SCHEMA=${SNAPSHOT_SCHEMA}`,
      )

      _resetTranscriptReaderForTesting()
      const rebuiltResume = await loadConversationForResume(sidSnap, bigSnapFile)
      const rebuiltStats = extractCallsAndResults(rebuiltResume?.messages ?? [])
      const rebuiltById = new Map(rebuiltStats.results.map(r => [r.id, r]))
      check(
        'resuming with a stale 1.1.0 snapshot on disk rebuilds from the file and restores both calls and reports',
        rebuiltStats.calls.includes(callA) &&
          rebuiltStats.calls.includes(callB) &&
          rebuiltById.get(callB)?.content === 'report from seat-b',
        JSON.stringify(rebuiltStats),
      )

      const uNext = atNextTick(createUserMessage({ content: 'one more turn after upgrade' }))
      const aNext = atNextTick(createAssistantMessage({ content: 'next reply.' }))
      aNext.message.stop_reason = 'end_turn'
      const appendedLines = [
        encodeTranscriptLine(bigSnapFile, { ...uNext, parentUuid: reply.uuid, isSidechain: false, cwd: workdir, sessionId: sidSnap, version: '1.1.1' }).line,
        encodeTranscriptLine(bigSnapFile, { ...aNext, parentUuid: uNext.uuid, isSidechain: false, cwd: workdir, sessionId: sidSnap, version: '1.1.1' }).line,
      ].join('')
      writeFileSync(bigSnapFile, paddedText + appendedLines)

      _resetTranscriptReaderForTesting()
      const afterTurnResume = await loadConversationForResume(sidSnap, bigSnapFile)
      const afterTurnStats = extractCallsAndResults(afterTurnResume?.messages ?? [])
      const afterTurnById = new Map(afterTurnStats.results.map(r => [r.id, r]))
      const renewed = JSON.parse(readFileSync(sidecar, 'utf8')) as { schemaVersion?: number }
      check(
        'after one more turn the session still holds both reports and a renewed snapshot stands under the new schema',
        afterTurnStats.calls.includes(callB) &&
          afterTurnById.get(callB)?.content === 'report from seat-b' &&
          (afterTurnResume?.messages ?? []).some(m => m.uuid === aNext.uuid) &&
          renewed.schemaVersion === SNAPSHOT_SCHEMA,
        JSON.stringify({ schema: renewed.schemaVersion, results: afterTurnStats.results }),
      )
    } finally {
      if (prevSnap === undefined) delete process.env.MERCURY_RESUME_SNAPSHOT
      else process.env.MERCURY_RESUME_SNAPSHOT = prevSnap
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
