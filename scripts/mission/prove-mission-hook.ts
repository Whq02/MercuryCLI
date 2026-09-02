#!/usr/bin/env bun
// ============================================================================
//  scripts/mission/prove-mission-hook.ts
//  PROOF (audit-cycle-1): the /mission stop-hook completion sentinel is scoped to the
//  CURRENT mission window, so a SECOND /mission in the same session is not instantly
//  satisfied by the FIRST mission's stale <<<GOAL-MET>>> still sitting in the transcript.
//
//  Bug (was): sawMissionMetSentinel() scanned the WHOLE transcript and returned true if
//  ANY assistant text contained the sentinel — so mission-2's first stop-hook evaluation
//  found mission-1's stale sentinel and allowed the stop immediately (mission-2 dead on arrival).
//  Fix: scan back only to THIS mission's boundary (the most recent MISSION_DIRECTIVE_HEADER or
//  user message — the /mission command itself is a user message) + a sticky `met` flag so a
//  met mission stays met without re-deriving it from a stale sentinel.
//
//  Run:  ~/.bun/bin/bun run scripts/mission/prove-mission-hook.ts
// ============================================================================
import {
  sawMissionMetSentinel,
  MISSION_MET_SENTINEL,
  MISSION_DIRECTIVE_HEADER,
  buildMissionDirective,
} from '../../src/utils/hooks/missionHook.js'
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
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

// Transcript-message fixtures matching the shape the Stop hook receives.
const asst = (text: string) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) as never
const user = (text: string) =>
  ({ type: 'user', message: { role: 'user', content: text } }) as never
// metaMessages (e.g. the injected directive) are user-role with block content.
const meta = (text: string) =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) as never

console.log('============================================================')
console.log(' /mission stop-hook — sentinel scoped to the current mission window')
console.log('============================================================')

section('current-turn completion is detected (normal single-mission flow)')
check(
  'sentinel in the latest assistant turn ⇒ met',
  sawMissionMetSentinel([user('/mission fix the bug'), asst('fixing…'), asst(`done\n${MISSION_MET_SENTINEL}`)]) === true,
)
check(
  'no sentinel yet ⇒ NOT met (hook blocks)',
  sawMissionMetSentinel([user('/mission fix the bug'), asst('still working, not done')]) === false,
)
check('empty transcript ⇒ NOT met', sawMissionMetSentinel([]) === false)

section('THE FIX: a stale sentinel from a prior mission does NOT satisfy a new mission')
// mission-1 met (its sentinel now lives permanently in the transcript), then /mission-2 is set
// (a user message = boundary), mission-2 not yet met. The OLD bug returned true here.
const twoMissions = [
  user('/mission fix the bug'),
  asst(`fixed it\n${MISSION_MET_SENTINEL}`), // mission-1's STALE sentinel
  user('/mission write the docs'), // mission-2 command (user message ⇒ boundary)
  asst('writing docs, not finished'),
]
check('a 2nd /mission is NOT insta-satisfied by mission-1 stale sentinel (the bug)', sawMissionMetSentinel(twoMissions) === false)
check(
  're-using the SAME condition is also not insta-satisfied',
  sawMissionMetSentinel([user('/mission x'), asst(MISSION_MET_SENTINEL), user('/mission x'), asst('redoing x')]) === false,
)
check(
  'mission-2 genuine completion (its OWN sentinel, after its command) ⇒ met',
  sawMissionMetSentinel([...twoMissions, asst(`docs done\n${MISSION_MET_SENTINEL}`)]) === true,
)

section('directive-header boundary (robust even with no user message between)')
check(
  'scan stops at the mission directive header ⇒ a stale sentinel before it is excluded',
  sawMissionMetSentinel([asst(MISSION_MET_SENTINEL), meta(buildMissionDirective('new mission')), asst('working on it')]) === false,
)
check(
  'a sentinel AFTER the directive header ⇒ met',
  sawMissionMetSentinel([meta(buildMissionDirective('g')), asst('work'), asst(MISSION_MET_SENTINEL)]) === true,
)
check('buildMissionDirective opens with MISSION_DIRECTIVE_HEADER (boundary coupling, no drift)', buildMissionDirective('g').startsWith(MISSION_DIRECTIVE_HEADER))

