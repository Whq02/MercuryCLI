#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { checker } from '../engine-durability/harness.ts'

const t = checker()
const gov = (await import('../../src/services/capacity/governor.js')) as Record<string, unknown> &
  typeof import('../../src/services/capacity/governor.js')

t.section('§1 — the ONE capacity owner exists with the permit pair (repro, verbatim)')
{
  t.check('src/services/capacity/governor.ts exists', gov != null, 'present')
  t.check('it exports acquireModelPermit()', typeof gov.acquireModelPermit === 'function', 'present')
  t.check('it exports releaseModelPermit()', typeof gov.releaseModelPermit === 'function', 'present')
}

const settleTick = () => new Promise(r => setTimeout(r, 10))

t.section('§2 — admission truth at lanes=1')
{
  gov._resetCapacityGovernorForTesting()
  gov.setGovernorCeilings({ modelLanes: 1 })
  const first = await gov.acquireModelPermit({ lane: 'foreground', callId: 't1.c1' })
  t.check('the first acquire grants immediately (waitedMs 0)', first.waitedMs === 0 && !first.reacquired, JSON.stringify(first))
  let secondGranted = false
  const secondP = gov.acquireModelPermit({ lane: 'foreground', callId: 't1.c2' }).then(g => {
    secondGranted = true
    return g
  })
  await settleTick()
  t.check('the second acquire WAITS while the lane is held', secondGranted === false, String(secondGranted))
  gov.releaseModelPermit(first.permitId)
  const second = await secondP
  t.check('release admits the waiter with a truthful wait', secondGranted === true && second.waitedMs >= 0, JSON.stringify(second))
  gov.releaseModelPermit(second.permitId)
}

t.section('§3 — the seats law: every seat may be filled; the foreground goes first in the queue')
{
  gov._resetCapacityGovernorForTesting()
  gov.setGovernorCeilings({ modelLanes: 2, delegationLanes: 2 })
  const bg1 = await gov.acquireModelPermit({ lane: 'background-session', callId: 'b.c1', sessionId: 's1', holder: 'agent-a' })
  const bg2 = await gov.acquireModelPermit({ lane: 'background-session', callId: 'b.c2', sessionId: 's2', holder: 'agent-b' })
  t.check('two seats ⇒ two delegated calls run at once (no seat held idle)', bg1.waitedMs === 0 && bg2.waitedMs === 0, JSON.stringify([bg1, bg2]))
  let bg3Words: string | null | undefined
  let bg3Granted = false
  void gov.acquireModelPermit({ lane: 'background-session', callId: 'b.c3', holder: 'agent-c', onWait: w => { bg3Words = w } }).then(() => {
    bg3Granted = true
  })
  let fgGranted = false
  void gov.acquireModelPermit({ lane: 'foreground', callId: 'f.c1' }).then(() => {
    fgGranted = true
  })
  await settleTick()
  t.check('a third delegated call waits and hears the seat sentence', bg3Granted === false && bg3Words === 'waiting for a seat — 2 of 2 held (agent-a, agent-b)', String(bg3Words))
  t.check("the chat's own call waits too when every seat is held", fgGranted === false, String(fgGranted))
  gov.releaseModelPermit(bg1.permitId)
  await settleTick()
  t.check('the freed seat goes to the FOREGROUND first (its place at the head of the queue)', fgGranted === true && bg3Granted === false, `fg ${fgGranted} bg3 ${bg3Granted}`)
  t.check("the waiter's sentence is re-spoken with the new holders", bg3Words === 'waiting for a seat — 2 of 2 held (agent-b, the chat)', String(bg3Words))
  gov.releaseModelPermitByCall('f.c1')
  await settleTick()
  t.check('then the delegated waiter, and its wait line clears', bg3Granted === true && bg3Words === null, `bg3 ${bg3Granted} words ${String(bg3Words)}`)
  gov._resetCapacityGovernorForTesting()
}

