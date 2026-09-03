#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-team-center.ts — the crew board on the canonical surface
//
//
//    §1 the REAL lifecycle model: phases derive from task/runner/mailbox
//       state (never elapsed time); operator vocabulary says 'waiting'
//    §2 the shared activity describer speaks the phase vocabulary
//    §3 /team is a discoverable deep link into the canonical surface
//    §4 dialog: message key, id-stable selection, failure/done grace windows
//    §5 detail card: canonical role + model + spawn-captured instruction profile
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-team-center.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
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
const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Crew board — real phases on the canonical surface')
console.log('============================================================')

const phases = await import('../../src/utils/swarm/teamPhases.js')

section('§1 — phase derivation from REAL state')
{
  const base = {
    status: 'running' as const,
    isIdle: false,
    shutdownRequested: false,
    awaitingPlanApproval: false,
    hasProgress: true,
  }
  check('working', phases.deriveTeammatePhase(base) === 'working')
  check('waiting (idle, ready for more work)', phases.deriveTeammatePhase({ ...base, isIdle: true }) === 'waiting')
  check('handoff-ready (idle + last action was a lead handoff)', phases.deriveTeammatePhase({ ...base, isIdle: true, lastActionWasLeadHandoff: true }) === 'handoff-ready')
  check('blocked = a real approval gate, never elapsed time', phases.deriveTeammatePhase({ ...base, awaitingPlanApproval: true }) === 'blocked')
  check('stopping (shutdown in flight)', phases.deriveTeammatePhase({ ...base, isIdle: true, shutdownRequested: true }) === 'stopping')
  check('spawning (registered, nothing tracked yet)', phases.deriveTeammatePhase({ ...base, hasProgress: false }) === 'spawning')
  check('done', phases.deriveTeammatePhase({ ...base, status: 'completed' }) === 'done')
  check('stopped', phases.deriveTeammatePhase({ ...base, status: 'killed' }) === 'stopped')
  check('failed', phases.deriveTeammatePhase({ ...base, status: 'failed' }) === 'failed')
  check('terminal outranks flags', phases.deriveTeammatePhase({ ...base, status: 'failed', shutdownRequested: true }) === 'failed')

  const handoffMsg = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'team-lead', content: 'Outcome: done' } }] },
  }
  const chatterMsg = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'scout-2', content: 'hi' } }] },
  }
  check('handoff detection: SendMessage to the lead', phases.lastActionWasLeadHandoff([handoffMsg]) === true)
  check('handoff detection: peer DM is not a handoff', phases.lastActionWasLeadHandoff([chatterMsg]) === false)
  check('handoff detection: empty history is not a handoff', phases.lastActionWasLeadHandoff([]) === false)
  check('handoff detection: LAST assistant action wins', phases.lastActionWasLeadHandoff([handoffMsg, chatterMsg]) === false)

  check("label: 'waiting', never 'idle'", phases.teammatePhaseLabel('waiting') === 'waiting')
  check('label: blocked names the gate', phases.teammatePhaseLabel('blocked') === 'blocked — awaiting approval')
}

section('§2 — the shared describer speaks the phase vocabulary')
{
  const utils = src('components', 'tasks', 'taskStatusUtils.tsx')
  check('describeTeammateActivity derives through the phase model', utils.includes('deriveTeammatePhase({'))
  check("the operator-facing 'idle' label is GONE", !utils.includes("return 'idle'"))
  check('working still shows the last concrete action, not a spinner phrase', utils.includes('summarizeRecentActivities'))
}

section('§3 — /team deep link')
{
  const team = (await import('../../src/commands/team/index.js')).default
  check('command name is team', team.name === 'team')
  check('description names the crew board', team.description.includes('Crew board'))
  check('not hidden', team.isHidden !== true)
  const teamSrc = src('commands', 'team', 'index.ts')
  check('routes into the CANONICAL surface (no competing dashboard)', teamSrc.includes("import('../tasks/tasks.js')"))
}

section('§4 — dialog: message key, stable selection, grace windows')
{
  const dlg = src('components', 'tasks', 'BackgroundTasksDialog.tsx')
  check("'m' messages the selected teammate", dlg.includes("e.key === 'f' || e.key === 'm'"))
  check('footer hints the message action', dlg.includes('action="message"'))
  check('selection is stable BY ID across updates', dlg.includes('selectedIdRef') && dlg.includes('findIndex(i => i.id === stableId)'))
  const runner = src('utils', 'swarm', 'inProcessRunner.ts')
  check('FAILED teammates keep their row + cause visible (30s grace)', runner.includes("const evictionDelay = status === 'failed' ? 30_000 : STOPPED_DISPLAY_MS"))
  check('DONE teammates get the visible-lifecycle grace too', runner.includes('setTimeout(() => evictTerminalTask(taskId, setAppState), evictionDelay)'))
}

section('§5 — detail card: role, model, spawn-captured profile')
{
  const detail = src('components', 'tasks', 'InProcessTeammateDetailDialog.tsx')
  check('shows the canonical role', detail.includes('role ${teammate.identity.agentType}'))
  check('shows the model', detail.includes('model ${teammate.model}'))
  check('shows the spawn-captured instruction profile', detail.includes('instructionAtSpawn') && detail.includes('captured at spawn'))
  check("'m' works from the detail card too", detail.includes('e.key === "f" || e.key === "m"'))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL TEAM-CENTER PROOFS PASS')
else {
  console.log(`❌ ${failures} TEAM-CENTER PROOF(S) FAILED`)
  process.exit(1)
}
