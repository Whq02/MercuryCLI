// ============================================================================
//  providers/huggingface.ts — the Hugging Face RouterProviderAdapter. The
//  moonshot adapter's laws: availability is credential truth alone; SEATS
//  STAY ANTHROPIC (resolveModel null / buildLaunchPatch throws — specialists
//  dispatch through the AgentTool/callModel path against describe().
//  catalogue); the credential value never enters this surface.
//
//  Catalogue: LIVE — the router's GET /v1/models snapshot when fetched
//  (provenance 'live-discovery' with its stamp), else the dated pins
//  ('static-pin'); every entry's context window is the catalogue's stated
//  width, never a guess.
// ============================================================================
import { getCachedProviderDiscovery, primeHuggingfaceDiscovery } from '../providerDiscovery.js'
import {
  getCachedHuggingfaceCatalogue,
  huggingfaceLiveContextWindow,
} from '../../../services/providers/huggingface/huggingfaceCatalogue.js'
import {
  HUGGINGFACE_DISPLAY_PINS,
  HUGGINGFACE_MODEL_PREFIX,
} from '../../../services/providers/huggingface/huggingfacePins.js'
import type {
  ProviderCatalogueEntry,
  ProviderDescription,
  RouteModelRef,
  RouterModelClass,
  RouterPosture,
  RouterProviderAdapter,
  RouterProviderModel,
  RouterProviderStatus,
  SpecialistRole,
} from './types.js'
import { SPECIALIST_ROLES } from './types.js'

const ALL_ROLES: readonly SpecialistRole[] = SPECIALIST_ROLES

/** The dated-pin catalogue (the fallback while the live list is absent). */
export const HUGGINGFACE_STATIC_CATALOGUE: readonly ProviderCatalogueEntry[] = HUGGINGFACE_DISPLAY_PINS.map(pin => ({
  id: `${HUGGINGFACE_MODEL_PREFIX}${pin.id}`,
  displayLabel: pin.displayName,
  modelClass: 'huggingface' as const,
  ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
  efforts: [],
  roles: ALL_ROLES,
}))

/** The live catalogue as specialist entries (every live chat model). */
export function huggingfaceLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const snapshot = getCachedHuggingfaceCatalogue()
  if (!snapshot || snapshot.models.length === 0) return undefined
  return {
    fetchedAtMs: snapshot.fetchedAtMs,
    entries: snapshot.models.map(model => {
      const window = huggingfaceLiveContextWindow(model.id)
      return {
        id: `${HUGGINGFACE_MODEL_PREFIX}${model.id}`,
        displayLabel: model.id,
        modelClass: 'huggingface' as const,
        ...(window !== undefined ? { contextWindow: window } : {}),
        efforts: [],
        roles: ALL_ROLES,
      }
    }),
  }
}

export function describeHuggingfaceProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('huggingface') ?? primeHuggingfaceDiscovery()
  const record = discovery?.provider === 'huggingface' ? discovery : undefined
  const live = huggingfaceLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    // reasoning deltas are not advertised: the router proxies each backend's
    // own reasoning spelling and no live turn has proven the decode yet.
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: ALL_ROLES,
    account: record?.keyPresent
      ? record.keySource === 'oauth'
        ? { kind: 'provider-oauth', label: record.accountLabel ?? 'Hugging Face account (OAuth)' }
        : { kind: 'api-key', label: record.accountLabel ?? (record.keySource === 'env' ? 'HF_TOKEN (env)' : 'Hugging Face token (stored, auth-scoped)') }
      : { kind: 'none', label: 'no Hugging Face credential detected' },
    catalogue: live?.entries ?? HUGGINGFACE_STATIC_CATALOGUE,
    ...(live
      ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs }
      : { catalogueSource: 'static-pin' as const }),
  }
}

export function huggingfaceStatus(): RouterProviderStatus {
  const discovery = primeHuggingfaceDiscovery()
  return discovery?.keyPresent ? { available: true } : { available: false, reason: 'no-api-key:huggingface' }
}

export function listHuggingfaceModels(): RouterProviderModel[] {
  if (!huggingfaceStatus().available) return []
  const entries = huggingfaceLiveCatalogue()?.entries ?? HUGGINGFACE_STATIC_CATALOGUE
  return entries.map(entry => ({
    ref: {
      provider: 'huggingface' as const,
      model: entry.id,
      modelClass: 'huggingface' as const,
      effort: 'high' as const,
      contextWindow: entry.contextWindow ?? 0,
    },
    displayLabel: entry.displayLabel,
  }))
}

export function resolveHuggingfaceModel(_modelClass: RouterModelClass, _posture: RouterPosture): RouteModelRef | null {
  return null
}

export function buildHuggingfaceLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider huggingface has no SEAT runtime — party/roster seats stay Anthropic; Hugging Face specialists dispatch through the AgentTool engine path',
  )
}

export const huggingfaceProviderAdapter: RouterProviderAdapter = {
  id: 'huggingface',
  transport: 'openai-compat-chat-completions',
  status: huggingfaceStatus,
  describe: describeHuggingfaceProvider,
  listModels: listHuggingfaceModels,
  resolveModel: resolveHuggingfaceModel,
  buildLaunchPatch: buildHuggingfaceLaunchPatch,
}
