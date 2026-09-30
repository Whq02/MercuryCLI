export const XAI_SURFACES_LANE_STUB = 'stub for the xai surfaces lane — replaced by the xai wire lane at the fold' as const
import { xaiCatalogueRows } from '../../../services/providers/xai/xaiCatalogue.js'
import { XAI_DISPLAY_PINS, XAI_EFFORTS, xaiCurrentModelId } from '../../../services/providers/xai/xaiPins.js'
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

export const XAI_STATIC_CATALOGUE: readonly ProviderCatalogueEntry[] = XAI_DISPLAY_PINS.map(pin => ({
  id: pin.id,
  displayLabel: pin.displayName,
  modelClass: 'xai' as const,
  ...(pin.contextWindow !== undefined ? { contextWindow: pin.contextWindow } : {}),
  efforts: [...XAI_EFFORTS],
  roles: ALL_ROLES,
}))

export function xaiLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { source } = xaiCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { entries: [], fetchedAtMs: source.fetchedAtMs }
}

export function xaiCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return xaiLiveCatalogue()?.entries ?? XAI_STATIC_CATALOGUE
}

export function xaiCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  const current = xaiCurrentModelId(id.trim().toLowerCase())
  return xaiCatalogueEntries().find(entry => entry.id === current)
}

export function describeXaiProvider(): ProviderDescription {
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'reasoning-deltas', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: ALL_ROLES,
    account: { kind: 'none', label: 'no xAI API key detected' },
    catalogue: XAI_STATIC_CATALOGUE,
    catalogueSource: 'static-pin',
  }
}

export function xaiStatus(): RouterProviderStatus {
  return { available: false, reason: 'no-api-key:xai' }
}

export function listXaiModels(): RouterProviderModel[] {
  return []
}

export function resolveXaiModel(_modelClass: RouterModelClass, _posture: RouterPosture): RouteModelRef | null {
  return null
}

export function buildXaiLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error(
    'router: provider xai has no SEAT runtime — roster seats stay Anthropic; xAI specialists dispatch through the AgentTool engine path',
  )
}

export const xaiProviderAdapter: RouterProviderAdapter = {
  id: 'xai',
  transport: 'openai-compat-chat-completions',
  status: xaiStatus,
  describe: describeXaiProvider,
  listModels: listXaiModels,
  resolveModel: resolveXaiModel,
  buildLaunchPatch: buildXaiLaunchPatch,
}
