#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'notice-landing-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'notice-landing-daemon-'))
delete process.env.MERCURY_HOME

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
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
  console.log('\nTIMEOUT — notice-row-landing prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

const notice = (id: string, words: string): string =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${words}" completed</summary>\n</task-notification>`

type Send = { clientMessageId: string; text: string; sentAtMs: number; state: 'pending' | 'delivered' | 'queued' | 'taken' }
type Guts = {
  sends: Send[]
  echoRows: Map<string, Message & { queued?: true }>
  attached: boolean
  tick: () => Promise<void>
  reconcileQueuedSends: (facts: unknown) => void
  reconcileSends: () => boolean
  paint: () => void
}

const sid = bootstrap.getSessionId()
const home = dirname(getTranscriptPathForSession(sid))
const connector = new DaemonSessionConnector({ sessionId: sid, home, workspaceId: '/tmp', title: 'rig', projectLabel: 'p' } as never)
const g = connector as unknown as Guts

const facts = (queue: Array<{ value: string; mode: string }>, atMs = Date.now()): unknown => ({
  schema: 1,
  sessionId: sid,
  atMs,
  busy: queue.length > 0,
  runnerGeneration: 1,
  queue,
  pendingModel: null,
})
const write = async (rows: unknown[]): Promise<void> => {
  await recordTranscript(rows as never)
  await flushSessionStorage()
  g.attached = true
  await g.tick.call(connector)
  g.attached = false
}
const escaped = (text: string): string => JSON.stringify(text).slice(1, -1)
const timesShown = (text: string): number => {
  const json = JSON.stringify(connector.records())
  const needle = escaped(text)
  let n = 0
  let at = json.indexOf(needle)
  while (at >= 0) {
    n++
    at = json.indexOf(needle, at + needle.length)
  }
  return n
}
const sendOf = (text: string): Send | undefined => g.sends.find(s => s.text === text)

section('N5 a notice taken between turns: its placeholder retires on the user-row landing, and the chat shows the row once')
{
  const NOTE = notice('t-between', 'the between-turns errand')
  g.reconcileQueuedSends(facts([{ value: NOTE, mode: 'task-notification' }]))
  check('the seat paints the placeholder the moment the facts carry the notice, queued', sendOf(NOTE)?.state === 'queued' && timesShown(NOTE) === 1, `state=${sendOf(NOTE)?.state} shown=${timesShown(NOTE)}`)
  g.reconcileQueuedSends(facts([]))
  check('the runner takes it: the placeholder reads taken and still paints once', sendOf(NOTE)?.state === 'taken' && timesShown(NOTE) === 1, `state=${sendOf(NOTE)?.state} shown=${timesShown(NOTE)}`)
  await write([
    createUserMessage({ content: NOTE }),
    createAssistantMessage({ content: 'noted: the errand reported' }),
    createUserMessage({ content: 'one more message' }),
    createAssistantMessage({ content: 'heard: one more message' }),
  ])
  check("the transcript's own user row retires the placeholder", sendOf(NOTE) === undefined && g.echoRows.size === 0, `sends=${JSON.stringify(g.sends.map(s => [s.text.slice(0, 40), s.state]))}`)
  check('the chat shows the notice once, never a ghost under the newer message', timesShown(NOTE) === 1, `shown=${timesShown(NOTE)}`)
  const painted = connector.records()
  const noteAt = painted.findIndex(row => JSON.stringify(row).includes(escaped(NOTE)))
  const lastAt = painted.length - 1
  check('the newest message is the last row painted', noteAt >= 0 && noteAt < lastAt && JSON.stringify(painted[lastAt]).includes('heard: one more message'))
}

section('N6 a notice taken mid-turn still retires on the attachment landing')
{
  const NOTE = notice('t-midturn', 'the mid-turn errand')
  g.reconcileQueuedSends(facts([{ value: NOTE, mode: 'task-notification' }]))
  g.reconcileQueuedSends(facts([]))
  check('the placeholder stands taken before the drain lands', sendOf(NOTE)?.state === 'taken' && timesShown(NOTE) === 1)
  await write([
    createAttachmentMessage({ type: 'queued_command', prompt: NOTE, commandMode: 'task-notification' } as never),
    createAssistantMessage({ content: 'noted: the mid-turn errand reported' }),
  ])
  check("the drain's attachment row retires the placeholder", sendOf(NOTE) === undefined, JSON.stringify(g.sends.map(s => [s.text.slice(0, 40), s.state])))
  check('the chat shows that notice once', timesShown(NOTE) === 1, `shown=${timesShown(NOTE)}`)
}

section('N7 a notice that never lands retires at ten minutes, and never before')
{
  const NOTE = notice('t-never', 'the errand nobody drained')
  g.reconcileQueuedSends(facts([{ value: NOTE, mode: 'task-notification' }]))
  g.reconcileQueuedSends(facts([]))
  const send = sendOf(NOTE)
  check('taken, unlanded: the row stands', send?.state === 'taken' && timesShown(NOTE) === 1)
  g.sends = g.sends.map(s => (s.text === NOTE ? { ...s, sentAtMs: s.sentAtMs - 9 * 60_000 } : s))
  g.reconcileSends()
  check('nine minutes in, the row still stands', sendOf(NOTE) !== undefined && timesShown(NOTE) === 1)
  g.sends = g.sends.map(s => (s.text === NOTE ? { ...s, sentAtMs: s.sentAtMs - 2 * 60_000 } : s))
  const moved = g.reconcileSends()
  g.paint()
  check('past ten minutes the backstop retires it', moved && sendOf(NOTE) === undefined && timesShown(NOTE) === 0, `shown=${timesShown(NOTE)}`)
}

section('N8 an older row carrying the same words never lands a newer notice')
{
  const NOTE = notice('t-old', 'the errand from an earlier life')
  const old = new Date(Date.now() - 20_000).toISOString()
  await write([{ ...(createUserMessage({ content: NOTE }) as unknown as Record<string, unknown>), timestamp: old }])
  g.reconcileQueuedSends(facts([{ value: NOTE, mode: 'task-notification' }]))
  g.reconcileQueuedSends(facts([]))
  g.reconcileSends()
  g.paint()
  check('the old-history row leaves the new placeholder standing', sendOf(NOTE)?.state === 'taken' && timesShown(NOTE) === 2, `state=${sendOf(NOTE)?.state} shown=${timesShown(NOTE)}`)
  await write([createUserMessage({ content: NOTE })])
  check('the fresh row lands it', sendOf(NOTE) === undefined && timesShown(NOTE) === 2, `shown=${timesShown(NOTE)}`)
}

clearTimeout(watchdog)
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
