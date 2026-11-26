#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID, type UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import type { LeafScene } from '../lib/resumeLeafScenes.ts'
import type { AssistantMessage, Message, UserMessage } from '../../src/engine/message-shapes/message.ts'
import type { TranscriptMessage } from '../../src/sessions/transcripts/transcriptEntries.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'conversation-end-')))
const home = join(scratch, 'home')
const project = join(scratch, 'project')
mkdirSync(home)
mkdirSync(project)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.NODE_ENV
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
process.chdir(project)

const state = await import('../../src/boot/process-state/processState.ts')
state.setOriginalCwd(project)
state.setCwdState(project)
state.setProjectRoot(project)
const { LEAF_SCENES, LEAF_UNFINISHED_SCENE, writeLeafScene } = await import('../lib/resumeLeafScenes.ts')
const { electConversationEnd } = await import('../../src/sessions/transcripts/conversationEnd.ts')
const { buildConversationChain } = await import('../../src/sessions/transcripts/chain.ts')
const { loadTranscriptFile } = await import('../../src/sessions/transcripts/loading.ts')
const { getCrewmateTranscriptPath, getProjectDir } = await import('../../src/sessions/transcripts/paths.ts')
const { createTranscriptRows, transcriptRowOrder } = await import('../../src/sessions/transcripts/rowGraph.ts')
const { adoptResumedSessionFile, flushSessionStorage, getTranscriptPath, recordSidechainTranscript, recordTranscript, resetProjectForTesting } = await import('../../src/sessions/transcripts/sessionStorage.ts')
const { _resetTranscriptReaderForTesting } = await import('../../src/sessions/transcripts/transcriptReader.ts')
const { appendEntryToFile } = await import('../../src/sessions/transcripts/writer.ts')
const { asAgentId, asSessionId } = await import('../../src/sessions/transcripts/ids.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createFoldBoundaryMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { createOperatorRewindRecordMessage } = await import('../../src/engine/compaction/checkpointRewind.ts')

const HINT =
  'choose in src/sessions/transcripts/conversationEnd.ts replays the writer over the rows after the newest fold (a late result keeps its own parent, what was written under it hangs where the writer stood) and elects the newest end among the turns that reach the fold; electConversationEnd projects that line through decorate in src/sessions/transcripts/rowGraph.ts'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail ? `${detail}; ` : ''}${HINT}`}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const j = (value: unknown): string => JSON.stringify(value)

type Graph = Map<UUID, TranscriptMessage>

async function freshSession(): Promise<UUID> {
  resetProjectForTesting()
  _resetTranscriptReaderForTesting()
  const sid = randomUUID()
  state.switchSession(asSessionId(sid))
  return sid
}

async function read(file: string): Promise<Graph> {
  _resetTranscriptReaderForTesting()
  return (await loadTranscriptFile(file, { keepAllLeaves: true, throwOnError: true })).messages
}

function namesOf(scene: LeafScene): Map<string, string> {
  return new Map<string, string>([
    [scene.prompt, 'prompt'],
    [scene.calls[0], 'call_a'],
    [scene.calls[1], 'call_b'],
    [scene.final, 'final'],
    ...scene.reports.map((id, index): [string, string] => [id, `report_${index}`]),
    ...(scene.boundary ? [[scene.boundary, 'boundary'] as [string, string]] : []),
    ...(scene.summary ? [[scene.summary, 'summary'] as [string, string]] : []),
    ...(scene.second ? [[scene.second.prompt, 'second_prompt'] as [string, string], [scene.second.end, 'second_end'] as [string, string]] : []),
  ])
}

function shapeOf(rows: readonly TranscriptMessage[], names: ReadonlyMap<string, string> = new Map()): string {
  return j(rows.map(row => names.get(row.uuid) ?? (row.type === 'system' ? `system:${row.subtype}` : row.type === 'attachment' ? `attachment:${row.attachment.type}` : textOf(row))))
}

function textOf(row: UserMessage | AssistantMessage): string {
  const content = row.message.content
  if (typeof content === 'string') return content
  return content.map(block => (block.type === 'text' ? block.text : block.type === 'tool_use' ? `call:${block.id}` : block.type === 'tool_result' ? `result:${block.tool_use_id}` : block.type)).join('+')
}

const ids = (rows: readonly TranscriptMessage[] | undefined): string[] => (rows ?? []).map(row => row.uuid)
const lastTurn = (rows: readonly TranscriptMessage[]): string | undefined => rows.findLast(row => row.type === 'user' || row.type === 'assistant')?.uuid

let clock = Date.now()
function at<T extends Message>(row: T, stamp = ++clock): T {
  row.timestamp = new Date(stamp).toISOString()
  return row
}
const said = (text: string, stamp?: number): UserMessage => at(createUserMessage({ content: text }), stamp)
function replied(text: string, stamp?: number): AssistantMessage {
  const row = at(createAssistantMessage({ content: text }), stamp)
  row.message.stop_reason = 'end_turn'
  return row
}
function called(id: string, group: string, stamp?: number): AssistantMessage {
  const row = at(createAssistantMessage({ content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'fixture' } }] }), stamp)
  row.message.id = group
  row.message.stop_reason = 'tool_use'
  return row
}
const reported = (id: string, issuer: AssistantMessage, stamp?: number): UserMessage =>
  at(createUserMessage({ sourceToolAssistantUUID: issuer.uuid, content: [{ type: 'tool_result', tool_use_id: id, content: `report of ${id}` }] }), stamp)
const summarised = (text: string): UserMessage => at(createUserMessage({ content: text, isCompactSummary: true }))
const noted = (): Message => at(createAttachmentMessage({ type: 'dead_thinking', dead: [{ messageId: 'msg_note', blockIndex: 0 }] }))

type Hand = { file: string; put: (row: Message, parent: Message | UUID | null, more?: Record<string, unknown>) => void }

function byHand(): Hand {
  const sid = randomUUID()
  const file = join(getProjectDir(project), `${sid}.jsonl`)
  return {
    file,
    put: (row, parent, more = {}) =>
      appendEntryToFile(file, { isSidechain: false, cwd: project, sessionId: sid, version: '1.0.0', ...row, parentUuid: parent === null || typeof parent === 'string' ? parent : parent.uuid, ...more }),
  }
}

function after(scene: LeafScene): Hand {
  return {
    file: scene.file,
    put: (row, parent, more = {}) =>
      appendEntryToFile(scene.file, { isSidechain: false, cwd: project, sessionId: scene.sid, version: '1.0.0', ...row, parentUuid: parent === null || typeof parent === 'string' ? parent : parent.uuid, ...more }),
  }
}

const RETAINS_ITS_CALLS: ReadonlySet<string> = new Set(['plain', 'tie', 'tie-behind', 'kept'])
const WRITES_UNDER_A_LATE_RESULT: ReadonlySet<string> = new Set(['onward', 'kept-late'])

try {
  for (const name of [...LEAF_SCENES, LEAF_UNFINISHED_SCENE] as const) {
    section(`§1 ${name}: written by the product's writer, read whole by its loader`)
    const scene = await writeLeafScene(name)
    const graph = await read(scene.file)
    const names = namesOf(scene)
    const parents = [...graph.values()].map(row => row.parentUuid)
    const elected = electConversationEnd(graph)
    const rows = elected?.rows ?? []
    const screen = elected?.screenRows ?? []
    const resumed = ids(rows)
    const shown = ids(screen)
    check(`${name}: the elected end is the row the conversation ends on`, elected?.primary.uuid === scene.end && lastTurn(rows) === scene.end, `primary ${names.get(elected?.primary.uuid ?? '') ?? elected?.primary.uuid} in ${shapeOf(rows, names)}`)
    check(`${name}: the resumed rows hold the last reply${scene.summary ? ' behind the active summary' : ''}`, resumed.includes(scene.final) && (scene.summary === undefined || (resumed.includes(scene.summary) && resumed.indexOf(scene.summary) < resumed.indexOf(scene.final))), shapeOf(rows, names))
    check(
      RETAINS_ITS_CALLS.has(name) ? `${name}: each result is resumed once, behind its call and before the reply` : `${name}: the result of a call that was folded away is not resumed`,
      RETAINS_ITS_CALLS.has(name)
        ? scene.reports.every(id => resumed.filter(seen => seen === id).length === 1 && resumed.indexOf(id) > resumed.indexOf(scene.calls[1]) && resumed.indexOf(id) < resumed.indexOf(scene.final))
        : scene.reports.every(id => !resumed.includes(id)),
      shapeOf(rows, names),
    )
    check(`${name}: the screen holds the reply${scene.summary ? ', the summary' : ''} and each result once`, shown.includes(scene.final) && (scene.summary === undefined || shown.includes(scene.summary)) && scene.reports.every(id => shown.filter(seen => seen === id).length === 1), shapeOf(screen, names))
    check(`${name}: no row twice, and the loaded rows are handed back as they were loaded`, new Set(resumed).size === resumed.length && new Set(shown).size === shown.length && [...rows, ...screen].every(row => graph.get(row.uuid) === row) && [...graph.values()].every((row, index) => row.parentUuid === parents[index]), `${shapeOf(rows, names)} · ${shapeOf(screen, names)}`)
    if (scene.second !== undefined) check(`${name}: the second turn follows the reply`, resumed.indexOf(scene.second.prompt) > resumed.indexOf(scene.final) && resumed.indexOf(scene.second.end) > resumed.indexOf(scene.second.prompt), shapeOf(rows, names))
    if (!WRITES_UNDER_A_LATE_RESULT.has(name)) check(`${name}: with nothing written under a late result the rows are the chain of the line's last row, as before`, j(resumed) === j(ids(buildConversationChain(graph, graph.get(scene.end)!))), shapeOf(rows, names))
    if (name === 'tie-behind') {
      const reversed = createTranscriptRows([...graph].reverse(), transcriptRowOrder(graph))
      check(`${name}: the order of the file decides, not the order the map hands rows out in`, j(ids(electConversationEnd(reversed)?.rows)) === j(resumed), shapeOf(electConversationEnd(reversed)?.rows ?? [], names))
    }

    if (name === 'plain') {
      section('§2 plain, with a trailing row, a rewind, a tie between two branches and another seat\'s row')
      const trailing = noted()
      await recordTranscript([trailing])
      await flushSessionStorage()
      const withNote = await read(scene.file)
      const noteEnd = electConversationEnd(withNote)
      check('a row that is neither prompt nor reply, written last, stays the last resumed row, and the reply stays the elected end', noteEnd?.primary.uuid === scene.final && noteEnd.rows.at(-1)?.uuid === trailing.uuid && j(ids(noteEnd.rows)) === j(ids(buildConversationChain(withNote, withNote.get(trailing.uuid)!))), shapeOf(noteEnd?.rows ?? [], names))

      const hand = after(scene)
      const again = said('continue from the first result')
      const answer = replied('reply on the rewound branch')
      hand.put(again, scene.reports[0]!)
      hand.put(answer, again)
      const rewound = electConversationEnd(await read(scene.file))
      check('a prompt written by hand under an earlier, timely result is a branch of its own: the newer reply wins and the abandoned reply is not grafted on', rewound?.primary.uuid === answer.uuid && ids(rewound.rows).includes(again.uuid) && !ids(rewound.rows).includes(scene.final), shapeOf(rewound?.rows ?? [], names))

      const tied = clock + 60_000
      const left = said('one branch', tied)
      const right = said('another branch', tied)
      const foreign = said('another seat', tied)
      hand.put(left, scene.prompt)
      hand.put(right, scene.prompt)
      hand.put(foreign, null, { isSidechain: true, agentId: 'peer' })
      const all = await read(scene.file)
      const shuffled = createTranscriptRows([...all].reverse(), transcriptRowOrder(all))
      const main = electConversationEnd(shuffled)
      const peer = electConversationEnd(shuffled, { kind: 'crewmate', agentId: 'peer' })
      check('two ends with one timestamp: the later in the file wins, whatever the map order, and never the other seat\'s row', main?.primary.uuid === right.uuid && !ids(main.rows).includes(foreign.uuid), shapeOf(main?.rows ?? [], names))
      check('a seat\'s election stays inside that seat, and a seat with no rows has no end', peer?.primary.uuid === foreign.uuid && j(ids(peer.rows)) === j([foreign.uuid]) && electConversationEnd(shuffled, { kind: 'crewmate', agentId: 'absent' }) === undefined, shapeOf(peer?.rows ?? []))
    }

    if (name === 'fold') {
      section('§3 fold, then a row that is no turn and a reply, both written under the late result')
      const queued = noted()
      const answer = replied('reply to what was queued')
      await recordTranscript([queued])
      await recordTranscript([answer])
      await flushSessionStorage()
      const grown = electConversationEnd(await read(scene.file))
      check('the row written between the late result and the reply stays on the line, in its place', grown?.primary.uuid === answer.uuid && j(ids(grown.rows)) === j([scene.boundary, scene.summary, scene.final, queued.uuid, answer.uuid]), shapeOf(grown?.rows ?? [], names))
      check('the screen shows the late result once, where it was written', j(ids(grown?.screenRows)) === j([scene.boundary, scene.summary, scene.final, scene.reports[0], queued.uuid, answer.uuid]), shapeOf(grown?.screenRows ?? [], names))
    }
  }

  section('§4 the clock was set back between two sittings, then the user rewound (stamps and parents written by hand)')
  {
    const hand = byHand()
    const T = Date.parse('2026-11-20T10:00:00.000Z')
    const u1 = said('first prompt', T)
    const a1 = replied('first reply', T + 1_000)
    const u2 = said('prompt of the sitting with the fast clock', T + 3_600_000)
    const a2 = replied('its reply', T + 3_601_000)
    const u2b = said('prompt after the rewind', T + 600_000)
    const a5 = called('clock_call', 'msg_clock', T + 601_000)
    const r5 = reported('clock_call', a5, T + 602_000)
    const a6 = replied('reply after the tool', T + 603_000)
    hand.put(u1, null)
    hand.put(a1, u1)
    hand.put(u2, a1)
    hand.put(a2, u2)
    hand.put(u2b, a1)
    hand.put(a5, u2b)
    hand.put(r5, a5)
    hand.put(a6, r5)
    const graph = await read(hand.file)
    const rows = ids(electConversationEnd(graph)?.rows)
    const fast = [u2.uuid, a2.uuid].some(id => rows.includes(id))
    const rewound = [u2b.uuid, a5.uuid, r5.uuid, a6.uuid].some(id => rows.includes(id))
    check('a result that was in order when it landed is never late: the two lines are not mixed', fast !== rewound, shapeOf(electConversationEnd(graph)?.rows ?? []))
    check('the vote is by timestamp, so the line with the newer stamps is read whole, as before', j(rows) === j([u1.uuid, a1.uuid, u2.uuid, a2.uuid]) && j(rows) === j(ids(buildConversationChain(graph, graph.get(a2.uuid)!))), shapeOf(electConversationEnd(graph)?.rows ?? []))
  }

  section('§5 older and damaged files (written by hand, as a reader meets them)')
  {
    const hand = byHand()
    const u0 = said('prompt before the fold')
    const c0 = called('old_call', 'msg_old')
    const boundary = at(createFoldBoundaryMessage('auto', 900, c0.uuid))
    const summary = summarised('summary of an old file')
    const final = replied('reply after the fold')
    const late = reported('old_call', c0)
    hand.put(u0, null)
    hand.put(c0, u0)
    hand.put(boundary, null)
    hand.put(summary, boundary)
    hand.put(final, summary)
    hand.put(late, c0)
    const elected = electConversationEnd(await read(hand.file))
    check('the folded call stands in the same part of the file: its late result does not bring the folded turns back', j(ids(elected?.rows)) === j([boundary.uuid, summary.uuid, final.uuid]) && elected?.primary.uuid === final.uuid, shapeOf(elected?.rows ?? []))
    check('the screen shows that late result once, below the reply', j(ids(elected?.screenRows)) === j([boundary.uuid, summary.uuid, final.uuid, late.uuid]), shapeOf(elected?.screenRows ?? []))
  }
  {
    const hand = byHand()
    const uk = said('kept prompt')
    const ak = replied('kept reply')
    const boundary = at(createFoldBoundaryMessage('auto', 900, ak.uuid))
    const summary = summarised('summary beside a list that names a lost row')
    boundary.compactMetadata.preservedSegment = { headUuid: uk.uuid, anchorUuid: summary.uuid, tailUuid: ak.uuid, keptUuids: [uk.uuid, randomUUID(), ak.uuid] }
    const p2 = said('prompt after the fold')
    const a2 = replied('reply after the fold')
    hand.put(uk, null)
    hand.put(ak, uk)
    hand.put(boundary, null)
    hand.put(summary, boundary)
    hand.put(p2, summary)
    hand.put(a2, p2)
    const graph = await read(hand.file)
    const elected = electConversationEnd(graph)
    check('a fold whose kept list does not hold reads as before: the fold, its summary and what follows', elected?.primary.uuid === a2.uuid && j(ids(elected.rows)) === j([boundary.uuid, summary.uuid, p2.uuid, a2.uuid]) && j(ids(elected.rows)) === j(ids(buildConversationChain(graph, graph.get(a2.uuid)!))), shapeOf(elected?.rows ?? []))
  }
  {
    await freshSession()
    const folded = replied('reply before the fold')
    const boundary = at(createFoldBoundaryMessage('auto', 900, folded.uuid))
    const summary = summarised('summary before the lost row')
    const p2 = said('prompt before the lost row')
    const a2 = replied('reply before the lost row')
    const p3 = said('the prompt whose row is lost')
    const a3 = replied('reply to the lost prompt')
    const p4 = said('prompt after the lost row')
    const a4 = replied('reply after the lost row')
    for (const row of [said('prompt before the fold'), folded, boundary, summary, p2, a2, p3, a3, p4, a4]) await recordTranscript([row])
    await flushSessionStorage()
    const file = getTranscriptPath()
    const lines = readFileSync(file, 'utf8').split('\n')
    const kept = lines.filter(line => line === '' || (JSON.parse(line) as { recordId?: string }).recordId !== p3.uuid)
    writeFileSync(file, kept.join('\n'))
    const elected = electConversationEnd(await read(file))
    const whole = [boundary.uuid, summary.uuid, p2.uuid, a2.uuid, a3.uuid, p4.uuid, a4.uuid]
    check('one row of the line after a fold is lost from the file: the turns before the gap and the turns after it are resumed, in file order', kept.length === lines.length - 1 && elected?.primary.uuid === a4.uuid && j(ids(elected.rows)) === j(whole), shapeOf(elected?.rows ?? []))
    check('the screen shows the same rows, as it did', j(ids(elected?.screenRows)) === j(whole), shapeOf(elected?.screenRows ?? []))
  }
  {
    const scene = await writeLeafScene('kept')
    const lines = readFileSync(scene.file, 'utf8').split('\n')
    const fold = lines.findIndex(line => line !== '' && (JSON.parse(line) as { recordId?: string }).recordId === scene.boundary)
    writeFileSync(scene.file, `${lines.slice(0, fold + 1).join('\n')}\n`)
    const graph = await read(scene.file)
    const elected = electConversationEnd(graph)
    const kept = [scene.prompt, ...scene.calls]
    check('a fold whose summary never landed (the file ends on the fold line): the kept rows are the conversation, on the resume and on the screen', fold > 0 && graph.has(scene.boundary!) && !graph.has(scene.summary!) && j(ids(elected?.rows)) === j(kept) && j(ids(elected?.screenRows)) === j(kept), `${shapeOf(elected?.rows ?? [], namesOf(scene))} · ${shapeOf(elected?.screenRows ?? [], namesOf(scene))}`)
    resetProjectForTesting()
    state.switchSession(asSessionId(scene.sid))
    adoptResumedSessionFile()
    const p2 = said('prompt of the next sitting')
    const a2 = replied('reply of the next sitting')
    await recordTranscript([p2], scene.calls[1])
    await recordTranscript([a2])
    await flushSessionStorage()
    const next = electConversationEnd(await read(scene.file))
    check('the next sitting goes on under the kept rows, and every later read still holds them', next?.primary.uuid === a2.uuid && j(ids(next.rows)) === j([...kept, p2.uuid, a2.uuid]) && j(ids(next.screenRows)) === j([...kept, p2.uuid, a2.uuid]), `${shapeOf(next?.rows ?? [], namesOf(scene))} · ${shapeOf(next?.screenRows ?? [], namesOf(scene))}`)
  }
  {
    const hand = byHand()
    const boundary = at(createFoldBoundaryMessage('auto', 900))
    hand.put(boundary, null)
    const elected = electConversationEnd(await read(hand.file))
    check('a fold line with nothing behind it is its own end, with no turn made up', elected?.primary.uuid === boundary.uuid && j(ids(elected.rows)) === j([boundary.uuid]), shapeOf(elected?.rows ?? []))
  }

  section('§6 a fresh runner writes an operator\'s rewind record first: a fork by intent stays a fork (the product\'s writer)')
  {
    const sid = await freshSession()
    const p1 = said('first prompt')
    const a1 = replied('first reply')
    const p2 = said('the turn that is wound back')
    const a2 = replied('the reply that is wound back')
    await recordTranscript([p1, a1, p2, a2])
    await flushSessionStorage()
    resetProjectForTesting()
    state.switchSession(asSessionId(sid))
    adoptResumedSessionFile()
    const record = at(createOperatorRewindRecordMessage({ turnUuid: p2.uuid, removed: 2 }))
    await recordTranscript([record], p2.uuid, [p1, a1, p2, a2, record])
    const p3 = said('prompt after the rewind')
    const a3 = replied('reply after the rewind')
    await recordTranscript([p3])
    await recordTranscript([a3])
    await flushSessionStorage()
    const elected = electConversationEnd(await read(getTranscriptPath()))
    check('the record\'s line is elected, the record behind its turn, and the wound-back reply is off it', elected?.primary.uuid === a3.uuid && j(ids(elected.rows)) === j([p1.uuid, a1.uuid, p2.uuid, record.uuid, p3.uuid, a3.uuid]), shapeOf(elected?.rows ?? []))
  }

  section('§7 a crewmate folds, a result of a folded call lands, and it goes on (its own writer)')
  {
    await freshSession()
    const agentId = `a${randomUUID().replace(/-/g, '').slice(0, 16)}`
    let tail: UUID | null = null
    const land = async (...rows: Message[]): Promise<void> => {
      for (const row of rows) {
        await recordSidechainTranscript([row], agentId, tail)
        tail = row.uuid
      }
      await flushSessionStorage()
    }
    const a = called('crew_call', 'msg_crew')
    const boundary = at(createFoldBoundaryMessage('auto', 900, a.uuid))
    const summary = summarised('summary of the crewmate')
    const final = replied('reply of the crewmate')
    const late = reported('crew_call', a)
    const onward = replied('the crewmate goes on')
    await land(said('brief of the crewmate'), a, boundary, summary, final, late, onward)
    const graph = await read(getCrewmateTranscriptPath(asAgentId(agentId)))
    const elected = electConversationEnd(graph, { kind: 'crewmate', agentId })
    check('the crewmate\'s end is its newer reply, behind its summary and the reply before the late result', elected?.primary.uuid === onward.uuid && j(ids(elected.rows)) === j([boundary.uuid, summary.uuid, final.uuid, onward.uuid]), shapeOf(elected?.rows ?? []))
    check('read as a session, a file that holds only a crewmate\'s rows has no end', electConversationEnd(graph) === undefined, shapeOf(electConversationEnd(graph)?.rows ?? []))
  }
} finally {
  removeScratch(scratch)
}

console.log(failures === 0 ? `\nTHE CONVERSATION'S END IS ELECTED ONCE: ${checks} checks hold` : `\n${failures} of ${checks} CHECKS FAILED`)
process.exit(failures === 0 ? 0 : 1)
