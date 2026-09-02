#!/usr/bin/env bun
// ============================================================================
//  scripts/router/prove-scribe-route-flow.ts
//  FUNCTIONAL PROOF (scribe stream, hermetic — real builders/compiler/store/
//  bridge/adapter, fake roster, scratch mailbox + route store, no daemon, no
//  API): the scribe route flow.
//    1. RouteWork 'plan' (bounded mission) → sonnet-opus-review, the dispatch
//       envelope carries route{model,effort} + routePlan identity, the node is
//       'dispatched' (outbox-first).
//    2. The bridge on an opus@max worker RECONFIGURES to sonnet-5@high at the
//       idle boundary and HOLDS the dispatch (0 delivered; node 'held').
//    3. The fresh (matching) worker gets EXACTLY ONE delivery; the observer
//       lands node 'delivered'; a re-drain never double-delivers.
//    4. A typed completion report lands node 'reported' (+completion digest);
//       RouteWork 'accept' closes the single-node plan.
//    5. A LEGACY envelope (no route-plan fields) routes through the local fallback:
//       mechanical task on an already-matching worker delivers with ZERO
//       reconfigure.
//    6. Posture 'fixed' routes NOTHING (no reconfigure, plain delivery).
//  Run: ~/.bun/bin/bun run scripts/router/prove-scribe-route-flow.ts
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const routerDir = mkdtempSync(join(tmpdir(), 'route-flow-router-'))
const teamsDir = mkdtempSync(join(tmpdir(), 'route-flow-teams-'))
process.env.MERCURY_ROUTER_STATE_DIR = routerDir
process.env.MERCURY_TEAMS_DIR = teamsDir
delete process.env.MERCURY_ROUTER_POSTURE
process.env.MERCURY_EVOLUTION_LEDGER = '0'
// AMBIENT-STATE fence (F6): the route adapter consults the PERSISTED seat
// slots — the operator's real
// <configHome>/seat-slots.json must never steer this proof.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'route-flow-home-'))
delete process.env.MERCURY_IMPLEMENTER_MODEL
delete process.env.MERCURY_IMPLEMENTER_EFFORT

const { drainScribeDispatches } = await import('../../src/daemon/scribeDispatchBridge.js')
const { resolveScribeDispatchRoute } = await import('../../src/utils/router/adapters/scribe.js')
const { handleRoutePlan } = await import('../../src/tools/SendMessageTool/routePlanOps.js')
const { routerRunStore, routerStoreWriters } = await import('../../src/substrate/routerRunStore.js')
const { buildDispatch, serializeScribeEnvelope, parseScribeEnvelope } = await import(
  '../../src/utils/scribe/scribeBus.js'
)
const { writeToMailbox, readUnreadMessages } = await import('../../src/utils/teammateMailbox.js')

