#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

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
const { disposeOwner } = await import('../../src/engine/run-owner/ownerLifecycle.ts')

const owner = P.makeOwnerKey({ workspace: '/axiom', sessionId: 'plane', lane: P.MAIN_LANE })
const events: P.OrderedExecutionEvent[] = []
const unsubscribe = P.subscribeExecutionEvents(e => {
  if (e.owner === owner) events.push(e)
})

const reg = (id: string, extra: Partial<P.RegisterExecutionInput> = {}) =>
  P.registerExecution({
    owner,
    id,
    kind: 'process',
    label: id,
    lifecycle: 'session',
    ...extra,
  })
const go = (id: string, to: P.ExecutionState, opts?: P.TransitionOptions) =>
  P.transitionExecution(owner, id, to, opts)

console.log('required journeys')
{
  reg('j1')
  go('j1', 'starting')
  go('j1', 'running')
  const done = go('j1', 'succeeded', { outcome: { code: 0 } })
  check('1. queued→starting→running→succeeded', done?.state === 'succeeded' && done.settledAt !== undefined,
    `state ${done?.state}; check transitionExecution and the legal-edge table in src/engine/execution-plane/executionPlane.ts and execution.ts`)

  reg('j2')
  go('j2', 'starting')
  const failed = go('j2', 'failed', { outcome: { reason: 'spawn refused' } })
  check('2. queued→starting→failed', failed?.state === 'failed' && failed.outcome?.reason === 'spawn refused',
    `state ${failed?.state}; transitionExecution in src/engine/execution-plane/executionPlane.ts must settle a failure and keep opts.outcome`)

  reg('j3')
  go('j3', 'starting')
  go('j3', 'running')
  go('j3', 'waiting')
  const back = go('j3', 'running')
  check('3. running→waiting→running', back?.state === 'running' && back.settledAt === undefined,
    `state ${back?.state}; running to waiting and back must be legal in src/engine/execution-plane/execution.ts and must not settle`)

  go('j3', 'stopping')
  const stopped = go('j3', 'stopped')
  check('4. running→stopping→stopped', stopped?.state === 'stopped',
    `state ${stopped?.state}; running to stopping to stopped must be legal in src/engine/execution-plane/execution.ts`)

  reg('j5')
  go('j5', 'starting')
  go('j5', 'running')
  go('j5', 'stopping')
  const raced = go('j5', 'succeeded')
  check('5. stopping racing success settles succeeded', raced?.state === 'succeeded',
    `state ${raced?.state}; stopping to succeeded must be a legal edge in src/engine/execution-plane/execution.ts`)
}

console.log('generation + idempotence laws')
{
  const r1 = reg('svc')
  check('first generation is 1', r1.generation === 1,
    `generation ${r1.generation}; registerExecution in src/engine/execution-plane/executionPlane.ts must mint generation 1 for a new id`)
  go('svc', 'starting')
  try {
    go('svc', 'running', { generation: 99 })
    check('7. stale generation refused', false,
      'transitionExecution in src/engine/execution-plane/executionPlane.ts accepted opts.generation 99 against a record at generation 1; it must throw ExecutionGenerationError')
  } catch (e) {
    check('7. stale generation refused', e instanceof P.ExecutionGenerationError,
      `threw ${String(e)}; transitionExecution in src/engine/execution-plane/executionPlane.ts must throw ExecutionGenerationError on a stale generation`)
  }
  go('svc', 'running', { generation: 1 })

  try {
    reg('svc')
    check('register over a live record refused', false,
      'registerExecution in src/engine/execution-plane/executionPlane.ts accepted a second registration over a live record; it must throw ExecutionRegistrationError')
  } catch (e) {
    check('register over a live record refused', e instanceof P.ExecutionRegistrationError,
      `threw ${String(e)}; registerExecution in src/engine/execution-plane/executionPlane.ts must throw ExecutionRegistrationError`)
  }

  const settled = P.settleExecution(owner, 'svc', 'stopped')
  check('settle reaches terminal', settled?.state === 'stopped',
    `state ${settled?.state}; check settleExecution in src/engine/execution-plane/executionPlane.ts`)
  const before = events.length
  const again = P.settleExecution(owner, 'svc', 'stopped')
  check('8. duplicate terminal settlement is idempotent (no event, no error)',
    again?.state === 'stopped' && events.length === before,
    `state ${again?.state}, ${events.length - before} new events; settleExecution in src/engine/execution-plane/executionPlane.ts must return the settled record without emitting when the state is already that terminal`)
  try {
    go('svc', 'failed')
    check('cross-terminal move refused', false,
      'transitionExecution in src/engine/execution-plane/executionPlane.ts moved a stopped record to failed; it must throw ExecutionTransitionError')
  } catch (e) {
    check('cross-terminal move refused', e instanceof P.ExecutionTransitionError,
      `threw ${String(e)}; transitionExecution in src/engine/execution-plane/executionPlane.ts must throw ExecutionTransitionError`)
  }

  const r2 = reg('svc')
  check('restart mints generation 2', r2.generation === 2,
    `generation ${r2.generation}; registerExecution in src/engine/execution-plane/executionPlane.ts must increment the generation when the id is registered again after settlement`)
  P.settleExecution(owner, 'svc', 'cancelled')

  try {
    P.settleExecution(owner, 'j1', 'running')
    check('settle refuses non-terminal states', false,
      'settleExecution in src/engine/execution-plane/executionPlane.ts accepted running as a settlement state; it must throw ExecutionTransitionError')
  } catch (e) {
    check('settle refuses non-terminal states', e instanceof P.ExecutionTransitionError,
      `threw ${String(e)}; settleExecution in src/engine/execution-plane/executionPlane.ts must throw ExecutionTransitionError`)
  }
}

