;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { Readable, Writable } from 'node:stream'
import type { Message as MessageRow } from '../../src/types/message.js'
import type { SessionFactsV1 } from '../../src/services/engine-connector/seatProjections.js'

const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const React = (await import('react')).default
const { render, Box } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { Message } = await import('../../src/components/Message.tsx')
const { formatClock } = await import('../../src/components/messages/TranscriptNameplate.tsx')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { buildMessageLookups } = await import('../../src/utils/messages/lookups.ts')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')

type Send = { clientMessageId: string; text: string; sentAtMs: number; state: 'queued' | 'taken'; mode: 'prompt' }
type Guts = {
  sends: Send[]
  echoRows: Map<string, MessageRow>
  rawRecords: MessageRow[]
  reconcileQueuedSends(facts: SessionFactsV1): void
  reconcileSends(): boolean
  paint(): void
}
const h = React.createElement
const strip = (value: string): string => value.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

async function paint(rows: readonly MessageRow[], columns: number): Promise<string[]> {
  const normalized = normalizeMessages([...rows])
  const lookups = buildMessageLookups(normalized, [...rows])
  const stdout = Object.assign(new Writable({ write(_chunk, _encoding, done) { done() } }), { columns, rows: 51, isTTY: false }) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const body = h(Box, { flexDirection: 'column' }, ...normalized.map(message => h(Message, {
    key: message.uuid,
    message,
    messages: normalized,
    tools: [],
    commands: [],
    verbose: false,
    addMargin: false,
    shouldAnimate: false,
    shouldShowDot: false,
    isTranscriptMode: false,
    isStatic: true,
    inProgressToolUseIDs: new Set<string>(),
    progressMessagesForMessage: [],
    lookups,
    width: columns,
  })))
  const instance = await render(h(AppStateProvider, { initialState: getDefaultAppState() }, body), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  instance.unmount()
  await instance.waitUntilExit()
  return strip(instance.lastFrame()).split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '')
}

console.log('Recorded queue/facts sequence through the real connector and row painters; no runner is booted.')
for (const { sameIdentity, skeleton } of [
  { sameIdentity: true, skeleton: true },
  { sameIdentity: true, skeleton: false },
  { sameIdentity: false, skeleton: false },
]) {
  const start = Date.now() - 3 * 60_000
  const stamp = (offset: number): string => new Date(start + offset).toISOString()
  const id = randomUUID()
  const laterId = randomUUID()
  const firstWords = 'FIRST_QUEUED_WORDS'
  const laterWords = 'LATER_WORDS'
  const connector = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'runner', title: 'check', projectLabel: 'check', workspaceId: 'check', home: tmpdir() })
  const g = connector as unknown as Guts
  const facts = (generation: number, queue: Array<{ uuid: string; value: string; mode: 'prompt' }>, queueReady = true, offset = 1500): void => {
    g.reconcileQueuedSends({ runnerGeneration: generation, queue, queueReady, atMs: start + offset } as SessionFactsV1)
  }
  const before = { ...createAssistantMessage({ content: 'BEFORE_RESTART' }), timestamp: stamp(0) }
  g.rawRecords = [before]
  facts(1, [], true, 0)
  g.sends = [{ clientMessageId: id, text: firstWords, sentAtMs: start + 1000, state: 'queued', mode: 'prompt' }]
  const waiting = { ...createUserMessage({ content: firstWords }), uuid: id, timestamp: stamp(1000), queued: true } as MessageRow
  g.echoRows.set(id, waiting)
  g.paint()
  check('the waiting message occupies one queue slot', connector.records().length === 2 && connector.records()[1] === waiting)
  if (skeleton) {
    facts(2, [], false)
    check('RED on the base: the restart skeleton never loses or takes the waiting row', g.sends.length === 1 && g.echoRows.get(id) === waiting && connector.lostLine() === null)
  }
  facts(2, [{ uuid: id, value: firstWords, mode: 'prompt' }], true, 1700)
  facts(2, [], true, 2000)
  const delivered = { ...createUserMessage({ content: firstWords }), uuid: sameIdentity ? id : randomUUID(), timestamp: stamp(2000) } as MessageRow
  const answered = { ...createAssistantMessage({ content: 'FIRST_ANSWER' }), timestamp: stamp(3000) }
  g.rawRecords = [before, delivered, answered]
  g.reconcileSends()
  g.paint()
  check(`the delivered row replaces its echo (${sameIdentity ? 'same' : 'changed'} uuid)`, g.sends.length === 0 && g.echoRows.size === 0 && connector.records().length === 3)
  const firstPositions = new Map(connector.records().map((row, index) => [row.uuid, index]))
  g.sends.push({ clientMessageId: laterId, text: laterWords, sentAtMs: start + 120_000, state: 'queued', mode: 'prompt' })
  g.echoRows.set(laterId, { ...createUserMessage({ content: laterWords }), uuid: laterId, timestamp: stamp(120_000), queued: true } as MessageRow)
  facts(2, [{ uuid: laterId, value: laterWords, mode: 'prompt' }], true, 120_000)
  const later = { ...createUserMessage({ content: laterWords }), uuid: laterId, timestamp: stamp(121_000) } as MessageRow
  const final = { ...createAssistantMessage({ content: 'FINAL_ANSWER' }), timestamp: stamp(122_000) }
  g.rawRecords = [before, delivered, answered, later, final]
  g.reconcileSends()
  g.paint()
  const rows = connector.records()
  check(`${sameIdentity ? '' : 'RED on the base: '}no echo remains below the last answer after later words arrive`, rows.length === 5 && rows[4] === final && g.echoRows.size === 0 && g.sends.length === 0)
  check('every transcript row keeps its already-painted position', rows.every((row, index) => !firstPositions.has(row.uuid) || firstPositions.get(row.uuid) === index))
  check('the final transcript stands in timestamp order without sorting', rows.every((row, index) => index === 0 || Date.parse(rows[index - 1]!.timestamp) <= Date.parse(row.timestamp)))
  for (const columns of [178, 120]) {
    const frame = await paint(rows, columns)
    const first = frame.findIndex(line => line.includes(firstWords))
    const last = frame.findIndex(line => line.includes('FINAL_ANSWER'))
    check(`${columns} columns: the queued message paints exactly once before the later message`, first >= 0 && frame.filter(line => line.includes(firstWords)).length === 1 && first < frame.findIndex(line => line.includes(laterWords)), frame.join('\n'))
    check(`${columns} columns: its plate carries delivery time`, first >= 0 && frame[first]!.includes(formatClock(delivered.timestamp)!), frame.join('\n'))
    check(`${columns} columns: nothing paints beneath the final answer`, last >= 0 && last === frame.length - 1, frame.join('\n'))
    check(`${columns} columns: no stale queued plate survives`, !frame.some(line => /\bqueued\b|\bheld\b/.test(line)), frame.join('\n'))
  }
}

console.log(`restart-queue-order: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
