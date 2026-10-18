import { minimaxCatalogueRows, minimaxModelFacts } from '../../../services/providers/minimax/minimaxCatalogue.js'
import { resolveMinimaxAccount } from '../../../services/providers/minimax/minimaxAccounts.js'
import type { ProviderCatalogueEntry, ProviderDescription, RouteModelRef, RouterModelClass, RouterPosture, RouterProviderAdapter, RouterProviderModel, RouterProviderStatus } from './types.js'
import { SPECIALIST_ROLES } from './types.js'

function minimaxLiveCatalogue(): { entries: ProviderCatalogueEntry[]; fetchedAtMs: number } | undefined {
  const { rows, source } = minimaxCatalogueRows()
  if (source.kind !== 'live') return undefined
  return { fetchedAtMs: source.fetchedAtMs, entries: rows.map(row => ({
    id: row.id, displayLabel: row.displayName, modelClass: 'minimax',
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    efforts: [...minimaxModelFacts(row.id).efforts], roles: SPECIALIST_ROLES,
  })) }
}

export function minimaxCatalogueEntries(): readonly ProviderCatalogueEntry[] {
  return minimaxLiveCatalogue()?.entries ?? []
}

export function minimaxCatalogueEntry(id: string): ProviderCatalogueEntry | undefined {
  return minimaxCatalogueEntries().find(row => row.id.toLowerCase() === id.trim().toLowerCase())
}

function describeMinimaxProvider(): ProviderDescription {
  const account = resolveMinimaxAccount()
  const live = minimaxLiveCatalogue()
  return {
    transport: 'openai-compat-chat-completions',
    capabilities: ['streaming', 'tool-calls', 'usage-accounting', 'cancellation', 'worktree-authoring'],
    roles: SPECIALIST_ROLES,
    account: account ? { kind: 'api-key', label: account.label } : { kind: 'none', label: 'no MiniMax API key detected' },
    catalogue: live?.entries ?? [],
    ...(live ? { catalogueSource: 'live-discovery' as const, discoveredAtMs: live.fetchedAtMs } : { catalogueSource: 'static-pin' as const }),
  }
}

function minimaxStatus(): RouterProviderStatus {
  return resolveMinimaxAccount() ? { available: true } : { available: false, reason: 'no-api-key:minimax' }
}

function listMinimaxModels(): RouterProviderModel[] {
  if (!minimaxStatus().available) return []
  return minimaxCatalogueEntries().map(entry => ({ ref: { provider: 'minimax', model: entry.id, modelClass: 'minimax', effort: 'high', contextWindow: entry.contextWindow ?? 0 }, displayLabel: entry.displayLabel }))
}

function resolveMinimaxModel(_modelClass: RouterModelClass, _posture: RouterPosture): RouteModelRef | null {
  return null
}

function buildMinimaxLaunchPatch(_ref: RouteModelRef): { model: string; effort: string } {
  throw new Error('router: provider minimax has no SEAT runtime — MiniMax specialists dispatch through the AgentTool engine path')
}

export const minimaxProviderAdapter: RouterProviderAdapter = {
  id: 'minimax', transport: 'openai-compat-chat-completions', status: minimaxStatus,
  describe: describeMinimaxProvider, listModels: listMinimaxModels, resolveModel: resolveMinimaxModel, buildLaunchPatch: buildMinimaxLaunchPatch,
}
