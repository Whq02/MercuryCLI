#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.MERCURY_CONFIG_DIR
assert(home, 'run with a scratch MERCURY_CONFIG_DIR')
const scratch = mkdtempSync(join(home, 'fold-rows-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_TURN_RECEIPT = '1'

const { composeTranscript } = await import('../../src/components/Messages.tsx')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.ts')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { foldedWorkOf } = await import('../../src/services/compact/compact.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
const { open } = await import('../../src/services/crewBoard/store.ts')

let checks = 0
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n── ${title}`)
const j = (value: unknown): string => JSON.stringify(value)

type Row = Record<string, unknown> & { uuid: string; compactMetadata?: { work?: unknown } }
type Work = { idle?: unknown; receipts: Array<{ board?: unknown }>; recap: unknown }
const names = new Map<string, string>()
const keep = <T extends Row>(name: string, row: T): T => { names.set(row.uuid, name); return row }
let seq = 0
const chat = (name: string, who: string, content: string, extra: Record<string, unknown> = {}): Row => keep(name, {
  type: 'system', subtype: 'crew_chat', level: 'info', isMeta: false, uuid: randomUUID(), timestamp: new Date(Date.UTC(2026, 10, 5, 9, 0, ++seq)).toISOString(),
  content, seq, name: who, authorRole: 'lifecycle' in extra ? 'system' : 'peer', kind: 'lifecycle' in extra ? 'notice' : 'result', mentions: ['main'], addresses: ['main'], ...extra,
})
const prompt = (name: string, text: string): Row => keep(name, createUserMessage({ content: text }) as Row)
const reply = (name: string, text: string): Row => { const row = createAssistantMessage({ content: text }); row.message.stop_reason = 'end_turn'; return keep(name, row as Row) }
const boundaryOf = (name: string): Row => keep(name, createCompactBoundaryMessage('manual', 1000) as unknown as Row)
const liveSummary = (name: string): Row => keep(name, createUserMessage({ content: 'The summary.', isCompactSummary: true }) as Row)
const foldSummary = (name: string): Row => keep(name, createUserMessage({ content: 'The summary.', isCompactSummary: true, isVisibleInTranscriptOnly: true }) as Row)
const named = (rows: ReadonlyArray<{ uuid: string; type?: string }>): string[] => rows.filter(row => row.type !== 'turn_receipt').map(row => names.get(row.uuid) ?? row.uuid.slice(0, 8))
const screen = (rows: Row[], mode: 'prompt' | 'transcript'): string[] =>
  named(composeTranscript({ normalized: normalizeMessages(rows as never), syntheticStreamingRows: [], verbose: false, fullscreen: false, isTranscriptMode: mode === 'transcript', truncateTranscript: false, tools: [], inProgressToolUseIDs: new Set() }).collapsed as Row[])
const workOf = (boundary: Row): Work => boundary.compactMetadata!.work as Work
const fold = (boundary: Row, rows: Row[], keptRows: Row[], summaryUuid: string): Work => { boundary.compactMetadata!.work = foldedWorkOf(rows as never, keptRows as never, summaryUuid as never); return workOf(boundary) }

section('a wave on the screen: lifecycle rows and posts across two turns, the second turn kept by the fold')
const launched = chat('launched', 'main', 'Swarm launched', { lifecycle: { kind: 'launched' } })
const p1 = prompt('p1', 'launch the crew')
const joined = chat('joined', 'goal-106', 'joined · team fold-106', { lifecycle: { kind: 'joined' }, team: 'fold-106', turnId: p1.uuid })
const a1 = reply('a1', 'Launched.')
const result = chat('result', 'goal-106', '@main goal-106 complete', { team: 'fold-106' })
const parked = chat('parked', 'tf-engine-106', 'parked · waiting on seat main posts', { lifecycle: { kind: 'parked', event: 'seat main posts' }, captain: true })
const p2 = prompt('p2', 'read the result')
const mid = chat('mid', 'review-106', '@main the review is in', { turnId: p2.uuid })
const a2 = reply('a2', 'Read.')
const history = [launched, p1, joined, a1, result, parked, p2, mid, a2]
const kept = [p2, mid, a2]
const folded = ['launched', 'joined', 'result', 'parked']
check('before any fold every row paints where it landed', j(screen(history, 'prompt')) === j(['launched', 'p1', 'joined', 'a1', 'result', 'parked', 'p2', 'mid', 'a2']), j(screen(history, 'prompt')))

const boundary = boundaryOf('B')
const summary = liveSummary('S')
fold(boundary, history, kept, summary.uuid)
check('the fold writes no retained rows: work carries no idle groups and no receipt carries board rows', workOf(boundary).idle === undefined && workOf(boundary).receipts.every(receipt => receipt.board === undefined), j(workOf(boundary)))
const later = chat('later', 'review-tensorfold-fixes2-106', 'joined', { lifecycle: { kind: 'joined' } })
const afterFold = [boundary, summary, ...kept, later]
for (const mode of ['prompt', 'transcript'] as const) {
  const painted = screen(afterFold, mode)
  check(`${mode} screen after /compact: no folded row paints after the summary`, !painted.some(name => folded.includes(name)), j(painted))
  check(`${mode} screen after /compact: the kept turn's mid-turn row paints where it landed, between its prompt and its reply`, j(painted.filter(name => ['p2', 'mid', 'a2'].includes(name))) === j(['p2', 'mid', 'a2']), j(painted))
  check(`${mode} screen after /compact: a row that lands after the fold paints after the kept tail`, painted.includes('a2') && painted.indexOf('later') > painted.indexOf('a2'), j(painted))
}
{
  const transcriptOnly = foldSummary('S-auto')
  const auto = boundaryOf('B-auto')
  fold(auto, history, kept, transcriptOnly.uuid)
  const painted = screen([auto, transcriptOnly, ...kept, later], 'transcript')
  check('an automatic fold (its summary transcript-only) paints no folded row either, in the transcript view that shows the summary', !painted.some(name => folded.includes(name)) && j(painted.filter(name => ['p2', 'mid', 'a2', 'later'].includes(name))) === j(['p2', 'mid', 'a2', 'later']), j(painted))
}

section('a boundary in the old shape: a transcript written before this fix carries work.idle and receipt board rows')
{
  const old = boundaryOf('B-old')
  const oldSummary = liveSummary('S-old')
  const oldKept = [p2, mid, a2]
  const base = fold(old, history, oldKept, oldSummary.uuid)
  old.compactMetadata!.work = {
    receipts: [{ beforeUuid: oldSummary.uuid, anchorUuid: p1.uuid, counts: { scratchpadEdits: 0, fileEdits: 0, adds: 0, dels: 0, reads: 0, searches: 0, fetches: 0, commands: 1, browser: 0, agents: 0, delegatedTokens: 0, delegatedCostUSD: 0, delegatedUnpriced: 0, tools: {} }, board: [joined] }, ...base.receipts],
    idle: [{ after: oldSummary.uuid, rows: [launched, result, parked] }],
    recap: base.recap,
  }
  for (const mode of ['prompt', 'transcript'] as const) {
    const painted = screen([old, oldSummary, ...oldKept, later], mode)
    check(`${mode} screen of the old shape: none of the rows the boundary carried paints`, !painted.some(name => folded.includes(name)), j(painted))
    check(`${mode} screen of the old shape: the kept rows and the later row still paint in order`, j(painted.filter(name => ['p2', 'mid', 'a2', 'later'].includes(name))) === j(['p2', 'mid', 'a2', 'later']), j(painted))
  }
}

section('a second fold carries nothing from the first')
{
  const p3 = prompt('p3', 'and the next step')
  const a3 = reply('a3', 'Done.')
  const secondHistory = [...afterFold, p3, a3]
  const second = boundaryOf('B2')
  const secondSummary = liveSummary('S2')
  fold(second, secondHistory, [p3, a3], secondSummary.uuid)
  check('the second fold writes no retained rows either', workOf(second).idle === undefined && workOf(second).receipts.every(receipt => receipt.board === undefined), j(workOf(second)))
  const painted = screen([second, secondSummary, p3, a3], 'transcript')
  check('after the second fold nothing of the first epoch paints: not its folded rows, not its kept rows, not the row that landed between the folds', j(painted) === j(['B2', 'S2', 'p3', 'a3']), j(painted))
  const oldShape = boundaryOf('B2-old')
  oldShape.compactMetadata!.work = { ...workOf(second), idle: [{ after: secondSummary.uuid, rows: [launched, joined, result, parked, mid, later] }] }
  check('a second fold of an old-shape transcript paints none of the rows the first fold had carried', j(screen([oldShape, secondSummary, p3, a3], 'transcript')) === j(['B2-old', 'S2', 'p3', 'a3']), j(screen([oldShape, secondSummary, p3, a3], 'transcript')))
}

section('a cold resume reads the folded transcript from disk and paints the same rows')
{
  const path = join(scratch, `${randomUUID()}.jsonl`)
  let parent: string | null = null
  for (const row of afterFold) {
    appendFileSync(path, (encodeTranscriptLine(path, { ...row, parentUuid: parent, isSidechain: false }) as { line: string }).line)
    parent = row.uuid
  }
  reader._resetTranscriptReaderForTesting()
  const cold = (await reader.readTranscriptChainSince(path, null)).rows as unknown as Row[]
  check('the cold read holds the boundary, the summary, the kept tail and the later row, once each', j(named(cold)) === j(['B', 'S', 'p2', 'mid', 'a2', 'later']), j(named(cold)))
  for (const mode of ['prompt', 'transcript'] as const) {
    const painted = screen(cold, mode)
    check(`${mode} screen on a cold resume: no folded row paints`, !painted.some(name => folded.includes(name)), j(painted))
    check(`${mode} screen on a cold resume: the kept mid-turn row and the later row paint where they landed`, j(painted.filter(name => ['p2', 'mid', 'a2', 'later'].includes(name))) === j(['p2', 'mid', 'a2', 'later']), j(painted))
  }
}

section('the model side is unchanged: after a fold the boundary carries the waits line and a new post, never a presented post')
{
  let clock = 0
  const board = open(join(scratch, 'board.sqlite'), 'fold-rows', () => (clock += 1000))
  const principal = (agentId: string) => ({ author: { sessionId: 'fold-rows', agentId, executionId: 'run' }, name: agentId })
  const main = principal('main')
  const seat = principal('goal-106')
  board.enroll(main)
  board.enroll(seat)
  let request = 0
  const post = (n: number) => { const receipt = board.post(seat, { clientOpId: `post-${n}`, kind: 'result', text: `@main result ${n}`, mentions: ['main'] }); assert(receipt.ok, j(receipt)); return receipt }
  const context = new Set<string>()
  const turn = (): string[] => {
    const packet = board.boundary(main, context)
    if (!packet) return []
    board.presented(main, packet.eventIds, `request-${++request}`)
    for (const id of packet.eventIds) context.add(id)
    return packet.eventIds
  }
  const first = post(1), second = post(2)
  const turnOne = turn()
  check('the first turn presents the two posts', turnOne.includes(first.eventId) && turnOne.includes(second.eventId), j(turnOne))
  const third = post(3)
  const park = board.post(seat, { clientOpId: 'park', kind: 'ask', text: '@main wake me when seat main posts' })
  assert(park.ok, j(park))
  board.complete(seat, 'completed')
  const turnTwo = turn()
  check('the second turn presents the third post, the park and the waits line', turnTwo.includes(third.eventId) && turnTwo.includes(park.eventId) && turnTwo.some(id => id.startsWith('waits:')), j(turnTwo))
  const settled = board.boundary(main, context)
  check('with the packets in the context the next boundary carries nothing', settled === null, j(settled))
  const afterTheFold = board.boundary(main, new Set())
  check('after a fold (an empty context) the boundary carries the waits line only, never a presented post', afterTheFold !== null && afterTheFold.eventIds.length === 1 && afterTheFold.eventIds[0]!.startsWith('waits:'), j(afterTheFold))
  const fourth = post(4)
  const fresh = board.boundary(main, new Set())
  check('a post that lands after the fold arrives beside the waits line', fresh !== null && fresh.eventIds.includes(fourth.eventId) && fresh.eventIds.length === 2 && ![first, second, third].some(receipt => fresh.eventIds.includes(receipt.eventId)), j(fresh))
  board.close()
}

console.log(`\n${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
