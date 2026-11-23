
import { fluxMark } from '../../integrations/media-flux/fluxProbe.js'
import type { OwnerKey } from '../../engine/run-owner/ownerKey.js'
import { registerOwnerScopedStore } from '../../engine/run-owner/ownerLifecycle.js'
import { OwnerScopedStore } from '../../engine/run-owner/ownerScopedStore.js'
import { processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import type { ContextResolution } from '../../models/facts/capabilities.js'
import { ctxForecastEnabled, recordCtxSample } from './ctxForecast.js'
import { passedOver } from '../../platform/errors/passedOver.js'

type ContextFillSource = 'usage' | 'estimate'
type ContextWindowSource = ContextResolution['source']

export interface LiveContextUsage {
  usedPct: number | null
  window: number
  compactAtPct: number | null
  usedTokens: number | null
  fillSource: ContextFillSource | null
  windowSource: ContextWindowSource | null
  windowPinned: boolean
}

interface ContextUsageDetail {
  usedTokens?: number | null
  fillSource?: ContextFillSource | null
  windowSource?: ContextWindowSource | null
  windowPinned?: boolean
}

const usageSlots = new OwnerScopedStore<LiveContextUsage>({
  name: 'ctx-usage-live',
  create: () => ({
    usedPct: null,
    window: 0,
    compactAtPct: null,
    usedTokens: null,
    fillSource: null,
    windowSource: null,
    windowPinned: false,
  }),
})
registerOwnerScopedStore(usageSlots)

let version = 0
const listeners = new Set<() => void>()

export function publishContextUsage(
  usedPct: number | null,
  window: number,
  compactAtPct: number | null = null,
  owner?: OwnerKey,
  detail?: ContextUsageDetail,
): void {
  const key = owner ?? processMainOwner()
  const slot = usageSlots.get(key)
  const next: LiveContextUsage = {
    usedPct,
    window,
    compactAtPct,
    usedTokens: detail?.usedTokens ?? null,
    fillSource: detail?.fillSource ?? null,
    windowSource: detail?.windowSource ?? null,
    windowPinned: detail?.windowPinned === true,
  }
  const changed =
    slot.usedPct !== next.usedPct ||
    slot.window !== next.window ||
    slot.compactAtPct !== next.compactAtPct ||
    slot.usedTokens !== next.usedTokens ||
    slot.fillSource !== next.fillSource ||
    slot.windowSource !== next.windowSource ||
    slot.windowPinned !== next.windowPinned
  Object.assign(slot, next)
  if (ctxForecastEnabled()) recordCtxSample(usedPct, key)
  if (changed) {
    version += 1
    fluxMark('ctxusage:publish')
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        passedOver(error)
      }
    }
  }
}

export function getLiveContextUsage(owner?: OwnerKey): LiveContextUsage {
  const slot = usageSlots.peek(owner ?? processMainOwner())
  if (!slot) {
    return {
      usedPct: null,
      window: 0,
      compactAtPct: null,
      usedTokens: null,
      fillSource: null,
      windowSource: null,
      windowPinned: false,
    }
  }
  return { ...slot }
}

export function getLiveContextUsageVersion(): number {
  return version
}

export function subscribeLiveContextUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
