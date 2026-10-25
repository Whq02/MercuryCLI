import { meliousCatalogueRows } from './meliousCatalogue.js'
import { resolveMeliousAccount } from './meliousAccounts.js'
import { meliousEffortVocabulary } from './meliousCatalogue.js'
import type { ProviderCatalogueEntry, ProviderDescription, ProviderModelRef, ProviderModelClass, ProviderAdapter, ProviderModel, ProviderStatus } from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

function meliousLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = meliousCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'melious',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...meliousEffortVocabulary(row.id)], roles: SPECIALIST_ROLES,
  })) }
}

export function meliousCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  const { rows } = meliousCatalogueRows()
  return rows.map(row => ({ id: row.id, displayLabel: row.displayName, modelClass: 'melious', ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}), efforts: [...meliousEffortVocabulary(row.id)], roles: SPECIALIST_ROLES }))
}

export function meliousCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return meliousCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

function describeMeliousProvider(): ProviderDescription {
  const account = resolveMeliousAccount()
  const live = meliousLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no Melious AI API key detected' },
    catalogue: meliousCatalogueEntries(),
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'live-discovery' as const }),
  }
}

function meliousStatus(): ProviderStatus {
  return resolveMeliousAccount() ? { available: true } : { available: false, reason: 'no-api-key:melious' }
}

function listMeliousModels(): ProviderModel[] {
  if (!meliousStatus().available) return []
  return meliousCatalogueEntries().map(entry => ({ ref: { provider: 'melious', model: entry.id, modelClass: 'melious', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

function resolveMeliousModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

function buildMeliousLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error('seat: provider melious has no SEAT runtime — Melious specialists dispatch through the AgentTool engine path')
}

export const meliousProviderAdapter: ProviderAdapter = {
  id: 'melious', transport: 'openai-compat-chat-completions', status: meliousStatus,
  describe: describeMeliousProvider, listModels: listMeliousModels, resolveModel: resolveMeliousModel, buildLaunchPatch: buildMeliousLaunchPatch,
}
