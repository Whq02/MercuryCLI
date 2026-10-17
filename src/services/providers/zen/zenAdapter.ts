import { zenCatalogueRows } from './zenCatalogue.js'
import { resolveZenAccount } from './zenAccounts.js'
import { zenDisplayPin, zenQualifiedId } from './zenPins.js'
import type { ProviderCatalogueEntry, ProviderDescription, ProviderModelRef, ProviderModelClass, ProviderAdapter, ProviderModel, ProviderStatus } from '../providerAdapter.js'
import { SPECIALIST_ROLES } from '../providerAdapter.js'

export function zenLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = zenCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: zenQualifiedId(row.id), displayLabel: row.displayName, modelClass: 'zen',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...(zenDisplayPin(row.id)?.efforts ?? [])], roles: SPECIALIST_ROLES,
  })) }
}

export function zenCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return zenLiveCatalogue()?.entries ?? []
}

export function zenCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return zenCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

export function describeZenProvider(): ProviderDescription {
  const account = resolveZenAccount()
  const live = zenLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no OpenCode Zen API key detected' },
    catalogue: live?.entries ?? [],
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

export function zenStatus(): ProviderStatus {
  return resolveZenAccount() ? { available: true } : { available: false, reason: 'no-api-key:zen' }
}

export function listZenModels(): ProviderModel[] {
  if (!zenStatus().available) return []
  return zenCatalogueEntries().map(entry => ({ ref: { provider: 'zen', model: entry.id, modelClass: 'zen', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

export function resolveZenModel(_modelClass: ProviderModelClass): ProviderModelRef | null {
  return null
}

export function buildZenLaunchPatch(_ref: ProviderModelRef): { model: string; effort: string } {
  throw new Error('seat: provider zen has no SEAT runtime — OpenCode Zen specialists dispatch through the AgentTool engine path')
}

export const zenProviderAdapter: ProviderAdapter = {
  id: 'zen', transport: 'openai-compat-chat-completions', status: zenStatus,
  describe: describeZenProvider, listModels: listZenModels, resolveModel: resolveZenModel, buildLaunchPatch: buildZenLaunchPatch,
}
