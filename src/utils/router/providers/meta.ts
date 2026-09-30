import { metaCatalogueRows } from '../../../services/providers/meta/metaCatalogue.js'
import { resolveMetaAccount } from '../../../services/providers/meta/metaAccounts.js'
import { metaDisplayPin } from '../../../services/providers/meta/metaPins.js'
import type { ProviderCatalogueEntry, ProviderDescription, RouteModelRef, RouterModelClass, RouterPosture, RouterProviderAdapter, RouterProviderModel, RouterProviderStatus } from './types.js'
import { SPECIALIST_ROLES } from './types.js'

export function metaLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = metaCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'muse',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...(metaDisplayPin(row.id)?.efforts ?? [])], roles: SPECIALIST_ROLES,
  })) }
}

export function metaCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return metaLiveCatalogue()?.entries ?? []
}

export function metaCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return metaCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

export function describeMetaProvider(): ProviderDescription {
  const account = resolveMetaAccount()
  const live = metaLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no Meta Model API key detected' },
    catalogue: live?.entries ?? [],
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

export function metaStatus(): RouterProviderStatus {
  return resolveMetaAccount() ? { available: true } : { available: false, reason: 'no-api-key:meta' }
}

export function listMetaModels(): RouterProviderModel[] {
  if (!metaStatus().available) return []
  return metaCatalogueEntries().map(entry => ({ ref: { provider: 'meta', model: entry.id, modelClass: 'muse', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

export function resolveMetaModel(_modelClass: RouterModelClass, _posture: RouterPosture): RouteModelRef | null {
  return null
}

export function buildMetaLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error('router: provider meta has no SEAT runtime — Meta specialists dispatch through the AgentTool engine path')
}

export const metaProviderAdapter: RouterProviderAdapter = {
  id: 'meta', transport: 'openai-compat-chat-completions', status: metaStatus,
  describe: describeMetaProvider, listModels: listMetaModels, resolveModel: resolveMetaModel, buildLaunchPatch: buildMetaLaunchPatch,
}
