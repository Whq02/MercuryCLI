#!/usr/bin/env bun
import type { SessionTailV1 } from '../../src/engine/connector/seatProjections.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { TailPart } = await import('../../src/engine/connector/daemon/tail.ts')
const { ECHO_RETIRE_MS } = await import('../../src/engine/connector/daemon/shared.ts')

let failures = 0
const WHERE = 'the part under test is TailPart in src/engine/connector/daemon/tail.ts: change its behaviour there to match the check, or update this check if the law moved'
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}${WHERE}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const j = (v: unknown): string => JSON.stringify(v)

type Row = Record<string, unknown>
const realNow = Date.now
let clock = 2_000_000
Date.now = () => clock

function part(): { tail: InstanceType<typeof TailPart>; rows: Row[]; seen: { paints: number } } {
  const rows: Row[] = []
  const seen = { paints: 0 }
  const tail = new TailPart({ sessionId: () => 'tail-part', rows: () => rows as never, model: () => 'the-model', paint: () => void seen.paints++ })
  return { tail, rows, seen }
}
const says = (file: Partial<SessionTailV1>): SessionTailV1 => ({ schema: 1, sessionId: 'tail-part', atMs: clock, text: null, ...file })
const landedRow = (messageId: string, text: string): Row => ({ type: 'assistant', uuid: `row-${messageId}`, timestamp: new Date(clock).toISOString(), message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }] } })

section('§1 the words stream, then become a row of the list')
{
  const { tail, seen } = part()
  check('at rest the tail holds nothing and has no place in the order', tail.store().read() === null && tail.seq() === null && tail.committedRows().length === 0)
  const before = tail.arrivalSeqFor()
  tail.takeTail(says({ text: 'carried', messageId: 'msg_1', phase: 'commentary', blockSinceMs: clock }))
  const place = tail.seq()
  check('the first words take a place in the order, after what arrived before them', tail.store().read() === 'carried' && place !== null && place > before, `${before} · ${String(place)}`)
  tail.takeTail(says({ text: 'carried to the owner', messageId: 'msg_1', phase: 'commentary', blockSinceMs: clock }))
  check('more words of the same block keep the place', tail.store().read() === 'carried to the owner' && tail.seq() === place)
  const same = says({ text: 'carried to the owner', messageId: 'msg_1', phase: 'commentary' })
  tail.takeTail(same)
  tail.takeTail(same)
  check('the same file read again changes nothing and paints nothing', tail.store().read() === 'carried to the owner' && seen.paints === 0)
  clock += 40
  tail.takeTail(says({ text: null, messageId: 'msg_1' }))
  const [row] = tail.committedRows()
  const painted = row?.row as { type: string; isVirtual?: boolean; timestamp: string; message: { id: string; model: string; content: Array<{ type: string; text: string; phase?: string }> } } | undefined
  check('the block ending makes the words one row, at the place the tail held, and paints once', tail.committedRows().length === 1 && row?.seq === place && row.messageId === 'msg_1' && row.text === 'carried to the owner' && row.atMs === clock && seen.paints === 1 && tail.seq() === null && tail.store().read() === null, j({ seq: row?.seq, place, paints: seen.paints }))
  check("the row is a virtual assistant row under the message's own id, with the register and the model in use", painted?.type === 'assistant' && painted.isVirtual === true && painted.message.id === 'msg_1' && painted.message.model === 'the-model' && j(painted.message.content) === j([{ type: 'text', text: 'carried to the owner', phase: 'commentary' }]) && painted.timestamp === new Date(clock).toISOString(), j(painted?.message))
}

