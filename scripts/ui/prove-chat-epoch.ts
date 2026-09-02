#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-chat-epoch.ts
//  PROOF: the cockpit CHAT glance tails the
//  scribe team's inbox FILES, which outlive sessions — tonight's operator
//  screenshot rendered Jun-18 escalates ("Blocked creating /U…") beside a
//  live Jul-6 session as if they were the current conversation.
//    A. crewChatRowsFromMailbox(sinceMs) — pre-epoch rows drop, post-epoch
//       stay, boundary is inclusive, 0/undefined = no filter (explicit opt-out).
//    B. The engage epoch — setScribeMode(true) stamps it, off clears it,
//       re-engage refreshes it.
//    C. Source lock — the rail passes the epoch (engage time, boot-time floor
//       for role-env launches).
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-chat-epoch.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const rows = await import('../../src/utils/cockpit/crewChatRows.js')
const mode = await import('../../src/utils/scribeMode.js')

section('A. sinceMs filter truth table')
const envText = (task: string) =>
  JSON.stringify({ type: 'scribe_protocol', kind: 'dispatch', request_id: 'r', from: 'team-lead', timestamp: 'x', task })
const EPOCH = Date.parse('2026-07-06T20:00:00.000Z')
const inboxes = [
  {
    inbox: 'implementer',
    messages: [
      { from: 'team-lead', text: envText('june ghost'), timestamp: '2026-06-18T11:57:32.816Z' },
      { from: 'team-lead', text: envText('at the boundary'), timestamp: '2026-07-06T20:00:00.000Z' },
      { from: 'team-lead', text: envText('tonight'), timestamp: '2026-07-06T20:50:54.386Z' },
    ],
  },
]
const filtered = rows.crewChatRowsFromMailbox(inboxes, 10, EPOCH)
check('pre-epoch June ghost dropped', !filtered.some(r => r.gist.includes('june ghost')), JSON.stringify(filtered.map(r => r.gist)))
check('boundary row kept (inclusive)', filtered.some(r => r.gist.includes('at the boundary')))
check('live row kept', filtered.some(r => r.gist.includes('tonight')))
const unfiltered = rows.crewChatRowsFromMailbox(inboxes, 10)
check('no epoch ⇒ no filter (3 rows)', unfiltered.length === 3, `len=${unfiltered.length}`)
check('epoch 0 ⇒ no filter (explicit opt-out)', rows.crewChatRowsFromMailbox(inboxes, 10, 0).length === 3)

section('B. the engage epoch lifecycle')
check('off ⇒ null epoch', mode.getScribeEngagedAtMs() === null || mode.isScribeModeOn())
const t0 = Date.now()
mode.setScribeMode(true)
const e1 = mode.getScribeEngagedAtMs()
check('engage stamps the epoch', e1 !== null && e1 >= t0)
mode.setScribeMode(false)
check('disengage clears it', mode.getScribeEngagedAtMs() === null)
mode.setScribeMode(true)
const e2 = mode.getScribeEngagedAtMs()
check('re-engage refreshes (>= prior)', e2 !== null && e2 >= (e1 ?? 0))
mode.setScribeMode(false)

section('C. rail source lock')
const rail = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'HelmLanesRail.tsx'), 'utf-8')
check('rail passes the engage epoch with a boot floor', rail.includes('getScribeEngagedAtMs() ?? RAIL_BOOT_MS'))
check('boot floor is module-load time', rail.includes('const RAIL_BOOT_MS = Date.now()'))

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('✅ chat epoch — ALL CHECKS PASS')
