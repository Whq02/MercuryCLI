#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-census.ts — slice-5 census enforcement + the
//  external-projection laws.
//
//    · every TaskType has a census row (a NEW task type cannot land
//      unclassified — this check fails the gate);
//    · every ExecutionKind is census-covered or explicitly generic;
//    · every runtime-registered execution domain is census-classified;
//    · the task chokepoints mirror the full lifecycle honestly
//      (pending→queued, running, completed→succeeded, killed→stopped);
//    · projectExternalState laws: no fabricated history, same-state no-op,
//      terminal-before-sighting no-op, illegal edges route legally or drop.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
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

const P = await import('../../src/services/primitives/index.ts')
const { EXECUTION_DOMAIN_CENSUS, censusEntry, censusPlaneKinds } =
  await import('../../src/services/primitives/executionCensus.ts')

// Install the real domain hooks by importing the production modules.
await import('../../src/services/projectServices/serviceManager.ts')
await import('../../src/services/workshop/runtime.ts')
await import('../../src/services/workshop/pythonRuntime.ts')
await import('../../src/services/lsp/LSPServerInstance.ts')
await import('../../src/services/dap/dapClient.ts')

function unionMembers(path: string, typeName: string): string[] {
  const src = readFileSync(path, 'utf8')
  const m = src.match(
    new RegExp(`export type ${typeName}\\s*=([\\s\\S]*?)(\\n\\n|\\nexport |\\n(?:const|interface|function) )`),
  )
  if (!m) return []
  return [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!)
}

console.log('census completeness (the unclassified-domain gate)')
{
  const taskTypes = unionMembers('src/Task.ts', 'TaskType')
  check('TaskType union read from live source', taskTypes.length >= 7)
  const missingTasks = taskTypes.filter(t => !censusEntry(`task:${t}`))
  check('every TaskType is census-classified', missingTasks.length === 0,
    missingTasks.map(t => `task:${t}`).join(', '))

  const GENERIC_KINDS = ['process'] // the base kind domains compose; no single owner
  const covered = censusPlaneKinds()
  const missingKinds = P.EXECUTION_STATES && // (keep tsc quiet about unused import shape)
    [...(await import('../../src/services/primitives/execution.ts')).EXECUTION_STATES.slice(0, 0),
    ]
  void missingKinds
  const kinds = unionMembers('src/services/primitives/execution.ts', 'ExecutionKind')
  const uncovered = kinds.filter(k => !covered.includes(k) && !GENERIC_KINDS.includes(k))
  check('every ExecutionKind is census-covered or explicitly generic',
    uncovered.length === 0, uncovered.join(', '))

  const registered = P.executionDomainKinds()
  const unclassified = registered.filter(k => !covered.includes(k))
  check('every registered execution domain is census-classified',
    unclassified.length === 0, unclassified.join(', '))
  check('census has all four classifications in use',
    new Set(EXECUTION_DOMAIN_CENSUS.map(e => e.classification)).size === 4)
  check('documented exclusions carry real reasons',
    EXECUTION_DOMAIN_CENSUS.filter(e => e.classification === 'documented-exclusion')
      .every(e => e.notes.length > 40))
}

console.log('task chokepoint projection')
{
  const { registerTask, updateTaskState } = await import('../../src/utils/task/framework.ts')
  const { taskExecutionKind, taskExecutionState } =
    await import('../../src/utils/task/executionProjection.ts')
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

  const taskTypes = unionMembers('src/Task.ts', 'TaskType')
  const statuses = unionMembers('src/Task.ts', 'TaskStatus')
  check('kind mapping is total over TaskType',
    taskTypes.every(t => typeof taskExecutionKind(t as never) === 'string'))
  check('state mapping is total over TaskStatus',
    statuses.every(s => typeof taskExecutionState(s as never) === 'string'))

  // A minimal AppState-shaped store for the chokepoints.
  let state = { tasks: {} as Record<string, unknown>, agentNameRegistry: new Map() }
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
  check('registerTask projects queued (pending)', registered?.state === 'queued')
  check('task output ref points at the task resource',
    registered?.outputRef === 'mercury://task/bash_axiom1')

  updateTaskState('bash_axiom1', setAppState as never, t => ({ ...t, status: 'running' }))
  check('running mirrors', P.getExecution(owner, 'bash_axiom1')?.state === 'running')
  updateTaskState('bash_axiom1', setAppState as never, t => ({ ...t, outputOffset: 5 }))
  check('non-status updates do not touch the plane',
    P.getExecution(owner, 'bash_axiom1')?.state === 'running')
  updateTaskState('bash_axiom1', setAppState as never, t => ({ ...t, status: 'completed' }))
  const done = P.getExecution(owner, 'bash_axiom1')
  check('completed settles succeeded', done?.state === 'succeeded' && done.settledAt !== undefined)

  const killed = { ...task, id: 'agent_axiom2', type: 'local_agent', status: 'running' }
  registerTask(killed as never, setAppState as never)
  check('running-at-registration registers live',
    P.getExecution(owner, 'agent_axiom2')?.state === 'running')
  updateTaskState('agent_axiom2', setAppState as never, t => ({ ...t, status: 'killed' }))
  check('killed settles stopped', P.getExecution(owner, 'agent_axiom2')?.state === 'stopped')
}

console.log('externalProjection laws')
{
  const { projectExternalState } = await import('../../src/services/primitives/externalProjection.ts')
  const owner = P.makeOwnerKey({ workspace: '/axiom-census', sessionId: 'ext', lane: P.MAIN_LANE })
  const spec = { id: 'x1', kind: 'process' as const, label: 'x', lifecycle: 'session' as const }

  projectExternalState(owner, spec, 'failed')
  check('terminal before first sighting projects nothing', P.getExecution(owner, 'x1') === undefined)

  projectExternalState(owner, spec, 'queued')
  projectExternalState(owner, spec, 'queued')
  const rec = P.getExecution(owner, 'x1')
  check('same-state re-projection is a no-op', rec?.state === 'queued' && rec.generation === 1)

  projectExternalState(owner, spec, 'waiting')
  check('illegal edge routes through the legal two-step path',
    P.getExecution(owner, 'x1')?.state === 'waiting')

  projectExternalState(owner, spec, 'succeeded')
  projectExternalState(owner, spec, 'running')
  const gen2 = P.getExecution(owner, 'x1')
  check('a live sighting after settlement registers the next generation',
    gen2?.state === 'running' && gen2.generation === 2)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
