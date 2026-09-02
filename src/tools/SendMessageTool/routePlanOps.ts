// ============================================================================
//  routePlanOps — the RouteWork seam: the Opus role's structured route contract
//  over the EXISTING bus write-path (a SendMessage `route_plan` message).
//
//  The route fabric deliberately does NOT mint a second dispatch tool: SendMessage is the
//  model's one bus channel, the planner packs already speak its structured
//  kinds, and one write-path keeps the supersede/dedup/journal law in one
//  place. `route_plan` gives the planner (the Scribe, or a routed planner
//  seat) the decisions it is uniquely positioned to make —
//  objective, decomposition, ownership, acceptance, model-CLASS preference —
//  and the LOCAL compiler validates, enriches, schedules, and REFUSES
//  incoherent graphs. The model never picks a provider-specific id (exactPin
//  is the operator's spelling, resolved-or-refused).
//
//  Ops:
//    plan         compile + commit + dispatch the initial ready set
//    accept       accept a reported node (promotes dependents; scribe-mode
//                 dispatches the next ready node in the same call)
//    revise       one focused revision = a bounded new attempt, re-dispatched
//    cancel       cancel a node (or the whole plan when nodeId is absent)
//    synthesize   the bounded synthesis packet (typed completions only)
//    accept-plan  final mission acceptance (the mechanical synthesis gate)
//    explain      the last decision record + event tail (why this route?)
//  Every op returns a compact JSON acknowledgement the model reads as data.
// ============================================================================
import { routerRunStore, routerStoreWriters } from '../../substrate/routerRunStore.js'
import { readOutcomeSnapshot } from '../../substrate/routerOutcomeStore.js'
import { logForDebugging } from '../../utils/debug.js'
import { generateRoutePlanId, type RouteBand, type RouteTaskShape, type TaskRoutePlan } from '../../utils/router/contracts.js'
import { buildContextCapsule, buildSynthesisPacket, renderCapsuleFrame } from '../../utils/router/contextCapsule.js'
import { buildRouterModelSnapshot } from '../../utils/router/modelRegistry.js'
import { resolveRouterModelPin, resolveRouterPosture } from '../../utils/router/postures.js'
import { compileRoute, type RouteCandidateNode } from '../../utils/router/routeCompiler.js'
import { nextAssignments, type SchedulerWorker } from '../../utils/router/scheduler.js'
import { buildDispatch, type DispatchEnvelope } from '../../utils/scribe/scribeBus.js'
import type { RouterModelClass } from '../../utils/router/providers/types.js'
import type { RequestOutput } from './SendMessageTool.js'

export interface RoutePlanMessage {
  type: 'route_plan'
  op: 'plan' | 'accept' | 'revise' | 'cancel' | 'synthesize' | 'accept-plan' | 'explain'
  objective?: string
  title?: string
  task?: string
  taskShape?: RouteTaskShape
  ambiguity?: number
  coupling?: number
  parallelism?: number
  requiresSynthesis?: boolean
  modelHint?: RouterModelClass
  exactPin?: string
  nodes?: Array<{
    id: string
    title: string
    task: string
    dependsOn?: string[]
    ownsPaths?: string[]
    acceptance?: string[]
    requestedModelClass?: RouterModelClass
    expectedResult?: string
  }>
  planId?: string
  nodeId?: string
  note?: string
  /** the typed replan trigger (the observed-event classes) — an
   *  invalid value nacks; when present it is recorded in the revision note. */
  trigger?: string
}

export interface RoutePlanDeps {
  /** The existing envelope delivery path (sendScribeEnvelope, injected). */
  send: (to: string, env: DispatchEnvelope) => Promise<{ data: RequestOutput }>
  senderRole: 'scribe' | 'router' | 'maintainer'
  /** The bus sender identity (scribeSenderName() at the call site). */
  senderName: string
  /** Executor lanes for fan-out (empty ⇒ nothing fans out). */
  executors: readonly string[]
}

const band = (v: number | undefined): RouteBand | undefined =>
  v === 0 || v === 1 || v === 2 || v === 3 ? v : undefined

function ack(message: string, requestId = '', target = ''): { data: RequestOutput } {
  return { data: { success: true, message, request_id: requestId, target } }
}
function nack(message: string, target = ''): { data: RequestOutput } {
  return { data: { success: false, message, request_id: '', target } }
}

async function readPlan(planId: string | undefined, mode?: 'scribe' | 'party'): Promise<TaskRoutePlan | null> {
  const state = await routerRunStore().read().catch(() => null)
  if (!state) return null
  if (planId) return state.plans.find(p => p.id === planId) ?? null
  const candidates = mode ? state.plans.filter(p => p.mode === mode) : state.plans
  return candidates[candidates.length - 1] ?? null
}

/** Dispatch one ready node: outbox-first (a refused transition never writes the
 *  mailbox), the capsule frame as the delivered task text. */
