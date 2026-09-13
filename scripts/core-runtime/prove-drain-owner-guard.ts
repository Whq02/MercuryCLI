#!/usr/bin/env bun
import { consumeDrainedCommands, selectDrainableCommands, type DrainScope } from '../../src/run-core/attachment-drain.ts'

let failures = 0
let checks = 0
const j = (v: unknown): string => JSON.stringify(v)
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Cmd = { uuid: string; mode: string; agentId?: string; value: string }
const line: Cmd = { uuid: 'u-line', mode: 'prompt', value: 'the operator line' }
const secondLine: Cmd = { uuid: 'u-line-2', mode: 'prompt', value: 'the second operator line' }
const notice: Cmd = { uuid: 'u-notice', mode: 'task-notification', value: 'a crew notice for the main thread' }
const addressed: Cmd = { uuid: 'u-addressed', mode: 'task-notification', agentId: 'agent-x', value: 'a note for agent x' }
const elsewhere: Cmd = { uuid: 'u-elsewhere', mode: 'task-notification', agentId: 'agent-y', value: 'a note for agent y' }
const slash: Cmd = { uuid: 'u-slash', mode: 'prompt', value: '/help' }
const queue: Cmd[] = [line, notice, addressed, secondLine, elsewhere, slash]
const isSlash = (c: Cmd): boolean => c.value.startsWith('/')
const ids = (cs: Cmd[]): string[] => cs.map(c => c.uuid)
const select = (scope: DrainScope): Cmd[] => selectDrainableCommands(queue, scope, isSlash)

section("G1 the session's own consumer takes the operator's lines and the main-thread notice, never an addressed note nor a slash")
{
  const took = select({ sleepRan: false, isMainThread: true, agentId: undefined })
  check("the session's own boundary drains the two lines and the notice, in queue order", j(ids(took)) === j(['u-line', 'u-notice', 'u-line-2']), j(ids(took)))
}

section('G2 a sub-agent whose source label reads as the main thread is refused the operator\'s line at the owner')
{
  const took = select({ sleepRan: false, isMainThread: true, agentId: 'agent-x' })
  check("a scope that claims the main thread under an agent id gets only the note addressed to that agent", j(ids(took)) === j(['u-addressed']), j(ids(took)))
  check("the operator's lines never reach it", !ids(took).includes('u-line') && !ids(took).includes('u-line-2'), j(ids(took)))
  check('the main-thread notice never reaches it', !ids(took).includes('u-notice'), j(ids(took)))
}

section("G3 a fork's shape — the parent's source label with an agent id of its own — is refused the same way")
{
  const took = select({ sleepRan: false, isMainThread: true, agentId: 'agent-fork' })
  check('a fork-shaped consumer gets nothing addressed to another agent and no operator line', took.length === 0, j(ids(took)))
}

section('G4 a sub-agent that says so honestly gets only its own note (the standing law)')
{
  const took = select({ sleepRan: false, isMainThread: false, agentId: 'agent-x' })
  check('an honest sub-agent scope drains only the note addressed to it', j(ids(took)) === j(['u-addressed']), j(ids(took)))
}

section('G5 a Sleep boundary changes the band, never the owner')
{
  const took = select({ sleepRan: true, isMainThread: true, agentId: 'agent-x' })
  check('at a Sleep boundary a sub-agent that claims the main thread still gets only its own note', j(ids(took)) === j(['u-addressed']), j(ids(took)))
  const own = select({ sleepRan: true, isMainThread: true, agentId: undefined })
  check("at a Sleep boundary the session's own consumer still drains its lines and notice", j(ids(own)) === j(['u-line', 'u-notice', 'u-line-2']), j(ids(own)))
}

section('G6 the consumption never hands out more than the selection')
{
  const removed: Cmd[] = []
  const started: string[] = []
  const consumed = consumeDrainedCommands(select({ sleepRan: false, isMainThread: true, agentId: 'agent-x' }), {
    notifyStarted: uuid => started.push(uuid),
    removeFromQueue: cs => removed.push(...cs),
  })
  check("a sub-agent's consumption removes only its own note and starts only that one", j(consumed) === j(['u-addressed']) && j(started) === j(['u-addressed']) && j(ids(removed)) === j(['u-addressed']), j({ consumed, started, removed: ids(removed) }))
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-drain-owner-guard: ALL LAWS HOLD' : `prove-drain-owner-guard: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
