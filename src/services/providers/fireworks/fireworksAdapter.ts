import { fireworksCatalogueRows } from './fireworksCatalogue.js'
import { resolveFireworksAccount } from './fireworksAccounts.js'
import { fireworksEffortVocabulary, fireworksQualifiedId } from './fireworksPins.js'
import type { ProviderCatalogueEntry, ProviderDescription, ProviderModelRef, ProviderModelClass, ProviderAdapter, ProviderModel, ProviderStatus } from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

function fireworksLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = fireworksCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'fireworks',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...fireworksEffortVocabulary(row.id)], roles: SPECIALIST_ROLES,
  })) }
}

export function fireworksCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  const { rows } = fireworksCatalogueRows()
  return rows.map(row => ({ id: row.id, displayLabel: row.displayName, modelClass: 'fireworks', ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}), efforts: [...fireworksEffortVocabulary(row.id)], roles: SPECIALIST_ROLES }))
}

export function fireworksCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return fireworksCatalogueEntries().find(row => row.id.toLowerCase() === fireworksQualifiedId(id).toLowerCase())
}

function describeFireworksProvider(): ProviderDescription {
  const account = resolveFireworksAccount()
  const live = fireworksLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no Fireworks API key detected' },
    catalogue: fireworksCatalogueEntries(),
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

function fireworksStatus(): ProviderStatus {
  return resolveFireworksAccount() ? { available: true } : { available: false, reason: 'no-api-key:fireworks' }
}

function listFireworksModels(): ProviderModel[] {
  if (!fireworksStatus().available) return []
  return fireworksCatalogueEntries().map(entry => ({ ref: { provider: 'fireworks', model: entry.id, modelClass: 'fireworks', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

function resolveFireworksModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

function buildFireworksLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error('router: provider fireworks has no SEAT runtime — Fireworks specialists dispatch through the AgentTool engine path')
}

export const fireworksProviderAdapter: ProviderAdapter = {
  id: 'fireworks', transport: 'openai-compat-chat-completions', status: fireworksStatus,
  describe: describeFireworksProvider, listModels: listFireworksModels, resolveModel: resolveFireworksModel, buildLaunchPatch: buildFireworksLaunchPatch,
}
