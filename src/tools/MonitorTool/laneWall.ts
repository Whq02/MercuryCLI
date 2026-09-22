import type { WatchWall } from './watchMailbox.js'
import { activeLaneWindow, isLaneWindowFamily, type LaneWindowFamily } from '../../services/providers/laneWindowFact.js'

type LaneLimit = { limit: string }
type LimitWindow = { state: 'limited'; resetsAtMs: number; observedAtMs: number } | { state: 'clear' }

export interface LaneWallReads {
  route: () => string | null
  usability: () => Record<string, LaneLimit | undefined>
  anthropicVerdict: (nowMs: number) => { status: string; lapsesAtMs?: number }
  openaiWindow: () => LimitWindow
  laneWindow: (family: LaneWindowFamily) => LimitWindow
}

function liveLaneWallReads(): LaneWallReads {
  return {
    route: () => {
      const { getMainLoopModel } = require('../../utils/model/model.js') as typeof import('../../utils/model/model.js')
      const { declaredRouteOf } = require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
      return declaredRouteOf(getMainLoopModel())
    },
    usability: () => {
      const { resolveProviderUsability } =
        require('../../services/providers/providerUsability.js') as typeof import('../../services/providers/providerUsability.js')
      return resolveProviderUsability()
    },
    anthropicVerdict: nowMs => {
      const { anthropicLimitVerdict } = require('../../services/claudeAiLimits.js') as typeof import('../../services/claudeAiLimits.js')
      return anthropicLimitVerdict(nowMs)
    },
    openaiWindow: () => {
      const { activeOpenaiWindow } =
        require('../../services/providers/openai/openaiWindowFact.js') as typeof import('../../services/providers/openai/openaiWindowFact.js')
      return activeOpenaiWindow()
    },
    laneWindow: family => activeLaneWindow(family),
  }
}

export function sessionLaneWall(nowMs: number = Date.now(), reads: LaneWallReads = liveLaneWallReads()): WatchWall {
  try {
    const route = reads.route()
    if (route === null) return { closed: false }
    const lane = reads.usability()[route]
    if (lane === undefined || lane.limit !== 'rejected') return { closed: false }
    if (route === 'anthropic') {
      const verdict = reads.anthropicVerdict(nowMs)
      return verdict.lapsesAtMs === undefined ? { closed: true } : { closed: true, reopensAtMs: verdict.lapsesAtMs }
    }
    if (route === 'openai') {
      const window = reads.openaiWindow()
      return window.state === 'limited' ? { closed: true, reopensAtMs: window.resetsAtMs } : { closed: true }
    }
    if (isLaneWindowFamily(route)) {
      const window = reads.laneWindow(route)
      return window.state === 'limited' ? { closed: true, reopensAtMs: window.resetsAtMs } : { closed: true }
    }
    return { closed: true }
  } catch {
    return { closed: false }
  }
}
