import { getCachedProviderDiscovery, primeXaiDiscovery } from '../providerDiscovery.js'
import { xaiCatalogueRows, xaiModelFacts } from '../../../services/providers/xai/xaiCatalogue.js'
import type { ProviderCatalogueEntry, ProviderDescription, RouteModelRef, RouterModelClass, RouterPosture, RouterProviderAdapter, RouterProviderModel, RouterProviderStatus } from './types.js'
import { SPECIALIST_ROLES } from './types.js'

export const XAI_STATIC_CATALOGUE: readonly ProviderCatalogueEntry[] = []
export function xaiLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = xaiCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'grok',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...(xaiModelFacts(row.id)?.efforts ?? [])], roles: SPECIALIST_ROLES,
  })) }
}
export function xaiCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return xaiLiveCatalogue()?.entries ?? XAI_STATIC_CATALOGUE
}
export function xaiCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return xaiCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}
export function describeXaiProvider(): ProviderDescription {
  const discovery = getCachedProviderDiscovery('xai')
  const record = discovery?.provider === 'xai' ? discovery : undefined
  const live = xaiLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'reasoning-deltas', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: record?.keyPresent ? { kind: record.keySource === 'oauth' ? 'provider-oauth' : 'api-key', label: record.keySource === 'oauth' ? 'Grok subscription' : record.keySource === 'stored' ? 'xAI API key (stored, auth-scoped)' : 'XAI_API_KEY (env)' } : { kind: 'none', label: 'no Grok sign-in or xAI API key detected' },
    catalogue: live?.entries ?? XAI_STATIC_CATALOGUE,
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}
export function xaiStatus(): RouterProviderStatus {
  return primeXaiDiscovery()?.keyPresent ? { available: true } : { available: false, reason: 'no-api-key:xai' }
}
export function listXaiModels(): RouterProviderModel[] {
  if (!xaiStatus().available) return []
  return xaiCatalogueEntries().map(entry => ({ ref: { provider: 'xai', model: entry.id, modelClass: 'grok', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}
export function resolveXaiModel(_modelClass: RouterModelClass, _posture: RouterPosture): RouteModelRef | null {
  return null
}
export function buildXaiLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error('router: provider xai has no SEAT runtime — xAI specialists dispatch through the AgentTool engine path')
}
export const xaiProviderAdapter: RouterProviderAdapter = {
  id: 'xai', transport: 'openai-compat-chat-completions', status: xaiStatus,
  describe: describeXaiProvider, listModels: listXaiModels, resolveModel: resolveXaiModel, buildLaunchPatch: buildXaiLaunchPatch,
}
