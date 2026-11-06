#!/usr/bin/env bun
import {
  sawMissionMetSentinel,
  MISSION_MET_SENTINEL,
  MISSION_DIRECTIVE_HEADER,
  buildMissionDirective,
} from '../../src/guards/mission.js'
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

const asst = (text: string) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) as never
const user = (text: string) =>
  ({ type: 'user', message: { role: 'user', content: text } }) as never
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
const twoMissions = [
  user('/mission fix the bug'),
  asst(`fixed it\n${MISSION_MET_SENTINEL}`),
  user('/mission write the docs'),
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
check(
  'header-quoting ack + genuine final sentinel in ONE message ⇒ met',
  sawMissionMetSentinel([
    meta(buildMissionDirective('finish the sweep')),
    asst(
      `Acknowledged: "${MISSION_DIRECTIVE_HEADER}" — starting now.\nswept everything, done.\n${MISSION_MET_SENTINEL}`,
    ),
  ]) === true,
)
check(
  'quoting the whole directive (embedded example sentinel) ⇒ NOT met',
  sawMissionMetSentinel([user('/mission g'), asst(`the mission says:\n${buildMissionDirective('g')}`)]) === false,
)
check(
  'sentinel mid-message with trailing prose ⇒ NOT met',
  sawMissionMetSentinel([user('/mission g'), asst(`${MISSION_MET_SENTINEL}\nstill more to do though`)]) === false,
)
check(
  'trailing blank lines after the final sentinel are tolerated',
  sawMissionMetSentinel([user('/mission g'), asst(`done.\n${MISSION_MET_SENTINEL}\n\n`)]) === true,
)
check(
  'buildMissionDirective teaches the snapshot-goal rule',
  /progress snapshot/.test(buildMissionDirective('g')) &&
    /once the work it describes is done/.test(buildMissionDirective('g')),
)
check(
  'buildMissionDirective teaches the itemised close: one numbered line per criterion, then the completion line',
  /one numbered line\s+per criterion naming its evidence/.test(buildMissionDirective('g')),
)

section('sticky `met` flag wired in the Stop callback (structural)')
const gh = src('guards', 'mission.ts')
check(
  'the directive (the words the turn starts with) teaches the snapshot-goal rule',
  /progress snapshot[\s\S]{0,120}once the work it describes is done/i.test(gh),
)
check(
  'the hold words take the form "Mission not completed: <goal> — <what is open>. Continue."',
  /\$\{MISSION_HOLD_HEAD\} \$\{mission\.condition\} — \$\{verdict\.reason\}\. Continue\./.test(gh),
)
check(
  'the interactive /mission panel surfaces met + paused as distinct states (mirrors mission.ts wording)',
  /Mission met — stops are allowed/.test(src('commands', 'mission', 'mission-jsx.tsx')) &&
    /Mission paused — /.test(src('commands', 'mission', 'mission-jsx.tsx')),
)
check('the judge short-circuits on mission.met (sticky completion) and waits while paused until the operator speaks', /mission\.met\) return \{ hold: false \}/.test(gh) && /if \(!operatorSpokeSince\(messages, mission\.paused\)\) return \{ hold: false \}/.test(gh))
check('callback sets mission.met = true on a met verdict', /mission\.met = true/.test(gh))
check('ActiveMission carries the met field', /met\?:\s*boolean/.test(gh))

section('the pause: a question to the operator pauses the mission (armed, waiting); met and cleared are the only ends')
check('ActiveMission carries the paused field, never a needsOperator end state', /paused\?:\s*MissionPause/.test(gh) && !/needsOperator/.test(gh) && !/needs-operator/.test(gh) && !/stood-down/.test(gh))
check(
  'the pause records the paused card before the stop is allowed',
  /mission\.paused = \{ why, boundary: operatorBoundary\(messages\) \}[\s\S]{0,240}persistCard\(sessionId, mission, 'paused'\)/.test(gh),
)
check('the mission holds without deferring to another guard: it claims the continuation and never reads the claim as a reason to stand aside', /claimContinuation\(processMainOwner\(\), turnBoundaryIndex\(messages\), messages\.length\)\n/.test(gh) && !/defers one round/.test(gh))
check('no block cap stands anywhere in the guard', !/maxBlocks|block cap|DEFAULT_MISSION_MAX_BLOCKS/.test(gh))
check(
  '/mission status renders met / PAUSED / active as distinct states',
  /mission\.met[\s\S]{0,80}Mission met[\s\S]{0,120}mission\.paused !== undefined[\s\S]{0,120}Mission PAUSED/.test(
    src('commands', 'mission', 'mission.ts'),
  ),
)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL MISSION-HOOK PROOFS PASS')
else console.log(`❌ ${failures} MISSION-HOOK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
