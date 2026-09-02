
import { getSdkBetas } from '../../bootstrap/state.js'
import { catalogueEpoch, subscribeCatalogueEpoch } from '../../services/providers/catalogueEpoch.js'
import {
  resolveProviderUsability,
  type ProviderId,
  type ProviderUsability,
} from '../../services/providers/providerUsability.js'
import { declaredRouteOf } from '../../services/providers/routeLaw.js'
import { resolveContextWindow, type ContextResolution } from '../model/capabilities.js'
import { renderModelName, type ModelName } from '../model/model.js'
import { withState, type Snapshot } from './types.js'

export type ModelData = {
  name: string
  model: string
  window: number
  windowSource: ContextResolution['source']
  windowReason?: string
  outputReserve: number
  provider: ProviderId | 'unrecognised'
  usability: Pick<ProviderUsability, 'usable' | 'credential' | 'limit' | 'blockers'> | null
}

const EMPTY: ModelData = {
  name: 'unknown',
  model: '',
  window: 0,
  windowSource: 'fallback',
  outputReserve: 0,
  provider: 'anthropic',
  usability: null,
}

export function modelGauge(model: ModelName): Snapshot<{ data: ModelData }> {
  try {
    const resolution = resolveContextWindow(model, getSdkBetas())
    const provider = declaredRouteOf(model) ?? 'unrecognised'
    let usability: ModelData['usability'] = null
    try {
      const u = provider === 'unrecognised' ? undefined : resolveProviderUsability()[provider]
      usability = u ? { usable: u.usable, credential: u.credential, limit: u.limit, blockers: u.blockers } : null
    } catch {
      usability = null
    }
    return {
      state: 'live',
      source: 'mainLoopModel · resolveContextWindow · providerUsability',
      data: {
        name: renderModelName(model),
        model,
        window: resolution.effectiveWindow,
        windowSource: resolution.source,
        ...(resolution.fallbackReason ? { windowReason: resolution.fallbackReason } : {}),
        outputReserve: resolution.outputReserve,
        provider,
        usability,
      },
    }
  } catch {
    return withState('unavailable', { ...EMPTY, model: String(model ?? '') }, 'model info missing')
  }
}

export function subscribeModelGauge(cb: () => void): () => void {
  return subscribeCatalogueEpoch(cb)
}

export function getModelGaugeVersion(): number {
  return catalogueEpoch()
}