let failures = 0
const check = (cond: boolean, msg: string): void => {
  if (cond) console.log(`  [PASS] ${msg}`)
  else {
    failures++
    console.error(`  [FAIL] ${msg}`)
  }
}
// Observer writes are fire-and-forget BY DESIGN (never block delivery) — the
// proof polls briefly for the settled state.
const settle = async (pred: () => Promise<boolean>): Promise<boolean> => {
  for (let i = 0; i < 40; i++) {
    if (await pred()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return pred()
}

// ── The fake worker: live spec + delivered frames + reconfigure log ──────────
// Seeded with the CURRENT implementer seat default (seatSlots.ts, D-02a).
let workerSpec = { model: 'claude-opus-5', effort: 'max' }
const reconfigures: Array<{ model?: string; effort?: string }> = []
const frames: string[] = []
const roster = {
  reply: async (_short: string, text: string): Promise<boolean> => {
    frames.push(text)
    return true
  },
}
const seen = new Set<string>()
const drainOnce = () =>
  drainScribeDispatches(roster, {
    short: 'implementer',
    agentName: 'implementer',
    teamName: 'scribe',
    isBusy: () => false,
    hasSeen: id => seen.has(id),
    markSeen: id => seen.add(id),
    durableDedup: false,
    resolveRoute: env => resolveScribeDispatchRoute(env, workerSpec),
    currentRoute: () => workerSpec,
    reconfigureRoute: patch => {
      reconfigures.push(patch)
      workerSpec = { ...workerSpec, ...patch }
    },
    onRouteHeld: (env, patch) => {
      if (env.routePlan) {
        void routerStoreWriters.nodeHeld(
          env.routePlan.planId,
          env.routePlan.nodeId,
          `reconfiguring${patch.model ? ` → ${patch.model}` : ''}`,
          Date.now(),
        )
      }
    },
    onDelivered: env => {
      void routerStoreWriters.requestDelivered(env.request_id, Date.now())
    },
  })

const send = async (to: string, env: Parameters<typeof serializeScribeEnvelope>[0]) => {
  await writeToMailbox(
    to,
    { from: 'team-lead', text: serializeScribeEnvelope(env), timestamp: new Date().toISOString() },
    'scribe',
  )
  return { data: { success: true, message: 'sent', request_id: env.request_id, target: to } }
}

// ── 1. RouteWork 'plan' ───────────────────────────────────────────────────────
const planAck = await handleRoutePlan(
  'implementer',
  {
    type: 'route_plan',
    op: 'plan',
    objective: 'add the missing --json flag to the status command',
    title: 'status --json',
    task: 'Implement a --json output mode for the status command in src/commands/status.ts with a unit test.',
    taskShape: 'bounded',
    ambiguity: 0,
    coupling: 0,
    parallelism: 0,
    nodes: [
      {
        id: 'n1',
        title: 'status --json',
        task: 'Add the flag, emit stable JSON, cover with one test.',
        ownsPaths: ['src/commands/status.ts'],
        acceptance: ['status --json emits parseable JSON', 'the new test passes'],
      },
    ],
  },
  { send, senderRole: 'scribe', senderName: 'team-lead', executors: [] },
)
const ackBody = JSON.parse(planAck.data.message) as { planId: string; profile: string; models: string[]; reasons: string[] }
check(planAck.data.success && ackBody.profile === 'sonnet-opus-review', `plan ack: ${ackBody.profile} [${ackBody.reasons.join(',')}]`)
check(ackBody.models.some(m => m.startsWith('sonnet:claude-sonnet-5@high')), `sonnet-5@high selected (${ackBody.models.join(', ')})`)
const planId = ackBody.planId

{
  const unread = await readUnreadMessages('implementer', 'scribe')
  const env = unread.map(m => parseScribeEnvelope(m.text)).find(e => e?.kind === 'dispatch')
  check(
    env?.kind === 'dispatch' && env.route?.model === 'claude-sonnet-5' && env.routePlan?.planId === planId,
    'the outbound envelope carries route{model,effort} + routePlan identity',
  )
  const st = await routerRunStore().read()
  const node = st.plans.find(p => p.id === planId)!.nodes[0]!
  check(node.state === 'dispatched' && node.busRequestId === env!.request_id, 'outbox-first: node dispatched with the exact request id')
}

// ── 2+3. reconfigure-at-idle → held → exactly-once delivery ─────────────────
{
  const delivered1 = await drainOnce()
  check(delivered1 === 0 && reconfigures.length === 1 && reconfigures[0]!.model === 'claude-sonnet-5' && reconfigures[0]!.effort === 'high',
    'first drain reconfigures opus@max → sonnet-5@high and HOLDS (0 delivered)')
  const heldOk = await settle(async () => {
    const n = (await routerRunStore().read()).plans.find(p => p.id === planId)!.nodes[0]!
    return n.state === 'held'
  })
  check(heldOk, "node parks 'held' (the UI shows the transition, never a spinner)")
  const delivered2 = await drainOnce()
  check(delivered2 === 1 && frames.length === 1, 'the matching worker gets exactly ONE delivery')
  const delivered3 = await drainOnce()
  check(delivered3 === 0 && frames.length === 1, 're-drain never double-delivers')
  const deliveredOk = await settle(async () => {
    const n = (await routerRunStore().read()).plans.find(p => p.id === planId)!.nodes[0]!
    return n.state === 'delivered'
  })
  check(deliveredOk, "observer landed 'delivered'")
  check(frames[0]!.includes('ACCEPTANCE') && frames[0]!.includes('RETURN CONTRACT'), 'the delivered frame is the capsule contract')
}

// ── 4. typed completion → accept ─────────────────────────────────────────────
{
  const node = (await routerRunStore().read()).plans.find(p => p.id === planId)!.nodes[0]!
  await routerStoreWriters.requestReported(
    node.busRequestId!,
    '{"summary":"flag added + test green","checks":["status --json emits parseable JSON: PASS","new test: PASS"],"changedAreas":["src/commands/status.ts"],"unresolved":[]}',
    Date.now(),
  )
  const reported = (await routerRunStore().read()).plans.find(p => p.id === planId)!.nodes[0]!
  check(reported.state === 'reported' && reported.completion?.checksReported.length === 2, 'typed completion recorded against the contract')
  const acceptAck = await handleRoutePlan(
    'implementer',
    { type: 'route_plan', op: 'accept', planId, nodeId: 'n1' },
    { send, senderRole: 'scribe', senderName: 'team-lead', executors: [] },
  )
  const acc = JSON.parse(acceptAck.data.message) as { planState: string }
  check(acceptAck.data.success && acc.planState === 'accepted', `acceptance closes the single-node plan (${acc.planState})`)
}

// ── 5. legacy envelope → local fallback, zero churn on a matching worker ─────
{
  const legacy = buildDispatch('team-lead', 'rename the typo in the header comment of src/commands/status.ts', {
    title: 'typo',
  })
  await writeToMailbox('implementer', { from: 'team-lead', text: serializeScribeEnvelope(legacy), timestamp: new Date().toISOString() }, 'scribe')
  const before = reconfigures.length
  const delivered = await drainOnce()
  check(delivered === 1 && reconfigures.length === before, 'legacy mechanical dispatch delivers with ZERO reconfigure (fallback matched the warm sonnet worker)')
}

// ── 6. posture 'fixed' routes nothing ────────────────────────────────────────
{
  process.env.MERCURY_ROUTER_POSTURE = 'fixed'
  const deep = buildDispatch('team-lead', 'refactor the whole daemon architecture end-to-end across roster.ts main.ts controlServer.ts', { title: 'deep' })
  await writeToMailbox('implementer', { from: 'team-lead', text: serializeScribeEnvelope(deep), timestamp: new Date().toISOString() }, 'scribe')
  const before = reconfigures.length
  const delivered = await drainOnce()
  check(delivered === 1 && reconfigures.length === before, "posture 'fixed' preserves the pinned topology (no reconfigure, plain delivery)")
  delete process.env.MERCURY_ROUTER_POSTURE
}

// ── 7. OPERATOR MODEL-AXIS PIN ───────────
//  A persisted implementer slot is durable operator intent: the adaptive
//  fabric may route EFFORT but must never move the seat off the slotted
//  model. Without the pin, the fallback compile silently retargeted an
//  explicitly-slotted Implementer on the next trivial dispatch.
{
  const { setOperatorSeatSlot, clearOperatorSeatSlot } = await import('../../src/utils/model/seatSlots.js')
  const saved = setOperatorSeatSlot('implementer', { model: 'claude-fable-5' })
  check(saved.ok, 'persist an explicit implementer slot (claude-fable-5)')
  // A mechanical task on an opus worker would compile to sonnet-5 — the pin
  // must keep the slotted model while effort still routes.
  const legacy = buildDispatch('team-lead', 'rename the typo in the header comment of src/commands/status.ts', { title: 'typo' })
  const patch = resolveScribeDispatchRoute(parseScribeEnvelope(serializeScribeEnvelope(legacy))!, {
    model: 'claude-opus-5',
    effort: 'max',
  })
  check(patch !== undefined && patch.model === 'claude-fable-5', `pinned slot owns the model axis (route → ${patch?.model})`)
  check(patch !== undefined && patch.effort !== undefined, 'effort axis still routes under the pin')
  // A RouteWork-resolved envelope's model yields to the pin the same way.
  const routed = buildDispatch('team-lead', 'bounded fix', { title: 'routed', route: { model: 'claude-sonnet-5', effort: 'high' } })
  const patch2 = resolveScribeDispatchRoute(parseScribeEnvelope(serializeScribeEnvelope(routed))!, {
    model: 'claude-opus-5',
    effort: 'max',
  })
  check(patch2 !== undefined && patch2.model === 'claude-fable-5' && patch2.effort === 'high', 'envelope route model yields to the pin; its effort is honored')
  // Clearing the slot restores full adaptive routing (origin back to default).
  clearOperatorSeatSlot('implementer')
  const patch3 = resolveScribeDispatchRoute(parseScribeEnvelope(serializeScribeEnvelope(legacy))!, {
    model: 'claude-opus-5',
    effort: 'max',
  })
  check(patch3 === undefined || patch3.model !== 'claude-fable-5', 'cleared slot restores adaptive model routing')
}

console.log('════════════════════════════════════════════════════════════════════════════')
rmSync(routerDir, { recursive: true, force: true })
rmSync(teamsDir, { recursive: true, force: true })
if (failures > 0) {
  console.error(`❌ ${failures} scribe route-flow proof(s) failed`)
  process.exit(1)
}
console.log('✅ SCRIBE ROUTE FLOW PROVEN END-TO-END')
