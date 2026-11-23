import type { WatchWall } from './watchMailbox.js'
import { activeLaneWindow, isLaneWindowFamily, type LaneWindowFamily } from '../../models/roads/laneWindowFact.js'

type LaneLimit = { limit: string }
type LimitWindow = { state: 'limited'; resetsAtMs: number; observedAtMs: number } | { state: 'clear' }

interface LaneWallReads {
  route: () => string | null
  usability: () => Record<string, LaneLimit | undefined>
  anthropicVerdict: (nowMs: number) => { status: string; lapsesAtMs?: number }
  openaiWindow: () => LimitWindow
  laneWindow: (family: LaneWindowFamily) => LimitWindow
}

function liveLaneWallReads(): LaneWallReads {
  return {
    route: () => {
      const { getEngineModel } = require('../../models/catalogue/engineModel.js') as typeof import('../../models/catalogue/engineModel.js')
      const { declaredRouteOf } = require('../../models/roads/routeLaw.js') as typeof import('../../models/roads/routeLaw.js')
      return declaredRouteOf(getEngineModel())
    },
    usability: () => {
      const { resolveProviderUsability } =
        require('../../models/roads/providerUsability.js') as typeof import('../../models/roads/providerUsability.js')
      return resolveProviderUsability()
    },
    anthropicVerdict: nowMs => {
      const { anthropicLimitVerdict } = require('../../models/roads/anthropic/anthropicLimits.js') as typeof import('../../models/roads/anthropic/anthropicLimits.js')
      return anthropicLimitVerdict(nowMs)
    },
    openaiWindow: () => {
      const { activeOpenaiWindow } =
        require('../../models/roads/openai/openaiWindowFact.js') as typeof import('../../models/roads/openai/openaiWindowFact.js')
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
