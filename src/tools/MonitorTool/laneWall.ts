import type { WatchWall } from './watchMailbox.js'

export function sessionLaneWall(nowMs: number = Date.now()): WatchWall {
  try {
    const { getMainLoopModel } = require('../../utils/model/model.js') as typeof import('../../utils/model/model.js')
    const { declaredRouteOf } = require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
    const route = declaredRouteOf(getMainLoopModel())
    if (route === null) return { closed: false }
    const { resolveProviderUsability } =
      require('../../services/providers/providerUsability.js') as typeof import('../../services/providers/providerUsability.js')
    const lane = resolveProviderUsability()[route]
    if (lane === undefined || lane.limit !== 'rejected') return { closed: false }
    if (route !== 'anthropic') return { closed: true }
    const { anthropicLimitVerdict } = require('../../services/claudeAiLimits.js') as typeof import('../../services/claudeAiLimits.js')
    const verdict = anthropicLimitVerdict(nowMs)
    return verdict.lapsesAtMs === undefined ? { closed: true } : { closed: true, reopensAtMs: verdict.lapsesAtMs }
  } catch {
    return { closed: false }
  }
}
