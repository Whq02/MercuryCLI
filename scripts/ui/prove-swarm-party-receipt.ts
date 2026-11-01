#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import React from 'react'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const { injectTurnReceipts, injectRetainedChatRows, foldedTurnReceipts, retainedChatRows, hasActivity, boardMessagesWords, isTurnBoundary } = await import('../../src/utils/cockpit/turnReceipt.ts')
const { isNavigableMessage, copyTextOf, MESSAGE_ACTIONS } = await import('../../src/components/messageActions.tsx')
type Row = Record<string, unknown>
const prompt = (text: string, uuid: string): Row => ({ type: 'user', uuid, message: { role: 'user', content: text } })
const toolUse = (name: string, uuid: string): Row => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${uuid}`, name, input: {} }] } })
const reply = (text: string, uuid: string, input?: number): Row => ({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }], ...(input === undefined ? {} : { usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) } })
const chat = (uuid: string, seq: number, name: string, content: string, turnId?: string, kind = 'result'): Row => ({
  type: 'system', subtype: 'crew_chat', content, level: 'info', uuid, timestamp: `2026-11-01T08:00:${String(seq).padStart(2, '0')}.000Z`,
  seq, name, authorRole: 'peer', kind, mentions: ['main'], addresses: ['main'], ...(turnId === undefined ? {} : { turnId }),
})
const inject = (rows: Row[], open = false) => injectTurnReceipts(injectRetainedChatRows(rows as never), TEMP_ROOT, open) as Row[]
const shape = (rows: Row[]): string[] => rows.map(row => row.type === 'turn_receipt' ? `receipt:${String(row.uuid).replace(/-turn-receipt$/, '')}` : String(row.uuid))
const receiptOf = (rows: Row[], anchor: string) => rows.find(row => row.type === 'turn_receipt' && row.uuid === `${anchor}-turn-receipt`) as { counts: { boardMessages: number; commands: number }; board?: Array<{ uuid: string; content: string }> } | undefined

section('words')
check('zero adds nothing', boardMessagesWords(0) === null)
check('one is singular', boardMessagesWords(1) === '1 board message')
check('many are plural', boardMessagesWords(14) === '14 board messages', String(boardMessagesWords(14)))

section('a board row is never a turn boundary')
check('a crew_chat row is not a boundary', !isTurnBoundary(chat('c0', 1, 'alpha', 'x', 'p1') as never))
check('a virtual user row (the off-state Crewboard notice) is not a boundary either', !isTurnBoundary({ type: 'user', isVirtual: true, message: { role: 'user', content: '<crew-board>{}</crew-board>' } } as never))
const split = inject([prompt('go', 'p1'), toolUse('Bash', 'a1'), chat('c1', 1, 'alpha', 'one', 'p1'), toolUse('Bash', 'a2'), reply('done', 'a3'), prompt('next', 'p2')])
check('two shell commands around an admitted row stay one turn: one receipt, 2 commands, 1 board message', receiptOf(split, 'p1')?.counts.commands === 2 && receiptOf(split, 'p1')?.counts.boardMessages === 1 && shape(split).filter(s => s.startsWith('receipt')).length === 1, JSON.stringify(shape(split)))

section('count 0, 1 and many; the fold at close; idle rows stay below the receipt')
const none = inject([prompt('plain', 'p1'), toolUse('Bash', 'a1'), reply('done', 'a2'), prompt('next', 'p2')])
check('a turn without board rows counts zero and carries no rows', receiptOf(none, 'p1')?.counts.boardMessages === 0 && receiptOf(none, 'p1')?.board === undefined)
const one = inject([prompt('one', 'p1'), toolUse('Bash', 'a1'), chat('c1', 1, 'alpha', 'the one', 'p1'), reply('done', 'a2'), prompt('next', 'p2')])
check('one admitted row folds: the row leaves the transcript and the receipt carries it', receiptOf(one, 'p1')?.counts.boardMessages === 1 && receiptOf(one, 'p1')?.board?.[0]?.uuid === 'c1' && !one.some(row => row.uuid === 'c1'), JSON.stringify(shape(one)))
const many = [prompt('many', 'p1'), toolUse('Bash', 'a1'), chat('c2', 2, 'beta', 'second', 'p1'), chat('c1', 1, 'alpha', 'first', 'p1'), toolUse('Bash', 'a2'), chat('c3', 3, 'gamma', 'third', 'p1'), reply('done', 'a3'), chat('c4', 4, 'alpha', 'idle one'), chat('c5', 5, 'beta', 'idle two'), prompt('next', 'p2'), reply('ok', 'a4')]
const folded = inject(many)
check('three admitted rows fold into one receipt, in board sequence order', receiptOf(folded, 'p1')?.counts.boardMessages === 3 && JSON.stringify(receiptOf(folded, 'p1')?.board?.map(row => row.uuid)) === '["c1","c2","c3"]', JSON.stringify(receiptOf(folded, 'p1')?.board?.map(row => row.uuid)))
check('the receipt sits after the turn\'s last content row and before the first idle row; the idle rows stay as rows', JSON.stringify(shape(folded)) === JSON.stringify(['p1', 'a1', 'a2', 'a3', 'receipt:p1', 'c4', 'c5', 'p2', 'a4', 'receipt:p2']), JSON.stringify(shape(folded)))
check('idle rows are not counted by the turn before them or the turn after them', receiptOf(folded, 'p2')?.counts.boardMessages === 0)
const before = inject([chat('c0', 1, 'alpha', 'before any prompt'), prompt('first', 'p1'), toolUse('Bash', 'a1'), reply('done', 'a2')])
check('a row before the first prompt stays where it is', shape(before)[0] === 'c0' && receiptOf(before, 'p1')?.counts.boardMessages === 0, JSON.stringify(shape(before)))

section('a board-only turn gets a receipt; an open turn keeps its rows on screen')
const boardOnly = inject([prompt('ask the crew', 'p1'), chat('c1', 1, 'alpha', 'answer', 'p1'), reply('they said so', 'a1'), prompt('next', 'p2')])
check('a turn with no tool and one admitted row has activity and a receipt of 1 board message', hasActivity(receiptOf(boardOnly, 'p1')!.counts as never) && receiptOf(boardOnly, 'p1')?.counts.boardMessages === 1)
const cut = inject([prompt('cut short', 'p1'), chat('c1', 1, 'alpha', 'arrived', 'p1'), prompt('next', 'p2')])
check('a turn with no reply and no tool but an admitted row still mints its receipt (the row is never lost)', receiptOf(cut, 'p1')?.counts.boardMessages === 1 && !cut.some(row => row.uuid === 'c1'))
const open = inject(many.slice(0, 7), true)
check('while the tail turn runs its admitted rows stay visible and its receipt counts none of them', open.some(row => row.uuid === 'c1') && open.some(row => row.uuid === 'c3') && (receiptOf(open, 'p1')?.counts.boardMessages ?? 0) === 0, JSON.stringify(shape(open)))
const closed = inject(many.slice(0, 7))
check('the same rows fold the moment the turn closes', JSON.stringify(shape(closed)) === JSON.stringify(['p1', 'a1', 'a2', 'a3', 'receipt:p1']), JSON.stringify(shape(closed)))
const earlierOpen = inject(many, true)
check('an open tail folds nothing of the earlier closed turns', receiptOf(earlierOpen, 'p1')?.counts.boardMessages === 3 && !earlierOpen.some(row => row.uuid === 'c1'))

section('MERCURY_TURN_RECEIPT=0 keeps every row in place')
process.env.MERCURY_TURN_RECEIPT = '0'
check('the injector returns its input untouched: admitted rows stay expanded in place', injectTurnReceipts(many as never, TEMP_ROOT) === (many as never))
process.env.MERCURY_TURN_RECEIPT = '1'

section('compaction keeps the admitted rows behind the receipt and the idle rows as rows')
const kept = many.slice(9)
const carried = foldedTurnReceipts(many as never, kept as never, 'sum', TEMP_ROOT)
const idle = retainedChatRows(many as never, kept as never, 'sum')
const retained = carried.find(receipt => receipt.beforeUuid === 'sum')
check('a fully folded turn leaves one retained receipt on the summary with its three admitted rows, complete', retained !== undefined && retained.counts.boardMessages === 3 && JSON.stringify(retained.board?.map(row => row.uuid)) === '["c1","c2","c3"]' && retained.board?.every(row => typeof row.content === 'string' && row.content !== '') === true, JSON.stringify(carried))
check('its idle rows are retained apart, anchored on the summary, whole and uncounted', JSON.stringify(idle.map(group => [group.after, group.rows.map(row => row.uuid)])) === '[["sum",["c4","c5"]]]' && idle[0]!.rows.every(row => row.turnId === undefined && row.content !== ''), JSON.stringify(idle))
const boundary = (receipts: unknown, retainedIdle: unknown, uuid = 'cb'): Row => ({ type: 'system', subtype: 'compact_boundary', uuid, compactMetadata: { work: { receipts, idle: retainedIdle, recap: { turns: 1, toolCounts: [], files: [], toolFailures: 0, failedToolUseIds: [] } } } })
const summary: Row = { type: 'user', uuid: 'sum', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'The summary.' } }
const afterFold = inject([boundary(carried, idle), summary, ...kept])
check('after the fold: the summary, the receipt with its three rows expandable, the two idle rows as rows, then the kept turn', JSON.stringify(shape(afterFold)) === JSON.stringify(['cb', 'sum', 'receipt:p1', 'c4', 'c5', 'p2', 'a4', 'receipt:p2']) && receiptOf(afterFold, 'p1')?.board?.length === 3, JSON.stringify(shape(afterFold)))
process.env.MERCURY_TURN_RECEIPT = '0'
check('with the receipt switch off the retained idle rows still paint after the summary', JSON.stringify(shape(inject([boundary(carried, idle), summary, ...kept]))) === JSON.stringify(['cb', 'sum', 'c4', 'c5', 'p2', 'a4']), JSON.stringify(shape(inject([boundary(carried, idle), summary, ...kept]))))
process.env.MERCURY_TURN_RECEIPT = '1'
const partialKept = many.slice(4)
const partial = foldedTurnReceipts(many as never, partialKept as never, 'sum', TEMP_ROOT)
const afterPartial = inject([boundary(partial, retainedChatRows(many as never, partialKept as never, 'sum')), summary, ...partialKept])
check('a turn cut by the fold carries its folded rows onto its surviving part: count and rows agree, kept rows are not doubled', receiptOf(afterPartial, 'p1')?.counts.boardMessages === 3 && JSON.stringify(receiptOf(afterPartial, 'p1')?.board?.map(row => row.uuid)) === '["c1","c2","c3"]' && retainedChatRows(many as never, partialKept as never, 'sum').length === 0 && shape(afterPartial).filter(id => id === 'c4').length === 1, JSON.stringify(shape(afterPartial)))
const folded2 = [boundary(carried, idle), summary, ...kept]
const again = foldedTurnReceipts(folded2 as never, [kept[0]!, kept[1]!] as never, 'sum2', TEMP_ROOT)
const idle2 = retainedChatRows(folded2 as never, [kept[0]!, kept[1]!] as never, 'sum2')
const twice = inject([boundary(again, idle2, 'cb2'), { ...summary, uuid: 'sum2' }, kept[0]!, kept[1]!])
check('a second compaction carries the receipt rows and the idle rows again, each event once, re-anchored on the new summary', receiptOf(twice, 'p1')?.counts.boardMessages === 3 && JSON.stringify(shape(twice)) === JSON.stringify(['cb2', 'sum2', 'receipt:p1', 'c4', 'c5', 'p2', 'a4', 'receipt:p2']), JSON.stringify({ shape: shape(twice), idle2 }))

section('the receipt with rows is navigable and clickable; without rows it stays as it was')
const withRows = receiptOf(folded, 'p1')!
const withoutRows = receiptOf(none, 'p1')!
check('navigable only when it carries rows', isNavigableMessage(withRows as never) && !isNavigableMessage(withoutRows as never))
check('enter expands it from the row cursor', MESSAGE_ACTIONS.some(action => action.key === 'enter' && action.types.includes('turn_receipt')))
check('copy takes the rows\' words', copyTextOf(withRows as never) === '[alpha] first\n[beta] second\n[gamma] third', JSON.stringify(copyTextOf(withRows as never)))
const messagesSrc = readFileSync(join(ROOT, 'src', 'components', 'Messages.tsx'), 'utf8')
check('a click toggles it (Messages.tsx counts a receipt with rows as clickable and opens the fold on the loading flag)', /message\.type === 'turn_receipt'\) return \(message\.board\?\.length \?\? 0\) > 0/.test(messagesSrc) && /turnOpen: isLoading/.test(messagesSrc))
check('Message.tsx hands the row its verbose flag', /<TurnReceiptRow message=\{message\} verbose=\{verbose\} \/>/.test(readFileSync(join(ROOT, 'src', 'components', 'Message.tsx'), 'utf8')))

section('the painted words')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { render, Box, flushPendingSyncWork } = await import('../../src/ink.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { TurnReceiptRow } = await import('../../src/components/messages/TurnReceiptRow.js')
async function paint(message: Row, verbose: boolean, columns = 120): Promise<string[]> {
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows: 24 }) as unknown as NodeJS.WriteStream
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const node = React.createElement(TerminalSizeContext.Provider, { value: { columns, rows: 24 } },
    React.createElement(Box, { flexDirection: 'column', width: columns }, React.createElement(TurnReceiptRow, { message: message as never, verbose })))
  const instance = await render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first
  flushPendingSyncWork()
  const frame = stripAnsi(instance.lastFrame()).replace(/\n$/, '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return frame.split('\n').filter(line => line.trim() !== '')
}
const words = (counts: Partial<Record<string, number>>, extra: Row = {}): Row => ({ type: 'turn_receipt', uuid: 'w-turn-receipt', counts: { scratchpadEdits: 0, fileEdits: 0, adds: 0, dels: 0, reads: 0, searches: 0, fetches: 0, commands: 0, browser: 0, agents: 0, delegatedTokens: 0, delegatedCostUSD: 0, delegatedUnpriced: 0, boardMessages: 0, tools: {}, ...counts }, ...extra })
check('the owner\'s line: ∙ 2 shell commands · ctx +1.8k ∙ 14 board messages', (await paint(words({ commands: 2, boardMessages: 14 }, { contextDelta: 1800 }), false))[0] === '∙ 2 shell commands · ctx +1.8k ∙ 14 board messages', (await paint(words({ commands: 2, boardMessages: 14 }, { contextDelta: 1800 }), false))[0])
check('with no other item: ∙ 1 board message, and never the no-tools words', (await paint(words({ boardMessages: 1 }), false))[0] === '∙ 1 board message')
check('a context delta alone keeps its place before the board item', (await paint(words({ boardMessages: 3 }, { contextDelta: 600 }), false))[0] === '∙ ctx +600 ∙ 3 board messages')
check('without board rows the line is as it was', (await paint(words({ commands: 2 }, { contextDelta: 1800 }), false))[0] === '∙ 2 shell commands · ctx +1.8k' && (await paint(words({}), false))[0] === '∙ no tools ran this turn')
const expanded = await paint({ ...withRows, uuid: 'w-turn-receipt' } as Row, true)
check('expanded, the rows paint beneath the line in board order with their time and name', expanded.length === 4 && expanded[1]!.includes('[alpha]') && expanded[1]!.includes('first') && expanded[2]!.includes('[beta]') && expanded[3]!.includes('[gamma]'), JSON.stringify(expanded))
check('collapsed, only the line paints', (await paint({ ...withRows, uuid: 'w-turn-receipt' } as Row, false)).length === 1)

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
  const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
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
    seq, name, ...(team === undefined ? {} : { team }), authorRole: 'peer', kind, mentions: ['main'], addresses: ['main'], ...(turnId === undefined ? {} : { turnId }),
  })
  const ADMITTED = ['The list is ready, eighteen rows.', 'The addon faults on the second image.', 'Read the fence first.']
  const IDLE = ['May I take the README row?', 'Yes, the README row is yours.']
  const fixture = (idle: boolean) => {
    const rows = [
      base({ parentUuid: null, type: 'user', uuid: P3, message: { role: 'user', content: 'fold the board' }, timestamp: '2026-06-19T12:00:09.000Z' }),
      base({ parentUuid: P3, type: 'assistant', uuid: ids[0], requestId: 'req_fold_1', message: { id: 'msg_fold_1', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'toolu_fold1', name: 'Bash', input: { command: 'echo one', description: 'First' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:10.000Z' }),
      base({ parentUuid: ids[0], type: 'user', uuid: ids[1], message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fold1', content: 'one' }] }, toolUseResult: 'one', timestamp: '2026-06-19T12:00:11.000Z' }),
      post(ids[1], '00000000-0000-4000-8000-00000000c001', 1, 'lists-judge', `@main ${ADMITTED[0]}`, 'result', P3, 'lists'),
      base({ parentUuid: '00000000-0000-4000-8000-00000000c001', type: 'assistant', uuid: ids[2], requestId: 'req_fold_2', message: { id: 'msg_fold_2', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'toolu_fold2', name: 'Bash', input: { command: 'echo two', description: 'Second' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 2400, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:13.000Z' }),
      base({ parentUuid: ids[2], type: 'user', uuid: ids[3], message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fold2', content: 'two' }] }, toolUseResult: 'two', timestamp: '2026-06-19T12:00:14.000Z' }),
      post(ids[3], '00000000-0000-4000-8000-00000000c002', 2, 'ocr-fix', `@main ${ADMITTED[1]}`, 'blocker', P3, 'ocr'),
      post('00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000c003', 3, 'main', `@ocr-fix ${ADMITTED[2]}`, 'result', P3),
      base({ parentUuid: '00000000-0000-4000-8000-00000000c003', type: 'assistant', uuid: ids[4], requestId: 'req_fold_3', message: { id: 'msg_fold_3', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Both echoes ran.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3000, output_tokens: 1 } }, timestamp: '2026-06-19T12:00:17.000Z' }),
      ...(idle ? [
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
  const RECEIPT = /∙ 2 shell commands(?: · ctx [+−][\d.]+[kM]?)? ∙ 3 board messages/
  const closed = { awaitPattern: `^(?![\\s\\S]*${ADMITTED[2]!.replace(/[.]/g, '\\.')})[\\s\\S]*board messages` }
  try {
    for (const [cols, rows] of [[120, 44], [80, 24]] as const) {
      for (const leg of ['idle', 'cursor'] as const) {
        fixture(leg === 'idle')
        const tag = `party-receipt-${leg}-${cols}x${rows}`
        const gridPath = join(captures, `${tag}.grid.json`)
        const sends = leg === 'idle'
          ? [
              then('', 'board messages', 'folded'),
              then(CLICK, 'board messages', undefined, { targetText: 'board messages' }),
              then('', ADMITTED[2]!, 'clicked'),
              then(CLICK, 'board messages', undefined, { targetText: 'board messages' }),
              then('', 'board messages', 'clicked-again', closed),
              then('\x0f', 'board messages'),
              then('', ADMITTED[2]!, 'verbose'),
              then('\x0f', 'board messages'),
              then('', 'board messages', 'verbose-off', closed),
            ]
          : [
              then('', 'board messages', 'folded'),
              then('\x1b[1;2A', 'board messages'),
              then('\x1b[B', 'navigate'),
              then('\x1b[B', 'navigate'),
              then('\x1b[B', 'navigate'),
              then('\r', 'enter expand'),
              then('', ADMITTED[2]!, 'entered'),
              then('\r', 'enter collapse'),
              then('', 'board messages', 'entered-again', closed),
              then('\x1b', 'enter expand'),
            ]
        const config = { cwd: RUNTIME_CWD, argv: ['node', DIST, '--resume', SID], cols, rows, total: 220, out: gridPath, readyText: ['board messages'], readySettleTicks: 3, sends }
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
        const foldedLines = marks.get('folded') ?? []
        const receiptAt = foldedLines.findIndex(line => RECEIPT.test(line))
        check(`${tag}: the closed turn's line reads ∙ 2 shell commands · ctx ∙ 3 board messages`, receiptAt >= 0, foldedLines.filter(line => line.includes('board')).join(' | '))
        check(`${tag}: the three admitted rows are behind the receipt, not on the screen`, ADMITTED.every(words => lineOf(foldedLines, words.slice(0, 18)) < 0), foldedLines.filter(line => ADMITTED.some(words => line.includes(words.slice(0, 18)))).join(' | '))
        if (leg === 'idle') {
          const idleAt = IDLE.map(words => lineOf(foldedLines, words.slice(0, 18)))
          check(`${tag}: the two idle rows stay as rows below the receipt, in order`, idleAt[0]! > receiptAt && idleAt[1]! > idleAt[0]!, JSON.stringify({ receiptAt, idleAt }))
          const clicked = marks.get('clicked') ?? []
          const opened = ADMITTED.map(words => lineOf(clicked, words.slice(0, 18)))
          const clickedReceipt = clicked.findIndex(line => RECEIPT.test(line))
          check(`${tag}: a click opens the receipt: the three rows paint beneath it in board order, above the idle rows`, opened.every(at => at > clickedReceipt) && opened[0]! < opened[1]! && opened[1]! < opened[2]! && opened[2]! < lineOf(clicked, IDLE[0]!.slice(0, 18)), JSON.stringify({ clickedReceipt, opened }))
          check(`${tag}: the rows keep the row shape: time, name in brackets, the words`, /\d{2}:\d{2}:\d{2} \[lists-judge\] @main The list is ready/.test(clicked[opened[0]!] ?? ''), clicked[opened[0]!] ?? '')
          check(`${tag}: a second click closes it`, ADMITTED.every(words => lineOf(marks.get('clicked-again') ?? [], words.slice(0, 18)) < 0))
          check(`${tag}: ctrl+o shows the same rows`, ADMITTED.every(words => lineOf(marks.get('verbose') ?? [], words.slice(0, 18)) >= 0))
          check(`${tag}: ctrl+o again hides them`, ADMITTED.every(words => lineOf(marks.get('verbose-off') ?? [], words.slice(0, 18)) < 0))
        } else {
          const entered = marks.get('entered') ?? []
          check(`${tag}: enter on the selected receipt opens it`, ADMITTED.every(words => lineOf(entered, words.slice(0, 18)) >= 0) && lineOf(entered, 'enter collapse') >= 0, entered.filter(line => line.includes('enter ')).join(' | '))
          check(`${tag}: enter again closes it`, ADMITTED.every(words => lineOf(marks.get('entered-again') ?? [], words.slice(0, 18)) < 0))
        }
        console.log(`  frames: ${join(captures, tag)}-*.png`)
      }
    }
  } finally {
    if (existsSync(daemonDir)) {
      for (const worker of Object.values(readSessionWorkers(daemonDir))) if (worker.pid && worker.endedAt === undefined) { try { process.kill(worker.pid, 'SIGTERM') } catch {} }
      try { const pid = Number(readFileSync(join(daemonDir, 'daemon.pid'), 'utf8').trim()); if (pid > 1) process.kill(pid, 'SIGTERM') } catch {}
    }
  }
}

console.log(`\nswarm party receipt: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
