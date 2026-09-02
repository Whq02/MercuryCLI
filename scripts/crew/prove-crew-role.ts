#!/usr/bin/env bun
// ============================================================================
//  scripts/crew/prove-crew-role.ts
//  PROOF: the crew ROLE in the bus layer — isCrewRole polarity (drives the
//  real gate), and the two SendMessage integrations (source-pinned: the
//  functions are module-private):
//    (1) a crew child is refused hand-serialized bus envelopes (envelopes
//        are built, never typed);
//    (2) workerReplyTarget routes a crew child's reply to TEAM-LEAD (the
//        operator's inbox) whatever name the model addressed.
//  Run:  ~/.bun/bin/bun run scripts/crew/prove-crew-role.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const gates = (await import('../../src/utils/workerRole.js')) as typeof import('../../src/utils/workerRole.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Crew role in the bus layer — proof')
console.log('============================================================')

section('isCrewRole — value-checked polarity (dual-polarity safe)')
const stash = process.env.MERCURY_CREW
delete process.env.MERCURY_CREW
check('unset ⇒ false', gates.isCrewRole() === false)
process.env.MERCURY_CREW = '1'
check("'1' ⇒ true (the daemon role stamp)", gates.isCrewRole() === true)
process.env.MERCURY_CREW = '0'
check("'0' ⇒ false (the operator kill is NOT a role)", gates.isCrewRole() === false)
process.env.MERCURY_CREW = '2'
check("junk value ⇒ false (strict ==='1')", gates.isCrewRole() === false)
if (stash === undefined) delete process.env.MERCURY_CREW
else process.env.MERCURY_CREW = stash

section('workerRole source — the read is a LITERAL dot read (registry-visible)')
const gatesSrc = src('utils', 'workerRole.ts')
check("isCrewRole reads the crew flag ='1' through the registry alias", /flagEnv\('MERCURY_CREW'\) === '1'/.test(gatesSrc))
check('assertSingleRole covers MERCURY_CREW beside the live roster', /\['MERCURY_CREW', \.\.\.LIVE_ROLE_ENV_VARS\]\.filter\(v => flagEnv\(v\) === '1'\)/.test(gatesSrc))

section('assertSingleRole — one role passes, two fail loud, the kill value is not a role')
{
  const stashCrew = process.env.MERCURY_CREW
  const stashWorker = process.env.MERCURY_CONCOURSE_WORKER
  delete process.env.MERCURY_CREW
  delete process.env.MERCURY_CONCOURSE_WORKER
  const throws = (): boolean => { try { gates.assertSingleRole(); return false } catch { return true } }
  check('no role ⇒ passes', throws() === false)
  process.env.MERCURY_CREW = '1'
  check('crew alone ⇒ passes', throws() === false)
  process.env.MERCURY_CONCOURSE_WORKER = '1'
  check('crew + concourse worker ⇒ fails LOUD', throws() === true)
  process.env.MERCURY_CREW = '0'
  check("MERCURY_CREW='0' beside a live role is NOT a double role", throws() === false)
  delete process.env.MERCURY_CONCOURSE_WORKER
  process.env.MERCURY_DPS1 = '1'
  check('a retired seat marker beside the kill value still reads as one role', throws() === false)
  process.env.MERCURY_CREW = '1'
  check('a retired seat marker beside a live role fails LOUD (the raw sweep)', throws() === true)
  delete process.env.MERCURY_DPS1
  if (stashCrew === undefined) delete process.env.MERCURY_CREW
  else process.env.MERCURY_CREW = stashCrew
  if (stashWorker === undefined) delete process.env.MERCURY_CONCOURSE_WORKER
  else process.env.MERCURY_CONCOURSE_WORKER = stashWorker
}

section('SendMessageTool — crew rides the same bus-role guards')
const smt = src('tools', 'SendMessageTool', 'SendMessageTool.ts')
check(
  'hand-serialized-envelope refusal keys on the crew role',
  /isCrewRole\(\)\)[\s\S]{0,40}looksLikeHandSerializedBusPayload\(content\)/.test(smt),
)
const replyFn = smt.match(/function workerReplyTarget\(addressed: string\): string \{[\s\S]*?\n\}/)?.[0] ?? ''
check('workerReplyTarget exists (reply routing seam)', replyFn.length > 0)
check('crew branch routes to TEAM_LEAD_NAME (the operator inbox)', /if \(isCrewRole\(\)\) return TEAM_LEAD_NAME/.test(replyFn))
check('the reply seam carries no retired seat markers', !replyFn.includes('MERCURY_DPS1'))

console.log('\n' + '═'.repeat(76))
if (failures > 0) { console.log(`❌ ${failures} CREW ROLE PROOF(S) FAILED`); process.exit(1) }
console.log('✅ ALL CREW ROLE PROOFS PASS')
