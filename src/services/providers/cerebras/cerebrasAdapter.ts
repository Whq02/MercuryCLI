import { cerebrasCatalogueRows } from './cerebrasCatalogue.js'
import { resolveCerebrasAccount } from './cerebrasAccounts.js'
import { cerebrasEffortVocabulary } from './cerebrasPins.js'
import type { ProviderCatalogueEntry, ProviderDescription, ProviderModelRef, ProviderModelClass, ProviderAdapter, ProviderModel, ProviderStatus } from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

function cerebrasLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = cerebrasCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'cerebras',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...cerebrasEffortVocabulary(row.id)], roles: SPECIALIST_ROLES,
  })) }
}

export function cerebrasCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  const { rows } = cerebrasCatalogueRows()
  return rows.map(row => ({ id: row.id, displayLabel: row.displayName, modelClass: 'cerebras', ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}), efforts: [...cerebrasEffortVocabulary(row.id)], roles: SPECIALIST_ROLES }))
}

export function cerebrasCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return cerebrasCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

function describeCerebrasProvider(): ProviderDescription {
  const account = resolveCerebrasAccount()
  const live = cerebrasLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no Cerebras API key detected' },
    catalogue: cerebrasCatalogueEntries(),
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

function cerebrasStatus(): ProviderStatus {
  return resolveCerebrasAccount() ? { available: true } : { available: false, reason: 'no-api-key:cerebras' }
}

function listCerebrasModels(): ProviderModel[] {
  if (!cerebrasStatus().available) return []
  return cerebrasCatalogueEntries().map(entry => ({ ref: { provider: 'cerebras', model: entry.id, modelClass: 'cerebras', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

function resolveCerebrasModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

function buildCerebrasLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error('seat: provider cerebras has no SEAT runtime — Cerebras specialists dispatch through the AgentTool engine path')
}

export const cerebrasProviderAdapter: ProviderAdapter = {
  id: 'cerebras', transport: 'openai-compat-chat-completions', status: cerebrasStatus,
  describe: describeCerebrasProvider, listModels: listCerebrasModels, resolveModel: resolveCerebrasModel, buildLaunchPatch: buildCerebrasLaunchPatch,
}
