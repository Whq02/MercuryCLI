#!/usr/bin/env bun
// ============================================================================
//  scripts/crew/prove-crew-role.ts
//  PROOF: the crew ROLE in the bus layer — isCrewRole polarity (drives the
//  real gate), and the two SendMessage integrations (source-pinned: the
//  functions are module-private, the party bus-authority proof precedent):
//    (1) a crew child is refused hand-serialized bus envelopes (same guard
//        as party/scribe/implementer — envelopes are built, never typed);
//    (2) implementerReplyTarget routes a crew child's reply to TEAM-LEAD
//        (the operator's inbox) whatever name the model addressed, and the
//        crew branch sits BEFORE the party branches (deterministic
//        precedence if a double-tag ever slipped past assertSingleRole).
//  Run:  ~/.bun/bin/bun run scripts/crew/prove-crew-role.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const gates = (await import('../../src/utils/scribe/scribeGates.js')) as typeof import('../../src/utils/scribe/scribeGates.js')

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

section('scribeGates source — the read is a LITERAL dot read (registry-visible)')
const gatesSrc = src('utils', 'scribe', 'scribeGates.ts')
check("isCrewRole reads the crew flag ='1' through the registry alias", /flagEnv\('MERCURY_CREW'\) === '1'/.test(gatesSrc))
check('assertSingleRole covers MERCURY_CREW', /'MERCURY_SCRIBE', 'MERCURY_IMPLEMENTER', 'MERCURY_CREW'/.test(gatesSrc))

section('SendMessageTool — crew rides the same bus-role guards')
const smt = src('tools', 'SendMessageTool', 'SendMessageTool.ts')
check(
  'hand-serialized-envelope refusal includes the crew role',
  /\(isScribeRole\(\) \|\| isImplementerRole\(\) \|\| isCrewRole\(\)\)/.test(smt),
)
const replyFn = smt.match(/function implementerReplyTarget\(addressed: string\): string \{[\s\S]*?\n\}/)?.[0] ?? ''
check('implementerReplyTarget exists (reply routing seam)', replyFn.length > 0)
check('crew branch routes to TEAM_LEAD_NAME (the operator inbox)', /if \(isCrewRole\(\)\) return TEAM_LEAD_NAME/.test(replyFn))
const crewIdx = replyFn.indexOf('isCrewRole()')
check('crew branch present in the reply seam (the retired party branches are gone)', crewIdx >= 0 && !replyFn.includes('MERCURY_DPS1'))

console.log('\n' + '═'.repeat(76))
if (failures > 0) { console.log(`❌ ${failures} CREW ROLE PROOF(S) FAILED`); process.exit(1) }
console.log('✅ ALL CREW ROLE PROOFS PASS')
