#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.MACRO = { VERSION: '1.0.0' } as any

const sandbox = mkdtempSync(join(tmpdir(), 'scoped-markread-'))
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_CONFIG_DIR = sandbox

const {
  unreadLiveMessagesFor,
  markLiveMessagesRead,
  markLiveMessagesReadWhere,
  liveCommsPath,
} = (await import('../../src/services/crew/liveComms.ts')) as typeof import('../../src/services/crew/liveComms.js')

type Msg = {
  from: string
  text: string
  timestamp: string
  read: boolean
}
const AGENT = 'worker'
const CREW = 'proofcrew'
const key = (m: { from: string; timestamp: string; text: string }) =>
  `${m.from} ${m.timestamp} ${m.text}`

function seed(messages: Msg[]): void {
  const path = liveCommsPath(CREW)
  mkdirSync(join(path, '..'), { recursive: true })
  const rows = messages.map((m, i) => ({ ...m, to: AGENT, id: `seed-${i + 1}`, seq: i + 1 }))
  writeFileSync(path, JSON.stringify({ schema: 1, crew: CREW, seq: rows.length, messages: rows, tasks: {}, busy: {} }), 'utf-8')
}

let fail = 0
function check(label: string, cond: boolean): void {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${label}`)
  if (!cond) fail = 1
}

const early: Msg = { from: 'lead', text: 'task A', timestamp: '2026-06-25T00:00:00.000Z', read: false }
const late: Msg = { from: 'lead', text: 'task B (arrived mid-window)', timestamp: '2026-06-25T00:00:01.000Z', read: false }

seed([early])
const snapshot = await unreadLiveMessagesFor(CREW, AGENT)
check('snapshot read exactly the one message present at poll time', snapshot.length === 1 && snapshot[0].text === early.text)
const deliveredKeys = new Set(snapshot.map(key))

seed([early, late])

await markLiveMessagesReadWhere(CREW, AGENT, m => deliveredKeys.has(key(m)))
const afterScoped = await unreadLiveMessagesFor(CREW, AGENT)
check('scoped mark: the mid-window arrival is STILL unread (not lost)', afterScoped.length === 1 && afterScoped[0].text === late.text)
check('scoped mark: the delivered message is now read', !afterScoped.some(m => m.text === early.text))

seed([early])
const snap2 = await unreadLiveMessagesFor(CREW, AGENT)
check('blanket scenario: snapshot is the single early message', snap2.length === 1)
seed([early, late])
await markLiveMessagesRead(CREW, AGENT)
const afterBlanket = await unreadLiveMessagesFor(CREW, AGENT)
check('blanket mark LOSES the mid-window arrival (proves the bug the fix prevents)', afterBlanket.length === 0)

rmSync(sandbox, { recursive: true, force: true })

console.log('')
if (fail) {
  console.log('# ❌ scoped mark-read TOCTOU proof FAILED')
  process.exit(1)
}
console.log('# ✅ scoped mark-read TOCTOU proof PASS (mid-window arrival survives the scoped mark; blanket loses it)')
