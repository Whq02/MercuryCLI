
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

function retiredBriefAbsent(world: string, c: Capture): void {
  check(`${world}: no retired brief teaching line reappears`, !hasProse(c, 'plan: edit /tasks'), 'the resumed frame prints the retired line plan: edit /tasks; remove that teaching line from the resumed-frame brief text')
  check(`${world}: no retired WORK section header reappears`, !/\bWORK\b/.test(c.text), 'the resumed frame prints a WORK section header again; remove that header from the resumed-frame brief')
}

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
check('the planning world shows the plan formed, at a glance', hasProse(planning, 'Plan formed — five items queued'), 'the resumed planning frame does not show the seeded last assistant line (Plan formed) at a glance; the brief must carry the final assistant text of the session')
check("the plan's objective is on screen (the ask line)", hasProse(planning, 'Replatform the fixture pipeline'), 'the resumed planning frame does not show the run objective on the ask line; the brief must print the run objective from the run sidecar')
retiredBriefAbsent('planning', planning)
const planningPanel = capture({ sid: sidA, tag: 'brief-planning-panel', sends: slashSends('/workbench'), total: 110 })
check("the prompts panel's receipt roll carries the plan's ask", hasProse(planningPanel, 'Replatform the fixture pipeline'), 'the /workbench prompts panel receipt roll lacks the plan ask; it must list the chat ask of the session')
check('the prompts panel chrome renders (the three tabs)', /PROMPTS/.test(planningPanel.text) && /SAVED PROMPTS/.test(planningPanel.text), 'the /workbench capture does not show the PROMPTS and SAVED PROMPTS tabs; the panel failed to open or its tab titles changed')

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
check('the direct ask is on screen at a glance', hasProse(direct, 'Fix the header casing'), 'the resumed direct-task frame does not show the run objective at a glance; the brief must print it')
check('a direct task shows no planning report (§6.1)', !hasProse(direct, 'Plan formed'), 'a direct task (one in-progress item, no plan) shows a Plan formed report; the brief must show a planning report only for a multi-item plan')
retiredBriefAbsent('direct', direct)

seedWorld()
const sidC = SIDS.J5
seedSubstantialState(sidC)
const landed = capture({ sid: sidC, tag: 'brief-landed', total: 90 })
check('the landed world reports landed items at a glance', hasProse(landed, 'Plan items 1–2 are landed'), 'the resumed frame lacks the landed-items line for the two completed deliverables seeded by seedSubstantialState in scripts/golden-journeys/j3State.ts')
check('the landed world resumes clean (the recap renders)', hasProse(landed, 'resumed clean'), 'the resumed frame lacks the resumed clean recap line')
retiredBriefAbsent('landed', landed)

cleanupWorld()
if (failures().length > 0) {
  console.error(`\nprove-brief: RED (${failures().length})`)
  process.exit(1)
}
console.log('\nprove-brief: green')
