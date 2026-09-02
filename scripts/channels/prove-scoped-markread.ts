#!/usr/bin/env bun
// Behavioral proof of the scoped mark-read TOCTOU fix (foreground inbox poll +
// headless drain). The bug: `markRead` read an `unread` SNAPSHOT, delivered it,
// then called the BLANKET `markMessagesAsRead(agent)` — which sets `read=true`
// on EVERY unread message, including any that arrived on disk between the read
// and the mark. Those mid-window arrivals were marked read WITHOUT being
// delivered ⇒ silently lost. Fix: mark only the delivered snapshot via
// `markMessagesAsReadByPredicate(agent, m => deliveredKeys.has(key(m)))`.
//
// This is a REAL behavioral proof: it seeds a real on-disk inbox (the JSON-array
// format readMailbox/markMessages* operate on, under a temp MERCURY_CONFIG_DIR),
// simulates the mid-window arrival, runs both the OLD (blanket) and NEW (scoped)
// mark, and asserts the late message survives ONLY under the scoped mark.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

globalThis.MACRO = { VERSION: '1.0.0' } as any

const sandbox = mkdtempSync(join(tmpdir(), 'scoped-markread-'))
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_CONFIG_DIR = sandbox

const mod = (await import(
  '../../src/utils/teammateMailbox.ts'
)) as typeof import('../../src/utils/teammateMailbox.js')
const {
  getInboxPath,
  readUnreadMessages,
  markMessagesAsRead,
  markMessagesAsReadByPredicate,
} = mod

type Msg = {
  from: string
  text: string
  timestamp: string
  read: boolean
}
const AGENT = 'worker'
const TEAM = 'proofteam'
const key = (m: { from: string; timestamp: string; text: string }) =>
  `${m.from} ${m.timestamp} ${m.text}`

function seed(messages: Msg[]): void {
  const path = getInboxPath(AGENT, TEAM)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(messages), 'utf-8')
}

let fail = 0
function check(label: string, cond: boolean): void {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${label}`)
  if (!cond) fail = 1
}

// --- Scenario: one message present at snapshot, a second arrives mid-window ---
const early: Msg = { from: 'lead', text: 'task A', timestamp: '2026-06-25T00:00:00.000Z', read: false }
const late: Msg = { from: 'lead', text: 'task B (arrived mid-window)', timestamp: '2026-06-25T00:00:01.000Z', read: false }

// ---------------------------------------------------------------------------
// 1. NEW scoped path — the fix. Snapshot delivers `early`; `late` lands before
//    the mark; we mark only the delivered snapshot ⇒ `late` stays unread.
// ---------------------------------------------------------------------------
seed([early])
const snapshot = await readUnreadMessages(AGENT, TEAM)
check('snapshot read exactly the one message present at poll time', snapshot.length === 1 && snapshot[0].text === early.text)
const deliveredKeys = new Set(snapshot.map(key))

// mid-window arrival: `late` is appended to the on-disk inbox AFTER the snapshot
seed([early, late])

await markMessagesAsReadByPredicate(AGENT, m => deliveredKeys.has(key(m)), TEAM)
const afterScoped = await readUnreadMessages(AGENT, TEAM)
check('scoped mark: the mid-window arrival is STILL unread (not lost)', afterScoped.length === 1 && afterScoped[0].text === late.text)
check('scoped mark: the delivered message is now read', !afterScoped.some(m => m.text === early.text))

// ---------------------------------------------------------------------------
// 2. OLD blanket path — the bug. Same race, but the blanket mark sweeps `late`
//    read though it was never delivered. This asserts the regression we fixed
//    is real (and would re-appear if someone reverts to the blanket call).
// ---------------------------------------------------------------------------
seed([early])
const snap2 = await readUnreadMessages(AGENT, TEAM)
check('blanket scenario: snapshot is the single early message', snap2.length === 1)
seed([early, late]) // mid-window arrival
await markMessagesAsRead(AGENT, TEAM) // the OLD unscoped call
const afterBlanket = await readUnreadMessages(AGENT, TEAM)
check('blanket mark LOSES the mid-window arrival (proves the bug the fix prevents)', afterBlanket.length === 0)

rmSync(sandbox, { recursive: true, force: true })

console.log('')
if (fail) {
  console.log('# ❌ scoped mark-read TOCTOU proof FAILED')
  process.exit(1)
}
console.log('# ✅ scoped mark-read TOCTOU proof PASS (mid-window arrival survives the scoped mark; blanket loses it)')
