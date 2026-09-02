#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'route-lifecycle-'))
process.env.MERCURY_ROUTER_STATE_DIR = dir

const { compileRoute } = await import('../../src/utils/router/routeCompiler.js')
const { buildRouterModelSnapshot } = await import('../../src/utils/router/modelRegistry.js')
const { nextAssignments, NODE_MAX_ATTEMPTS } = await import('../../src/utils/router/scheduler.js')
const { routerRunStore, routerStoreWriters, reconcileRouterRuns } = await import(
  '../../src/substrate/routerRunStore.js'
)

let failures = 0
const check = (cond: boolean, msg: string): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}`)
  }
}

const NOW = 1_800_000_000_000
const snapshot = buildRouterModelSnapshot()

function compileGraphPlan(planId: string) {
  const r = compileRoute({
    mode: 'fanout',
    mission: {
      objective: 'ship the three-stage migration',
      title: 'migration',
      task: 'schema, then implementation, then docs',
      taskShape: 'bounded',
      ambiguity: 0,
      coupling: 1,
      parallelism: 1,
      candidateNodes: [
        { id: 'n1', title: 'schema', task: 'migrate the schema', dependsOn: [], ownsPaths: ['src/schema.ts'], acceptance: ['schema compiles'] },
        { id: 'n2', title: 'impl', task: 'implement against the new schema', dependsOn: ['n1'], ownsPaths: ['src/impl.ts'], acceptance: ['tests green'] },
        { id: 'n3', title: 'docs', task: 'update the docs', dependsOn: ['n1'], ownsPaths: ['docs/x.md'], acceptance: ['docs mention the new field'] },
      ],
    },
    posture: 'adaptive',
    models: snapshot,
    worker: { maxWidth: 3, sharedLane: false },
    now: NOW,
    planId,
  })
  if (!r.ok) throw new Error(`compile refused: ${r.refusal.detail}`)
  return r.plan
}

const read = async () => routerRunStore().read()
const planOf = async (id: string) => (await read()).plans.find(p => p.id === id)!
const nodeOf = async (id: string, nid: string) => (await planOf(id)).nodes.find(n => n.id === nid)!

{
  const plan = compileGraphPlan('rp-t1')
  await routerStoreWriters.commitPlan(plan, NOW)
  let p = await planOf('rp-t1')
  check(p.state === 'running', 'committed plan runs')
  check(
    p.nodes.find(n => n.id === 'n1')!.state === 'ready' &&
      p.nodes.find(n => n.id === 'n2')!.state === 'blocked',
    'roots ready, dependents blocked at commit',
  )
  await routerStoreWriters.nodeDispatched('rp-t1', 'n1', 'req-1', 'dps1', 1, NOW + 1)
  await routerStoreWriters.requestDelivered('req-1', NOW + 2)
  await routerStoreWriters.requestWorking('req-1', NOW + 3)
  await routerStoreWriters.requestReported('req-1', '{"summary":"schema migrated","checks":["schema compiles: PASS"],"changedAreas":["src/schema.ts"],"unresolved":[]} done', NOW + 4)
  p = await planOf('rp-t1')
  check(p.nodes.find(n => n.id === 'n2')!.state === 'blocked', 'reported (unaccepted) does NOT promote dependents')
  await routerStoreWriters.acceptNode('rp-t1', 'n1', 'planner', NOW + 5)
  p = await planOf('rp-t1')
  check(
    p.nodes.find(n => n.id === 'n2')!.state === 'ready' && p.nodes.find(n => n.id === 'n3')!.state === 'ready',
    'acceptance promotes BOTH dependents in the same mutation',
  )
  const n1 = p.nodes.find(n => n.id === 'n1')!
  check(n1.completion?.acceptedBy === 'planner' && n1.completion.checksReported.length === 1, 'typed completion + acceptor recorded')
}

{
  const p = await planOf('rp-t1')
  const assigns = nextAssignments(p, [
    { short: 'dps1', modelClass: 'sonnet', busy: false },
    { short: 'dps2', modelClass: 'sonnet', busy: false },
  ])
  check(assigns.length === 2, 'two ready disjoint nodes → two assignments on two free lanes')
  const one = nextAssignments(p, [
    { short: 'dps1', modelClass: 'sonnet', busy: false },
    { short: 'dps2', modelClass: 'sonnet', busy: true },
  ])
  check(one.length === 1, 'a busy lane is never double-assigned (width ≤ capacity)')
  const shared = nextAssignments(p, [{ short: 'dps1', modelClass: 'sonnet', busy: false }, { short: 'dps2', modelClass: 'sonnet', busy: false }], { sharedLane: true })
  check(shared.length === 1, 'shared-lane topology caps assignments at 1')
  const reconf = nextAssignments(p, [{ short: 'dps1', modelClass: 'opus', busy: false }])
  check(reconf.length === 1 && reconf[0]!.needsReconfigure, 'class mismatch surfaces needsReconfigure, never silent')
}

{
  await routerStoreWriters.nodeDispatched('rp-t1', 'n2', 'req-2', 'dps1', 3, NOW + 10)
  await routerStoreWriters.requestDelivered('req-2', NOW + 11)
  await routerStoreWriters.requestWorking('req-2', NOW + 12, 2)
  let n2 = await nodeOf('rp-t1', 'n2')
  check(n2.state === 'delivered', 'a STALE generation (2 < 3) cannot advance the node')
  await routerStoreWriters.requestWorking('req-2', NOW + 13, 3)
  await routerStoreWriters.requestReported('req-2', '{"summary":"impl done","checks":["tests green: PASS"],"changedAreas":["src/impl.ts"],"unresolved":[]}', NOW + 14, 3)
  await routerStoreWriters.requestReported('req-2', '{"summary":"impl done TWICE","checks":[],"changedAreas":[],"unresolved":[]}', NOW + 15, 3)
  n2 = await nodeOf('rp-t1', 'n2')
  check(n2.state === 'reported' && n2.completion?.summary === 'impl done', 'duplicate settle event is idempotent (first completion wins)')
}

{
  await routerStoreWriters.reviseNode('rp-t1', 'n2', 'address the failing acceptance only', NOW + 20)
  let n2 = await nodeOf('rp-t1', 'n2')
  check(n2.state === 'ready' && n2.attempt === 2 && n2.busRequestId === undefined, 'revision = new bounded attempt, request identity cleared')
  await routerStoreWriters.nodeDispatched('rp-t1', 'n2', 'req-2b', 'dps1', 4, NOW + 21)
  await routerStoreWriters.requestFailed('req-2b', 'still failing', NOW + 22, 4)
  await routerStoreWriters.reviseNode('rp-t1', 'n2', 'one more focused pass', NOW + 23)
  await routerStoreWriters.nodeDispatched('rp-t1', 'n2', 'req-2c', 'dps1', 5, NOW + 24)
  await routerStoreWriters.requestFailed('req-2c', 'third failure', NOW + 25, 5)
  await routerStoreWriters.reviseNode('rp-t1', 'n2', 'over the ceiling', NOW + 26)
  n2 = await nodeOf('rp-t1', 'n2')
  check(n2.state === 'failed' && n2.attempt === NODE_MAX_ATTEMPTS, `revision refuses over the ${NODE_MAX_ATTEMPTS}-attempt ceiling (node stays failed)`)
  const events = (await read()).events
  check(events.some(e => e.to === 'refused:revise'), 'the refused revision left a visible event echo')
}

{
  const plan = compileGraphPlan('rp-t2')
  await routerStoreWriters.commitPlan(plan, NOW + 30)
  await routerStoreWriters.acceptPlan('rp-t2', 'planner', NOW + 31)
  let p = await planOf('rp-t2')
  check(p.state !== 'accepted', 'final acceptance REFUSED while nodes are unaccepted')
  for (const [nid, req] of [['n1', 'r1'], ['n2', 'r2'], ['n3', 'r3']] as const) {
    await routerStoreWriters.nodeDispatched('rp-t2', nid, req, 'dps1', 1, NOW + 32)
    await routerStoreWriters.requestDelivered(req, NOW + 33)
    await routerStoreWriters.requestReported(req, `{"summary":"${nid} done","checks":["PASS"],"changedAreas":[],"unresolved":[]}`, NOW + 34)
    await routerStoreWriters.acceptNode('rp-t2', nid, 'planner', NOW + 35)
  }
  p = await planOf('rp-t2')
  check(p.state === 'synthesizing', 'all nodes accepted + synthesis required ⇒ synthesizing (not auto-accepted)')
  await routerStoreWriters.acceptPlan('rp-t2', 'planner', NOW + 36)
  p = await planOf('rp-t2')
  check(p.state === 'accepted', 'synthesis owner acceptance closes the plan')
}

{
  const plan = compileGraphPlan('rp-t3')
  await routerStoreWriters.commitPlan(plan, NOW + 40)
  await routerStoreWriters.nodeDispatched('rp-t3', 'n1', 'req-31', 'dps1', 1, NOW + 41)
  const plan2 = compileGraphPlan('rp-t4')
  await routerStoreWriters.commitPlan(plan2, NOW + 42)
  await routerStoreWriters.nodeDispatched('rp-t4', 'n1', 'req-41', 'dps2', 1, NOW + 43)
  const touched = await reconcileRouterRuns({
    deliveredState: async id => (id === 'req-31' ? 'delivered' : null),
    workerGeneration: () => 1,
    now: NOW + 50,
  })
  check(touched >= 2, 'reconciliation touched both in-flight nodes')
  const n31 = await nodeOf('rp-t3', 'n1')
  const n41 = await nodeOf('rp-t4', 'n1')
  check(n31.state === 'delivered', 'durably-delivered dispatch upgraded (lost mark healed), NOT redelivered')
  check(n41.state === 'ready' && n41.busRequestId === 'req-41', 'never-delivered dispatch requeued to ready')
  await routerStoreWriters.requestDelivered('req-31', NOW + 51)
  const before = await nodeOf('rp-t3', 'n1')
  check(before.state === 'delivered', 'precondition: n1 delivered')
  await reconcileRouterRuns({
    deliveredState: async () => 'delivered',
    workerGeneration: () => 3,
    now: NOW + 52,
  })
  const after = await nodeOf('rp-t3', 'n1')
  check(
    after.state === 'ready' && after.attempt === 2,
    'retired-generation attempt becomes a bounded NEW attempt (no phantom completion)',
  )
}

{
  const p = await planOf('rp-t1')
  const n3 = p.nodes.find(n => n.id === 'n3')!
  const stateBefore = n3.state
  await routerStoreWriters.requestReported('nonexistent-req', '{"summary":"?"}', NOW + 60)
  const pAfter = await planOf('rp-t1')
  check(
    pAfter.nodes.find(n => n.id === 'n3')!.state === stateBefore,
    'an unrouted request id never invents/advances a row',
  )
}

console.log('════════════════════════════════════════════════════════════════════════════')
rmSync(dir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`❌ ${failures} lifecycle invariant(s) violated`)
  process.exit(1)
}
console.log('✅ ALL ROUTE LIFECYCLE INVARIANTS HOLD')
