#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-capacity-governor.ts — (the core): the
//  ONE capacity owner. Subsumes repro-permit-backstop VERBATIM (the owner +
//  the permit pair — retired into this standing prover when the owner
//  landed; stays unmet until the streamModel backstop wiring, the
//  profile composition and the spawn-surface propagation are proven).
//
//  §1  the owner + permit surface (frozen verbatim).
//  §2  admission truth at lanes=1: the second acquire WAITS (truthful
//      waitedMs) and admits deterministically on release.
// §3 the interactive reserve: background never takes the LAST lane;
//      foreground does; at ceiling 1 the single lane is shared
//      foreground-first in the queue.
//  §4  idempotency: same-callId reacquire re-answers the HELD permit
//      (fallback revalidation, no double count); release is idempotent and
//      addressable by call.
//  §5  hysteresis: lowering ceilings revokes nothing (drains at release);
//      raising admits waiters immediately.
//  §6  the composition (profile+machine+role terms): the role
//      partition (two-seat worker · single-seat children · visible machine
//      allowance), the delegation BAND mapping (1→1, 2→2, 3→machine — the
//      profile fact is delegation width, never a duplicate in-process
//      clamp), and the machine formula shared with the workflow limiter.
//  §7  the delegation-class clamp: 'background-session' admission honors
//      min(background allowance, delegationLanes) while foreground and
//      service traffic keep their own admission.
//  §8  the workflow limiter consumes the SAME composed truth
//      (computeConcurrencyCap = min(historical clamp, delegationLanes)).
// ============================================================================

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

t.section('§3 — the interactive reserve')
{
  gov._resetCapacityGovernorForTesting()
  gov.setGovernorCeilings({ modelLanes: 2 })
  const bg1 = await gov.acquireModelPermit({ lane: 'background-session', callId: 'b.c1', sessionId: 's1' })
  let bg2Granted = false
  void gov.acquireModelPermit({ lane: 'background-session', callId: 'b.c2', sessionId: 's2' }).then(() => {
    bg2Granted = true
  })
  await settleTick()
  t.check('background never takes the LAST lane (1 of 2 held ⇒ bg queues)', bg2Granted === false, String(bg2Granted))
  const fg = await gov.acquireModelPermit({ lane: 'foreground', callId: 'f.c1' })
  t.check('foreground takes the reserved last lane immediately', fg.waitedMs === 0, JSON.stringify(fg))
  gov.releaseModelPermit(fg.permitId)
  await settleTick()
  t.check('a freed lane still honors the reserve (bg keeps waiting at 1 of 2)', bg2Granted === false, String(bg2Granted))
  gov.releaseModelPermit(bg1.permitId)
  await settleTick()
  t.check('bg admits once the board drops below the reserve line', bg2Granted === true, String(bg2Granted))
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

t.section('§6 — the §5.6 composition: roles, the delegation band, the machine term')
{
  const compose = await import('../../src/services/capacity/composeCeilings.js')
  t.check('machine allowance = min(16, max(2, cpu−2)) — the shared formula', compose.machineLaneAllowance(10) === 8 && compose.machineLaneAllowance(2) === 2 && compose.machineLaneAllowance(64) === 16, `${compose.machineLaneAllowance(10)}/${compose.machineLaneAllowance(2)}/${compose.machineLaneAllowance(64)}`)
  const worker = compose.composeGovernorCeilings({ cpuCount: 10, role: 'concourse-worker', delegationBand: 3, operatorLanes: null })
  t.check('a concourse worker composes the TWO-SEAT law (2 lanes, 1 delegated)', worker.modelLanes === 2 && worker.delegationLanes === 1, JSON.stringify(worker))
  const seat = compose.composeGovernorCeilings({ cpuCount: 10, role: 'single-seat', delegationBand: null, operatorLanes: null })
  t.check('a party seat / Implementer composes ONE lane (a seat is one seat)', seat.modelLanes === 1 && seat.delegationLanes === 1, JSON.stringify(seat))
  const visible = compose.composeGovernorCeilings({ cpuCount: 10, role: 'visible', delegationBand: null, operatorLanes: null })
  t.check('the visible process composes the machine allowance (unarmed profile ⇒ full width)', visible.modelLanes === 8 && visible.delegationLanes === 8, JSON.stringify(visible))
  const solo = compose.composeGovernorCeilings({ cpuCount: 10, role: 'visible', delegationBand: 1, operatorLanes: null })
  t.check('a band-1 (solo) profile serializes delegation — the REAL profile input', solo.delegationLanes === 1 && solo.modelLanes === 8, JSON.stringify(solo))
  const band2 = compose.composeGovernorCeilings({ cpuCount: 10, role: 'visible', delegationBand: 2, operatorLanes: null })
  t.check('a band-2 profile composes two delegated lanes', band2.delegationLanes === 2, JSON.stringify(band2))
  const band3 = compose.composeGovernorCeilings({ cpuCount: 10, role: 'visible', delegationBand: 3, operatorLanes: null })
  t.check('band 3 defers to the machine term (never a NEW clamp)', band3.delegationLanes === 8, JSON.stringify(band3))

  t.check("role detection: the worker role env composes 'concourse-worker'", compose.composedRoleFromEnv({ MERCURY_CONCOURSE_WORKER: '1' }) === 'concourse-worker', 'worker')
  t.check("role detection: the implementer stamp composes 'single-seat'; a RETIRED seat stamp composes nothing", compose.composedRoleFromEnv({ MERCURY_IMPLEMENTER: '1' }) === 'single-seat' && compose.composedRoleFromEnv({ MERCURY_TANK: '1' }) === 'visible', 'seat')
  t.check("role detection: a clean env composes 'visible'", compose.composedRoleFromEnv({}) === 'visible', 'visible')
  const pinned = compose.composeGovernorCeilings({ cpuCount: 10, role: 'visible', delegationBand: null, operatorLanes: 1 })
  t.check('the §5.6 OPERATOR term mins BOTH axes (MERCURY_MODEL_LANES=1 serializes)', pinned.modelLanes === 1 && pinned.delegationLanes === 1, JSON.stringify(pinned))
  t.check('operator-term parsing: registered env → int, junk → null', compose.operatorLanesFromEnv({ MERCURY_MODEL_LANES: '3' }) === 3 && compose.operatorLanesFromEnv({ MERCURY_MODEL_LANES: 'x' }) === null && compose.operatorLanesFromEnv({}) === null, 'parse')
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
  t.check('at default ceilings the historical clamp is byte-identical', computeConcurrencyCap(10) === 8 && computeConcurrencyCap(64) === 16, `${computeConcurrencyCap(10)}/${computeConcurrencyCap(64)}`)
  gov.setGovernorCeilings({ delegationLanes: 1 })
  t.check('a composed delegation ceiling narrows the workflow scheduler too (one truth)', computeConcurrencyCap(10) === 1, String(computeConcurrencyCap(10)))
  gov._resetCapacityGovernorForTesting()
}

t.finish('prove-capacity-governor')
