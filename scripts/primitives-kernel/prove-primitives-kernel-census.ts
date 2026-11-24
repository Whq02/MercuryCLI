#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'axiom-census-'))

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const P = await import('../../src/engine/runtime-kernel/index.ts')
const { EXECUTION_DOMAIN_CENSUS, censusPlaneKinds } =
  await import('../../src/engine/runtime-kernel/executionCensus.ts')

await import('../../src/tools/engines/project-services/serviceManager.ts')
await import('../../src/integrations/lsp/LSPServerInstance.ts')
await import('../../src/integrations/debugger/dapClient.ts')


console.log('census completeness (the unclassified-domain gate)')
{

  const covered = censusPlaneKinds()

  const registered = P.executionDomainKinds()
  const unclassified = registered.filter(k => !covered.includes(k))
  check('every registered execution domain is census-classified',
    unclassified.length === 0,
    `${unclassified.join(', ')} (add a census entry for each registered kind to EXECUTION_DOMAIN_CENSUS in src/engine/runtime-kernel/executionCensus.ts)`)
  check('census has all four classifications in use',
    new Set(EXECUTION_DOMAIN_CENSUS.map(e => e.classification)).size === 4,
    'EXECUTION_DOMAIN_CENSUS in src/engine/runtime-kernel/executionCensus.ts must use all four classifications; add or reclassify an entry')
  check('documented exclusions carry real reasons',
    EXECUTION_DOMAIN_CENSUS.filter(e => e.classification === 'documented-exclusion')
      .every(e => e.notes.length > 40),
    'a documented-exclusion entry in EXECUTION_DOMAIN_CENSUS (src/engine/runtime-kernel/executionCensus.ts) has notes of 40 characters or fewer; write the real reason')
}

console.log('task chokepoint projection')
{
  const { registerTask, updateTaskState } = await import('../../src/engine/task-framework/taskRegistry.ts')
  const { taskExecutionKind, taskExecutionState } =
    await import('../../src/engine/task-framework/executionProjection.ts')
  const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')


  let state = { tasks: {} as Record<string, unknown>, crewmateNameRegistry: new Map() }
  const setAppState = (updater: (prev: typeof state) => typeof state): void => {
    state = updater(state)
  }
  const owner = processMainOwner()
  const task = {
    id: 'bash_axiom1',
    type: 'local_bash',
    status: 'pending',
    description: 'axiom census proof shell',
    notified: false,
    outputOffset: 0,
  }
  registerTask(task as never, setAppState as never)
  const registered = P.getExecution(owner, 'bash_axiom1')
  check('registerTask projects queued (pending)', registered?.state === 'queued',
    `state was ${registered?.state}; check taskExecutionState in src/engine/task-framework/executionProjection.ts and the projectTaskExecution call in registerTask (src/engine/task-framework/taskRegistry.ts)`)
  check('task output ref points at the task resource',
    registered?.outputRef === 'mercury://task/bash_axiom1',
    `outputRef was ${registered?.outputRef}; check projectTaskExecution in src/engine/task-framework/executionProjection.ts`)

  updateTaskState('bash_axiom1', setAppState as never, t => ({ ...t, status: 'running' }))
  check('running mirrors', P.getExecution(owner, 'bash_axiom1')?.state === 'running',
    'updateTaskState in src/engine/task-framework/taskRegistry.ts must project a status change through projectTaskExecution (src/engine/task-framework/executionProjection.ts)')
  updateTaskState('bash_axiom1', setAppState as never, t => ({ ...t, outputOffset: 5 }))
  check('non-status updates do not touch the plane',
    P.getExecution(owner, 'bash_axiom1')?.state === 'running',
    'updateTaskState in src/engine/task-framework/taskRegistry.ts must project only when the status changed')
  updateTaskState('bash_axiom1', setAppState as never, t => ({ ...t, status: 'completed' }))
  const done = P.getExecution(owner, 'bash_axiom1')
  check('completed settles succeeded', done?.state === 'succeeded' && done.settledAt !== undefined,
    `state was ${done?.state}; completed must map to succeeded and settle in taskExecutionState (src/engine/task-framework/executionProjection.ts)`)

  const killed = { ...task, id: 'agent_axiom2', type: 'local_agent', status: 'running' }
  registerTask(killed as never, setAppState as never)
  check('running-at-registration registers live',
    P.getExecution(owner, 'agent_axiom2')?.state === 'running',
    'registerTask in src/engine/task-framework/taskRegistry.ts must project the status a task registers with, via projectTaskExecution')
  updateTaskState('agent_axiom2', setAppState as never, t => ({ ...t, status: 'killed' }))
  check('killed settles stopped', P.getExecution(owner, 'agent_axiom2')?.state === 'stopped',
    'killed must map to stopped in taskExecutionState (src/engine/task-framework/executionProjection.ts)')
}

console.log('externalProjection laws')
{
  const { projectExternalState } = await import('../../src/engine/execution-plane/externalProjection.ts')
  const owner = P.makeOwnerKey({ workspace: '/axiom-census', sessionId: 'ext', lane: P.MAIN_LANE })
  const spec = { id: 'x1', kind: 'process' as const, label: 'x', lifecycle: 'session' as const }

  projectExternalState(owner, spec, 'failed')
  check('terminal before first sighting projects nothing', P.getExecution(owner, 'x1') === undefined,
    'projectExternalState in src/engine/execution-plane/externalProjection.ts must return without registering when the target is terminal and nothing is live')

  projectExternalState(owner, spec, 'queued')
  projectExternalState(owner, spec, 'queued')
  const rec = P.getExecution(owner, 'x1')
  check('same-state re-projection is a no-op', rec?.state === 'queued' && rec.generation === 1,
    `state ${rec?.state}, generation ${rec?.generation}; projectExternalState in src/engine/execution-plane/externalProjection.ts must skip a target equal to the current state`)

  projectExternalState(owner, spec, 'waiting')
  check('illegal edge routes through the legal two-step path',
    P.getExecution(owner, 'x1')?.state === 'waiting',
    'projectExternalState in src/engine/execution-plane/externalProjection.ts must reach the target through legalExecutionTransitions when the direct edge is illegal')

  projectExternalState(owner, spec, 'succeeded')
  projectExternalState(owner, spec, 'running')
  const gen2 = P.getExecution(owner, 'x1')
  check('a live sighting after settlement registers the next generation',
    gen2?.state === 'running' && gen2.generation === 2,
    `state ${gen2?.state}, generation ${gen2?.generation}; projectExternalState in src/engine/execution-plane/externalProjection.ts must register a new generation when the current record is terminal and the target is live`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