console.log('requestStop mechanics')
{
  reg('qstop')
  const cancelled = P.requestStopExecution(owner, 'qstop')
  check('queued stop cancels immediately', cancelled?.state === 'cancelled',
    `state ${cancelled?.state}; requestStopExecution in src/engine/execution-plane/executionPlane.ts must settle a queued record as cancelled`)

  let domainStopCalled = ''
  P.registerExecutionDomain('process', {
    requestStop: r => {
      domainStopCalled = r.spec.id
    },
  })
  reg('rstop')
  go('rstop', 'starting')
  go('rstop', 'running')
  const stopping = P.requestStopExecution(owner, 'rstop')
  check('live stop records stopping + notifies the domain',
    stopping?.state === 'stopping' && domainStopCalled === 'rstop',
    `state ${stopping?.state}, domain hook saw ${JSON.stringify(domainStopCalled)}; requestStopExecution in src/engine/execution-plane/executionPlane.ts must move a live record to stopping and call the requestStop hook registered with registerExecutionDomain`)
  const idem = P.requestStopExecution(owner, 'rstop')
  check('repeated stop request is a no-op', idem?.state === 'stopping',
    `state ${idem?.state}; requestStopExecution in src/engine/execution-plane/executionPlane.ts must return a record already stopping unchanged`)
  P.settleExecution(owner, 'rstop', 'stopped')
}

console.log('references, ordering, bounds')
{
  reg('withrefs', { outputRef: 'mercury://execution/withrefs?child=output' })
  go('withrefs', 'starting')
  go('withrefs', 'running')
  P.observeExecution(owner, 'withrefs', { evidenceRefs: ['mercury://evidence/e1'] })
  const settled = P.settleExecution(owner, 'withrefs', 'succeeded', {
    evidenceRefs: ['mercury://evidence/e2'],
  })
  check('10. output + evidence references accumulate',
    settled?.outputRef === 'mercury://execution/withrefs?child=output' &&
      settled.evidenceRefs.length === 2,
    `outputRef ${settled?.outputRef}, evidenceRefs ${settled?.evidenceRefs.length}; observeExecution and settleExecution in src/engine/execution-plane/executionPlane.ts must keep outputRef and append evidenceRefs`)
  const post = P.observeExecution(owner, 'withrefs', {
    outputRef: 'mercury://execution/other',
    evidenceRefs: ['mercury://evidence/e3'],
  })
  check('terminal records accept evidence only (identity/output frozen)',
    post?.outputRef === 'mercury://execution/withrefs?child=output' && post.evidenceRefs.length === 3,
    `outputRef ${post?.outputRef}, evidenceRefs ${post?.evidenceRefs.length}; observeExecution in src/engine/execution-plane/executionPlane.ts must append evidence only on a terminal record and ignore outputRef`)

  const seqs = events.map(e => e.seq)
  check('events are strictly ordered per owner',
    seqs.every((s, i) => i === 0 || s > seqs[i - 1]!),
    `seqs ${seqs.join(',')}; the per-owner sequence on OrderedExecutionEvent in src/engine/execution-plane/executionPlane.ts must increase on every event`)

  const listed = P.listExecutions(owner, { limit: 2 })
  check('listing is bounded', listed.length === 2,
    `listed ${listed.length}; listExecutions in src/engine/execution-plane/executionPlane.ts must honour opts.limit`)
  const liveOnly = P.listExecutions(owner, { liveOnly: true })
  check('liveOnly filters settled records', liveOnly.every(r => !['succeeded', 'failed', 'stopped', 'cancelled', 'unavailable', 'indeterminate'].includes(r.state)),
    'listExecutions in src/engine/execution-plane/executionPlane.ts must drop settled records when opts.liveOnly is set')

  for (let i = 0; i < 140; i++) {
    reg(`flood-${i}`)
    P.settleExecution(owner, `flood-${i}`, 'cancelled')
  }
  const counts = P.executionPlaneCounts()
  check('settled ring is bounded', counts.records <= 200, `records=${counts.records}`)
  reg('flood-0')
  check('generation memory survives ring eviction',
    P.getExecution(owner, 'flood-0')?.generation === 2,
    `generation ${P.getExecution(owner, 'flood-0')?.generation}; src/engine/execution-plane/executionPlane.ts must remember the last generation of an id after its settled record is evicted from the ring`)
  P.settleExecution(owner, 'flood-0', 'cancelled')
}

console.log('owner disposal')
{
  const disposedIds: string[] = []
  const unsub = P.subscribeExecutionEvents(e => {
    if (e.owner === owner && e.event.type === 'disposed') disposedIds.push(e.event.record.spec.id)
  })
  await disposeOwner(owner)
  check('6. disposal empties the owner and emits disposed events',
    P.listExecutions(owner).length === 0 && disposedIds.length > 0,
    `${P.listExecutions(owner).length} records left, ${disposedIds.length} disposed events; check disposeOwner in src/engine/run-owner/ownerLifecycle.ts and the disposal path in src/engine/execution-plane/executionPlane.ts`)
  check('plane returns to baseline after disposal', P.executionPlaneCounts().owners === 0,
    `owners ${P.executionPlaneCounts().owners}; disposeOwner in src/engine/run-owner/ownerLifecycle.ts must remove the owner from the plane in src/engine/execution-plane/executionPlane.ts`)
  unsub()
}

unsubscribe()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