section('final-line discrimination + the snapshot-mission clause (the hardening)')
// The wedge-fix: an ack that QUOTES the directive header then genuinely finishes in the
// SAME message must clear — the old order broke on the quoted header before the sentinel.
check(
  'header-quoting ack + genuine final sentinel in ONE message ⇒ met',
  sawMissionMetSentinel([
    meta(buildMissionDirective('finish the sweep')),
    asst(
      `Acknowledged: "${MISSION_DIRECTIVE_HEADER}" — starting now.\nswept everything, done.\n${MISSION_MET_SENTINEL}`,
    ),
  ]) === true,
)
// The false-positive guard: quoting the FULL directive (whose template embeds an indented
// example sentinel followed by more instruction lines) is NOT a completion signal.
check(
  'quoting the whole directive (embedded example sentinel) ⇒ NOT met',
  sawMissionMetSentinel([user('/mission g'), asst(`the mission says:\n${buildMissionDirective('g')}`)]) === false,
)
// The contract: the sentinel must END the turn — mid-message with trailing prose is not
// a completion signal (matches the directive's "single final line" wording).
check(
  'sentinel mid-message with trailing prose ⇒ NOT met',
  sawMissionMetSentinel([user('/mission g'), asst(`${MISSION_MET_SENTINEL}\nstill more to do though`)]) === false,
)
check(
  'trailing blank lines after the final sentinel are tolerated',
  sawMissionMetSentinel([user('/mission g'), asst(`done.\n${MISSION_MET_SENTINEL}\n\n`)]) === true,
)
// The snapshot-condition clause — the literalism class that wedged a host-harness mission
// a condition describing an in-flight state must count as met once the
// work it directs is COMPLETE. Both the directive and the re-prompt carry the clause.
check(
  'buildMissionDirective teaches the snapshot-condition rule',
  /progress snapshot/.test(buildMissionDirective('g')) &&
    /PAST the described state counts as met/.test(buildMissionDirective('g')),
)

section('sticky `met` flag wired in the Stop callback (structural)')
const gh = src('utils', 'hooks', 'missionHook.ts')
check(
  'the block re-prompt (errorMessage) teaches the snapshot-condition rule',
  /snapshot-style condition[\s\S]{0,180}past the described state is completion/i.test(gh),
)
check(
  'the interactive /mission panel surfaces met + DISARMED (mirrors mission.ts wording)',
  /Mission met — stops are allowed/.test(src('commands', 'mission', 'mission-jsx.tsx')) &&
    /Mission DISARMED \(block cap reached/.test(src('commands', 'mission', 'mission-jsx.tsx')),
)
check('callback short-circuits on mission.met (sticky completion)', /if \(mission\.met\) return true/.test(gh))
check('callback sets mission.met = true when the sentinel is first seen', /mission\.met = true/.test(gh))
check('ActiveMission carries the met field', /met\?:\s*boolean/.test(gh))

section('honest cap-disarm: gaveUp recorded + surfaced (the LOW HONESTY finding)')
check('ActiveMission carries the gaveUp field', /gaveUp\?:\s*boolean/.test(gh))
check(
  'the block-cap branch records the disarm before allowing the stop',
  /mission\.gaveUp = true[\s\S]{0,200}block cap \(\$\{maxBlocks\}\) reached/.test(gh),
)
check(
  '/mission status renders met / DISARMED / active as distinct states',
  /mission\.met[\s\S]{0,80}Mission met[\s\S]{0,120}mission\.gaveUp[\s\S]{0,120}DISARMED/.test(
    src('commands', 'mission', 'mission.ts'),
  ),
)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MISSION-HOOK PROOFS PASS')
else console.log(`❌ ${failures} MISSION-HOOK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
