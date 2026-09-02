#!/usr/bin/env bun
// ============================================================================
//  scripts/primitives-kernel/prove-primitives-kernel-execution-plane.ts — slice-2 plane laws: the
//  prompt's ten required journeys plus registration/generation/event/bound/
//  leak mechanics. The plane owns lifecycle mechanics ONLY — domain truth
//  arrives through registered observers, and the proofs pin that boundary.
// ============================================================================
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

const P = await import('../../src/services/primitives/index.ts')
const { disposeOwner } = await import('../../src/services/run/ownerLifecycle.ts')

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

// ── the ten required journeys ────────────────────────────────────────────────
console.log('required journeys')
{
  reg('j1')
  go('j1', 'starting')
  go('j1', 'running')
  const done = go('j1', 'succeeded', { outcome: { code: 0 } })
  check('1. queued→starting→running→succeeded', done?.state === 'succeeded' && done.settledAt !== undefined)

  reg('j2')
  go('j2', 'starting')
  const failed = go('j2', 'failed', { outcome: { reason: 'spawn refused' } })
  check('2. queued→starting→failed', failed?.state === 'failed' && failed.outcome?.reason === 'spawn refused')

  reg('j3')
  go('j3', 'starting')
  go('j3', 'running')
  go('j3', 'waiting')
  const back = go('j3', 'running')
  check('3. running→waiting→running', back?.state === 'running' && back.settledAt === undefined)

  go('j3', 'stopping')
  const stopped = go('j3', 'stopped')
  check('4. running→stopping→stopped', stopped?.state === 'stopped')

  reg('j5')
  go('j5', 'starting')
  go('j5', 'running')
  go('j5', 'stopping')
  const raced = go('j5', 'succeeded')
  check('5. stopping racing success settles succeeded', raced?.state === 'succeeded')
}

// ── stale generation + duplicate terminal + registration laws ───────────────
console.log('generation + idempotence laws')
{
  const r1 = reg('svc')
  check('first generation is 1', r1.generation === 1)
  go('svc', 'starting')
  try {
    go('svc', 'running', { generation: 99 })
    check('7. stale generation refused', false)
  } catch (e) {
    check('7. stale generation refused', e instanceof P.ExecutionGenerationError)
  }
  go('svc', 'running', { generation: 1 })

  try {
    reg('svc')
    check('register over a live record refused', false)
  } catch (e) {
    check('register over a live record refused', e instanceof P.ExecutionRegistrationError)
  }

  const settled = P.settleExecution(owner, 'svc', 'stopped')
  check('settle reaches terminal', settled?.state === 'stopped')
  const before = events.length
  const again = P.settleExecution(owner, 'svc', 'stopped')
  check('8. duplicate terminal settlement is idempotent (no event, no error)',
    again?.state === 'stopped' && events.length === before)
  try {
    go('svc', 'failed')
    check('cross-terminal move refused', false)
  } catch (e) {
    check('cross-terminal move refused', e instanceof P.ExecutionTransitionError)
  }

  const r2 = reg('svc')
  check('restart mints generation 2', r2.generation === 2)
  P.settleExecution(owner, 'svc', 'cancelled')

  try {
    P.settleExecution(owner, 'j1', 'running')
    check('settle refuses non-terminal states', false)
  } catch (e) {
    check('settle refuses non-terminal states', e instanceof P.ExecutionTransitionError)
  }
}

// ── requestStop mechanics ────────────────────────────────────────────────────
console.log('requestStop mechanics')
{
  reg('qstop')
  const cancelled = P.requestStopExecution(owner, 'qstop')
  check('queued stop cancels immediately', cancelled?.state === 'cancelled')

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
    stopping?.state === 'stopping' && domainStopCalled === 'rstop')
  const idem = P.requestStopExecution(owner, 'rstop')
  check('repeated stop request is a no-op', idem?.state === 'stopping')
  P.settleExecution(owner, 'rstop', 'stopped')
}

