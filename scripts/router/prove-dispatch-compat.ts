#!/usr/bin/env bun
// ============================================================================
//  scripts/router/prove-dispatch-compat.ts
//  CHARACTERIZATION: the per-task router
//  (dispatchRouter.ts) and the scribe bus envelope decoder (scribeBus.ts)
//  are the substrate the routing kernel sits ABOVE without
//  breaking anything already dispatching. This is a characterization
//  proof, not a design proof: it pins the observable behavior (classifier
//  outputs, envelope round-trips, minimal hand-written envelopes still
//  decoding) that the kernel composes against.
//
//  Covers:
//   - decideDispatchRoute: keyword/file-count/length-driven effort+lane.
//   - normalizeRouteEffort: clamps to the allowed set, else undefined.
//   - resolveDispatchEffort: envelope effort wins over the classifier.
//   - parseScribeEnvelope: round-trips buildDispatch output (route.effort/lane),
//     parses a minimal hand-written envelope with only route.effort (no lane,
//     no plan fields at all), and IGNORES unknown extra fields (routePlanId/
//     routeNodeId) — proving the plan fields are backward-safe additions,
//     never something the decoder chokes on.
//
//  Run:  ~/.bun/bin/bun run scripts/router/prove-dispatch-compat.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const router = (await import('../../src/utils/scribe/dispatchRouter.js')) as typeof import('../../src/utils/scribe/dispatchRouter.js')
const bus = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')

console.log('============================================================')
console.log(' router fixture-corpus phase — dispatch-compat characterization')
console.log('============================================================')

section('decideDispatchRoute (pure classifier) — current behavior pinned')

const renameDecision = router.decideDispatchRoute('rename the header comment in foo.ts')
check(
  'a bounded rename (mechanical keyword, 1 file, short) ⇒ effort high / lane quick',
  renameDecision.effort === 'high' && renameDecision.lane === 'quick',
  `got effort=${renameDecision.effort} lane=${renameDecision.lane}`,
)

const refactorMission =
  'refactor the auth pipeline end to end: rework src/auth/tokenRefresh.ts, src/auth/sessionGuard.ts, and src/auth/authMiddleware.ts so the retry/backoff logic is shared instead of duplicated three times, and audit every call site for the race the current implementation leaves open. ' +
  'x'.repeat(700 - 260)
check('a ~700-char refactor mission mentioning 3 .ts files is actually ≥600 chars', refactorMission.length >= 600, `len=${refactorMission.length}`)
const refactorDecision = router.decideDispatchRoute(refactorMission)
check(
  'a long refactor mission naming 3 files ⇒ effort max / lane deep',
  refactorDecision.effort === 'max' && refactorDecision.lane === 'deep',
  `got effort=${refactorDecision.effort} lane=${refactorDecision.lane}`,
)

const plainMedium = 'add a --json flag to the status command so it prints machine-readable output alongside the existing table'
const plainDecision = router.decideDispatchRoute(plainMedium)
check(
  'a plain medium task (no deep keyword, no quick keyword, <600 chars) ⇒ effort xhigh / lane standard',
  plainDecision.effort === 'xhigh' && plainDecision.lane === 'standard',
  `got effort=${plainDecision.effort} lane=${plainDecision.lane}`,
)

section('normalizeRouteEffort — clamp to the allowed set')
check("normalizeRouteEffort('junk') ⇒ undefined (unknown value never smuggled through)", router.normalizeRouteEffort('junk') === undefined)
check("normalizeRouteEffort('max') ⇒ 'max'", router.normalizeRouteEffort('max') === 'max')
check("normalizeRouteEffort('high') ⇒ 'high'", router.normalizeRouteEffort('high') === 'high')
check("normalizeRouteEffort('xhigh') ⇒ 'xhigh'", router.normalizeRouteEffort('xhigh') === 'xhigh')

