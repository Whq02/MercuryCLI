#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import React from 'react'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

const ROOT = join(import.meta.dir, '..', '..')
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const DIST = arg('--dist') ?? process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const TEMP_ROOT = '/tmp/claude-1/'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

process.env.MERCURY_TURN_RECEIPT = '1'
const receiptModule = await import('../../src/utils/cockpit/turnReceipt.ts')
const { injectTurnReceipts, injectRetainedChatRows, foldedTurnReceipts, retainedChatRows, hasActivity, isTurnBoundary } = receiptModule
const { isNavigableMessage, copyTextOf, MESSAGE_ACTIONS } = await import('../../src/components/messageActions.tsx')
type Row = Record<string, unknown>
const prompt = (text: string, uuid: string): Row => ({ type: 'user', uuid, message: { role: 'user', content: text } })
const toolUse = (name: string, uuid: string): Row => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${uuid}`, name, input: {} }] } })
const reply = (text: string, uuid: string, input?: number): Row => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }], ...(input === undefined ? {} : { usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) } })
const chat = (uuid: string, seq: number, name: string, content: string, turnId?: string, kind = 'result'): Row => ({
  type: 'system', subtype: 'crew_chat', content, level: 'info', uuid, timestamp: `2026-11-01T08:00:${String(seq).padStart(2, '0')}.000Z`,
  seq, name, authorRole: 'peer', kind, mentions: ['main'], addresses: ['main'], ...(turnId === undefined ? {} : { turnId }),
})
const inject = (rows: Row[]) => injectTurnReceipts(injectRetainedChatRows(rows as never), TEMP_ROOT) as Row[]
const shape = (rows: Row[]): string[] => rows.map(row => row.type === 'turn_receipt' ? `receipt:${String(row.uuid).replace(/-turn-receipt$/, '')}` : String(row.uuid))
const receiptOf = (rows: Row[], anchor: string) => rows.find(row => row.type === 'turn_receipt' && row.uuid === `${anchor}-turn-receipt`) as { counts: Record<string, unknown> & { commands: number }; board?: unknown } | undefined
const plain = (rows: Row[]): boolean => rows.filter(row => row.type === 'turn_receipt').every(row => (row as { board?: unknown }).board === undefined && !('boardMessages' in ((row as { counts: Record<string, unknown> }).counts)))

section('the lead speaks at the call boundary; every row stays where it landed')
const leadPost: Row = { ...chat('lead-post', 2, 'main', '@alpha Read the fence first.', 'p1'), authorRole: 'lead' }
const leadTurn = [prompt('ask the crew', 'p1'), toolUse('CrewBoard', 'call'), chat('peer-one', 1, 'alpha', 'first incoming post', 'p1'), leadPost, chat('peer-two', 3, 'beta', 'second incoming post', 'p1'), reply('The crew has the note.', 'done')]
const leadClosed = inject(leadTurn)
check('the lead post and both incoming rows stay between the call and the reply after the turn closes; the receipt follows the reply', JSON.stringify(shape(leadClosed)) === '["p1","call","peer-one","lead-post","peer-two","done","receipt:p1"]', JSON.stringify(shape(leadClosed)))
check('the receipt carries no rows and no board count', plain(leadClosed) && receiptOf(leadClosed, 'p1') !== undefined, JSON.stringify(receiptOf(leadClosed, 'p1')))
const leadOnly = inject([leadTurn[0]!, leadTurn[1]!, leadPost, leadTurn[5]!])
check('a lead-only turn reads the same way', JSON.stringify(shape(leadOnly)) === '["p1","call","lead-post","done","receipt:p1"]' && plain(leadOnly))

section('the board event makes one durable row, not the tool result')
{
  const home = process.env.MERCURY_CONFIG_DIR
  if (!home) throw new Error('use a scratch MERCURY_CONFIG_DIR')
  const scratch = mkdtempSync(join(home, 'lead-row-'))
  const { buildTool } = await import('../../src/Tool.ts')
  const { open } = await import('../../src/services/crewBoard/store.ts')
  const { tool } = await import('../../src/services/crewBoard/implementation.ts')
  const { partyFeed } = await import('../../src/services/crewBoard/party.ts')
  const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
  const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const board = open(join(scratch, 'board.sqlite'), sessionId)
  const principal = { author: { sessionId, agentId: 'main', executionId: 'lead-turn' }, name: 'main' }
  const peer = { author: { sessionId, agentId: 'alpha', executionId: 'peer-turn' }, name: 'alpha' }
  const rows: Row[] = []
  const transcript = join(scratch, `${sessionId}.jsonl`)
  const record = (row: Row): void => {
    const entry = { ...row, parentUuid: rows.at(-1)?.uuid ?? null, isSidechain: false, sessionId, timestamp: row.timestamp ?? new Date().toISOString() }
    rows.push(entry)
    appendFileSync(transcript, encodeTranscriptLine(transcript, entry).line)
  }
  const party = partyFeed({ store: () => board, anchor: () => 'p1', record: async row => { record(row) } })
  try {
    board.enroll(principal)
    board.enroll(peer)
    board.setChat({ on: true, filter: { kind: 'all' } })
    board.markScreenIntroduced()
    board.markScreenCursor(board.view().snapshot)
    record(prompt('post the note', 'p1'))
    party.blockOpen()
    record(toolUse('CrewBoard', 'call'))
    party.landed()
    const boardTool = tool({ buildTool, principal: () => principal, paused: () => false, sessionOn: () => true }, () => board)
    const input = { op: 'post', clientOpId: 'lead-note', kind: 'result', text: '@alpha Read the fence first.' }
    const result = await boardTool.call(input, {} as never, undefined as never, {} as never, undefined as never)
    party.check()
    await Promise.resolve()
    const own = rows.find(row => row.subtype === 'crew_chat')
    check('the CrewBoard post supplies its event id; the feed stamps lead and main at the call boundary', (result.data as { ok?: boolean; eventId?: string }).ok === true && own?.uuid === (result.data as { eventId?: string }).eventId && own?.authorRole === 'lead' && own?.name === 'main' && own?.turnId === 'p1' && rows[2] === own, JSON.stringify(own))
    const live = await reader.readTranscriptChainSince(transcript, null)
    record({ type: 'user', uuid: 'result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-call', content: JSON.stringify(result.data) }] } })
    const incoming: string[] = []
    for (const clientOpId of ['one', 'two']) {
      const posted = board.post(peer, { clientOpId, kind: 'result', text: clientOpId })
      if (!posted.ok) throw new Error(posted.reason)
      incoming.push(posted.eventId)
    }
    party.check()
    await Promise.resolve()
    record(reply('The crew has the note.', 'done'))
    party.turnEnd()
    const streamed = await reader.readTranscriptChainSince(transcript, live.cursor)
    const reattached = await reader.readTranscriptChainSince(transcript, null)
    reader._resetTranscriptReaderForTesting()
    const cold = await reader.readTranscriptChainSince(transcript, null)
    const expected = ['p1', 'call', own?.uuid, 'result', ...incoming, 'done', 'receipt:p1']
    for (const [label, chain] of [['live', streamed], ['reattach', reattached], ['cold resume', cold]] as const) {
      const painted = inject([...chain.rows] as Row[])
      check(`${label}: the lead row stands once at its boundary and the two incoming rows stand where they landed, before the reply`, JSON.stringify(shape(painted)) === JSON.stringify(expected) && plain(painted), JSON.stringify(shape(painted)))
    }
    party.check()
    await Promise.resolve()
    check('the persisted cursor prevents a second copy of the lead row', rows.filter(row => row.uuid === own?.uuid).length === 1 && board.screenCursor() === board.view().snapshot)
  } finally {
    board.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

section('words')
check('the derive owner has no board-message words left', !('boardMessagesWords' in receiptModule) && !/board message/.test(readFileSync(join(ROOT, 'src', 'utils', 'cockpit', 'turnReceipt.ts'), 'utf8')))
check('the row prints no board-message words and no rows of its own', !/board/.test(readFileSync(join(ROOT, 'src', 'components', 'messages', 'TurnReceiptRow.tsx'), 'utf8')) && !/CrewChatRow/.test(readFileSync(join(ROOT, 'src', 'components', 'messages', 'TurnReceiptRow.tsx'), 'utf8')))

section('a board row is never a turn boundary')
check('a crew_chat row is not a boundary', !isTurnBoundary(chat('c0', 1, 'alpha', 'x', 'p1') as never))
check('a virtual user row (the off-state Crewboard notice) is not a boundary either', !isTurnBoundary({ type: 'user', isVirtual: true, message: { role: 'user', content: '<crew-board>{}</crew-board>' } } as never))
const split = inject([prompt('go', 'p1'), toolUse('Bash', 'a1'), chat('c1', 1, 'alpha', 'one', 'p1'), toolUse('Bash', 'a2'), reply('done', 'a3'), prompt('next', 'p2')])
check('two shell commands around an admitted row stay one turn: the row between them, one receipt of 2 commands', JSON.stringify(shape(split)) === '["p1","a1","c1","a2","a3","receipt:p1","p2"]' && receiptOf(split, 'p1')?.counts.commands === 2 && plain(split), JSON.stringify(shape(split)))

section('no row leaves the stream at the close; idle rows stay below the receipt')
const none = inject([prompt('plain', 'p1'), toolUse('Bash', 'a1'), reply('done', 'a2'), prompt('next', 'p2')])
check('a turn without board rows reads as it did', JSON.stringify(shape(none)) === '["p1","a1","a2","receipt:p1","p2"]' && plain(none))
const one = inject([prompt('one', 'p1'), toolUse('Bash', 'a1'), chat('c1', 1, 'alpha', 'the one', 'p1'), reply('done', 'a2'), prompt('next', 'p2')])
check('one admitted row stays where it landed, before the reply and the receipt', JSON.stringify(shape(one)) === '["p1","a1","c1","a2","receipt:p1","p2"]' && plain(one), JSON.stringify(shape(one)))
const many = [prompt('many', 'p1'), toolUse('Bash', 'a1'), chat('c2', 2, 'beta', 'second', 'p1'), chat('c1', 1, 'alpha', 'first', 'p1'), toolUse('Bash', 'a2'), chat('c3', 3, 'gamma', 'third', 'p1'), reply('done', 'a3'), chat('c4', 4, 'alpha', 'idle one'), chat('c5', 5, 'beta', 'idle two'), prompt('next', 'p2'), reply('ok', 'a4')]
const closed = inject(many)
check('three admitted rows stay in arrival order among the tool rows; the receipt sits after the reply and before the first idle row; the idle rows stay as rows', JSON.stringify(shape(closed)) === JSON.stringify(['p1', 'a1', 'c2', 'c1', 'a2', 'c3', 'a3', 'receipt:p1', 'c4', 'c5', 'p2', 'a4', 'receipt:p2']) && plain(closed), JSON.stringify(shape(closed)))
check('the receipts count tool work only', receiptOf(closed, 'p1')?.counts.commands === 2 && receiptOf(closed, 'p2')?.counts.commands === 0)
const before = inject([chat('c0', 1, 'alpha', 'before any prompt'), prompt('first', 'p1'), toolUse('Bash', 'a1'), reply('done', 'a2')])
check('a row before the first prompt stays where it is', shape(before)[0] === 'c0' && plain(before), JSON.stringify(shape(before)))
const trailing = inject([prompt('ends on an attachment', 'p1'), reply('waiting', 'a1'), { type: 'attachment', uuid: 't1', attachment: { type: 'queued_command', prompt: 'later', isMeta: true } }, chat('c7', 7, 'alpha', 'after the attachment')])
check('a turn whose transcript ends with an attachment still puts its receipt before the idle row', JSON.stringify(shape(trailing)) === JSON.stringify(['p1', 'a1', 't1', 'receipt:p1', 'c7']), JSON.stringify(shape(trailing)))

section('a board-only turn: the rows are the record; a receipt comes only with a reply or tool work')
const boardOnly = inject([prompt('ask the crew', 'p1'), chat('c1', 1, 'alpha', 'answer', 'p1'), reply('they said so', 'a1'), prompt('next', 'p2')])
check('a turn with no tool and one admitted row keeps the row and gets the reply\'s receipt without activity', JSON.stringify(shape(boardOnly)) === '["p1","c1","a1","receipt:p1","p2"]' && !hasActivity(receiptOf(boardOnly, 'p1')!.counts as never), JSON.stringify(shape(boardOnly)))
const cut = inject([prompt('cut short', 'p1'), chat('c1', 1, 'alpha', 'arrived', 'p1'), prompt('next', 'p2')])
check('a turn with no reply and no tool keeps its admitted row and mints no receipt (the row is never lost)', JSON.stringify(shape(cut)) === '["p1","c1","p2"]', JSON.stringify(shape(cut)))
const running = inject(many.slice(0, 7))
check('the tail turn reads the same while it runs and once it closes', JSON.stringify(shape(running)) === JSON.stringify(['p1', 'a1', 'c2', 'c1', 'a2', 'c3', 'a3', 'receipt:p1']) && plain(running), JSON.stringify(shape(running)))

section('a wake turn after idle rows is its own turn')
const woken = [prompt('go', 'p1'), toolUse('Bash', 'a1'), reply('done', 'a2', 1000), chat('c1', 1, 'alpha', 'idle one'), chat('c2', 2, 'beta', '@main idle two'), reply('Noted.', 'a3', 1013), chat('c3', 3, 'alpha', 'during the wake', 'n1'), chat('c4', 4, 'beta', 'after the wake')]
const wake = inject(woken)
check('the wake receipt sits under the reply and the row the wake admitted, before the idle row that follows; the idle rows before the wake stay above the earlier receipt', JSON.stringify(shape(wake)) === JSON.stringify(['p1', 'a1', 'a2', 'receipt:p1', 'c1', 'c2', 'a3', 'c3', 'receipt:a3', 'c4']), JSON.stringify(shape(wake)))
check('the earlier turn keeps its own counts and the wake turn its own: 1 shell command · ctx +1.0k, then no tools · ctx +13', receiptOf(wake, 'p1')?.counts.commands === 1 && (wake.find(row => row.uuid === 'p1-turn-receipt') as { contextDelta?: number }).contextDelta === 1000 && receiptOf(wake, 'a3')?.counts.commands === 0 && (wake.find(row => row.uuid === 'a3-turn-receipt') as { contextDelta?: number }).contextDelta === 13 && plain(wake), JSON.stringify(wake.filter(row => row.type === 'turn_receipt')))
const wakeWork = inject([prompt('go', 'p1'), reply('done', 'a1'), chat('c1', 1, 'alpha', 'idle'), chat('c2', 2, 'beta', 'first of the wake', 'n1'), reply('Noted.', 'a2')])
check('a row admitted before the wake\'s first reply opens the wake turn and stays as its first row', JSON.stringify(shape(wakeWork)) === JSON.stringify(['p1', 'a1', 'receipt:p1', 'c1', 'c2', 'a2', 'receipt:c2']) && plain(wakeWork), JSON.stringify(shape(wakeWork)))
const waking = inject(woken.slice(0, 5))
check('while the wake turn loads and nothing of it has landed, the closed turn keeps its receipt and the idle rows stay below it', JSON.stringify(shape(waking)) === JSON.stringify(['p1', 'a1', 'a2', 'receipt:p1', 'c1', 'c2']), JSON.stringify(shape(waking)))
const wakeOpen = inject(woken.slice(0, 7))
check('while the wake turn runs, its admitted row stays on screen after the reply', JSON.stringify(shape(wakeOpen)) === JSON.stringify(['p1', 'a1', 'a2', 'receipt:p1', 'c1', 'c2', 'a3', 'c3', 'receipt:a3']), JSON.stringify(shape(wakeOpen)))

section('MERCURY_TURN_RECEIPT=0 keeps every row in place')
process.env.MERCURY_TURN_RECEIPT = '0'
check('the injector returns its input untouched: admitted rows stay expanded in place', injectTurnReceipts(many as never, TEMP_ROOT) === (many as never))
process.env.MERCURY_TURN_RECEIPT = '1'

section('compaction keeps every board row as a row: the rows not kept come back after the summary in seq order')
const kept = many.slice(9)
const carried = foldedTurnReceipts(many as never, kept as never, 'sum', TEMP_ROOT)
const idle = retainedChatRows(many as never, kept as never, 'sum')
check('a fully folded turn retains no receipt and no receipt carries board rows', carried.every(receipt => receipt.board === undefined && !('boardMessages' in receipt.counts)) && !carried.some(receipt => receipt.beforeUuid === 'sum'), JSON.stringify(carried))
check('its five rows, the admitted and the idle alike, are retained whole, anchored on the summary, in seq order', JSON.stringify(idle.map(group => [group.after, group.rows.map(row => row.uuid)])) === '[["sum",["c1","c2","c3","c4","c5"]]]' && idle[0]!.rows.every(row => row.content !== ''), JSON.stringify(idle))
const boundary = (receipts: unknown, retainedIdle: unknown, uuid = 'cb'): Row => ({ type: 'system', subtype: 'compact_boundary', uuid, compactMetadata: { work: { receipts, idle: retainedIdle, recap: { turns: 1, toolCounts: [], files: [], toolFailures: 0, failedToolUseIds: [] } } } })
const summary: Row = { type: 'user', uuid: 'sum', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'The summary.' } }
const leadCarry = foldedTurnReceipts(leadTurn as never, [] as never, 'sum', TEMP_ROOT)
const leadRetained = retainedChatRows(leadTurn as never, [] as never, 'sum')
const leadCompacted = inject([boundary(leadCarry, leadRetained), summary])
check('compaction retains the lead post and both incoming posts as rows after the summary, the receipt after them', JSON.stringify(shape(leadCompacted)) === JSON.stringify(['cb', 'sum', 'peer-one', 'lead-post', 'peer-two', 'receipt:p1']) && JSON.stringify(leadRetained.flatMap(group => group.rows.map(row => row.uuid))) === '["peer-one","lead-post","peer-two"]' && plain(leadCompacted), JSON.stringify(shape(leadCompacted)))
const afterFold = inject([boundary(carried, idle), summary, ...kept])
check('after the fold: the summary, the five rows as rows, then the kept turn', JSON.stringify(shape(afterFold)) === JSON.stringify(['cb', 'sum', 'c1', 'c2', 'c3', 'c4', 'c5', 'p2', 'a4', 'receipt:p2']) && plain(afterFold), JSON.stringify(shape(afterFold)))
process.env.MERCURY_TURN_RECEIPT = '0'
check('with the receipt switch off the retained rows still paint after the summary', JSON.stringify(shape(inject([boundary(carried, idle), summary, ...kept]))) === JSON.stringify(['cb', 'sum', 'c1', 'c2', 'c3', 'c4', 'c5', 'p2', 'a4']), JSON.stringify(shape(inject([boundary(carried, idle), summary, ...kept]))))
process.env.MERCURY_TURN_RECEIPT = '1'
const partialKept = many.slice(4)
const partial = foldedTurnReceipts(many as never, partialKept as never, 'sum', TEMP_ROOT)
const partialIdle = retainedChatRows(many as never, partialKept as never, 'sum')
const afterPartial = inject([boundary(partial, partialIdle), summary, ...partialKept])
check('a turn cut by the fold: its two folded rows come back after the summary, its kept rows are not doubled, its receipt keeps the folded command', JSON.stringify(shape(afterPartial)) === JSON.stringify(['cb', 'sum', 'c1', 'c2', 'a2', 'c3', 'a3', 'receipt:p1', 'c4', 'c5', 'p2', 'a4', 'receipt:p2']) && receiptOf(afterPartial, 'p1')?.counts.commands === 2 && JSON.stringify(partialIdle.map(group => [group.after, group.rows.map(row => row.uuid)])) === '[["sum",["c1","c2"]]]', JSON.stringify(shape(afterPartial)))
const folded2 = [boundary(carried, idle), summary, ...kept]
const again = foldedTurnReceipts(folded2 as never, [kept[0]!, kept[1]!] as never, 'sum2', TEMP_ROOT)
const idle2 = retainedChatRows(folded2 as never, [kept[0]!, kept[1]!] as never, 'sum2')
const twice = inject([boundary(again, idle2, 'cb2'), { ...summary, uuid: 'sum2' }, kept[0]!, kept[1]!])
check('a second compaction carries the five rows again, each event once, re-anchored on the new summary', JSON.stringify(shape(twice)) === JSON.stringify(['cb2', 'sum2', 'c1', 'c2', 'c3', 'c4', 'c5', 'p2', 'a4', 'receipt:p2']), JSON.stringify({ shape: shape(twice), idle2 }))
const older = [boundary([{ beforeUuid: 'sum', anchorUuid: 'p1', counts: { scratchpadEdits: 0, fileEdits: 0, adds: 0, dels: 0, reads: 0, searches: 0, fetches: 0, commands: 2, browser: 0, agents: 0, delegatedTokens: 0, delegatedCostUSD: 0, delegatedUnpriced: 0, boardMessages: 3, tools: {} }, board: [many[3], many[2], many[5]] }], [{ after: 'sum', rows: [many[7], many[8]] }]), summary, ...kept]
const olderPainted = inject(older)
check('a transcript written under the old fold: the rows its receipt carried paint as rows before the receipt, in seq order, and the count is forgotten', JSON.stringify(shape(olderPainted)) === JSON.stringify(['cb', 'sum', 'c1', 'c2', 'c3', 'receipt:p1', 'c4', 'c5', 'p2', 'a4', 'receipt:p2']) && receiptOf(olderPainted, 'p1')?.counts.commands === 2 && plain(olderPainted), JSON.stringify(shape(olderPainted)))
const olderAgain = retainedChatRows(older as never, [kept[0]!, kept[1]!] as never, 'sum2')
check('a second compaction of that transcript retains the carried rows as rows beside the idle rows', JSON.stringify(olderAgain.map(group => [group.after, group.rows.map(row => row.uuid)])) === '[["sum2",["c1","c2","c3","c4","c5"]]]', JSON.stringify(olderAgain))
const c6 = chat('c6', 6, 'alpha', 'named twice')
const doubled = injectRetainedChatRows([boundary([], [{ after: 'sum', rows: [c6] }, { after: 'p2', rows: [c6, chat('c4', 4, 'alpha', 'kept')] }]), summary, kept[0]!, chat('c4', 4, 'alpha', 'kept')] as never) as Row[]
check('a row two groups name paints once, at its first placement; a row already on the screen is never added', JSON.stringify(shape(doubled)) === JSON.stringify(['cb', 'sum', 'c6', 'p2', 'c4']), JSON.stringify(shape(doubled)))

section('the receipt is never navigable or clickable, and never copies rows')
const receiptRow = receiptOf(closed, 'p1')!
check('not navigable', !isNavigableMessage(receiptRow as never))
check('enter does not address it', !MESSAGE_ACTIONS.some(action => action.key === 'enter' && action.types.includes('turn_receipt')))
check('copy takes nothing from it', copyTextOf(receiptRow as never) === '')
const messagesSrc = readFileSync(join(ROOT, 'src', 'components', 'Messages.tsx'), 'utf8')
check('Messages.tsx counts no receipt as clickable and composes the transcript without a turn-open flag', !/turn_receipt'\) return/.test(messagesSrc) && !/turnOpen/.test(messagesSrc) && /collapsed = injectTurnReceipts\(collapsed, getMercuryTempDir\(\)\)/.test(messagesSrc))
check('Message.tsx hands the row no verbose flag', /<TurnReceiptRow message=\{message\} \/>/.test(readFileSync(join(ROOT, 'src', 'components', 'Message.tsx'), 'utf8')))

section('the painted words')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { render, Box, flushPendingSyncWork } = await import('../../src/ink.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { TurnReceiptRow } = await import('../../src/components/messages/TurnReceiptRow.js')
async function paint(message: Row, columns = 120): Promise<string[]> {
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: 24 }) as unknown as NodeJS.WriteStream
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const node = React.createElement(TerminalSizeContext.Provider, { value: { columns, rows: 24 } },
    React.createElement(Box, { flexDirection: 'column', width: columns }, React.createElement(TurnReceiptRow, { message: message as never })))
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first
  flushPendingSyncWork()
  const frame = stripAnsi(instance.lastFrame()).replace(/\n$/, '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return frame.split('\n').filter(line => line.trim() !== '')
}
const words = (counts: Partial<Record<string, number>>, extra: Row = {}): Row => ({ type: 'turn_receipt', uuid: 'w-turn-receipt', counts: { scratchpadEdits: 0, fileEdits: 0, adds: 0, dels: 0, reads: 0, searches: 0, fetches: 0, commands: 0, browser: 0, agents: 0, delegatedTokens: 0, delegatedCostUSD: 0, delegatedUnpriced: 0, tools: {}, ...counts }, ...extra })
check('the owner\'s line: ∙ 2 shell commands · ctx +1.8k, nothing after it', JSON.stringify(await paint(words({ commands: 2 }, { contextDelta: 1800 }))) === JSON.stringify(['∙ 2 shell commands · ctx +1.8k']), JSON.stringify(await paint(words({ commands: 2 }, { contextDelta: 1800 }))))
check('a turn with no tool work reads the no-tools words', (await paint(words({})))[0] === '∙ no tools ran this turn')
check('a context delta alone keeps its place', (await paint(words({}, { contextDelta: 600 })))[0] === '∙ no tools ran this turn · ctx +600')
const stale = await paint(words({ commands: 2, boardMessages: 14 }, { contextDelta: 1800, board: [many[3], many[2]] }))
check('a count or rows left on an old receipt object paint nothing: one line, no board words, no rows beneath', JSON.stringify(stale) === JSON.stringify(['∙ 2 shell commands · ctx +1.8k']), JSON.stringify(stale))

section('frames')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const driver = resolveCaptureDriver()
if (!existsSync(DIST)) console.log(`  [SKIP] no built artifact at ${DIST}: pass --dist <mercury.mjs> for the frames`)
else if (driver.kind !== 'posix-pty') console.log(`  [SKIP] the frames need the POSIX pty capture driver; this host has ${driver.kind}`)
else {
  const home = process.env.MERCURY_CONFIG_DIR
  if (!home) throw new Error('the frames need a scratch MERCURY_CONFIG_DIR')
  const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
  const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
  const { gridToPng } = await import('./gridToPng.ts')
  const { readSessionWorkers } = await import('../../src/daemon/concourseWorkers.ts')
  const { seedFirstRun, FIXTURE_API_KEY } = await import('../lib/firstRunSeed.ts')
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const api = await startFixtureApi([])
  const captures = arg('--captures') ?? join(home, 'captures')
  mkdirSync(captures, { recursive: true })
  const RUNTIME_CWD = ROOT
  seedFirstRun(home, [RUNTIME_CWD])
  const SID = `00000000-aaaa-bbbb-dddd-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`
  const daemonDir = join(tmpdir(), `mercury-receipt-daemon-${process.pid}`)
  const env: Record<string, string> = {
    ...(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !['ANTHROPIC_API_KEY', 'CI', 'MERCURY_CRITTER'].includes(entry[0]))) as Record<string, string>),
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_HOME: join(tmpdir(), `mercury-receipt-home-${process.pid}`),
    MERCURY_CREW_DIR: join(tmpdir(), `mercury-receipt-crew-${process.pid}`),
    MERCURY_HEALTH_STATE_DIR: join(tmpdir(), `mercury-receipt-health-${process.pid}`),
    MERCURY_BOOT_PREFLIGHT: '0', MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_LIVE_GLYPHS: '0', MERCURY_LIVE_CLOCK: '0', MERCURY_CRITTER_GAZE: '0', MERCURY_CRITTER_IDLE: '0', MERCURY_CRITTER_SLEEP: '0',
    MERCURY_TURN_RECEIPT: '1', MERCURY_VERIFY_EVIDENCE: '0', TERM: 'xterm-256color', USER: 'sam', MERCURY_OPERATOR: 'sam',
    ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: api.url,
  }
  const projects = getProjectDir(RUNTIME_CWD)
  mkdirSync(projects, { recursive: true })
  const encode = (lines: Record<string, unknown>[]): string => {
    let n = 0
    const ctx = { sessionId: SID as never, nextOrdinal: () => ordinalOf(++n) as never, observedAt: '2026-06-19T12:00:00.000Z', source: { channel: 'sdk' } as const }
    return lines.map(line => JSON.stringify(entryToRecord(line, ctx as never))).join('\n') + '\n'
  }
  const base = (extra: Record<string, unknown>) => ({ isSidechain: false, entrypoint: 'cli', cwd: RUNTIME_CWD, sessionId: SID, version: '1.0.0', gitBranch: 'main', ...extra })
  const P3 = '00000000-0000-4000-8000-00000000a003'
  const ids = ['00000000-0000-4000-8000-00000000a004', '00000000-0000-4000-8000-00000000a005', '00000000-0000-4000-8000-00000000a006', '00000000-0000-4000-8000-00000000a007', '00000000-0000-4000-8000-00000000a008']
  const post = (parent: string, uuid: string, seq: number, name: string, content: string, kind: string, turnId?: string, team?: string) => base({
    parentUuid: parent, type: 'system', subtype: 'crew_chat', uuid, content, level: 'info', timestamp: `2026-06-19T12:00:${10 + seq}.000Z`,
    seq, name, ...(team === undefined ? {} : { team }), authorRole: name === 'main' ? 'lead' : 'peer', kind, mentions: ['main'], addresses: ['main'], ...(turnId === undefined ? {} : { turnId }),
  })
  const ADMITTED = ['The list is ready, eighteen rows.', 'The addon faults on the second image.']
  const LEAD = 'Read the fence first.'
  const IDLE = ['May I take the README row?', 'Yes, the README row is yours.']
  const NOTICE_REPLIES = ['The first reply.', 'The notice reply.']
  const NOTICE = '@main The notice arrived.'
  const fixture = (leg: 'idle' | 'cursor' | 'notice') => {
    const rows = leg === 'notice' ? [
      base({ parentUuid: null, type: 'user', uuid: P3, message: { role: 'user', content: 'say hello' }, timestamp: '2026-06-19T12:00:09.000Z' }),
      base({ parentUuid: P3, type: 'assistant', uuid: ids[0], requestId: 'req_notice_1', message: { id: 'msg_notice_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: NOTICE_REPLIES[0] }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 13, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:10.000Z' }),
      base({ parentUuid: ids[0], type: 'user', uuid: ids[1], isVirtual: true, origin: { kind: 'task-notification' }, message: { role: 'user', content: `<crew-board>${JSON.stringify({ name: 'lists-judge', kind: 'result', text: NOTICE })}</crew-board>` }, timestamp: '2026-06-19T12:00:11.000Z' }),
      base({ parentUuid: ids[1], type: 'assistant', uuid: ids[2], requestId: 'req_notice_2', message: { id: 'msg_notice_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: NOTICE_REPLIES[1] }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 13, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:12.000Z' }),
    ] : [
      base({ parentUuid: null, type: 'user', uuid: P3, message: { role: 'user', content: 'fold the board' }, timestamp: '2026-06-19T12:00:09.000Z' }),
      base({ parentUuid: P3, type: 'assistant', uuid: ids[0], requestId: 'req_fold_1', message: { id: 'msg_fold_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'toolu_fold1', name: 'Bash', input: { command: 'echo one', description: 'First' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:10.000Z' }),
      base({ parentUuid: ids[0], type: 'user', uuid: ids[1], message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fold1', content: 'one' }] }, toolUseResult: 'one', timestamp: '2026-06-19T12:00:11.000Z' }),
      post(ids[1], '00000000-0000-4000-8000-00000000c001', 1, 'lists-judge', `@main ${ADMITTED[0]}`, 'result', P3, 'lists'),
      base({ parentUuid: '00000000-0000-4000-8000-00000000c001', type: 'assistant', uuid: ids[2], requestId: 'req_fold_2', message: { id: 'msg_fold_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'toolu_fold2', name: 'Bash', input: { command: 'echo two', description: 'Second' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2400, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:13.000Z' }),
      base({ parentUuid: ids[2], type: 'user', uuid: ids[3], message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fold2', content: 'two' }] }, toolUseResult: 'two', timestamp: '2026-06-19T12:00:14.000Z' }),
      post(ids[3], '00000000-0000-4000-8000-00000000c002', 2, 'ocr-fix', `@main ${ADMITTED[1]}`, 'blocker', P3, 'ocr'),
      post('00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000c003', 3, 'main', `@ocr-fix ${LEAD}`, 'result', P3),
      base({ parentUuid: '00000000-0000-4000-8000-00000000c003', type: 'assistant', uuid: ids[4], requestId: 'req_fold_3', message: { id: 'msg_fold_3', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Both echoes ran.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3000, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:17.000Z' }),
      ...(leg === 'idle' ? [
        post(ids[4], '00000000-0000-4000-8000-00000000c004', 4, 'lists-writer', `@main ${IDLE[0]}`, 'ask', undefined, 'lists'),
        post(ids[4], '00000000-0000-4000-8000-00000000c005', 5, 'main', `@lists-writer ${IDLE[1]}`, 'answer'),
      ] : []),
    ]
    writeFileSync(join(projects, `${SID}.jsonl`), encode(rows))
  }
  const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
  const then = (data: string, awaitText: string, mark?: string, extra: Record<string, unknown> = {}) => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 2, awaitSettleTicks: 3, ...(mark ? { mark } : {}), ...extra })
  type Grid = Array<Array<{ c: string }>>
  const text = (grid: Grid): string[] => grid.map(line => line.map(cell => cell.c || ' ').join(''))
  const lineOf = (lines: string[], needle: string): number => lines.findIndex(line => line.includes(needle))
  const RECEIPT = /∙ 2 shell commands/
  const REPLY = 'Both echoes ran.'
  try {
    for (const [cols, rows] of [[120, 44], [80, 24]] as const) {
      for (const leg of ['idle', 'cursor', 'notice'] as const) {
        fixture(leg)
        const tag = `party-receipt-${leg}-${cols}x${rows}`
        const gridPath = join(captures, `${tag}.grid.json`)
        const sends = leg === 'notice' ? [then('', NOTICE_REPLIES[1]!, 'woken')] : leg === 'idle'
          ? [
              then('', REPLY, 'painted'),
              then(CLICK, REPLY, undefined, { targetText: '2 shell commands' }),
              then('', REPLY, 'clicked'),
              then('\x0f', REPLY),
              then('', REPLY, 'verbose'),
              then('\x0f', REPLY),
              then('', REPLY, 'verbose-off'),
            ]
          : [
              then('', REPLY, 'painted'),
              then('\x1b[1;2A', REPLY),
              then('\x1b[B', 'navigate'),
              then('\x1b[B', 'navigate'),
              then('\x1b[B', 'navigate'),
              then('\x1b[B', 'navigate'),
              then('\r', REPLY),
              then('', REPLY, 'entered'),
              then('\x1b', REPLY),
            ]
        const config = { cwd: RUNTIME_CWD, argv: ['node', DIST, '--resume', SID], cols, rows, total: 220, out: gridPath, readyText: [leg === 'notice' ? NOTICE_REPLIES[1]! : REPLY], readySettleTicks: 3, sends }
        const configPath = join(captures, `${tag}.json`)
        writeFileSync(configPath, JSON.stringify(config))
        let stderr = ''
        const code = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(driver.python, [join(import.meta.dir, 'vshot.py'), configPath], { env, timeout: vshotBudgetMs(150000), stdio: ['ignore', 'ignore', 'pipe'] })
          child.stderr.on('data', chunk => { stderr += String(chunk) })
          child.on('error', reject)
          child.on('exit', resolve)
        })
        check(`${tag}: the capture ran every send`, code === 0, stderr.slice(-600))
        if (!existsSync(gridPath)) continue
        const payload = JSON.parse(readFileSync(gridPath, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; grid: Grid }> }
        const marks = new Map((payload.marks ?? []).map(mark => [mark.label, text(mark.grid)]))
        for (const [label, lines] of [...marks, ['final', text(payload.grid)]] as Array<[string, string[]]>) {
          writeFileSync(join(captures, `${tag}-${label}.txt`), lines.join('\n') + '\n')
        }
        const stills = (payload.marks ?? []).map(mark => ({ grid: mark.grid, cols, rows, label: mark.label }))
        for (const still of stills) {
          const stillPath = join(captures, `${tag}-${still.label}.grid.json`)
          writeFileSync(stillPath, JSON.stringify(still))
          await gridToPng(stillPath, join(captures, `${tag}-${still.label}.png`))
        }
        await gridToPng(gridPath, join(captures, `${tag}.png`))
        if (leg === 'notice') {
          const lines = marks.get('woken') ?? []
          const firstReply = lineOf(lines, NOTICE_REPLIES[0]!)
          const firstReceipt = lineOf(lines, '∙ no tools ran this turn · ctx +13')
          const notice = lineOf(lines, '[Crewboard] lists-judge')
          const wakeReply = lineOf(lines, NOTICE_REPLIES[1]!)
          const wakeReceipt = lineOf(lines, '∙ no tools ran this turn · ctx +0')
          check(`${tag}: chat off resumes with a receipt under each reply and the notice between them`, firstReply >= 0 && firstReceipt > firstReply && notice > firstReceipt && wakeReply > notice && wakeReceipt > wakeReply, JSON.stringify({ firstReply, firstReceipt, notice, wakeReply, wakeReceipt }))
          check(`${tag}: the notice keeps its words and the two receipts do not count board rows`, lineOf(lines, NOTICE) >= 0 && lines.filter(line => line.includes('no tools ran this turn')).length === 2 && !lines.some(line => line.includes('board message')), lines.join('\n'))
          console.log(`  frames: ${join(captures, tag)}-*.png`)
          continue
        }
        const painted = marks.get('painted') ?? []
        const receiptAt = painted.findIndex(line => RECEIPT.test(line))
        check(`${tag}: the closed turn's receipt counts the two shell commands and the context, nothing about the board`, receiptAt >= 0 && !painted.some(line => line.includes('board message')), painted.filter(line => line.includes('shell command') || line.includes('board')).join(' | '))
        const places = (lines: string[]): number[] => {
          const found = [...ADMITTED.map(words => lineOf(lines, words.slice(0, 18))), lineOf(lines, `[main] @ocr-fix ${LEAD}`), lineOf(lines, REPLY), lines.findIndex(line => RECEIPT.test(line)), ...(leg === 'idle' ? IDLE.map(words => lineOf(lines, words.slice(0, 18))) : [])]
          return found.map(at => (at < 0 ? -1 : at - found[0]!))
        }
        const firstAt = lineOf(painted, ADMITTED[0]!.slice(0, 18)), secondAt = lineOf(painted, ADMITTED[1]!.slice(0, 18)), leadAt = lineOf(painted, `[main] @ocr-fix ${LEAD}`), replyAt = lineOf(painted, REPLY)
        check(`${tag}: the two incoming rows stand where they landed, in arrival order, before the lead row, the reply and the receipt`, firstAt >= 0 && secondAt > firstAt && leadAt > secondAt && replyAt > leadAt && receiptAt > replyAt, JSON.stringify({ firstAt, secondAt, leadAt, replyAt, receiptAt }))
        check(`${tag}: the rows keep the row shape: time, name in brackets, the words`, /\d{2}:\d{2}:\d{2} \[lists-judge\] @main The list is ready/.test(painted[firstAt] ?? '') && /\d{2}:\d{2}:\d{2} \[ocr-fix\] @main The addon faults/.test(painted[secondAt] ?? ''), `${painted[firstAt]} | ${painted[secondAt]}`)
        const everyRow = (lines: string[]): boolean => ADMITTED.every(words => lineOf(lines, words.slice(0, 18)) >= 0) && lines.filter(line => line.includes(`[main] @ocr-fix ${LEAD}`)).length === 1
        if (leg === 'idle') {
          const idleAt = IDLE.map(words => lineOf(painted, words.slice(0, 18)))
          check(`${tag}: the two idle rows stay as rows below the receipt, in order`, idleAt[0]! > receiptAt && idleAt[1]! > idleAt[0]!, JSON.stringify({ receiptAt, idleAt }))
          const clicked = marks.get('clicked') ?? []
          check(`${tag}: a click on the receipt hides nothing: every row keeps its place`, JSON.stringify(places(clicked)) === JSON.stringify(places(painted)), JSON.stringify({ painted: places(painted), clicked: places(clicked) }))
          check(`${tag}: ctrl+o keeps every row`, everyRow(marks.get('verbose') ?? []))
          check(`${tag}: ctrl+o again keeps every row`, everyRow(marks.get('verbose-off') ?? []))
        } else {
          const entered = marks.get('entered') ?? []
          check(`${tag}: the row cursor and enter hide no row and open nothing under the receipt`, everyRow(entered) && JSON.stringify(places(entered)) === JSON.stringify(places(painted)) && !entered.some(line => line.includes('board message')), JSON.stringify({ painted: places(painted), entered: places(entered) }))
        }
        check(`${tag}: no frame hides or duplicates the lead post`, [...marks.values()].every(lines => lines.filter(line => line.includes(`[main] @ocr-fix ${LEAD}`)).length === 1))
        console.log(`  frames: ${join(captures, tag)}-*.png`)
      }
    }
    writeFileSync(join(captures, 'requests.json'), JSON.stringify(api.messageRequests(), null, 2))
    check('the saved-turn captures request only automatic titles, never another conversational reply', api.messageRequests().every(request => {
      const body = request.body as { output_config?: { format?: { schema?: { required?: string[] } } }; tools?: unknown[] }
      return JSON.stringify(body.output_config?.format?.schema?.required) === '["title"]' && body.tools?.length === 0
    }))
  } finally {
    await api.close()
    if (existsSync(daemonDir)) {
      for (const worker of Object.values(readSessionWorkers(daemonDir))) if (worker.pid && worker.endedAt === undefined) { try { process.kill(worker.pid, 'SIGTERM') } catch {} }
      try { const pid = Number(readFileSync(join(daemonDir, 'daemon.pid'), 'utf8').trim()); if (pid > 1) process.kill(pid, 'SIGTERM') } catch {}
    }
  }
}

console.log(`\nswarm party receipt: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