async function dispatchNode(
  plan: TaskRoutePlan,
  nodeId: string,
  worker: string,
  senderRoleFrom: string,
  deps: RoutePlanDeps,
  now: number,
): Promise<string | null> {
  const node = plan.nodes.find(n => n.id === nodeId)
  if (!node) return null
  const capsule = buildContextCapsule({ plan, node, now })
  const env = buildDispatch(senderRoleFrom, renderCapsuleFrame(capsule), {
    title: node.title,
    ...(node.assignedModel
      ? { route: { model: node.assignedModel.model, effort: node.assignedModel.effort } }
      : {}),
    routePlan: { planId: plan.id, nodeId: node.id, revision: plan.revision, attempt: node.attempt },
  })
  const applied = await routerStoreWriters.nodeDispatched(plan.id, node.id, env.request_id, worker, undefined, now)
  if (!applied) return null
  await deps.send(worker, env)
  return env.request_id
}

export async function handleRoutePlan(
  targetName: string,
  msg: RoutePlanMessage,
  deps: RoutePlanDeps,
): Promise<{ data: RequestOutput }> {
  const now = Date.now()
  const mode: 'scribe' | 'party' = deps.senderRole === 'scribe' ? 'scribe' : 'party'
  const senderFrom = deps.senderName

  try {
    switch (msg.op) {
      case 'plan': {
        if (!msg.objective || !msg.task) {
          return nack("route_plan op 'plan' needs objective + task (and usually nodes)", targetName)
        }
        // No worker lane is shared-dir now (the seat rows that carried that
        // truth left with the router party); every executor lane isolates.
        const sharedLane = false
        const posture = resolveRouterPosture()
        const pin = resolveRouterModelPin()
        const taskShape = msg.taskShape
        const outcome =
          taskShape !== undefined && band(msg.ambiguity) !== undefined && band(msg.coupling) !== undefined
            ? await readOutcomeSnapshot({
                mode,
                taskShape,
                ambiguity: msg.ambiguity as number,
                coupling: msg.coupling as number,
                now,
              })
            : undefined
        const result = compileRoute({
          mode,
          intentSource: 'structured',
          mission: {
            objective: msg.objective,
            title: msg.title ?? msg.objective,
            task: msg.task,
            ...(taskShape ? { taskShape } : {}),
            ...(band(msg.ambiguity) !== undefined ? { ambiguity: band(msg.ambiguity) } : {}),
            ...(band(msg.coupling) !== undefined ? { coupling: band(msg.coupling) } : {}),
            ...(band(msg.parallelism) !== undefined ? { parallelism: band(msg.parallelism) } : {}),
            ...(msg.nodes ? { candidateNodes: msg.nodes as RouteCandidateNode[] } : {}),
            ...(msg.modelHint ? { modelHint: msg.modelHint } : {}),
            ...(pin !== 'auto' && !msg.modelHint ? { modelHint: pin } : {}),
            ...(msg.exactPin ? { exactPin: msg.exactPin } : {}),
            ...(msg.requiresSynthesis !== undefined ? { requiresSynthesis: msg.requiresSynthesis } : {}),
          },
          posture,
          models: buildRouterModelSnapshot(),
          worker: { maxWidth: mode === 'party' ? 3 : 1, sharedLane },
          ...(outcome ? { outcome } : {}),
          now,
          planId: generateRoutePlanId(now),
        })
        if (!result.ok) {
          return nack(
            `route REFUSED [${result.refusal.reasonCodes.join(', ')}]: ${result.refusal.detail}. Repair the graph and re-plan — nothing was dispatched.`,
            targetName,
          )
        }
        const plan = result.plan
        await routerStoreWriters.commitPlan(plan, now)
        // Initial ready-set dispatch.
        const dispatched: string[] = []
        if (mode === 'scribe') {
          const first = plan.nodes.find(n => n.state === 'ready')
          if (first) {
            const committed = await readPlan(plan.id)
            if (committed) {
              const id = await dispatchNode(committed, first.id, targetName, senderFrom, deps, now)
              if (id) dispatched.push(`${first.id}→${targetName}`)
            }
          }
        } else {
          const committed = await readPlan(plan.id)
          if (committed) {
            const workers: SchedulerWorker[] = deps.executors.map(
              short => ({ short, modelClass: 'sonnet', busy: false }),
            )
            const assignments = nextAssignments(committed, workers, { sharedLane })
            for (const a of assignments) {
              const fresh = await readPlan(plan.id)
              if (!fresh) break
              const id = await dispatchNode(fresh, a.nodeId, a.worker, senderFrom, deps, now)
              if (id) dispatched.push(`${a.nodeId}→${a.worker}`)
            }
          }
        }
        const d = plan.decision
        return ack(
          JSON.stringify({
            planId: plan.id,
            profile: plan.profile,
            width: dispatched.length || 1,
            models: d.selectedModels.map(m => `${m.modelClass}:${m.model}@${m.effort}`),
            reasons: d.decisiveReasons,
            adjustments: d.adjustments,
            dispatched,
            synthesis: plan.synthesis.required ? plan.synthesis.owner : 'not-required',
            next:
              dispatched.length > 0
                ? 'Workers will report typed completions; accept or revise each against its acceptance contract.'
                : 'No node was dispatchable now (held/blocked) — the scheduler resumes it at the next boundary.',
          }),
          plan.id,
          targetName,
        )
      }

      case 'accept': {
        if (!msg.planId || !msg.nodeId) return nack("op 'accept' needs planId + nodeId", targetName)
        await routerStoreWriters.acceptNode(msg.planId, msg.nodeId, deps.senderRole, now)
        const plan = await readPlan(msg.planId)
        if (!plan) return nack(`unknown plan '${msg.planId}'`, targetName)
        const dispatched: string[] = []
        if (plan.mode === 'scribe' && plan.state === 'running') {
          const next = plan.nodes.find(n => n.state === 'ready')
          if (next) {
            const id = await dispatchNode(plan, next.id, targetName, senderFrom, deps, now)
            if (id) dispatched.push(`${next.id}→${targetName}`)
          }
        }
        return ack(
          JSON.stringify({
            planId: plan.id,
            accepted: msg.nodeId,
            planState: plan.state,
            dispatched,
            ...(plan.state === 'synthesizing'
              ? { next: `all nodes accepted — synthesize, then op 'accept-plan' for final acceptance` }
              : {}),
          }),
          plan.id,
          targetName,
        )
      }

      case 'revise': {
        if (!msg.planId || !msg.nodeId || !msg.note) {
          return nack("op 'revise' needs planId + nodeId + note (the focused unmet acceptance)", targetName)
        }
        // a typed trigger, when given, must come from the closed
        // vocabulary; it rides the revision note (durable + classifiable).
        const { isMissionReplanTrigger, MISSION_REPLAN_TRIGGERS } = await import(
          '../../services/mission/replan.js'
        )
        if (msg.trigger !== undefined && !isMissionReplanTrigger(msg.trigger)) {
          return nack(
            `unknown replan trigger '${msg.trigger}' — one of: ${MISSION_REPLAN_TRIGGERS.join(', ')}`,
            targetName,
          )
        }
        const revisionNote = msg.trigger ? `[trigger: ${msg.trigger}] ${msg.note}` : msg.note
        await routerStoreWriters.reviseNode(msg.planId, msg.nodeId, revisionNote, now)
        const plan = await readPlan(msg.planId)
        const node = plan?.nodes.find(n => n.id === msg.nodeId)
        if (!plan || !node) return nack(`unknown plan/node '${msg.planId}/${msg.nodeId}'`, targetName)
        if (node.state !== 'ready') {
          return nack(
            `revision refused (node is '${node.state}', attempt ${node.attempt}) — see /router explain`,
            targetName,
          )
        }
        const worker = plan.mode === 'scribe' ? targetName : (node.assignedWorker ?? deps.executors[0] ?? targetName)
        const id = await dispatchNode(plan, node.id, worker, senderFrom, deps, now)
        return ack(
          JSON.stringify({ planId: plan.id, revised: node.id, attempt: node.attempt, dispatched: id ? [`${node.id}→${worker}`] : [] }),
          plan.id,
          targetName,
        )
      }

      case 'cancel': {
        if (!msg.planId) return nack("op 'cancel' needs planId (nodeId optional)", targetName)
        if (msg.nodeId) await routerStoreWriters.cancelNode(msg.planId, msg.nodeId, msg.note ?? 'planner cancel', now)
        else await routerStoreWriters.cancelPlan(msg.planId, msg.note ?? 'planner cancel', now)
        return ack(JSON.stringify({ planId: msg.planId, cancelled: msg.nodeId ?? 'plan' }), msg.planId, targetName)
      }

      case 'synthesize': {
        const plan = await readPlan(msg.planId, mode)
        if (!plan) return nack('no route plan found to synthesize', targetName)
        return ack(JSON.stringify(buildSynthesisPacket(plan)), plan.id, targetName)
      }

      case 'accept-plan': {
        if (!msg.planId) return nack("op 'accept-plan' needs planId", targetName)
        await routerStoreWriters.acceptPlan(msg.planId, deps.senderRole, now)
        const plan = await readPlan(msg.planId)
        return ack(JSON.stringify({ planId: msg.planId, planState: plan?.state ?? 'unknown' }), msg.planId, targetName)
      }

      case 'explain': {
        const plan = await readPlan(msg.planId, mode)
        if (!plan) return nack('no route plan recorded yet', targetName)
        const state = await routerRunStore().read()
        return ack(
          JSON.stringify({
            planId: plan.id,
            state: plan.state,
            profile: plan.profile,
            decision: plan.decision,
            nodes: plan.nodes.map(n => ({
              id: n.id,
              state: n.state,
              attempt: n.attempt,
              worker: n.assignedWorker,
              model: n.assignedModel ? `${n.assignedModel.model}@${n.assignedModel.effort}` : undefined,
            })),
            recentEvents: state.events.filter(e => e.planId === plan.id).slice(-10),
          }),
          plan.id,
          targetName,
        )
      }
    }
  } catch (e) {
    logForDebugging(`[router] route_plan op '${msg.op}' failed: ${e}`)
    return nack(`route_plan op '${msg.op}' failed: ${String(e).split('\n')[0]}`, targetName)
  }
  return nack(`unknown route_plan op`, targetName)
}
