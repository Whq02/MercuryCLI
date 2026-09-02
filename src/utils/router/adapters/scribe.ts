// ============================================================================
//  router/adapters/scribe — the Scribe-stream binding of the routing kernel.
//
//  The daemon's dispatch bridge asks ONE question per chosen dispatch: "what
//  model+effort should the Implementer run for THIS task?" This adapter
//  answers it from (in precedence order):
//    1. posture 'fixed'          → undefined (nothing routes — pinned topology);
//    2. the envelope's RESOLVED route (RouteWork wrote it) — re-validated
//       FAIL-CLOSED through seatSlots here (a junk/Haiku model in a mailbox
//       file can never reach a spawn spec);
//    3. the LOCAL FALLBACK compile — a legacy dispatch (no route-plan fields)
//       routes through compileRoute's legacy path (decideDispatchRoute inside),
//       so old envelopes keep working and still benefit from model routing.
//  The operator model PIN (/router pin opus|sonnet) forces the class on the
//  fallback path and is visible in the decision record as 'operator-pin'.
//  Every reconfigure this produces is applied by the bridge ONLY at a real
//  idle boundary (the existing respawn-if-idle-else-queue seam) — never
//  mid-turn.
// ============================================================================
import type { DispatchEnvelope } from '../../scribe/scribeBus.js'
import { resolveImplementerSeat, validateSeatEffort, validateSeatModel } from '../../model/seatSlots.js'
import type { EffortValue } from '../../effort.js'
import { logForDebugging } from '../../debug.js'
import { generateRoutePlanId } from '../contracts.js'
import { buildRouterModelSnapshot, classOfModel } from '../modelRegistry.js'
import { resolveRouterModelPin, resolveRouterPosture } from '../postures.js'
import { compileRoute } from '../routeCompiler.js'

export interface ScribeRoutePatch {
  model?: string
  effort?: string
}

/**
 * Resolve the route target for one chosen scribe dispatch. `current` is the
 * Implementer's live spec (roster truth). Returns undefined when nothing
 * should change hands (fixed posture / resolution failure — fail SAFE to the
 * current worker, never to a broken one).
 */
export function resolveScribeDispatchRoute(
  env: DispatchEnvelope,
  current: { model?: string; effort?: string },
): ScribeRoutePatch | undefined {
  try {
    const posture = resolveRouterPosture()
    if (posture === 'fixed') return undefined

    const seat = resolveImplementerSeat()
    const fallbackModel = current.model ?? seat.model
    const fallbackEffort = (current.effort ?? 'max') as EffortValue
    // OPERATOR MODEL-AXIS PIN: a
    // persisted/env implementer slot is DURABLE OPERATOR INTENT (the
    // precedence law: env pin > persisted slot > route > ratified default) —
    // the adaptive fabric may still route EFFORT per task, but it must never
    // move the seat off the operator's explicitly slotted model. Before this,
    // the fallback compile silently retargeted an explicitly gpt-slotted
    // Implementer to sonnet-5 on the next trivial dispatch — the operator's
    // "reslot applied" receipt was true for one respawn and then quietly
    // undone. A 'default' origin (no operator intent) keeps full routing.
    const modelPinned = seat.modelOrigin !== 'default'

    // 2. A RouteWork-resolved envelope: re-validate fail-closed and honor it
    //    (the model axis yields to an operator pin).
    if (env.route?.model || (env.routePlan && env.route?.effort)) {
      const m = validateSeatModel(env.route?.model, fallbackModel)
      if (m.note) logForDebugging(`[router] scribe route model adjusted: ${m.note}`)
      const e = validateSeatEffort(env.route?.effort, fallbackEffort)
      if (e.note) logForDebugging(`[router] scribe route effort adjusted: ${e.note}`)
      if (modelPinned && m.model !== seat.model) {
        logForDebugging(
          `[router] scribe route model '${m.model}' overridden by the operator ${seat.modelOrigin} slot '${seat.model}' — model axis pinned, effort routed`,
        )
      }
      return { model: modelPinned ? seat.model : m.model, effort: String(e.effort) }
    }

    // 3. Local fallback compile (legacy envelope / missing metadata).
    const pin = resolveRouterModelPin()
    const result = compileRoute({
      mode: 'scribe',
      intentSource: 'legacy',
      mission: {
        objective: env.title ?? env.task.slice(0, 120),
        title: env.title ?? '',
        task: env.task,
        ...(env.route?.effort || env.route?.lane
          ? { legacyRoute: { ...(env.route.effort ? { effort: env.route.effort } : {}), ...(env.route.lane ? { lane: env.route.lane } : {}) } }
          : {}),
        ...(pin !== 'auto' ? { modelHint: pin } : {}),
      },
      posture,
      models: buildRouterModelSnapshot(),
      worker: {
        maxWidth: 1,
        sharedLane: false,
        ...(classOfModel(current.model) ? { currentModelClass: classOfModel(current.model) } : {}),
        ...(current.effort ? { currentEffort: current.effort } : {}),
      },
      now: Date.now(),
      planId: generateRoutePlanId(),
    })
    if (!result.ok) {
      logForDebugging(`[router] scribe fallback compile refused (${result.refusal.reasonCodes.join(',')}) — keeping the current worker`)
      return undefined
    }
    const ref = result.plan.nodes[0]?.assignedModel
    if (!ref) return undefined
    logForDebugging(
      `[router] scribe fallback route: ${result.plan.profile} → ${ref.model}@${ref.effort} [${result.plan.decision.decisiveReasons.join(',')}]`,
    )
    if (modelPinned && ref.model !== seat.model) {
      logForDebugging(
        `[router] scribe fallback model '${ref.model}' overridden by the operator ${seat.modelOrigin} slot '${seat.model}' — model axis pinned, effort routed`,
      )
    }
    return { model: modelPinned ? seat.model : ref.model, effort: ref.effort }
  } catch (e) {
    logForDebugging(`[router] scribe route resolution threw (keeping current worker): ${e}`)
    return undefined
  }
}