section('resolveDispatchEffort — envelope effort wins over the classifier')
const resolvedExplicit = router.resolveDispatchEffort('rename the header comment in foo.ts', 'max')
check(
  "an explicit envelope effort ('max') wins even though the classifier would say 'high'",
  resolvedExplicit.effort === 'max' && resolvedExplicit.source === 'envelope',
  `got effort=${resolvedExplicit.effort} source=${resolvedExplicit.source}`,
)
const resolvedFallback = router.resolveDispatchEffort('rename the header comment in foo.ts', undefined)
check(
  'no envelope effort ⇒ falls back to the classifier',
  resolvedFallback.effort === 'high' && resolvedFallback.source === 'classifier',
  `got effort=${resolvedFallback.effort} source=${resolvedFallback.source}`,
)
const resolvedBogus = router.resolveDispatchEffort('rename the header comment in foo.ts', 'turbo')
check(
  'a bogus envelope effort is rejected by normalizeRouteEffort ⇒ classifier decides, never an invalid effort',
  resolvedBogus.source === 'classifier' && resolvedBogus.effort === 'high',
  `got effort=${resolvedBogus.effort} source=${resolvedBogus.source}`,
)

section('parseScribeEnvelope — total decoder compatibility (new-built, old hand-written, forward-safe)')

const built = bus.buildDispatch('team-lead', 'root-cause the daemon crash', {
  title: 'Daemon crash triage',
  route: { effort: 'max', lane: 'deep' },
})
const builtText = bus.serializeScribeEnvelope(built)
const roundTripped = bus.parseScribeEnvelope(builtText)
check(
  'a freshly built dispatch (buildDispatch) with route {effort:max, lane:deep} round-trips through serialize+parse',
  roundTripped !== null &&
    roundTripped.kind === 'dispatch' &&
    (roundTripped as typeof built).task === 'root-cause the daemon crash' &&
    (roundTripped as typeof built).route?.effort === 'max' &&
    (roundTripped as typeof built).route?.lane === 'deep',
  `got ${JSON.stringify(roundTripped)}`,
)

const oldEnvelopeText = JSON.stringify({
  type: 'scribe_protocol',
  kind: 'dispatch',
  request_id: 'x1',
  from: 'team-lead',
  timestamp: '2026-01-01T00:00:00Z',
  task: 't',
  route: { effort: 'high' },
})
const oldParsed = bus.parseScribeEnvelope(oldEnvelopeText)
check(
  'an OLD hand-written envelope (only route.effort, no lane, no route-plan fields at all) still parses',
  oldParsed !== null &&
    oldParsed.kind === 'dispatch' &&
    (oldParsed as { route?: { effort?: string } }).route?.effort === 'high' &&
    (oldParsed as { route?: { lane?: string } }).route?.lane === undefined,
  `got ${JSON.stringify(oldParsed)}`,
)

const forwardSafeText = JSON.stringify({
  type: 'scribe_protocol',
  kind: 'dispatch',
  request_id: 'x1',
  from: 'team-lead',
  timestamp: '2026-01-01T00:00:00Z',
  task: 't',
  route: { effort: 'high' },
  routePlanId: 'p1',
  routeNodeId: 'n1',
})
const forwardSafeParsed = bus.parseScribeEnvelope(forwardSafeText)
check(
  'an envelope carrying UNKNOWN extra fields (routePlanId, routeNodeId — future route-plan additions) still parses (backward-safe: the current decoder ignores fields it does not know about, it never refuses on their presence)',
  forwardSafeParsed !== null &&
    forwardSafeParsed.kind === 'dispatch' &&
    (forwardSafeParsed as unknown as Record<string, unknown>).routePlanId === 'p1' &&
    (forwardSafeParsed as unknown as Record<string, unknown>).routeNodeId === 'n1',
  `got ${JSON.stringify(forwardSafeParsed)}`,
)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DISPATCH-COMPAT CHARACTERIZATION PROOFS PASS')
else console.log(`❌ ${failures} DISPATCH-COMPAT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
