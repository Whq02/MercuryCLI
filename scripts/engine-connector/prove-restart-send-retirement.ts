;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import type { Message } from '../../src/types/message.js'
import type { SessionFactsV1 } from '../../src/services/engine-connector/seatProjections.js'

const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { createUserMessage } = await import('../../src/utils/messages/factories.ts')

type Send = {
  clientMessageId: string
  text: string
  sentAtMs: number
  state: 'queued' | 'taken'
  mode: 'prompt'
}
type Guts = {
  sends: Send[]
  echoRows: Map<string, Message>
  rawRecords: Message[]
  reconcileQueuedSends(facts: SessionFactsV1): void
  reconcileSends(): boolean
  paint(): void
}

let failures = 0
let checks = 0
function check(label: string, ok: boolean): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}

const now = Date.now()
const stamp = (offset: number): string => new Date(now + offset).toISOString()
function rig(text = 'please check the saved result') {
  const connector = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'runner', title: 'check', projectLabel: 'check', workspaceId: 'check', home: tmpdir() })
  const guts = connector as unknown as Guts
  const id = randomUUID()
  const row = (uuid: string, words = text, at = stamp(1000)): Message => ({ ...createUserMessage({ content: words }), uuid, timestamp: at }) as Message
  guts.sends = [{ clientMessageId: id, text, sentAtMs: now, state: 'queued', mode: 'prompt' }]
  guts.echoRows.set(id, { ...row(id, text, stamp(0)), queued: true } as Message)
  const facts = (generation: number, ids: string[] = [id], queueReady = true): void => {
    guts.reconcileQueuedSends({ runnerGeneration: generation, atMs: now + generation, queueReady, queue: ids.map(uuid => ({ uuid, value: text, mode: 'prompt' })) } as SessionFactsV1)
  }
  const land = (rows: Message[]): void => {
    guts.rawRecords = rows
    guts.reconcileSends()
    guts.paint()
  }
  facts(1)
  return { connector, guts, id, row, facts, land }
}

{
  const r = rig()
  const echo = r.guts.echoRows.get(r.id)
  r.facts(2)
  check('the new runner keeps a send its queue still lists', r.guts.sends.length === 1 && r.guts.echoRows.get(r.id) === echo)
  const twin = r.row(randomUUID())
  r.land([twin])
  check('RED on the base: a carried send retires against the fresh twin under another uuid', r.guts.sends.length === 0 && r.guts.echoRows.size === 0)
  check('RED on the base: only the transcript twin remains on the screen', r.connector.records().length === 1 && r.connector.records()[0] === twin)
}
{
  const r = rig()
  r.facts(2)
  r.land([r.row(r.id)])
  check('an unchanged identity still retires after a restart', r.guts.sends.length === 0 && r.guts.echoRows.size === 0)
}
{
  const r = rig()
  r.facts(2, [])
  check('a queued send absent from the new runner is still reported lost', r.guts.sends.length === 0 && r.guts.echoRows.size === 0 && r.connector.lostLine() !== null)
}
{
  const r = rig()
  r.land([r.row(randomUUID())])
  check('a UUID send without a generation change keeps identity-only retirement', r.guts.sends.length === 1)
}
{
  const r = rig()
  r.facts(2)
  r.land([r.row(randomUUID(), undefined, stamp(-500))])
  check('even a nearby older row cannot take a carried send', r.guts.sends.length === 1)
  r.land([r.row(randomUUID(), undefined, 'not a clock')])
  check('a row without a valid time cannot take a carried send', r.guts.sends.length === 1)
  r.land([{ ...r.row(randomUUID()), isMeta: true } as Message])
  check('a meta row cannot take a carried send', r.guts.sends.length === 1)
  r.land([r.row(randomUUID(), 'different words')])
  check('different words cannot take a carried send', r.guts.sends.length === 1)
}
{
  const r = rig()
  const second = randomUUID()
  r.guts.sends.push({ ...r.guts.sends[0]!, clientMessageId: second })
  r.guts.echoRows.set(second, r.row(second))
  r.facts(2, [r.id, second])
  const firstTwin = r.row(randomUUID())
  r.land([firstTwin])
  check('RED on the base: one text twin retires exactly one carried send', r.guts.sends.length === 1 && r.guts.echoRows.size === 1)
  r.land([firstTwin])
  check('the same row cannot retire the second send on another tick', r.guts.sends.length === 1)
  r.land([firstTwin, r.row(randomUUID(), undefined, stamp(2000))])
  check('a second fresh twin retires the second send', r.guts.sends.length === 0 && r.guts.echoRows.size === 0)
}
{
  const r = rig()
  const second = randomUUID()
  r.guts.sends.push({ ...r.guts.sends[0]!, clientMessageId: second })
  r.guts.echoRows.set(second, r.row(second))
  r.facts(2, [r.id, second])
  r.land([r.row(second)])
  check('an identity-owned row cannot also retire a same-text neighbour', r.guts.sends.length === 1 && r.guts.sends[0]?.clientMessageId === r.id)
  r.land([r.row(second)])
  check('an identity-owned row stays spent on the following tick', r.guts.sends.length === 1)
}

{
  const r = rig()
  const echo = r.guts.echoRows.get(r.id)
  r.facts(2, [], false)
  check('RED on the base: a skeleton cannot lose, take or re-stamp a queued send', r.guts.sends[0]?.state === 'queued' && r.guts.echoRows.get(r.id) === echo && r.connector.lostLine() === null)
  r.facts(2)
  r.land([r.row(randomUUID())])
  check('the first real queue still detects the deferred generation change', r.guts.sends.length === 0 && r.guts.echoRows.size === 0)
}
{
  const r = rig()
  r.facts(2, [], false)
  r.facts(2, [])
  check('only the real new queue can declare a missing send lost', r.guts.sends.length === 0 && r.guts.echoRows.size === 0 && r.connector.lostLine() !== null)
}
{
  const r = rig()
  r.guts.rawRecords = [r.row(r.id)]
  r.facts(2, [])
  check('RED on the base: an already-persisted delivery is never announced lost at the restart edge', r.guts.sends.length === 0 && r.guts.echoRows.size === 0 && r.connector.lostLine() === null)
}

console.log(`restart-send-retirement: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
