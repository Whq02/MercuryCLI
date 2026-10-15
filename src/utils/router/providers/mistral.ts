import { mistralCatalogueRows, mistralModelFacts } from '../../../services/providers/mistral/mistralCatalogue.js'
import { resolveMistralAccount } from '../../../services/providers/mistral/mistralAccounts.js'
import type { ProviderCatalogueEntry, ProviderDescription, RouteModelRef, RouterModelClass, RouterPosture, RouterProviderAdapter, RouterProviderModel, RouterProviderStatus } from './types.js'
import { SPECIALIST_ROLES } from './types.js'

export function mistralLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = mistralCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'mistral',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...mistralModelFacts(row.id).efforts], roles: SPECIALIST_ROLES,
  })) }
}

export function mistralCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return mistralLiveCatalogue()?.entries ?? []
}

export function mistralCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return mistralCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

export function describeMistralProvider(): ProviderDescription {
  const account = resolveMistralAccount()
  const live = mistralLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no Mistral API key detected' },
    catalogue: live?.entries ?? [],
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

export function mistralStatus(): RouterProviderStatus {
  return resolveMistralAccount() ? { available: true } : { available: false, reason: 'no-api-key:mistral' }
}

export function listMistralModels(): RouterProviderModel[] {
  if (!mistralStatus().available) return []
  return mistralCatalogueEntries().map(entry => ({ ref: { provider: 'mistral', model: entry.id, modelClass: 'mistral', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

export function resolveMistralModel(_modelClass: RouterModelClass, _posture: RouterPosture): RouteModelRef | null {
  return null
}

export function buildMistralLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error('router: provider mistral has no SEAT runtime — Mistral specialists dispatch through the AgentTool engine path')
}

export const mistralProviderAdapter: RouterProviderAdapter = {
  id: 'mistral', transport: 'openai-compat-chat-completions', status: mistralStatus,
  describe: describeMistralProvider, listModels: listMistralModels, resolveModel: resolveMistralModel, buildLaunchPatch: buildMistralLaunchPatch,
}