t.section('§3b — a stopped waiter leaves the queue')
{
  gov._resetCapacityGovernorForTesting()
  gov.setGovernorCeilings({ modelLanes: 1, delegationLanes: 1 })
  const held = await gov.acquireModelPermit({ lane: 'background-session', callId: 'k.c1', holder: 'agent-a' })
  const stop = new AbortController()
  const { APIUserAbortError } = await import('../../src/services/api/sdkErrors.js')
  let deadOutcome = 'pending'
  gov.acquireModelPermit({ lane: 'background-session', callId: 'k.c2', holder: 'agent-b', signal: stop.signal }).then(
    () => { deadOutcome = 'admitted' },
    (e: unknown) => { deadOutcome = e instanceof APIUserAbortError ? 'rejected:APIUserAbortError' : `rejected:${String(e)}` },
  )
  let liveGranted = false
  void gov.acquireModelPermit({ lane: 'background-session', callId: 'k.c3', holder: 'agent-c' }).then(() => { liveGranted = true })
  await settleTick()
  t.check('both wait behind the one seat', deadOutcome === 'pending' && liveGranted === false && gov._governorStateForTesting().waiters === 2, JSON.stringify(gov._governorStateForTesting()))
  stop.abort()
  await settleTick()
  t.check('the stopped waiter leaves the queue and rejects as the user\'s abort', deadOutcome === 'rejected:APIUserAbortError' && gov._governorStateForTesting().waiters === 1, `${deadOutcome} · ${JSON.stringify(gov._governorStateForTesting())}`)
  gov.releaseModelPermit(held.permitId)
  await settleTick()
  t.check('the freed seat goes to the LIVE waiter, never the dead one', liveGranted === true && gov._governorStateForTesting().held === 1, JSON.stringify(gov._governorStateForTesting()))
  const dead = gov.acquireModelPermit({ lane: 'background-session', callId: 'k.c4', signal: AbortSignal.abort() })
  let refused = false
  await dead.catch(() => { refused = true })
  t.check('an already-stopped request never queues', refused === true, String(refused))
  gov._resetCapacityGovernorForTesting()
}

t.section('§4 — idempotency')
{
  gov._resetCapacityGovernorForTesting()
  gov.setGovernorCeilings({ modelLanes: 2 })
  const a = await gov.acquireModelPermit({ lane: 'foreground', callId: 'x.c1' })
  const re = await gov.acquireModelPermit({ lane: 'foreground', callId: 'x.c1' })
  t.check('same-callId reacquire re-answers the HELD permit (no double count)', re.permitId === a.permitId && re.reacquired === true && gov.heldPermits().length === 1, JSON.stringify(re))
  gov.releaseModelPermit(a.permitId)
  gov.releaseModelPermit(a.permitId)
  t.check('release is idempotent', gov.heldPermits().length === 0, String(gov.heldPermits().length))
  const b = await gov.acquireModelPermit({ lane: 'foreground', callId: 'y.c1' })
  gov.releaseModelPermitByCall('y.c1')
  t.check('release-by-call settles the held permit (the finally path)', gov.heldPermits().length === 0, JSON.stringify(b))
}

t.section('§5 — hysteresis')
{
  gov._resetCapacityGovernorForTesting()
  gov.setGovernorCeilings({ modelLanes: 3 })
  const p1 = await gov.acquireModelPermit({ lane: 'foreground', callId: 'h.c1' })
  const p2 = await gov.acquireModelPermit({ lane: 'foreground', callId: 'h.c2' })
  gov.setGovernorCeilings({ modelLanes: 1 })
  t.check('lowering revokes NOTHING (both permits still held — drain at release)', gov.heldPermits().length === 2, String(gov.heldPermits().length))
  let queuedGranted = false
  void gov.acquireModelPermit({ lane: 'foreground', callId: 'h.c3' }).then(() => {
    queuedGranted = true
  })
  await settleTick()
  t.check('new work queues under the lowered ceiling', queuedGranted === false, String(queuedGranted))
  gov.releaseModelPermit(p1.permitId)
  await settleTick()
  t.check('a release under an over-held board admits nothing yet (2 held > ceiling 1... drains toward it)', queuedGranted === false && gov.heldPermits().length === 1, `${gov.heldPermits().length} held`)
  gov.releaseModelPermit(p2.permitId)
  await settleTick()
  t.check('draining to below-ceiling admits the waiter', queuedGranted === true, String(queuedGranted))
  gov.setGovernorCeilings({ modelLanes: 3 })
  gov._resetCapacityGovernorForTesting()
}

