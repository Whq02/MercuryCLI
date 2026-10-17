import { togetherCatalogueRows } from '../../../services/providers/together/togetherCatalogue.js'
import { resolveTogetherAccount } from '../../../services/providers/together/togetherAccounts.js'
import { togetherEffortVocabulary } from '../../../services/providers/together/togetherPins.js'
import type { ProviderCatalogueEntry, ProviderDescription, RouteModelRef, RouterModelClass, RouterPosture, RouterProviderAdapter, RouterProviderModel, RouterProviderStatus } from './types.js'
import { SPECIALIST_ROLES } from './types.js'

export function togetherLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = togetherCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'together',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...togetherEffortVocabulary(row.id)], roles: SPECIALIST_ROLES,
  })) }
}

export function togetherCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return togetherLiveCatalogue()?.entries ?? []
}

export function togetherCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return togetherCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

export function describeTogetherProvider(): ProviderDescription {
  const account = resolveTogetherAccount()
  const live = togetherLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no Together AI API key detected' },
    catalogue: live?.entries ?? [],
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

export function togetherStatus(): RouterProviderStatus {
  return resolveTogetherAccount() ? { available: true } : { available: false, reason: 'no-api-key:together' }
}

export function listTogetherModels(): RouterProviderModel[] {
  if (!togetherStatus().available) return []
  return togetherCatalogueEntries().map(entry => ({ ref: { provider: 'together', model: entry.id, modelClass: 'together', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

export function resolveTogetherModel(_modelClass: RouterModelClass, _posture: RouterPosture): RouteModelRef | null {
  return null
}

export function buildTogetherLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error('router: provider together has no SEAT runtime — Together AI specialists dispatch through the AgentTool engine path')
}

export const togetherProviderAdapter: RouterProviderAdapter = {
  id: 'together', transport: 'openai-compat-chat-completions', status: togetherStatus,
  describe: describeTogetherProvider, listModels: listTogetherModels, resolveModel: resolveTogetherModel, buildLaunchPatch: buildTogetherLaunchPatch,
}
