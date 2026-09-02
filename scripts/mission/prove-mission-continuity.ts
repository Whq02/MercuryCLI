#!/usr/bin/env bun
// ============================================================================
//  scripts/mission/prove-mission-continuity.ts
//  PROOF (lane CP-B): mission continuity is a MECHANISM — the mission card
//  (goal · state · next step) persists through every hook transition,
//  survives compaction and the process boundary, and hands off through the
//  MissionView projection the concourse surfaces already read. Driven
//  against the REAL hook closure (dug out of the session-hook state, never
//  a re-implementation) on a scratch config home.
//
//    §1 arming writes the card: goal verbatim, state armed, a next step
//    §2 a blocked stop advances the card (iterations, the loop's own reason)
//    §3 the sentinel settles it: card state met, next step null
//    §4 COMPACTION: a post-compact transcript (directive text gone) still
//       blocks — no false met, and the refusal text re-states the goal
//    §5 RESUME (the process boundary): a fresh map + an armed card re-arms
//       the hook; met/cleared cards are history and re-arm nothing; a live
//       mission is never clobbered
//    §6 CONCOURSE: an armed card alone composes a MissionView (goal source
//       mission-card, the card block carried); a settled card leaves the
//       idle law intact (no view)
//    §7 clearing writes the terminal card
//
//  Run:  ~/.bun/bin/bun run scripts/mission/prove-mission-continuity.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const watchdog = setTimeout(() => {
  console.log('FATAL: prover watchdog (120s) — treat as failure')
  process.exit(1)
}, 120_000)
watchdog.unref?.()
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'mercury-mission-cont-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

const {
  setActiveMission,
  clearActiveMission,
  getActiveMission,
  rearmMissionFromCard,
  MISSION_MET_SENTINEL,
} = await import('../../src/utils/hooks/missionHook.js')
const { readMissionCard, writeMissionCard } = await import('../../src/services/mission/missionCard.js')
const { composeMissionView } = await import('../../src/services/mission/projection.js')

