import { metaCatalogueRows } from './metaCatalogue.js'
import { resolveMetaAccount } from './metaAccounts.js'
import { metaDisplayPin } from './metaPins.js'
import type { ProviderCatalogueEntry, ProviderDescription, ProviderModelRef, ProviderModelClass, ProviderAdapter, ProviderModel, ProviderStatus } from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

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
    account: account ? { kind: account.kind === 'muse-code' ? 'provider-oauth' : 'api-key', label: account.label } : { kind: 'none', label: 'no Meta Model API key detected' },
    catalogue: live?.entries ?? [],
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

export function metaStatus(): ProviderStatus {
  return resolveMetaAccount() ? { available: true } : { available: false, reason: 'no-api-key:meta' }
}

export function listMetaModels(): ProviderModel[] {
  if (!metaStatus().available) return []
  return metaCatalogueEntries().map(entry => ({ ref: { provider: 'meta', model: entry.id, modelClass: 'muse', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

export function resolveMetaModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

export function buildMetaLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error('seat: provider meta has no SEAT runtime — Meta specialists dispatch through the AgentTool engine path')
}

export const metaProviderAdapter: ProviderAdapter = {
  id: 'meta', transport: 'openai-compat-chat-completions', status: metaStatus,
  describe: describeMetaProvider, listModels: listMetaModels, resolveModel: resolveMetaModel, buildLaunchPatch: buildMetaLaunchPatch,
}