section('§2 the order: what arrives before, at and after the words')
{
  const { tail } = part()
  const since = clock
  tail.takeTail(says({ text: 'the words', messageId: 'msg_1', blockSinceMs: since }))
  const place = tail.seq()!
  check('a send seen before the block began stands just before the tail', tail.arrivalSeqFor(since - 1) === place - 1)
  const after = tail.arrivalSeqFor(since + 1)
  check('a send seen after the block began, or with no clock, stands after it', after > place && tail.arrivalSeqFor() > after)
  check('a notice taken before the block began stands just before the tail, a later one after it', tail.noticeSeqAt(since) === place - 1 && tail.noticeSeqAt(since + 1) > place)
  clock += 10
  tail.takeTail(says({ text: null, messageId: 'msg_1' }))
  const committed = tail.committedRows()[0]!
  check('with the tail gone the newest row is the mark: a send seen before its block stands just before that row', tail.seq() === null && tail.arrivalSeqFor(committed.sinceMs - 1) === committed.seq - 1 && tail.arrivalSeqFor(committed.sinceMs) > committed.seq)
  const unanchored = part()
  check('with neither tail nor row every arrival takes the next number', unanchored.tail.arrivalSeqFor(1) === 2 && unanchored.tail.noticeSeqAt(1) === 4 && unanchored.tail.arrivalSeqFor() === 6)
  const noBlockClock = part()
  noBlockClock.tail.takeTail(says({ text: 'words with no block clock', messageId: 'msg_2' }))
  check("a tail that names no block clock began at the file's own stamp", noBlockClock.tail.arrivalSeqFor(clock - 1) === noBlockClock.tail.seq()! - 1)
}

section('§3 words that are taken back, and a press of interrupt')
{
  const { tail, seen } = part()
  tail.takeTail(says({ text: 'a draft', messageId: 'msg_draft' }))
  tail.takeTail(says({ text: null, messageId: 'msg_draft' }))
  tail.takeTail(says({ text: 'kept words', messageId: 'msg_kept' }))
  tail.takeTail(says({ text: null, messageId: 'msg_kept' }))
  const paints = seen.paints
  tail.takeTail(says({ text: null, withdrawn: 'msg_draft' }))
  check('a message the runner takes back loses its row and the list paints once', j(tail.committedRows().map(r => r.messageId)) === j(['msg_kept']) && seen.paints === paints + 1)
  tail.takeTail(says({ text: null, withdrawn: 'msg_draft' }))
  check('the same word again paints nothing', seen.paints === paints + 1)
  tail.takeTail(says({ text: 'more of the draft', messageId: 'msg_draft', withdrawn: 'msg_draft' }))
  tail.takeTail(says({ text: null, messageId: 'msg_draft', withdrawn: 'msg_draft' }))
  check('words of a taken-back message still held are dropped, never a row, and leave no ghost', tail.committedRows().length === 1 && tail.store().readSettled() === null)

  const pressed = part()
  pressed.tail.takeTail(says({ text: 'said before the press', messageId: 'msg_a' }))
  pressed.tail.takeTail(says({ text: null, messageId: 'msg_a' }))
  pressed.tail.takeTail(says({ text: 'half-written', messageId: 'msg_b' }))
  const before = pressed.seen.paints
  pressed.tail.interrupted(clock)
  check('a press drops the rows of the turn and the words still streaming, and leaves no ghost', pressed.tail.committedRows().length === 0 && pressed.tail.store().read() === null && pressed.tail.store().readSettled() === null && pressed.seen.paints === before + 2, `${pressed.seen.paints - before} paints`)
  pressed.tail.takeTail(says({ text: 'half-written and more after the press', messageId: 'msg_b' }))
  check('later words of the interrupted message are not shown', pressed.tail.store().read() === null)
  pressed.tail.takeTail(says({ text: 'the next message', messageId: 'msg_c' }))
  check('the next message streams as ever', pressed.tail.store().read() === 'the next message')
  const undone = part()
  undone.tail.takeTail(says({ text: 'kept after all', messageId: 'msg_d' }))
  undone.tail.interrupted(clock)
  undone.tail.interruptUndone()
  undone.tail.takeTail(says({ text: 'kept after all, and more', messageId: 'msg_d' }))
  check('a press the carrier refused is forgotten: the message streams again', undone.tail.store().read() === 'kept after all, and more')
  const idle = part()
  idle.tail.interrupted(clock)
  check('a press with no message in the tail drops nothing and paints nothing', idle.seen.paints === 0 && idle.tail.store().read() === null)
  const remembered = part()
  remembered.tail.takeTail(says({ text: 'words', messageId: 'msg_e' }))
  remembered.tail.takeTail(says({ text: null, messageId: 'msg_e', streamBlock: 'tool_use' }))
  remembered.tail.interrupted(clock)
  remembered.tail.takeTail(says({ text: 'late words of the same message', messageId: 'msg_e' }))
  check('a press after the words ended still names the last message the tail carried', remembered.tail.store().read() === null && remembered.tail.committedRows().length === 0)
}