t.section('§6 — the composition: the seats, the delegation band, the operator term, the provenance')
{
  const compose = await import('../../src/services/capacity/composeCeilings.js')
  const seats3 = compose.composeGovernorCeilings({ seats: 3, seatSource: 'consented', delegationBand: null, profileId: null, operatorLanes: null })
  t.check('three seats compose three lanes and three delegated lanes — the seats are the one truth', seats3.modelLanes === 3 && seats3.delegationLanes === 3, JSON.stringify(seats3))
  const inherited = compose.composeGovernorCeilings({ seats: 5, seatSource: 'inherited', delegationBand: 3, profileId: 'anthropic-default', operatorLanes: null })
  t.check("the daemon's inherited reading composes the same way; band 3 defers to the seats (never a NEW clamp)", inherited.modelLanes === 5 && inherited.delegationLanes === 5, JSON.stringify(inherited))
  const solo = compose.composeGovernorCeilings({ seats: 3, seatSource: 'machine', delegationBand: 1, profileId: 'openai-default', operatorLanes: null })
  t.check('a band-1 (solo) profile narrows delegation to one lane under three seats', solo.delegationLanes === 1 && solo.modelLanes === 3, JSON.stringify(solo))
  const soloWhy = compose.composeProvenance({ seats: 3, seatSource: 'machine', delegationBand: 1, profileId: 'openai-default', operatorLanes: null }, solo)
  t.check('…and the provenance names the profile as the narrowing term', soloWhy.narrowing?.by === 'profile' && soloWhy.narrowing.band === 1 && soloWhy.narrowing.profileId === 'openai-default' && soloWhy.seats === 3 && soloWhy.seatSource === 'machine', JSON.stringify(soloWhy))
  const band2 = compose.composeGovernorCeilings({ seats: 3, seatSource: 'consented', delegationBand: 2, profileId: 'zai-default', operatorLanes: null })
  t.check('a band-2 profile composes two delegated lanes under three seats', band2.delegationLanes === 2 && band2.modelLanes === 3, JSON.stringify(band2))
  const wide = compose.composeGovernorCeilings({ seats: 2, seatSource: 'consented', delegationBand: 3, profileId: 'anthropic-default', operatorLanes: null })
  t.check('a band never WIDENS past the seats', wide.delegationLanes === 2, JSON.stringify(wide))
  const none = compose.composeProvenance({ seats: 3, seatSource: 'consented', delegationBand: null, profileId: null, operatorLanes: null }, seats3)
  t.check('nothing narrows ⇒ no narrowing in the provenance', none.narrowing === null && none.seatSource === 'consented', JSON.stringify(none))
  const pinned = compose.composeGovernorCeilings({ seats: 3, seatSource: 'consented', delegationBand: null, profileId: null, operatorLanes: 1 })
  t.check('the OPERATOR term mins BOTH axes (MERCURY_MODEL_LANES=1 serializes)', pinned.modelLanes === 1 && pinned.delegationLanes === 1, JSON.stringify(pinned))
  const pinnedWhy = compose.composeProvenance({ seats: 3, seatSource: 'consented', delegationBand: null, profileId: null, operatorLanes: 1 }, pinned)
  t.check('…and the provenance names the operator ceiling', pinnedWhy.narrowing?.by === 'operator' && pinnedWhy.narrowing.lanes === 1, JSON.stringify(pinnedWhy))
  t.check('operator-term parsing: registered env → int, junk → null', compose.operatorLanesFromEnv({ MERCURY_MODEL_LANES: '3' }) === 3 && compose.operatorLanesFromEnv({ MERCURY_MODEL_LANES: 'x' }) === null && compose.operatorLanesFromEnv({}) === null, 'parse')
  t.check('inherited-seats parsing: the daemon stamp → int, junk/absent → null', compose.inheritedSeatsFromEnv({ MERCURY_SEATS: '4' }) === 4 && compose.inheritedSeatsFromEnv({ MERCURY_SEATS: '0' }) === null && compose.inheritedSeatsFromEnv({}) === null, 'parse')
}

t.section('§7 — the delegation-class clamp at admission')
{
  gov._resetCapacityGovernorForTesting()
  gov.setGovernorCeilings({ modelLanes: 4, delegationLanes: 1 })
  const bg1 = await gov.acquireModelPermit({ lane: 'background-session', callId: 'd.b1' })
  t.check('the first delegated acquire admits', bg1.waitedMs === 0, JSON.stringify(bg1))
  let bg2Granted = false
  const bg2 = gov.acquireModelPermit({ lane: 'background-session', callId: 'd.b2' }).then(g => {
    bg2Granted = true
    return g
  })
  await settleTick()
  t.check('a SECOND delegated acquire queues behind delegationLanes=1 (lanes free)', bg2Granted === false && gov.heldPermits().length === 1, `${gov.heldPermits().length} held`)
  const svc = await gov.acquireModelPermit({ lane: 'service', callId: 'd.s1' })
  t.check('service traffic keeps its own admission (not delegation-clamped)', svc.waitedMs === 0, JSON.stringify(svc))
  const fg = await gov.acquireModelPermit({ lane: 'foreground', callId: 'd.f1' })
  t.check('foreground admission untouched by the delegation clamp', fg.waitedMs === 0, JSON.stringify(fg))
  gov.releaseModelPermitByCall('d.b1')
  await bg2
  t.check('releasing the delegated seat admits the queued delegated waiter', bg2Granted === true, String(bg2Granted))
  gov._resetCapacityGovernorForTesting()
}

t.section('§8 — the workflow limiter consumes the composed truth')
{
  gov._resetCapacityGovernorForTesting()
  const { computeConcurrencyCap } = await import('../../src/tools/WorkflowTool/agentHooks.js')
  gov.setGovernorCeilings({ modelLanes: 3, delegationLanes: 3 })
  t.check('three seats ⇒ the workflow scheduler runs three agents at once (no CPU arithmetic of its own)', computeConcurrencyCap() === 3, String(computeConcurrencyCap()))
  gov.setGovernorCeilings({ delegationLanes: 1 })
  t.check('a composed delegation ceiling narrows the workflow scheduler too (one truth)', computeConcurrencyCap() === 1, String(computeConcurrencyCap()))
  gov._resetCapacityGovernorForTesting()
}

t.finish('prove-capacity-governor')