// ── reconciliation (Law 6) ───────────────────────────────────────────────────
console.log('reconciliation laws')
{
  P._resetExecutionPlaneForTesting()
  events.length = 0
  reg('dead-proc')
  go('dead-proc', 'starting')
  go('dead-proc', 'running', {
    externalIdentity: { pid: 999999, startToken: 'tok' },
  })
  reg('mystery', { kind: 'background-job' })
  go('mystery', 'starting')

  const before = P.reconcileExecutions(owner)
  check('no reconciler ⇒ honestly unverifiable, record untouched',
    before.unverifiable.includes('dead-proc') && before.unverifiable.includes('mystery') &&
      P.getExecution(owner, 'dead-proc')?.state === 'running')

  P.registerExecutionDomain('process', {
    reconcile: record =>
      record.externalIdentity?.pid === 999999
        ? { state: 'failed', outcome: { reason: 'process gone (reconciled)' } }
        : null,
  })
  const report = P.reconcileExecutions(owner)
  const corrected = P.getExecution(owner, 'dead-proc')
  check('9. reconciliation corrects a stale apparent-live record',
    report.corrected.some(c => c.id === 'dead-proc' && c.to === 'failed') &&
      corrected?.state === 'failed')
  const reconciledEvent = events.find(
    e => e.event.type === 'transition' && e.event.record.spec.id === 'dead-proc' && e.event.to === 'failed',
  )
  check('reconciled transitions are MARKED reconciled',
    reconciledEvent?.event.type === 'transition' && reconciledEvent.event.reconciled === true)
  check('domains that cannot answer stay unverifiable', report.unverifiable.includes('mystery'))
  P.settleExecution(owner, 'mystery', 'indeterminate', { outcome: { reason: 'unverifiable at teardown' } })
}

// ── output/evidence refs + ordered events + bounds ──────────────────────────
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
      settled.evidenceRefs.length === 2)
  const post = P.observeExecution(owner, 'withrefs', {
    outputRef: 'mercury://execution/other',
    evidenceRefs: ['mercury://evidence/e3'],
  })
  check('terminal records accept evidence only (identity/output frozen)',
    post?.outputRef === 'mercury://execution/withrefs?child=output' && post.evidenceRefs.length === 3)

  const seqs = events.map(e => e.seq)
  check('events are strictly ordered per owner',
    seqs.every((s, i) => i === 0 || s > seqs[i - 1]!))

  const listed = P.listExecutions(owner, { limit: 2 })
  check('listing is bounded', listed.length === 2)
  const liveOnly = P.listExecutions(owner, { liveOnly: true })
  check('liveOnly filters settled records', liveOnly.every(r => !['succeeded', 'failed', 'stopped', 'cancelled', 'unavailable', 'indeterminate'].includes(r.state)))

  // Settled-ring bound: flood with settled records; ring stays capped;
  // generation memory survives eviction.
  for (let i = 0; i < 140; i++) {
    reg(`flood-${i}`)
    P.settleExecution(owner, `flood-${i}`, 'cancelled')
  }
  const counts = P.executionPlaneCounts()
  check('settled ring is bounded', counts.records <= 200, `records=${counts.records}`)
  reg('flood-0')
  check('generation memory survives ring eviction',
    P.getExecution(owner, 'flood-0')?.generation === 2)
  P.settleExecution(owner, 'flood-0', 'cancelled')
}

// ── 6. owner disposal ────────────────────────────────────────────────────────
console.log('owner disposal')
{
  const disposedIds: string[] = []
  const unsub = P.subscribeExecutionEvents(e => {
    if (e.owner === owner && e.event.type === 'disposed') disposedIds.push(e.event.record.spec.id)
  })
  await disposeOwner(owner)
  check('6. disposal empties the owner and emits disposed events',
    P.listExecutions(owner).length === 0 && disposedIds.length > 0)
  check('plane returns to baseline after disposal', P.executionPlaneCounts().owners === 0)
  unsub()
}

unsubscribe()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