section('§4 rows leave when their record lands, when they grow old, and with the runner')
{
  const { tail, rows, seen } = part()
  tail.takeTail(says({ text: 'words that will land', messageId: 'msg_1' }))
  tail.takeTail(says({ text: null, messageId: 'msg_1' }))
  tail.takeTail(says({ text: 'words that never land', messageId: 'msg_2' }))
  tail.takeTail(says({ text: null, messageId: 'msg_2' }))
  check('with no record landed nothing retires', tail.retireTextRows() === false && tail.committedRows().length === 2)
  rows.push(landedRow('msg_1', 'words that will land, and the rest of the block'))
  check("a row whose record landed under its id, beginning with its words, retires", tail.retireTextRows() === true && j(tail.committedRows().map(r => r.messageId)) === j(['msg_2']))
  rows.push(landedRow('msg_2', 'other words under the same id'))
  check('a record with other words under the id retires nothing', tail.retireTextRows() === false)
  clock += ECHO_RETIRE_MS
  check('a row is kept to the last millisecond of its ten minutes', tail.retireTextRows() === false && tail.committedRows().length === 1)
  clock += 1
  check('…and retires after them', tail.retireTextRows() === true && tail.committedRows().length === 0)
  check('retiring paints nothing by itself: the tick that called it paints', seen.paints === 2)

  const restarted = part()
  restarted.tail.retireTextRowsWithRunner()
  check('a runner that restarted with no row standing paints nothing', restarted.seen.paints === 0)
  restarted.tail.takeTail(says({ text: 'words of the old runner', messageId: 'msg_old' }))
  restarted.tail.takeTail(says({ text: null, messageId: 'msg_old' }))
  restarted.tail.retireTextRowsWithRunner()
  check("a runner that restarted takes the old runner's rows with it and paints", restarted.tail.committedRows().length === 0 && restarted.seen.paints === 2)
  restarted.tail.takeTail(says({ text: 'a row before a rewind', messageId: 'msg_new' }))
  restarted.tail.takeTail(says({ text: null, messageId: 'msg_new' }))
  restarted.tail.dropCommittedRows()
  check('a rewind drops the rows and leaves the painting to the tick', restarted.tail.committedRows().length === 0 && restarted.seen.paints === 3)
}

section('§5 the window lets go')
{
  const { tail } = part()
  tail.takeTail(says({ text: 'words on the glass', messageId: 'msg_1', phase: 'final_answer' }))
  tail.detached()
  check('detached: no words, no ghost, no id, no register, no place in the order', tail.store().read() === null && tail.store().readSettled() === null && j(tail.store().readIds()) === j({ current: null, settled: null }) && j(tail.store().readPhases()) === j({ current: null, settled: null }) && tail.seq() === null)
  tail.takeTail(says({ text: 'words on the glass', messageId: 'msg_1', phase: 'final_answer' }))
  check('the same file read after the window comes back is shown again', tail.store().read() === 'words on the glass' && tail.seq() !== null)
}

Date.now = realNow
console.log(failures === 0 ? '\nprove-connector-tail-part: the part holds' : `\nprove-connector-tail-part: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
