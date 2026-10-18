import { cohereCatalogueRows, cohereModelFacts } from './cohereCatalogue.js'
import { resolveCohereAccount } from './cohereAccounts.js'
import type { ProviderCatalogueEntry, ProviderDescription, ProviderModelRef, ProviderModelClass, ProviderAdapter, ProviderModel, ProviderStatus } from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

function cohereLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = cohereCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'cohere',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...cohereModelFacts(row.id).efforts], roles: SPECIALIST_ROLES,
  })) }
}

export function cohereCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return cohereLiveCatalogue()?.entries ?? []
}

export function cohereCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return cohereCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

function describeCohereProvider(): ProviderDescription {
  const account = resolveCohereAccount()
  const live = cohereLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no Cohere API key detected' },
    catalogue: live?.entries ?? [],
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

function cohereStatus(): ProviderStatus {
  return resolveCohereAccount() ? { available: true } : { available: false, reason: 'no-api-key:cohere' }
}

function listCohereModels(): ProviderModel[] {
  if (!cohereStatus().available) return []
  return cohereCatalogueEntries().map(entry => ({ ref: { provider: 'cohere', model: entry.id, modelClass: 'cohere', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

function resolveCohereModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

function buildCohereLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error('seat: provider cohere has no SEAT runtime — Cohere specialists dispatch through the AgentTool engine path')
}

export const cohereProviderAdapter: ProviderAdapter = {
  id: 'cohere', transport: 'openai-compat-chat-completions', status: cohereStatus,
  describe: describeCohereProvider, listModels: listCohereModels, resolveModel: resolveCohereModel, buildLaunchPatch: buildCohereLaunchPatch,
}
