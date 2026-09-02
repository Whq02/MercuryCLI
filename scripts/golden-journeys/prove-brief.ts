// ============================================================================
//  scripts/golden-journeys/prove-brief.ts — the three plan-shape worlds on the
//  resumed frame
//
//  Three worlds through the real cockpit, distinguished by plan shape:
//    · PLANNING (a formed multi-item plan, nothing landed) — the plan and its
//      objective are on screen at a glance (the resumed transcript), and the
//      prompts panel's receipt roll carries the ask;
//    · DIRECT (one work item) — the ask is on screen, no planning report;
//    · LANDED (the J3 mid-flight state, items done) — the landed report is on
//      screen and the resume recap renders.
//
//  The WORK-lane brief rows (`via …` execution shape + the one edit/steer
// teaching line) retired with the WORK panel and the
//  unified resume (the rail's WORK digest never paints on a resumed frame):
//  each world now guards that retirement the panel prover's L10 way — no
//  retired brief string reappears. Successor surfaces for plan inspection:
//  the at-glance transcript + the prompts panel's receipt roll (below); the
//  focused-chat task board is the lead-queued follow-up.
// ============================================================================

import {
  SIDS,
  capture,
  cleanupWorld,
  foldRun,
  hasProse,
  makeChecker,
  requireDist,
  seedTasks,
  seedWorld,
  slashSends,
  writeRunSidecar,
  writeSession,
  conversationRows,
  type Capture,
} from './journeyLib.ts'
import { seedSubstantialState } from './j3State.ts'

requireDist()
const { check, failures } = makeChecker()
console.log('prove-brief — the plan-shape worlds on the resumed frame')

const t0 = Date.parse('2026-07-20T12:00:00.000Z')

/** The retired WORK-lane brief strings must never reappear on a journey
 *  frame (the panel prover's L10 pattern, applied to the cockpit). */
function retiredBriefAbsent(world: string, c: Capture): void {
  check(`${world}: no retired brief teaching line reappears`, !hasProse(c, 'plan: edit /tasks'))
  check(`${world}: no retired WORK section header reappears`, !/\bWORK\b/.test(c.text))
}

// ── world A: PLANNING (5 items formed, none landed) ─────────────────────────
seedWorld()
const sidA = SIDS.J3
writeSession(
  sidA,
  conversationRows(sidA, 'Replatform the fixture pipeline', [], 'Plan formed — five items queued; starting now.'),
)
seedTasks(sidA, [
  { id: '1', subject: 'map the pipeline stages', status: 'pending' },
  { id: '2', subject: 'port the ingest step', status: 'pending' },
  { id: '3', subject: 'port the transform step', status: 'pending' },
  { id: '4', subject: 'port the publish step', status: 'pending', blockedBy: ['3'] },
  { id: '5', subject: 'verify the pipeline end to end', status: 'pending', blockedBy: ['4'] },
])
writeRunSidecar(
  sidA,
  foldRun(sidA, 'run_momentum_brief', 'Replatform the fixture pipeline', [
    ...['map the pipeline stages', 'port the ingest step', 'port the transform step', 'port the publish step', 'verify the pipeline end to end'].map(
      (title, i) => ({
        type: 'task-transition' as const,
        at: t0 + 1000 + i * 500,
        taskId: String(i + 1),
        title,
        state: 'open' as const,
      }),
    ),
  ]),
)
const planning = capture({ sid: sidA, tag: 'brief-planning', total: 90 })
check('the planning world shows the plan formed, at a glance', hasProse(planning, 'Plan formed — five items queued'))
check("the plan's objective is on screen (the ask line)", hasProse(planning, 'Replatform the fixture pipeline'))
retiredBriefAbsent('planning', planning)
// The prompts panel (the /workbench slot) is the plan-inspection door: its
// receipt roll carries the ask that formed the plan.
const planningPanel = capture({ sid: sidA, tag: 'brief-planning-panel', sends: slashSends('/workbench'), total: 110 })
check("the prompts panel's receipt roll carries the plan's ask", hasProse(planningPanel, 'Replatform the fixture pipeline'))
check('the prompts panel chrome renders (the three tabs)', /PROMPTS/.test(planningPanel.text) && /SAVED PROMPTS/.test(planningPanel.text))

// ── world B: DIRECT (one item) — the ask, no planning report ────────────────
seedWorld()
const sidB = SIDS.J1
writeSession(sidB, conversationRows(sidB, 'Fix the header casing', [], 'On it.'))
writeRunSidecar(
  sidB,
  foldRun(sidB, 'run_momentum_direct', 'Fix the header casing', [
    { type: 'task-transition', at: t0 + 1000, taskId: '1', title: 'fix the header casing', state: 'in-progress' },
  ]),
)
const direct = capture({ sid: sidB, tag: 'brief-direct', total: 90 })
check('the direct ask is on screen at a glance', hasProse(direct, 'Fix the header casing'))
check('a direct task shows no planning report (§6.1)', !hasProse(direct, 'Plan formed'))
retiredBriefAbsent('direct', direct)

// ── world C: LANDED (the J3 state, 2 done) ──────────────────────────────────
seedWorld()
const sidC = SIDS.J5
seedSubstantialState(sidC)
const landed = capture({ sid: sidC, tag: 'brief-landed', total: 90 })
check('the landed world reports landed items at a glance', hasProse(landed, 'Plan items 1–2 are landed'))
check('the landed world resumes clean (the recap renders)', hasProse(landed, 'resumed clean'))
retiredBriefAbsent('landed', landed)

cleanupWorld()
if (failures().length > 0) {
  console.error(`\nprove-brief: RED (${failures().length})`)
  process.exit(1)
}
console.log('\nprove-brief: green')