// A live session-hook state the REAL addFunctionHook writes into.
interface StopHookRecord {
  callback: (m: unknown[]) => boolean | Promise<boolean>
  errorMessage: string
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let state: any = { sessionHooks: new Map() }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setAppState = (f: (prev: any) => any): void => {
  state = f(state)
}

const stopClosure = (sessionId: string): StopHookRecord => {
  const groups = (state.sessionHooks.get(sessionId)?.hooks?.['Stop'] ?? []) as Array<{
    hooks: Array<{ hook: StopHookRecord }>
  }>
  const hooks = groups.flatMap(g => g.hooks.map(h => h.hook))
  if (hooks.length !== 1) throw new Error(`expected exactly one Stop hook, found ${hooks.length}`)
  return hooks[0]!
}

const user = (text: string): unknown => ({ type: 'user', message: { role: 'user', content: text } })
const asst = (text: string): unknown => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

console.log('============================================================')
console.log(' mission continuity — card · compaction · resume · concourse')
console.log('============================================================')

const S1 = 'cont-session-1'
const GOAL = 'the parser suite is green and the fix is pushed'

section('§1 arming writes the card')
{
  const directive = setActiveMission(setAppState as never, GOAL, { sessionId: S1 })
  check('the directive re-states the goal', directive.includes(GOAL))
  const card = readMissionCard(S1)
  check('card exists with the goal verbatim', card !== null && card.goal === GOAL, JSON.stringify(card))
  check('card state is armed with a next step', card?.state === 'armed' && (card?.nextStep ?? '').length > 0, card?.nextStep ?? '')
  check('iterations start at zero', card?.iterations === 0)
}

section('§2 a blocked stop advances the card')
{
  const hook = stopClosure(S1)
  const verdict = await hook.callback([user(`/mission ${GOAL}`), asst('still working on the parser')])
  check('the stop is refused (mission not met)', verdict === false, String(verdict))
  const card = readMissionCard(S1)
  check('the card advanced to check 1', card?.iterations === 1, String(card?.iterations))
  check('the card carries the loop reason as the next step', (card?.nextStep ?? '').includes('not yet met'), card?.nextStep ?? '')
}

section('§3 the sentinel settles the card')
{
  const hook = stopClosure(S1)
  const verdict = await hook.callback([
    user(`/mission ${GOAL}`),
    asst(`suite green, pushed.\n${MISSION_MET_SENTINEL}`),
  ])
  check('the stop passes on the sentinel', verdict === true)
  const card = readMissionCard(S1)
  check('the card settled met, next step null', card?.state === 'met' && card?.nextStep === null, JSON.stringify(card))
}

const S2 = 'cont-session-2'
section('§4 compaction: the directive text is gone, the mission still holds')
{
  setActiveMission(setAppState as never, GOAL, { sessionId: S2 })
  const hook = stopClosure(S2)
  // The post-compact shape: a summary message carrying no directive header,
  // then work with no sentinel. The fences find nothing — and that means
  // BLOCK (no false met), while the refusal text re-states the goal.
  // A longer post-compact transcript also lands on a FRESH turn boundary,
  // so the shared continuation latch treats this as a new stop attempt
  // (the latch, not compaction, is what defers same-boundary re-claims).
  const verdict = await hook.callback([
    user('Summary of the conversation so far: the operator armed a standing goal about the parser suite; work continues.'),
    asst('picking the work back up'),
    user('continue'),
    asst('resuming after compaction, parser still red'),
  ])
  check('the post-compact stop is still refused', verdict === false)
  check('the refusal text re-states the goal for the compacted context', hook.errorMessage.includes(GOAL), hook.errorMessage.slice(0, 120))
  const card = readMissionCard(S2)
  check('the card still says armed', card?.state === 'armed')
}

const S3 = 'cont-session-3'
section('§5 resume: the process boundary')
{
  // The previous process armed and died: only the card remains (the map in
  // THIS process has never seen S3 — exactly the resume shape).
  writeMissionCard({
    schema: 1,
    sessionId: S3,
    goal: 'finish the migration and record the receipt',
    state: 'armed',
    nextStep: 'Mission not yet met (check 4)',
    iterations: 4,
    setAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  })
  check('no live mission before the re-arm', getActiveMission(S3) === undefined)
  const rearmed = rearmMissionFromCard(setAppState as never, S3)
  check('the armed card re-arms', rearmed === true)
  const live = getActiveMission(S3)
  check('the re-armed mission carries the card goal', live?.condition === 'finish the migration and record the receipt')
  const card = readMissionCard(S3)
  check('the card notes the re-arm', (card?.nextStep ?? '').includes('re-armed on resume'), card?.nextStep ?? '')
  check('a live mission is never clobbered by a second re-arm', rearmMissionFromCard(setAppState as never, S3) === false)
  check('a met card re-arms nothing', rearmMissionFromCard(setAppState as never, S1) === false)

  // The id-split boot (the CP-B-V finding): the adopted transcript's card
  // key differs from the live process id — the card re-arms under the LIVE
  // id and the old card becomes a `continued` pointer, never orphaned-armed.
  const OLD = 'cont-session-old'
  const LIVE = 'cont-session-live'
  writeMissionCard({
    schema: 1,
    sessionId: OLD,
    goal: 'survive the id split',
    state: 'armed',
    nextStep: 'Mission not yet met (check 2)',
    iterations: 2,
    setAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const split = rearmMissionFromCard(setAppState as never, { cardSessionId: OLD, armSessionId: LIVE })
  check('the split re-arm fires', split === true)
  check('the mission lives under the LIVE id', getActiveMission(LIVE)?.condition === 'survive the id split')
  const moved = readMissionCard(LIVE)
  check('the successor card is armed under the live id', moved?.state === 'armed' && moved?.goal === 'survive the id split', JSON.stringify(moved))
  const old = readMissionCard(OLD)
  check(
    'the old card is a `continued` pointer at its successor (no orphaned-armed)',
    old?.state === 'continued' && (old?.nextStep ?? '').includes(LIVE),
    JSON.stringify(old),
  )
  check('a continued card re-arms nothing', rearmMissionFromCard(setAppState as never, { cardSessionId: OLD, armSessionId: 'cont-session-third' }) === false)
}

section('§6 concourse: the card composes into the MissionView')
{
  const baseInputs = {
    workspace: '/tmp/ws',
    runObjective: null,
    runLifecycle: null,
    plans: [],
    snapshot: null,
    memoryRefs: [],
    executions: [],
    evidenceDigest: null,
    posture: null,
    nodeAttemptCeiling: 3,
    now: Date.now(),
  }
  const armed = composeMissionView({
    ...baseInputs,
    card: { sessionId: S3, goal: 'finish the migration', state: 'armed', nextStep: 'keep going', iterations: 4, updatedAt: new Date().toISOString() },
  } as never)
  check('an armed card alone composes a view', armed !== null)
  check('the goal source is mission-card, text carried', armed?.goal.source === 'mission-card' && armed?.goal.text === 'finish the migration', JSON.stringify(armed?.goal))
  check('the card block rides the view (the hand-off fact)', armed?.card?.nextStep === 'keep going' && armed?.card?.iterations === 4)
  const settled = composeMissionView({
    ...baseInputs,
    card: { sessionId: S1, goal: GOAL, state: 'met', nextStep: null, iterations: 2, updatedAt: new Date().toISOString() },
  } as never)
  check('a settled card leaves the idle law intact (no view)', settled === null)
  const none = composeMissionView({ ...baseInputs, card: null } as never)
  check('no card, no run, no plan ⇒ no view (unchanged law)', none === null)
}

section('§7 clearing writes the terminal card')
{
  const cleared = clearActiveMission(setAppState as never, S3)
  check('clear hands back the condition', cleared === 'finish the migration and record the receipt')
  const card = readMissionCard(S3)
  check('the card is terminal', card?.state === 'cleared' && card?.nextStep === null, JSON.stringify(card))
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL MISSION-CONTINUITY PROOFS PASS' : `❌ ${failures} MISSION-CONTINUITY CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
