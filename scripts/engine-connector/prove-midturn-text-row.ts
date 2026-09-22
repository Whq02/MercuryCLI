#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'midturn-text-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'midturn-text-daemon-'))
delete process.env.MERCURY_HOME

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { publishSessionTail } = await import('../../src/services/engine-connector/seatProjections.ts')
const { createAssistantMessage, createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { recordTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
type Message = import('../../src/types/message.ts').Message

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — midturn-text-row prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

type Guts = {
  attached: boolean
  tick: () => Promise<void>
  readTail: () => void
  reconcileQueuedSends: (facts: unknown) => void
  reconcileSends: () => boolean
  paint: () => void
  textRows: unknown[]
  sends: Array<{ clientMessageId: string; text: string; state: string }>
  tailSeq: number | null
}

const sid = bootstrap.getSessionId()
const home = dirname(getTranscriptPathForSession(sid))
const connector = new DaemonSessionConnector({ sessionId: sid, home, workspaceId: '/tmp', title: 'rig', projectLabel: 'p' } as never)
const g = connector as unknown as Guts

let clock = Date.now() - 10_000
const later = (ms = 5): number => {
  clock += ms
  return clock
}
const feed = (tail: { text: string | null; messageId?: string; streamBlock?: 'text' | 'tool_use'; blockSinceMs?: number; phase?: 'commentary' | 'final_answer' }): void => {
  publishSessionTail({ schema: 1, sessionId: sid, atMs: later(), text: tail.text, ...(tail.messageId !== undefined ? { messageId: tail.messageId } : {}), ...(tail.streamBlock !== undefined ? { streamBlock: tail.streamBlock } : {}), ...(tail.blockSinceMs !== undefined ? { blockSinceMs: tail.blockSinceMs } : {}), ...(tail.phase !== undefined ? { phase: tail.phase } : {}) } as never)
  g.readTail.call(connector)
}
const facts = (queue: Array<{ value: string; mode: string }>, atMs: number): unknown => ({ schema: 1, sessionId: sid, atMs, busy: true, runnerGeneration: 1, queue, pendingModel: null })
const write = async (rows: unknown[]): Promise<void> => {
  await recordTranscript(rows as never)
  await flushSessionStorage()
  g.attached = true
  await g.tick.call(connector)
  g.attached = false
}
const escaped = (text: string): string => JSON.stringify(text).slice(1, -1)
const rowsWith = (text: string): Message[] => connector.records().filter(row => JSON.stringify(row).includes(escaped(text)))
const indexOf = (text: string): number => connector.records().findIndex(row => JSON.stringify(row).includes(escaped(text)))
const assistantWithId = (text: string, id: string): Message => {
  const m = createAssistantMessage({ content: text }) as unknown as { message: Record<string, unknown> }
  return { ...m, message: { ...m.message, id } } as unknown as Message
}
const notice = (id: string, words: string): string => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${words}" completed</summary>\n</task-notification>`

section('T1 the words stream: the tail holds them, the list has no row yet')
const WORDS = 'carried to the owner, waiting'
const M1 = 'msg_midturn_1'
{
  const since = later()
  feed({ text: 'carried', messageId: M1, streamBlock: 'text', blockSinceMs: since })
  feed({ text: WORDS, messageId: M1, streamBlock: 'text', blockSinceMs: since })
  check('the tail store holds the streaming words', connector.tail().read() === WORDS, String(connector.tail().read()))
  check('no row of the list carries them yet', rowsWith(WORDS).length === 0, `${rowsWith(WORDS).length}`)
  check('the anchor stands at the end of the list', connector.tailAnchor() === connector.records().length)
}

section('T2 THE DEFECT PIN: the block ends and the tool call begins — the words are a row of the list, not a ghost')
{
  feed({ text: null, messageId: M1, streamBlock: 'text' })
  feed({ text: null, messageId: M1, streamBlock: 'tool_use' })
  const rows = rowsWith(WORDS)
  const row = rows[0] as (Message & { message?: { id?: string; content?: Array<{ type?: string; text?: string }> } }) | undefined
  check('one assistant row of the list carries the words', rows.length === 1 && row?.type === 'assistant', `${rows.length} rows, first type ${row?.type}`)
  check("the row carries the message's own identity", row?.message?.id === M1, String(row?.message?.id))
  check('the row is the whole block, a text block', row?.message?.content?.[0]?.type === 'text' && row.message.content[0].text === WORDS)
  check('the tail store holds nothing and keeps no ghost', connector.tail().read() === null && connector.tail().readSettled() === null, `read=${String(connector.tail().read())} settled=${String(connector.tail().readSettled())}`)
  check('the anchor stands after the committed row', connector.tailAnchor() === connector.records().length && indexOf(WORDS) === connector.records().length - 1)
  check('the row is virtual: never a transcript record', (row as { isVirtual?: boolean } | undefined)?.isVirtual === true)
}

section('T3 a notice that arrives after the words stands after them')
const NOTE_AFTER = notice('t-after', 'the errand after the words')
{
  g.reconcileQueuedSends(facts([{ value: NOTE_AFTER, mode: 'task-notification' }], later()))
  check('the notice paints once', rowsWith(NOTE_AFTER).length === 1, `${rowsWith(NOTE_AFTER).length}`)
  check('the notice stands below the committed words', indexOf(WORDS) !== -1 && indexOf(NOTE_AFTER) !== -1 && indexOf(WORDS) < indexOf(NOTE_AFTER), `words=${indexOf(WORDS)} notice=${indexOf(NOTE_AFTER)}`)
}

section("T4 the record lands: it takes the committed row's place, the words paint once, the notice stays below")
{
  await write([assistantWithId(WORDS, M1)])
  const rows = rowsWith(WORDS)
  check('the words paint exactly once after the landing', rows.length === 1, `${rows.length}`)
  check('the standing row is the record, not the committed row', (rows[0] as { isVirtual?: boolean } | undefined)?.isVirtual !== true && g.textRows.length === 0, `virtual=${String((rows[0] as { isVirtual?: boolean } | undefined)?.isVirtual)} committed=${g.textRows.length}`)
  check('the notice still stands below the words', indexOf(WORDS) < indexOf(NOTE_AFTER), `words=${indexOf(WORDS)} notice=${indexOf(NOTE_AFTER)}`)
  g.reconcileQueuedSends(facts([], later()))
  await write([createUserMessage({ content: NOTE_AFTER }), assistantWithId('noted', 'msg_midturn_1b')])
  check("the notice's own landing retires its echo", g.sends.length === 0 && rowsWith(NOTE_AFTER).length === 1, `sends=${g.sends.length} shown=${rowsWith(NOTE_AFTER).length}`)
}

section('T5 the record already stands when the block ends: no committed row, no ghost, the words once')
const WORDS2 = 'the record landed before the clear'
const M2 = 'msg_midturn_2'
{
  const since = later()
  feed({ text: WORDS2, messageId: M2, streamBlock: 'text', blockSinceMs: since })
  await write([assistantWithId(WORDS2, M2)])
  feed({ text: null, messageId: M2, streamBlock: 'tool_use' })
  check('the words paint once', rowsWith(WORDS2).length === 1, `${rowsWith(WORDS2).length}`)
  check('no committed row was minted', g.textRows.length === 0, `${g.textRows.length}`)
  check('no ghost stands in the store', connector.tail().readSettled() === null)
}

section('T6 a tail with no identity keeps the ghost road: nothing is committed')
const WORDS3 = 'words from a runner that names no message'
{
  const since = later()
  feed({ text: WORDS3, streamBlock: 'text', blockSinceMs: since })
  feed({ text: null, streamBlock: 'tool_use' })
  check('no row of the list carries the words', rowsWith(WORDS3).length === 0, `${rowsWith(WORDS3).length}`)
  check('the store holds the ghost for the leaf to bridge', connector.tail().readSettled() === WORDS3, String(connector.tail().readSettled()))
  connector.tail().dropSettled()
}

section('T7 a prefix held at the clear retires on the whole block landing')
const M4 = 'msg_midturn_4'
{
  const since = later()
  feed({ text: 'the coalesced', messageId: M4, streamBlock: 'text', blockSinceMs: since })
  feed({ text: null, messageId: M4, streamBlock: 'tool_use' })
  check('the prefix stands as a committed row', rowsWith('the coalesced').length === 1 && g.textRows.length === 1)
  await write([assistantWithId('the coalesced prefix and the rest of the block', M4)])
  check('the whole block retires the prefix row', g.textRows.length === 0 && rowsWith('the coalesced').length === 1, `committed=${g.textRows.length} shown=${rowsWith('the coalesced').length}`)
}

section('T8 a notice held since before the words began stands above them')
const WORDS5 = 'words that began after the notice was queued'
const M5 = 'msg_midturn_5'
const NOTE_BEFORE = notice('t-before', 'the errand from before the words')
{
  const seen = later()
  const since = later(50)
  feed({ text: WORDS5, messageId: M5, streamBlock: 'text', blockSinceMs: since })
  feed({ text: null, messageId: M5, streamBlock: 'tool_use' })
  g.reconcileQueuedSends(facts([{ value: NOTE_BEFORE, mode: 'task-notification' }], seen))
  check('the notice stands above the committed words', indexOf(NOTE_BEFORE) !== -1 && indexOf(WORDS5) !== -1 && indexOf(NOTE_BEFORE) < indexOf(WORDS5), `notice=${indexOf(NOTE_BEFORE)} words=${indexOf(WORDS5)}`)
  await write([assistantWithId(WORDS5, M5)])
  g.reconcileQueuedSends(facts([], later()))
  await write([createUserMessage({ content: NOTE_BEFORE })])
  check('everything lands once', rowsWith(WORDS5).length === 1 && rowsWith(NOTE_BEFORE).length === 1 && g.textRows.length === 0)
}

section("T9 the runner's relaunch retires a committed row whose record never came")
const WORDS6 = 'words a relaunched runner never recorded'
const M6 = 'msg_midturn_6'
{
  const since = later()
  feed({ text: WORDS6, messageId: M6, streamBlock: 'text', blockSinceMs: since })
  feed({ text: null, messageId: M6, streamBlock: 'tool_use' })
  check('the words stand as a committed row', rowsWith(WORDS6).length === 1)
  g.reconcileQueuedSends({ ...(facts([], later()) as Record<string, unknown>), runnerGeneration: 2 })
  check('the relaunch retires the row', rowsWith(WORDS6).length === 0 && g.textRows.length === 0, `shown=${rowsWith(WORDS6).length}`)
}

clearTimeout(watchdog)
console.log(`\nprove-midturn-text-row: ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
