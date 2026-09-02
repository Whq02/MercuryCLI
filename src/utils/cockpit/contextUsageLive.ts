
import { fluxMark } from '../flux/fluxProbe.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { registerOwnerScopedStore } from '../../services/run/ownerLifecycle.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import type { ContextResolution } from '../model/capabilities.js'
import { ctxForecastEnabled, recordCtxSample } from './ctxForecast.js'

export type ContextFillSource = 'usage' | 'estimate'
export type ContextWindowSource = ContextResolution['source']

export interface LiveContextUsage {
  usedPct: number | null
  window: number
  compactAtPct: number | null
  usedTokens: number | null
  fillSource: ContextFillSource | null
  windowSource: ContextWindowSource | null
}

export interface ContextUsageDetail {
  usedTokens?: number | null
  fillSource?: ContextFillSource | null
  windowSource?: ContextWindowSource | null
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
  }
  const changed =
    slot.usedPct !== next.usedPct ||
    slot.window !== next.window ||
    slot.compactAtPct !== next.compactAtPct ||
    slot.usedTokens !== next.usedTokens ||
    slot.fillSource !== next.fillSource ||
    slot.windowSource !== next.windowSource
  Object.assign(slot, next)
  if (ctxForecastEnabled()) recordCtxSample(usedPct, key)
  if (changed) {
    version += 1
    fluxMark('ctxusage:publish')
    for (const listener of listeners) {
      try {
        listener()
      } catch {
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
