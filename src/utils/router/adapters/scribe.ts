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
    const modelPinned = seat.modelOrigin !== 'default'

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
